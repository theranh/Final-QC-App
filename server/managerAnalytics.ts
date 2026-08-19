// Manager Analytics — GET /api/admin/manager-analytics
//
// Read-only. Requires requireAdmin (isAuthenticated + active employee + isAdmin).
// Reporting timezone: America/Chicago.
// Cohort: intakes whose completed_at falls in the requested local-calendar date range.
// Arrival: intakes.created_at (NULL → unknown, never backfilled).
// Final QC: first non-archived inspection for the normalized VIN at/after intake
//   completion time, located by inspections.created_at.
// Tracker: column B roOpen (raw string), column C completed/release (raw string).
//   Parses only strict YYYY-MM-DD or M/D/YYYY with 4-digit year + real calendar
//   validation. Ambiguous values stay null; raw strings are always returned.
//   Existing frozen production_tracker supplements roOpen only (no release date).
//
// Nothing in this module mutates any table.

import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireAdmin } from "./access";
import { buildPayload } from "./dashboard";
import { readTrackerRange } from "./googleSheets";

const TZ = "America/Chicago";
const SAMPLE_THRESHOLD = 5;
const ROW_CAP = 500; // max rows in cycles.rows before truncated=true
const SHEETS_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Exported pure helpers (tested independently)
// ---------------------------------------------------------------------------

/**
 * Parse a strict YYYY-MM-DD or M/D/YYYY (4-digit year) date string.
 * Returns a YYYY-MM-DD string when valid, otherwise null.
 * Validates real calendar dates (e.g. rejects Feb 30).
 * @public exported for tests
 */
export function parseTrackerDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();

  // Try YYYY-MM-DD
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (isRealDate(y, m, d)) {
      return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
    }
    return null;
  }

  // Try M/D/YYYY (must have exactly 4-digit year)
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (slashMatch) {
    const m = parseInt(slashMatch[1], 10);
    const d = parseInt(slashMatch[2], 10);
    const y = parseInt(slashMatch[3], 10);
    if (isRealDate(y, m, d)) {
      return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
    }
    return null;
  }

  return null;
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function pad4(n: number): string { return String(n).padStart(4, "0"); }

function addCalendarDays(day: string, amount: number): string | null {
  const parsed = parseTrackerDate(day);
  if (!parsed) return null;
  const [y, m, d] = parsed.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + amount));
  return `${pad4(next.getUTCFullYear())}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

/** True iff (year, month 1-based, day) is a real calendar date. */
function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dmax = new Date(y, m, 0).getDate(); // day 0 of next month = last day of month
  return d <= dmax;
}

/**
 * Convert a YYYY-MM-DD local date string to epoch millis at midnight
 * in the given timezone (default: America/Chicago). Returns null if input is invalid.
 *
 * Strategy: pick a UTC probe time that is guaranteed to land on the correct
 * local calendar day (6am UTC works for any US timezone from UTC-12 to UTC+0).
 * Then use Intl to find what local hour that probe is at, and subtract that
 * many hours to back up to local midnight.
 * When Intl reports hour "24" that means the probe IS local midnight (0h),
 * so we subtract 0 hours and the probe itself is the answer.
 * @public exported for tests
 */
export function localDayToEpoch(day: string, tz: string = TZ): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);

  // 6am UTC lands on the correct local calendar day for all US timezones.
  const probe = new Date(Date.UTC(y, mo - 1, d, 6, 0, 0, 0));

  // Verify the probe is on the right local calendar day.
  const probeLocalDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(probe);
  if (probeLocalDay !== day) return null;

  // Find what local hour the probe is at, then subtract to reach midnight.
  // Intl returns "24" when the time is exactly 00:00 local (midnight display quirk).
  const hourParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(probe);
  const hourStr = hourParts.find((p) => p.type === "hour")?.value ?? "0";
  const minuteStr = hourParts.find((p) => p.type === "minute")?.value ?? "0";
  // hour "24" = midnight (treat as 0); otherwise parse normally.
  const localHour = parseInt(hourStr, 10) % 24;
  const localMinute = parseInt(minuteStr, 10);

  return probe.getTime() - (localHour * 3_600_000 + localMinute * 60_000);
}

/**
 * Compute duration in decimal hours between two epoch-ms timestamps.
 * Returns null if either is null/undefined, or if end < start (invalid order
 * is tracked separately).
 * @public exported for tests
 */
export function durationHours(
  startMs: number | null | undefined,
  endMs: number | null | undefined
): number | null {
  if (startMs == null || endMs == null) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs < startMs) return null; // invalid order
  return (endMs - startMs) / 3_600_000;
}

/**
 * Aggregate an array of nullable hour values into stage stats.
 * total = all rows in cohort for this stage.
 * eligible = rows where both endpoints are non-null.
 * unknown = rows where at least one endpoint is null.
 * invalidOrder = rows where end < start.
 * coverage = eligible / total (null if total=0).
 * avgHours, medianHours, p90Hours = null when eligible=0.
 * @public exported for tests
 */
export function stageStats(
  hours: (number | null)[],
  totalRows: number,
  invalidOrderCount: number
): {
  total: number;
  eligible: number;
  unknown: number;
  invalidOrder: number;
  coverage: number | null;
  avgHours: number | null;
  medianHours: number | null;
  p90Hours: number | null;
} {
  const finite = hours.filter((h): h is number => h != null && Number.isFinite(h));
  const eligible = finite.length;
  const unknown = totalRows - eligible - invalidOrderCount;
  const coverage = totalRows > 0 ? eligible / totalRows : null;

  if (eligible === 0) {
    return { total: totalRows, eligible, unknown, invalidOrder: invalidOrderCount, coverage, avgHours: null, medianHours: null, p90Hours: null };
  }

  const sorted = [...finite].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / eligible;
  const median = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);

  return {
    total: totalRows,
    eligible,
    unknown,
    invalidOrder: invalidOrderCount,
    coverage,
    avgHours: rnd(avg),
    medianHours: rnd(median),
    p90Hours: rnd(p90),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function rnd(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Normalize a damage type string for grouping (lowercase, collapse spaces).
 * @public exported for tests
 */
export function normalizeDamageType(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 60) || "unknown";
}

export function classifyAiCorrectionDiff(diff: unknown): string {
  const value = String(diff ?? "").toLowerCase();
  if (value.startsWith("panel ")) return "Panel call";
  if (value.includes(": severity ")) return "Severity call";
  if (value.includes(": damage ")) return "Damage type";
  if (value.includes(": paint_damaged ")) return "Paint damage";
  if (value.includes(": blend ")) return "Blend recommendation";
  return "Other classification call";
}

function localDayForEpoch(epochMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function calendarDayDurationHours(
  startDay: string | null | undefined,
  endDay: string | null | undefined,
): number | null {
  const start = parseTrackerDate(startDay);
  const end = parseTrackerDate(endDay);
  if (!start || !end) return null;
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const days = (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000;
  return days < 0 ? null : days * 24;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type TrackerLiveRow = {
  vin: string;
  roOpen: string | null;    // raw col B
  completed: string | null; // raw col C
};

type CohortRow = {
  vin: string;
  stock: string;
  vehicle: string;
  estimator: string | null;
  // epoch ms
  arrival: number | null;
  intakeComplete: number;
  intakeId: string;
};

type InspectionRow = {
  vin: string;
  qcNumber: string;
  result: string;
  createdAtMs: number;
};

type CycleRow = {
  vin: string;
  stock: string;
  vehicle: string;
  estimator: string | null;
  qcNumber: string | null;
  qcResult: string | null;
  timestamps: {
    arrival: number | null;
    intakeComplete: number;
    finalQc: number | null;
    roOpen: number | null;
    release: number | null;
  };
  rawTracker: {
    roOpen: string | null;
    release: string | null;
  };
  durations: {
    arrivalToIntake: number | null;
    intakeToQc: number | null;
    qcToRo: number | null;
    roToRelease: number | null;
  };
};

// ---------------------------------------------------------------------------
// Tracker data fetch (live sheet + frozen production_tracker)
// ---------------------------------------------------------------------------

/** Fetch live tracker rows for the current month tab. Returns null if unavailable. */
async function fetchLiveTracker(): Promise<Map<string, TrackerLiveRow> | null> {
  try {
    const now = new Date();
    // Build tab name like "Jul 2026"
    const tab = now.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: TZ });
    const timeout = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error("tracker timeout")), SHEETS_TIMEOUT_MS)
    );
    const fetch = readTrackerRange(tab, "A21:C2021").then((rows) => {
      if (!rows) return null;
      const out = new Map<string, TrackerLiveRow>();
      for (const r of rows) {
        const vin = String(r?.[0] ?? "").trim().toUpperCase();
        if (!vin || out.has(vin)) continue;
        out.set(vin, {
          vin,
          roOpen: String(r?.[1] ?? "").trim() || null,
          completed: String(r?.[2] ?? "").trim() || null,
        });
      }
      return out;
    });
    return await Promise.race([fetch, timeout]) as Map<string, TrackerLiveRow> | null;
  } catch {
    return null;
  }
}

/**
 * Build combined tracker map: live sheet (col B + C) supplemented by
 * frozen production_tracker (col B / roOpen only, no release).
 * Returns null if neither source is available.
 */
async function fetchTrackerData(fromEpoch: number, toEpoch: number): Promise<{
  byVin: Map<string, { roOpen: string | null; release: string | null }>;
  source: "live" | "frozen_only" | "unavailable";
}> {
  const [live, frozen] = await Promise.all([
    fetchLiveTracker().catch(() => null),
    fetchFrozenTracker(fromEpoch, toEpoch).catch(() => null),
  ]);

  if (!live && (!frozen || frozen.size === 0)) {
    return { byVin: new Map(), source: "unavailable" };
  }

  const byVin = new Map<string, { roOpen: string | null; release: string | null }>();

  // Merge: live wins for any VIN it has; frozen supplements missing VINs (roOpen only).
  if (live) {
    for (const [vin, row] of live) {
      byVin.set(vin, { roOpen: row.roOpen, release: row.completed });
    }
  }

  if (frozen) {
    for (const [vin, row] of frozen) {
      if (!byVin.has(vin)) {
        byVin.set(vin, { roOpen: row.roOpen, release: null }); // frozen has no release
      }
    }
  }

  const source = live ? "live" : "frozen_only";
  return { byVin, source: source as "live" | "frozen_only" };
}

/** Fetch frozen tracker values only for VINs in the bounded intake cohort. */
async function fetchFrozenTracker(
  fromEpoch: number,
  toEpoch: number,
): Promise<Map<string, { roOpen: string | null }> | null> {
  try {
    const res = await db.execute(sql`
      SELECT DISTINCT ON (UPPER(TRIM(pt.vin)))
        UPPER(TRIM(pt.vin)) AS vin,
        pt.ro_open
      FROM production_tracker pt
      WHERE UPPER(TRIM(pt.vin)) IN (
        SELECT DISTINCT UPPER(TRIM(vin))
        FROM intakes
        WHERE completed_at IS NOT NULL
          AND completed_at >= to_timestamp(${fromEpoch / 1000.0})
          AND completed_at < to_timestamp(${toEpoch / 1000.0})
      )
      ORDER BY UPPER(TRIM(pt.vin)), pt.snapshot_at DESC
    `);
    const out = new Map<string, { roOpen: string | null }>();
    for (const r of ((res as any).rows ?? res) as any[]) {
      const vin = String(r.vin ?? "").trim().toUpperCase();
      if (!vin) continue;
      out.set(vin, { roOpen: r.ro_open != null ? String(r.ro_open).trim() || null : null });
    }
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main payload builder
// ---------------------------------------------------------------------------

export async function buildManagerAnalytics(opts: {
  from: string;
  to: string;
  estimator?: string | null;
  qcResult?: string | null;
}): Promise<unknown> {
  const { from, to, estimator: estimatorFilter, qcResult: qcResultFilter } = opts;

  // Convert from/to to half-open instant range in UTC
  // from-day 00:00:00 local → inclusive start
  // to-day 00:00:00 local next day → exclusive end
  const fromEpoch = localDayToEpoch(from, TZ)!;
  const nextDay = addCalendarDays(to, 1);
  const toEpoch = nextDay ? localDayToEpoch(nextDay, TZ)! : null;
  if (toEpoch == null) throw new Error("Unable to calculate reporting range");

  const generatedAt = Date.now();

  // 1. Cohort: completed intakes in range
  const cohortRes = await db.execute(sql`
    SELECT
      UPPER(TRIM(vin)) AS vin,
      stock,
      vehicle,
      estimator,
      EXTRACT(EPOCH FROM created_at) * 1000 AS arrival_ms,
      EXTRACT(EPOCH FROM completed_at) * 1000 AS complete_ms,
      id AS intake_id
    FROM intakes
    WHERE completed_at IS NOT NULL
      AND completed_at >= to_timestamp(${fromEpoch / 1000.0})
      AND completed_at < to_timestamp(${toEpoch / 1000.0})
    ORDER BY completed_at ASC
  `);

  const cohortRows: CohortRow[] = ((cohortRes as any).rows ?? (cohortRes as any)).map((r: any) => ({
    vin: String(r.vin ?? "").trim().toUpperCase(),
    stock: String(r.stock ?? "").trim(),
    vehicle: String(r.vehicle ?? "").trim(),
    estimator: r.estimator != null ? String(r.estimator).trim() || null : null,
    arrival: r.arrival_ms != null ? Math.round(Number(r.arrival_ms)) : null,
    intakeComplete: Math.round(Number(r.complete_ms)),
    intakeId: String(r.intake_id ?? ""),
  })).filter((r: CohortRow) => r.vin.length >= 6 && Number.isFinite(r.intakeComplete));

  // Available estimators from the unfiltered cohort
  const allEstimators = [...new Set(
    cohortRows
      .map((r) => r.estimator)
      .filter((e): e is string => e != null && e.length > 0)
  )].sort();

  // 2. Get all VINs in the cohort to fetch inspections
  const cohortVins = [...new Set(cohortRows.map((r) => r.vin))];

  // 3. Fetch first non-archived inspection for each VIN (by inspections.created_at)
  const inspectionsByVin = new Map<string, InspectionRow[]>();
  if (cohortVins.length > 0) {
    const inspRes = await db.execute(sql`
      SELECT
        UPPER(TRIM(vin)) AS vin,
        qc_number,
        result,
        EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms
      FROM inspections
      WHERE UPPER(TRIM(vin)) IN (
        SELECT DISTINCT UPPER(TRIM(vin))
        FROM intakes
        WHERE completed_at IS NOT NULL
          AND completed_at >= to_timestamp(${fromEpoch / 1000.0})
          AND completed_at < to_timestamp(${toEpoch / 1000.0})
      )
        AND NOT archived
      ORDER BY UPPER(TRIM(vin)), created_at ASC
    `);
    for (const r of ((inspRes as any).rows ?? (inspRes as any)) as any[]) {
      const vin = String(r.vin ?? "").trim().toUpperCase();
      if (!vin) continue;
      const inspection = {
        vin,
        qcNumber: String(r.qc_number ?? ""),
        result: String(r.result ?? ""),
        createdAtMs: Math.round(Number(r.created_ms)),
      };
      const existing = inspectionsByVin.get(vin);
      if (existing) existing.push(inspection);
      else inspectionsByVin.set(vin, [inspection]);
    }
  }

  // 4. Fetch tracker data (live + frozen)
  const trackerResult = await fetchTrackerData(fromEpoch, toEpoch);
  const trackerByVin = trackerResult.byVin;
  const trackerSource = trackerResult.source;

  // 5. Build cycle rows
  const allCycleRows: CycleRow[] = cohortRows.map((intake) => {
    const insp = (inspectionsByVin.get(intake.vin) ?? [])
      .find((candidate) => candidate.createdAtMs >= intake.intakeComplete) ?? null;
    const tracker = trackerByVin.get(intake.vin) ?? null;

    // Final QC: first non-archived inspection at/after intake completion
    let finalQcMs: number | null = null;
    let qcNumber: string | null = null;
    let qcResult: string | null = null;
    if (insp) {
      finalQcMs = insp.createdAtMs;
      qcNumber = insp.qcNumber;
      qcResult = insp.result === "pass" ? "pass" : "fail";
    }

    const rawRoOpen = tracker?.roOpen ?? null;
    const rawRelease = tracker?.release ?? null;
    const parsedRoOpen = parseTrackerDate(rawRoOpen);
    const parsedRelease = parseTrackerDate(rawRelease);

    // Convert parsed dates to epoch ms (at local midnight)
    const roOpenMs = parsedRoOpen ? localDayToEpoch(parsedRoOpen, TZ) : null;
    const releaseMs = parsedRelease ? localDayToEpoch(parsedRelease, TZ) : null;

    const durations = {
      arrivalToIntake: durationHours(intake.arrival, intake.intakeComplete),
      intakeToQc: durationHours(intake.intakeComplete, finalQcMs),
      qcToRo: calendarDayDurationHours(
        finalQcMs == null ? null : localDayForEpoch(finalQcMs),
        parsedRoOpen,
      ),
      roToRelease: calendarDayDurationHours(parsedRoOpen, parsedRelease),
    };

    return {
      vin: intake.vin,
      stock: intake.stock,
      vehicle: intake.vehicle,
      estimator: intake.estimator,
      qcNumber,
      qcResult,
      timestamps: {
        arrival: intake.arrival,
        intakeComplete: intake.intakeComplete,
        finalQc: finalQcMs,
        roOpen: roOpenMs,
        release: releaseMs,
      },
      rawTracker: {
        roOpen: rawRoOpen,
        release: rawRelease,
      },
      durations,
    };
  });

  // 6. Apply filters
  let filteredRows = allCycleRows;
  if (estimatorFilter) {
    filteredRows = filteredRows.filter((r) => r.estimator === estimatorFilter);
  }
  if (qcResultFilter === "pass") {
    filteredRows = filteredRows.filter((r) => r.qcResult === "pass");
  } else if (qcResultFilter === "fail") {
    filteredRows = filteredRows.filter((r) => r.qcResult === "fail");
  }

  // 7. Compute stage stats from filtered rows
  const stages = buildStages(filteredRows);

  // 8. Truncate rows for response
  const truncated = filteredRows.length > ROW_CAP;
  const responseRows = filteredRows.slice(0, ROW_CAP);

  // 9. Daily summary — compose from existing buildPayload(today, today)
  const daily = await buildDailySummary(trackerSource);

  // 10. Calibration
  const calibration = await buildCalibration(from, to, fromEpoch, toEpoch);

  return {
    generatedAt,
    timezone: TZ,
    range: { from, to, cohort: "completed_intakes" },
    filters: {
      estimator: estimatorFilter ?? null,
      qcResult: qcResultFilter ?? null,
      options: {
        estimators: allEstimators,
        qcResults: ["pass", "fail"],
      },
    },
    cycles: {
      stages,
      rows: responseRows,
      truncated,
    },
    daily,
    calibration,
  };
}

// ---------------------------------------------------------------------------
// Stage aggregation
// ---------------------------------------------------------------------------

function buildStages(rows: CycleRow[]) {
  const total = rows.length;

  const stageKeys = [
    { key: "arrivalToIntake", label: "Arrival → Intake Complete", precision: "timestamp" },
    { key: "intakeToQc", label: "Intake Complete → Final QC", precision: "timestamp" },
    { key: "qcToRo", label: "Final QC → RO Open", precision: "calendar_day" },
    { key: "roToRelease", label: "RO Open → Release", precision: "calendar_day" },
  ] as const;

  return stageKeys.map(({ key, label, precision }) => {
    let eligible = 0;
    let unknownCount = 0;
    let invalidOrder = 0;
    const hours: (number | null)[] = [];

    for (const row of rows) {
      const dur = row.durations[key];
      if (dur == null) {
        // Check whether it's due to missing endpoints vs invalid order
        // We need to infer invalid order from raw timestamps
        const inv = isInvalidOrder(row, key);
        if (inv) {
          invalidOrder++;
        } else {
          unknownCount++;
        }
        hours.push(null);
      } else {
        eligible++;
        hours.push(dur);
      }
    }

    const stats = stageStats(
      hours.filter((h) => h != null) as number[],
      total,
      invalidOrder
    );

    return {
      key,
      label,
      precision,
      ...stats,
    };
  });
}

function isInvalidOrder(row: CycleRow, key: keyof CycleRow["durations"]): boolean {
  const ts = row.timestamps;
  switch (key) {
    case "arrivalToIntake":
      return ts.arrival != null && ts.intakeComplete != null && ts.intakeComplete < ts.arrival;
    case "intakeToQc":
      return ts.intakeComplete != null && ts.finalQc != null && ts.finalQc < ts.intakeComplete;
    case "qcToRo":
      return ts.finalQc != null && ts.roOpen != null && ts.roOpen < ts.finalQc;
    case "roToRelease":
      return ts.roOpen != null && ts.release != null && ts.release < ts.roOpen;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

async function buildDailySummary(trackerSource: string): Promise<unknown> {
  const generatedAt = Date.now();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  try {
    // Compose from existing buildPayload for today only
    const payload = await buildPayload(today, today) as any;

    // Extract relevant daily numbers
    const daily = (payload.daily as any[])?.find((d: any) => d.day === today);
    const completedIntakes = daily?.intakes ?? 0;

    // QC pass/fail today
    const qcRes = await db.execute(sql`
      SELECT result, COUNT(*)::int AS n
      FROM inspections
      WHERE (created_at AT TIME ZONE ${TZ})::date = ${today}::date
        AND NOT archived
      GROUP BY result
    `);
    let qcsPassed = 0;
    let qcsFailed = 0;
    for (const r of ((qcRes as any).rows ?? qcRes) as any[]) {
      if (String(r.result) === "pass") qcsPassed += Number(r.n) || 0;
      else qcsFailed += Number(r.n) || 0;
    }

    const openRechecks = (payload.kpi as any)?.openRechecks ?? 0;

    // aging from payload
    const aging = payload.aging ?? null;

    // Export exceptions (failed sheet exports)
    const exportStage = aging?.stages?.find((s: any) => s.key === "exportFailed");
    const exportExceptions = {
      count: exportStage?.count ?? 0,
      trucks: Array.isArray(exportStage?.trucks) ? exportStage.trucks : [],
    };

    return {
      day: today,
      scope: "right_now",
      completedIntakes,
      qcsPassed,
      qcsFailed,
      openRechecks,
      aging,
      exportExceptions,
      trackerSource,
      generatedAt,
    };
  } catch (err) {
    return {
      day: today,
      scope: "right_now",
      completedIntakes: null,
      qcsPassed: null,
      qcsFailed: null,
      openRechecks: null,
      aging: null,
      exportExceptions: { count: null, trucks: [] },
      trackerSource,
      generatedAt,
      error: String((err as any)?.message || "daily summary failed"),
    };
  }
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

async function buildCalibration(
  from: string,
  to: string,
  fromEpoch: number,
  toEpoch: number
): Promise<unknown> {
  const notes: string[] = [
    "AI call corrections and committed pricing corrections are separate, anonymous, read-only coaching signals.",
  ];

  // AI calibration
  let aiSection: unknown;
  try {
    aiSection = await buildAiCalibration(fromEpoch, toEpoch, notes);
  } catch (err) {
    notes.push(`AI calibration unavailable: ${(err as any)?.message || err}`);
    aiSection = { available: false, reason: String((err as any)?.message || err) };
  }

  // Pricing calibration
  let pricingSection: unknown;
  try {
    pricingSection = await buildPricingCalibration(fromEpoch, toEpoch, notes);
  } catch (err) {
    notes.push(`Pricing calibration unavailable: ${(err as any)?.message || err}`);
    pricingSection = { available: false, reason: String((err as any)?.message || err) };
  }

  const available = (aiSection as any)?.available !== false || (pricingSection as any)?.available !== false;

  return {
    available,
    sampleThreshold: SAMPLE_THRESHOLD,
    ai: aiSection,
    pricing: pricingSection,
    notes,
  };
}

async function buildAiCalibration(
  fromEpoch: number,
  toEpoch: number,
  notes: string[]
): Promise<unknown> {
  // ai_analyses table: analyses in range, corrected count
  // Range is bounded by the cohort's epoch range
  const res = await db.execute(sql`
    SELECT
      COUNT(*)::int AS analyses,
      COUNT(*) FILTER (WHERE corrected)::int AS corrected,
      COUNT(DISTINCT analysis_id) FILTER (WHERE analysis_id IS NOT NULL)::int AS unique_analyses
    FROM ai_analyses
    WHERE ts >= ${fromEpoch}
      AND ts < ${toEpoch}
      AND analysis_id IS NOT NULL
  `).catch((err: any) => {
    throw new Error(`ai_analyses unavailable: ${err?.message || err}`);
  });

  const row = ((res as any).rows ?? (res as any))[0] as any;
  const analyses = Number(row?.analyses) || 0;
  const corrected = Number(row?.corrected) || 0;
  const fieldRes = await db.execute(sql`
    SELECT diffs
    FROM corrections
    WHERE ts >= ${fromEpoch}
      AND ts < ${toEpoch}
    ORDER BY id DESC
    LIMIT 500
  `).catch(() => ({ rows: [] }));
  const correctionRows = ((fieldRes as any).rows ?? fieldRes) as any[];
  const fieldCounts = new Map<string, number>();
  let fieldTotal = 0;
  for (const correction of correctionRows) {
    const diffs = correction?.diffs;
    if (Array.isArray(diffs)) {
      for (const diff of diffs) {
        const field = classifyAiCorrectionDiff(diff);
        fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
        fieldTotal++;
      }
    } else if (diffs && typeof diffs === "object") {
      const fieldLabels: Record<string, string> = {
        panel: "Panel call",
        severity: "Severity call",
        damage_type: "Damage type",
        paint_damaged: "Paint damage",
        blend_adjacent_recommended: "Blend recommendation",
      };
      for (const key of Object.keys(diffs)) {
        const field = fieldLabels[key] ?? key.replace(/_/g, " ");
        fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
        fieldTotal++;
      }
    }
  }
  const byField = [...fieldCounts.entries()]
    .map(([field, count]) => ({ field, count, share: fieldTotal > 0 ? count / fieldTotal : null }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));

  const correctionRate = analyses > 0 ? corrected / analyses : null;
  notes.push("AI field patterns use the bounded corrections corpus, which retains at most 500 recent edits and may include changes made before final quote commit.");

  if (analyses < SAMPLE_THRESHOLD) {
    notes.push(`AI calibration: only ${analyses} analyses in range (threshold ${SAMPLE_THRESHOLD}); results may be unreliable.`);
  }

  return {
    available: true,
    analyses,
    corrected,
    correctionRate,
    corpusRows: correctionRows.length,
    byField,
    _telemetryNote: "Analysis counts come from deduplicated ai_analyses telemetry. Field patterns come from the bounded legacy corrections corpus, which retains at most 500 recent rows.",
  };
}

async function buildPricingCalibration(
  fromEpoch: number,
  toEpoch: number,
  _notes: string[]
): Promise<unknown> {
  // Read immutable quote_snapshots + pricing_corrections in range
  const [summaryRes, byDamageRes, byComponentRes] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)::int AS committed_versions,
        COALESCE(SUM(lines_total), 0)::int AS billable_lines,
        COALESCE(SUM(lines_overridden), 0)::int AS overridden_lines
      FROM quote_snapshots
      WHERE created_at >= to_timestamp(${fromEpoch / 1000.0})
        AND created_at < to_timestamp(${toEpoch / 1000.0})
    `).catch((err: any) => {
      throw new Error(`quote_snapshots unavailable: ${err?.message || err}`);
    }),

    db.execute(sql`
      WITH committed_lines AS (
        SELECT
          qs.id AS snapshot_id,
          line->>'id' AS line_id,
          COALESCE(NULLIF(line->>'damage', ''), 'unknown') AS damage_type,
          COALESCE((line->>'overridden')::boolean, false) AS overridden
        FROM quote_snapshots qs
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(qs.engine->'lines', '[]'::jsonb)
        ) AS line
        WHERE qs.created_at >= to_timestamp(${fromEpoch / 1000.0})
          AND qs.created_at < to_timestamp(${toEpoch / 1000.0})
      )
      SELECT
        cl.damage_type,
        COUNT(*)::int AS total_lines,
        COUNT(*) FILTER (WHERE cl.overridden)::int AS corrected_lines,
        AVG((pc.final_usd::numeric - pc.calc_usd::numeric))
          FILTER (WHERE pc.id IS NOT NULL)::float AS avg_usd_delta
      FROM committed_lines cl
      LEFT JOIN pricing_corrections pc
        ON pc.snapshot_id = cl.snapshot_id
       AND pc.line_id = cl.line_id
      GROUP BY cl.damage_type
      ORDER BY corrected_lines DESC, total_lines DESC
    `).catch(() => ({ rows: [] })),

    db.execute(sql`
      SELECT
        SUM(CASE WHEN final_b != calc_b THEN 1 ELSE 0 END)::int AS body_overrides,
        SUM(CASE WHEN final_p != calc_p THEN 1 ELSE 0 END)::int AS paint_overrides,
        SUM(CASE WHEN final_ri != calc_ri THEN 1 ELSE 0 END)::int AS ri_overrides,
        SUM(CASE WHEN final_usd != calc_usd THEN 1 ELSE 0 END)::int AS usd_overrides,
        AVG(final_b::numeric - calc_b::numeric)::float AS avg_body_delta,
        AVG(final_p::numeric - calc_p::numeric)::float AS avg_paint_delta,
        AVG(final_ri::numeric - calc_ri::numeric)::float AS avg_ri_delta,
        AVG(final_usd::numeric - calc_usd::numeric)::float AS avg_usd_delta
      FROM pricing_corrections
      WHERE created_at >= to_timestamp(${fromEpoch / 1000.0})
        AND created_at < to_timestamp(${toEpoch / 1000.0})
    `).catch(() => ({ rows: [{}] })),
  ]);

  const s = ((summaryRes as any).rows ?? (summaryRes as any))[0] as any;
  const committedVersions = Number(s?.committed_versions) || 0;
  const billableLines = Number(s?.billable_lines) || 0;
  const overriddenLines = Number(s?.overridden_lines) || 0;
  const overrideRate = billableLines > 0 ? overriddenLines / billableLines : null;

  const byDamage = ((byDamageRes as any).rows ?? (byDamageRes as any)).map((r: any) => ({
    category: normalizeDamageType(r.damage_type),
    total: Number(r.total_lines) || 0,
    corrected: Number(r.corrected_lines) || 0,
    rate: Number(r.total_lines) > 0 ? Number(r.corrected_lines) / Number(r.total_lines) : null,
    lowSample: Number(r.total_lines) < SAMPLE_THRESHOLD,
    avgUsdDelta: r.avg_usd_delta != null ? Math.round(Number(r.avg_usd_delta) * 100) / 100 : null,
  }));

  const bc = ((byComponentRes as any).rows ?? (byComponentRes as any))[0] as any;
  const componentRows = [
    ["Body hours", Number(bc?.body_overrides) || 0, bc?.avg_body_delta, 3],
    ["Paint hours", Number(bc?.paint_overrides) || 0, bc?.avg_paint_delta, 3],
    ["R&I hours", Number(bc?.ri_overrides) || 0, bc?.avg_ri_delta, 3],
    ["Total dollars", Number(bc?.usd_overrides) || 0, bc?.avg_usd_delta, 2],
  ] as const;
  const byComponent = componentRows.map(([component, count, rawAverage, places]) => ({
    component,
    count,
    share: overriddenLines > 0 ? count / overriddenLines : null,
    avgDelta: rawAverage != null
      ? Math.round(Number(rawAverage) * (10 ** places)) / (10 ** places)
      : null,
  }));

  return {
    available: true,
    committedVersions,
    billableLines,
    overriddenLines,
    overrideRate,
    byDamage,
    byComponent,
    _note: "Reads immutable quote_snapshots + pricing_corrections; no pricing math is changed.",
  };
}

// ---------------------------------------------------------------------------
// Route validation helpers
// ---------------------------------------------------------------------------

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validateDayParam(s: unknown): string | null {
  const m = DAY_RE.exec(String(s ?? "").trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (!isRealDate(y, mo, d)) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerManagerAnalyticsRoute(app: Express): void {
  app.get("/api/admin/manager-analytics", requireAdmin, async (req, res, next) => {
    try {
      const fromRaw = req.query.from;
      const toRaw = req.query.to;

      if (!fromRaw || !toRaw) {
        return res.status(400).json({ message: "Both 'from' and 'to' YYYY-MM-DD parameters are required." });
      }

      const from = validateDayParam(fromRaw);
      const to = validateDayParam(toRaw);

      if (!from) {
        return res.status(400).json({ message: "Invalid 'from' date. Use YYYY-MM-DD." });
      }
      if (!to) {
        return res.status(400).json({ message: "Invalid 'to' date. Use YYYY-MM-DD." });
      }
      if (from > to) {
        return res.status(400).json({ message: "'from' must be on or before 'to'." });
      }

      // Max range: 366 days inclusive
      const fromEpoch = localDayToEpoch(from, TZ)!;
      const toEpoch = localDayToEpoch(to, TZ)!;
      const dayDiff = Math.round((toEpoch - fromEpoch) / 86_400_000);
      if (dayDiff > 366) {
        return res.status(400).json({ message: "Date range must not exceed 366 days." });
      }

      const estimator = req.query.estimator ? String(req.query.estimator).trim() || null : null;
      const qcResult = req.query.qcResult === "pass" || req.query.qcResult === "fail"
        ? String(req.query.qcResult)
        : null;

      res.set("Cache-Control", "no-store");
      const payload = await buildManagerAnalytics({ from, to, estimator, qcResult });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });
}
