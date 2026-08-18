import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireEmployee } from "./access";
import { monthTabName, readTrackerRange } from "./googleSheets";
import { frozenMonth } from "./tracker";
import {
  fetchCompletedIntakes,
  fetchIntakeStats,
  fetchQuoteCovers,
  lookupIntakeByVin,
} from "./localQuote";

// One dashboard endpoint: GET /api/dashboard?from=<ISO>&to=<ISO>.
// Composes, server-side, in one response:
//   - this app's Postgres (inspections + audit_log)
//   - the Body Quoter data, now local in this app's Postgres (quotes + intakes:
//     daily counts for the range, quote summaries per VIN, completed intakes)
//   - the VPC Production Tracker sheet (money figures, read as typed — never recomputed)
// Every KPI is computed here and only here; the client renders, it never recomputes.
// If the sheet is unreachable the rest still returns, flagged "trackerSource":
// "unavailable". The Quoter data is local now, so it is always available.
// Aggregates cover EVERY inspection: the SQL projects trimmed rows (no photo
// blobs), so reading the whole table stays cheap.

const PAYLOAD_CACHE_MS = 25_000;
const REMOTE_CACHE_MS = 60_000; // sheet reads, per the spec
const SHEETS_TIMEOUT_MS = 10_000;
const TABLE_FIRST_DATA_ROW = 21; // row 20 is the tracker's table header
const TZ = "America/Chicago";

const SEGMENTS = ["mech", "cosm", "detail", "bed", "ceramic", "under"] as const;

// ---------- caches ----------

const payloadCache = new Map<string, { at: number; body: unknown }>();

/** Drop composed payloads after an inspection commit, so a just-inspected
 *  vehicle never lingers in the "awaiting Final QC" list for the cache TTL. */
let cacheGen = 0;
export function invalidateDashboardCache() {
  payloadCache.clear();
  cacheGen += 1; // in-flight builds started before this must not repopulate the cache
}
const payloadInFlight = new Map<string, Promise<unknown>>();
let sheetCache: { at: number; body: SheetData | null } | null = null;

type TrackerRow = {
  roOpen: string | null;
  completed: string | null;
  pictureReceived: string | null;
  retailPlan: number | null;
  closedRO: number | null;
  daysPictureToClose: number | null;
  daysInProduction: number | null;
  variance: number | null; // column I, read as typed — never recomputed
  variancePct: number | null; // column J, read as typed
  notes: string | null;
};

type SheetData = {
  summary: Record<string, number | null>;
  byVin: Map<string, TrackerRow>;
};

/** Trimmed inspection row — projected in SQL, never includes photo blobs. */
type LiteRow = {
  qcNumber: string;
  stock: string;
  vehicle: string;
  vin: string;
  result: string;
  status: string;
  inspector: string | null;
  title: string | null;
  ts: number;
  clearedTs: number | null;
  openItems: { cat: string; item: string; note: string }[];
  failItems: { cat: string; item: string }[];
  archived: boolean;
};

// ---------- helpers ----------

const money = (v: unknown): number | null => {
  const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const num = (v: unknown): number | null => {
  const n = parseFloat(String(v ?? "").replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s || null;
};

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayOf = (ts: number | Date): string => DAY_FMT.format(ts);

function parseISODay(s: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  return m ? m[0] : null;
}

/** @internal exported for tests */
export { last8WeekMondays };

/** Enumerate YYYY-MM-DD days from..to inclusive (bounded). */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  for (let i = 0; i < 400 && cur <= end; i++) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86_400_000);
  }
  return out;
}

/**
 * Return YYYY-MM-DD labels for the 8 most recent Monday-start weeks in tz,
 * oldest first.  Always produces exactly 8 entries so the dashboard chart has
 * a consistent x-axis regardless of data density.
 */
function last8WeekMondays(tz: string): string[] {
  const now = new Date();
  const tzDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const base = new Date(`${tzDay}T12:00:00Z`);
  const dow = base.getUTCDay(); // 0 = Sun, 1 = Mon, …
  const daysToMon = dow === 0 ? 6 : dow - 1;
  base.setUTCDate(base.getUTCDate() - daysToMon); // roll back to this Monday
  const weeks: string[] = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 7 * 86_400_000);
    weeks.push(d.toISOString().slice(0, 10));
  }
  return weeks;
}

// ---------- Body Quoter (local: quotes / intakes tables) ----------

type QuoteSummary = {
  found: boolean;
  totals?: { hrs?: number; usd?: number };
  lineCount?: number;
};

/** Trimmed quote summaries per VIN. One query fetches the latest quote for
 *  every requested VIN (newest by the quote's stored `ts`, VIN upper-cased) —
 *  mirroring the old quote-by-vin matching — so the vehicle-card fields
 *  (hrs / usd / lineCount) stay identical. */
async function fetchQuotes(vins: string[]): Promise<Map<string, QuoteSummary>> {
  const out = new Map<string, QuoteSummary>();
  const unique = [...new Set(vins.filter((v) => v && v.length >= 6))];
  if (!unique.length) return out;
  const res = await db.execute(sql`
    SELECT DISTINCT ON (UPPER(data->>'vin')) UPPER(data->>'vin') AS vin, data
    FROM quotes
    WHERE UPPER(data->>'vin') = ANY(${sql.raw(`ARRAY[${unique.map((v) => `'${v.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
    ORDER BY UPPER(data->>'vin'), (data->>'ts')::bigint DESC
  `);
  for (const r of ((res as any).rows ?? res) as any[]) {
    const q = (r.data as any) || {};
    const lineCount = Array.isArray(q.lines) ? q.lines.filter((l: any) => l && l.cls).length : 0;
    out.set(String(r.vin), {
      found: true,
      totals: { hrs: q.totals?.hrs, usd: q.totals?.usd },
      lineCount,
    });
  }
  return out;
}

// ---------- tracker sheet ----------

/** Summary block (rows 1–19) parsed by label keywords, read as typed. */
function parseSummary(rows: string[][] | null): Record<string, number | null> {
  const summary: Record<string, number | null> = {
    completed: null, retailPlan: null, closedRO: null, variance: null, variancePct: null, claimsApproved: null,
  };
  if (!rows) return summary;
  const want: [string, RegExp, boolean][] = [
    ["completed", /^vehicles\s*completed/i, false],
    ["retailPlan", /retail\s*plan\s*\$/i, false],
    ["closedRO", /closed\s*ro\s*\$/i, false],
    ["variance", /variance\s*\$/i, false],
    ["variancePct", /variance\s*%/i, false],
    ["claimsApproved", /claims?\s*approved/i, true],
  ];
  for (const row of rows) {
    const label = String(row?.[0] ?? "").trim();
    for (const [key, re, sum] of want) {
      if (!re.test(label)) continue;
      for (let v = 1; v < row.length; v++) {
        const val = money(row[v]);
        if (val != null) {
          summary[key] = sum ? (summary[key] ?? 0) + val : val;
          break;
        }
      }
      break;
    }
  }
  return summary;
}

// Tracker table columns (row 20 headers): A VIN · B RO Open Date · C Completed
// Date · D Picture Received · E Retail Plan $ · F Closed RO $ · G Days Picture
// to Close · H Days in Production · I Variance $ · J Variance % · K–O depts ·
// P QC Result · Q notes.
function parseVehicleRows(rows: string[][] | null, into: Map<string, TrackerRow>) {
  if (!rows) return;
  for (const r of rows) {
    const vin = String(r?.[0] ?? "").trim().toUpperCase();
    if (!vin || into.has(vin)) continue; // first occurrence wins (current month read first)
    into.set(vin, {
      roOpen: text(r[1]),
      completed: text(r[2]),
      pictureReceived: text(r[3]),
      retailPlan: money(r[4]),
      closedRO: money(r[5]),
      daysPictureToClose: num(r[6]),
      daysInProduction: num(r[7]),
      variance: money(r[8]),
      variancePct: num(r[9]),
      notes: text(r[16]),
    });
  }
}

/**
 * A frozen (snapshotted) closed month provides only the three stored columns
 * (retail plan, closed RO, days-to-close), read exactly as typed. Everything
 * else — dates, days-in-production, and BOTH variance fields — is unavailable
 * (null), NOT $0: we never recompute figures for frozen months (a computed
 * closed − retail variance would violate "stored exactly as typed"). The UI
 * marks these unavailable rather than showing a derived number.
 */
function frozenToTrackerRow(f: {
  retailPlanUsd: number | null;
  closedRoUsd: number | null;
  daysToClose: number | null;
}): TrackerRow {
  return {
    roOpen: null,
    completed: null,
    pictureReceived: null,
    retailPlan: f.retailPlanUsd,
    closedRO: f.closedRoUsd,
    daysPictureToClose: f.daysToClose,
    daysInProduction: null,
    variance: null, // never recomputed for frozen months
    variancePct: null, // never recomputed for frozen months
    notes: null,
  };
}

/** Sheet figures — current month live + previous (closed) month, cached 60s.
 *  The previous month prefers its frozen snapshot when one exists (closed
 *  months are read from production_tracker); the current month stays live from
 *  the sheet. Null = sheet unreachable. */
async function fetchSheetData(): Promise<SheetData | null> {
  if (sheetCache && Date.now() - sheetCache.at < REMOTE_CACHE_MS) return sheetCache.body;
  let body: SheetData | null = null;
  try {
    const now = new Date();
    const curTab = monthTabName(now);
    const prev = new Date(now);
    prev.setDate(0);
    const prevTab = monthTabName(prev);
    // Frozen snapshot for the closed (previous) month, if one exists. A read
    // failure here must not sink the whole dashboard — degrade to the live sheet.
    const prevFrozen = await frozenMonth(prevTab).catch((err) => {
      console.error(`Dashboard: could not read frozen tracker for "${prevTab}":`, err?.message || err);
      return new Map<string, { retailPlanUsd: number | null; closedRoUsd: number | null; daysToClose: number | null }>();
    });
    const havePrevSnapshot = prevFrozen.size > 0;
    const [summaryRows, curRows, prevRows] = await withTimeout(
      Promise.all([
        readTrackerRange(curTab, "A1:H19"),
        readTrackerRange(curTab, `A${TABLE_FIRST_DATA_ROW}:Q${TABLE_FIRST_DATA_ROW + 2000}`),
        // Skip the live read of a closed month once it's frozen — the snapshot
        // is the source of truth for that month.
        havePrevSnapshot
          ? Promise.resolve(null)
          : readTrackerRange(prevTab, `A${TABLE_FIRST_DATA_ROW}:Q${TABLE_FIRST_DATA_ROW + 2000}`).catch((err) => {
              console.error(`Dashboard: could not read tab "${prevTab}":`, err?.message || err);
              return null;
            }),
      ]),
      SHEETS_TIMEOUT_MS,
      "Tracker sheet read"
    );
    const byVin = new Map<string, TrackerRow>();
    parseVehicleRows(curRows, byVin); // current month wins on repeat VINs
    if (havePrevSnapshot) {
      // Closed month: use the frozen snapshot for any VIN not in the current month.
      for (const [vin, f] of prevFrozen) if (!byVin.has(vin)) byVin.set(vin, frozenToTrackerRow(f));
    } else {
      parseVehicleRows(prevRows, byVin);
    }
    body = { summary: parseSummary(summaryRows), byVin };
  } catch (err: any) {
    console.error("Dashboard: tracker sheet read failed:", err?.message || err);
    body = null;
  }
  sheetCache = { at: Date.now(), body };
  return body;
}

// ---------- inspections (trimmed, all rows, no photo blobs) ----------

async function fetchLiteRows(): Promise<LiteRow[]> {
  const res = await db.execute(sql`
    SELECT
      qc_number, stock, vehicle, vin, result, status, archived,
      data->>'inspector' AS inspector,
      data->>'title' AS title,
      data->>'ts' AS ts,
      data->>'clearedTs' AS cleared_ts,
      extract(epoch from created_at) * 1000 AS created_ms,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('cat', oi->>'cat', 'item', oi->>'item', 'note', COALESCE(oi->>'note', '')))
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'openItems') = 'array' THEN data->'openItems' ELSE '[]'::jsonb END) oi
      ), '[]'::jsonb) AS open_items,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('cat', kv.key, 'item', it->>'item'))
        FROM jsonb_each(CASE WHEN jsonb_typeof(data->'items') = 'object' THEN data->'items' ELSE '{}'::jsonb END) kv,
             jsonb_array_elements(CASE WHEN jsonb_typeof(kv.value) = 'array' THEN kv.value ELSE '[]'::jsonb END) it
        WHERE it->>'mark' = 'f'
      ), '[]'::jsonb) AS fail_items
    FROM inspections
    ORDER BY created_at DESC
  `);
  return (((res as any).rows ?? res) as any[]).map((r) => ({
    qcNumber: String(r.qc_number),
    stock: String(r.stock ?? ""),
    vehicle: String(r.vehicle ?? ""),
    vin: String(r.vin ?? "").trim().toUpperCase(),
    result: String(r.result),
    status: String(r.status),
    inspector: r.inspector ?? null,
    title: r.title ?? null,
    ts: num(r.ts) ?? Number(r.created_ms),
    clearedTs: num(r.cleared_ts),
    openItems: (typeof r.open_items === "string" ? JSON.parse(r.open_items) : r.open_items) || [],
    failItems: (typeof r.fail_items === "string" ? JSON.parse(r.fail_items) : r.fail_items) || [],
    archived: r.archived === true || r.archived === "t",
  }));
}

// ---------- payload assembly ----------

export async function buildPayload(from: string, to: string): Promise<unknown> {
  const [allRows, stats, sheet, completedIntakes] = await Promise.all([
    fetchLiteRows(),
    fetchIntakeStats(from, to),
    fetchSheetData(),
    fetchCompletedIntakes(),
  ]);
  // Archived records (e.g. units imported from the old app) are excluded from
  // every dashboard/report aggregation but stay viewable in the records list.
  const rows = allRows.filter((r) => !r.archived);

  const trackerByVin = sheet?.byVin ?? new Map<string, TrackerRow>();
  const quotes = await fetchQuotes(rows.map((r) => r.vin));

  // ----- vehicles -----
  const vehicles = rows.map((row) => {
    const tracker = trackerByVin.get(row.vin) || null;
    const quote = quotes.get(row.vin) || { found: false as const };
    const released = tracker?.closedRO != null;
    const statusKey = row.status === "open" ? "openRecheck" : released ? "released" : "frontlineReady";
    return {
      vin: row.vin,
      stock: row.stock,
      vehicle: row.vehicle,
      qcNumber: row.qcNumber,
      result: row.result,
      status: row.status,
      statusKey,
      inspector: row.inspector,
      createdTs: row.ts,
      finalizedTs: row.status === "cleared" && row.clearedTs ? row.clearedTs : row.ts,
      day: dayOf(row.ts),
      segments: [...new Set(row.openItems.map((oi) => oi.cat).filter(Boolean))],
      itemCount: row.openItems.length,
      note: row.openItems.map((oi) => String(oi.note || "").trim()).find(Boolean) || "",
      daysInProduction: tracker?.daysInProduction ?? null, // off the sheet as typed
      quote: quote.found
        ? { hrs: quote.totals?.hrs ?? null, usd: quote.totals?.usd ?? null, lineCount: quote.lineCount ?? null }
        : null,
      tracker,
    };
  });
  const byQc = new Map(vehicles.map((v) => [v.qcNumber, v]));

  // ----- KPIs (this range) -----
  const inRangeRows = rows.filter((r) => {
    const d = dayOf(r.ts);
    return d >= from && d <= to;
  });
  const inspectionsCount = inRangeRows.length;
  const failedFirst = inRangeRows.filter((r) => r.result === "fail").length; // first result only
  const failRate = inspectionsCount ? failedFirst / inspectionsCount : null;
  const openRechecks = rows.filter((r) => r.status === "open").length;
  const dips = inRangeRows
    .map((r) => trackerByVin.get(r.vin)?.daysInProduction)
    .filter((d): d is number => d != null);
  const avgDaysInProduction = dips.length ? dips.reduce((a, b) => a + b, 0) / dips.length : null;

  // Cleared in range + avg days from first fail to cleared (both dates required).
  const clearedRows = rows.filter(
    (r) => r.status === "cleared" && r.clearedTs != null && dayOf(r.clearedTs) >= from && dayOf(r.clearedTs) <= to
  );
  const clearDays = clearedRows
    .filter((r) => r.ts)
    .map((r) => (r.clearedTs! - r.ts) / 86_400_000)
    .filter((d) => Number.isFinite(d) && d >= 0);
  const avgFailToClearDays = clearDays.length
    ? clearDays.reduce((a, b) => a + b, 0) / clearDays.length
    : null;

  const kpi = {
    inspections: inspectionsCount,
    firstPass: inspectionsCount - failedFirst,
    failedFirst,
    failRate,
    avgDaysInProduction,
    openRechecks,
    clearedInRange: clearedRows.length,
    avgFailToClearDays,
  };

  // ----- daily: finalQcs from audit_log, intakes from local intakes table -----
  const qcByDay = await db.execute(sql`
    SELECT to_char(at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
    FROM audit_log a
    WHERE action IN ('created', 'recheck_committed')
      AND to_char(at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') BETWEEN ${from} AND ${to}
      AND NOT EXISTS (SELECT 1 FROM inspections i WHERE i.qc_number = a.qc_number AND i.archived)
    GROUP BY 1
  `);
  const qcDayMap = new Map<string, number>();
  for (const r of ((qcByDay as any).rows ?? qcByDay) as any[]) qcDayMap.set(String(r.day), Number(r.n) || 0);
  const intakeDayMap = new Map<string, number>();
  for (const d of stats.days) intakeDayMap.set(d.day, d.intakes);
  const daily = eachDay(from, to).map((day) => ({
    day,
    intakes: intakeDayMap.get(day) ?? 0,
    finalQcs: qcDayMap.get(day) ?? 0,
  }));

  // ----- Daily Tracker: fixed trailing 7 days ending today, range-independent -----
  const today = dayOf(Date.now());
  const d7from = dayOf(Date.now() - 6 * 86_400_000);
  const [stats7, qc7Res] = await Promise.all([
    fetchIntakeStats(d7from, today),
    db.execute(sql`
      SELECT to_char(at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
      FROM audit_log a
      WHERE action IN ('created', 'recheck_committed')
        AND to_char(at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') BETWEEN ${d7from} AND ${today}
        AND NOT EXISTS (SELECT 1 FROM inspections i WHERE i.qc_number = a.qc_number AND i.archived)
      GROUP BY 1
    `),
  ]);
  const qc7Map = new Map<string, number>();
  for (const r of ((qc7Res as any).rows ?? qc7Res) as any[]) qc7Map.set(String(r.day), Number(r.n) || 0);
  const intake7Map = new Map<string, number>();
  for (const d of stats7.days) intake7Map.set(d.day, d.intakes);
  const tracker7Days = eachDay(d7from, today).map((day) => ({
    day,
    intakes: intake7Map.get(day) ?? 0,
    finalQcs: qc7Map.get(day) ?? 0,
  }));
  const tracker7 = {
    days: tracker7Days,
    todayIntakes: intake7Map.get(today) ?? 0,
    todayFinalQcs: qc7Map.get(today) ?? 0,
    weekIntakes: tracker7Days.reduce((a, d) => a + d.intakes, 0),
    weekFinalQcs: tracker7Days.reduce((a, d) => a + d.finalQcs, 0),
  };

  // ----- awaiting Final QC: completed intake, no inspection yet -----
  // A plain join now that intakes are local: every completed intake whose VIN
  // has no inspection row (VINs already normalized trim/upper on both sides).
  // Archived inspections still count as "inspected" here — otherwise an
  // archived unit's completed intake would resurface as Awaiting Final QC.
  const inspectedVins = new Set(allRows.map((r) => r.vin));
  // One card per VIN: prefer a committed intake over an in-progress one; the
  // source list is newest-activity-first, so the first match per VIN wins.
  const byVin = new Map<string, (typeof completedIntakes)[number]>();
  for (const i of completedIntakes) {
    if (inspectedVins.has(i.vin)) continue;
    const cur = byVin.get(i.vin);
    if (!cur || (cur.inProgress && !i.inProgress)) byVin.set(i.vin, i);
  }
  const awaitingBase = [...byVin.values()]
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  // Enrich each In-Take Quotes card with its quote's cover thumb + figures so
  // the Vehicles bucket mirrors the intake app's all-quotes list.
  const awaitingCovers = await fetchQuoteCovers(awaitingBase.map((i) => ({ vin: i.vin, quoteId: i.quoteId })));
  const awaiting = awaitingBase.map((i) => {
    const c = awaitingCovers.get(i.vin);
    return {
      ...i,
      cover: c?.cover ?? null,
      hrs: c?.hrs ?? null,
      usd: c?.usd ?? null,
      lineCount: c?.lineCount ?? 0,
    };
  });

  // ----- byStatus -----
  const byStatus = {
    awaitingFinalQc: awaiting.length,
    openRecheck: openRechecks,
    frontlineReady: vehicles.filter((v) => v.statusKey === "frontlineReady").length,
    released: vehicles.filter((v) => v.statusKey === "released").length,
  };

  // ----- blocked (open re-checks) -----
  const nowTs = Date.now();
  const blocked = vehicles
    .filter((v) => v.status === "open")
    .map((v) => ({
      qcNumber: v.qcNumber,
      stock: v.stock,
      vehicle: v.vehicle,
      vin: v.vin,
      failedAt: v.day,
      daysOpen: Math.max(0, Math.floor((nowTs - v.createdTs) / 86_400_000)),
      segments: v.segments,
      itemCount: v.itemCount,
      note: v.note,
    }))
    .sort((a, b) => b.daysOpen - a.daysOpen);

  // ----- deptFailRate + topFailedItems + byInspector (first inspections in range) -----
  const segVehicles = new Map<string, number>();
  const segItems = new Map<string, number>();
  const itemFails = new Map<string, { segment: string; item: string; count: number }>();
  const inspectors = new Map<string, { name: string; title: string; total: number; fails: number }>();
  for (const r of inRangeRows) {
    const segsHit = new Set<string>();
    for (const f of r.failItems) {
      const seg = String(f.cat || "");
      segsHit.add(seg);
      segItems.set(seg, (segItems.get(seg) || 0) + 1);
      const key = `${seg}|${f.item}`;
      const cur = itemFails.get(key) || { segment: seg, item: String(f.item || ""), count: 0 };
      cur.count++;
      itemFails.set(key, cur);
    }
    for (const seg of segsHit) segVehicles.set(seg, (segVehicles.get(seg) || 0) + 1);
    const name = r.inspector || "Unknown";
    const insp = inspectors.get(name) || { name, title: r.title || "", total: 0, fails: 0 };
    insp.total++;
    if (r.result === "fail") insp.fails++;
    inspectors.set(name, insp);
  }
  const deptFailRate = SEGMENTS.map((seg) => ({
    segment: seg,
    rate: inspectionsCount ? (segVehicles.get(seg) || 0) / inspectionsCount : null,
    failedVehicles: segVehicles.get(seg) || 0,
    failedItems: segItems.get(seg) || 0,
  }));
  const topFailedItems = [...itemFails.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  const byInspector = [...inspectors.values()]
    .sort((a, b) => b.total - a.total)
    .map((i) => ({
      ...i,
      firstPassPct: i.total ? Math.round(((i.total - i.fails) / i.total) * 100) : null,
    }));

  // ----- recent activity (QC commits; intake events live only in the quoter) -----
  const auditRes = await db.execute(sql`
    SELECT qc_number, action, actor_name, extract(epoch from at) * 1000 AS at_ms
    FROM audit_log a
    WHERE action IN ('created', 'recheck_committed')
      AND NOT EXISTS (SELECT 1 FROM inspections i WHERE i.qc_number = a.qc_number AND i.archived)
    ORDER BY at DESC
    LIMIT 30
  `);
  const activity = (((auditRes as any).rows ?? auditRes) as any[]).map((a) => {
    const v = a.qc_number ? byQc.get(String(a.qc_number)) : null;
    return {
      at: Number(a.at_ms),
      action: String(a.action),
      qcNumber: a.qc_number ? String(a.qc_number) : null,
      stock: v?.stock ?? null,
      vehicle: v?.vehicle ?? null,
      actor: String(a.actor_name ?? ""),
    };
  });

  // ----- throughput per week (last 8 weeks, Monday start) -----
  const weeklyRes = await db.execute(sql`
    SELECT to_char(date_trunc('week', at AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS week, COUNT(*)::int AS n
    FROM audit_log a
    WHERE action IN ('created', 'recheck_committed') AND at > now() - interval '8 weeks'
      AND NOT EXISTS (SELECT 1 FROM inspections i WHERE i.qc_number = a.qc_number AND i.archived)
    GROUP BY 1 ORDER BY 1
  `);
  const weekly = (((weeklyRes as any).rows ?? weeklyRes) as any[]).map((r) => ({
    week: String(r.week),
    finalQcs: Number(r.n) || 0,
  }));

  // ----- AI accuracy trend (last 8 weeks, linked by analysis_id) -----
  // Only analyses with a tracked analysis_id are counted; rows without one
  // pre-date this feature and are excluded so the denominator is always
  // reliable (no second-look inflation — the client reuses the same UUID for
  // both the initial call and the second look; ON CONFLICT DO NOTHING on the
  // server keeps only one row per UUID).
  // Corrections are counted in the ANALYSIS week (not the correction week) so
  // cross-week corrections are attributed to the right period.
  // If the ai_analyses table doesn't exist yet (first boot before
  // ensureAccuracySchema runs) the query returns empty rows — no crash.
  // Query ai_analyses only — correction state is stored in the corrected column
  // so accuracy data survives the 500-row learning-cache cleanup on corrections.
  const accuracyRes = await db
    .execute(sql`
      SELECT
        to_char(date_trunc('week', to_timestamp(ts / 1000.0) AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS week,
        COUNT(*)::int AS analyses,
        COUNT(*) FILTER (WHERE corrected)::int AS corrected
      FROM ai_analyses
      WHERE ts > extract(epoch from now() - interval '8 weeks') * 1000
        AND analysis_id IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `)
    .catch(() => ({ rows: [] } as any));
  const accuracyByWk = new Map<string, { analyses: number; corrections: number }>();
  for (const r of ((accuracyRes as any).rows ?? []) as any[]) {
    accuracyByWk.set(String(r.week), {
      analyses: Number(r.analyses) || 0,
      corrections: Number(r.corrected) || 0,
    });
  }
  // Always emit exactly 8 buckets so the client gets a consistent x-axis.
  const aiAccuracy = last8WeekMondays(TZ).map((week) => ({
    week,
    analyses: accuracyByWk.get(week)?.analyses ?? 0,
    corrections: accuracyByWk.get(week)?.corrections ?? 0,
  }));

  // ----- THIS WEEK strip (Monday-start week in TZ, additive/read-only) -----
  // intakes completed, QCs passed/failed (first inspection result this week),
  // and average quoted hours across quotes created this week.
  const [weekIntakesRes, weekQcRes, weekQuoteRes] = await Promise.all([
    db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM intakes
      WHERE completed_at IS NOT NULL
        AND completed_at AT TIME ZONE ${TZ} >= date_trunc('week', now() AT TIME ZONE ${TZ})
    `),
    db.execute(sql`
      SELECT result, COUNT(*)::int AS n
      FROM inspections
      WHERE created_at AT TIME ZONE ${TZ} >= date_trunc('week', now() AT TIME ZONE ${TZ})
        AND NOT archived
      GROUP BY result
    `),
    db.execute(sql`
      SELECT (data->'totals'->>'hrs')::numeric AS hrs
      FROM quotes
      WHERE to_timestamp((data->>'ts')::bigint / 1000.0) AT TIME ZONE ${TZ}
            >= date_trunc('week', now() AT TIME ZONE ${TZ})
        AND (data->'totals'->>'hrs') IS NOT NULL
    `),
  ]);
  const weekIntakesCompleted = Number(((weekIntakesRes as any).rows ?? weekIntakesRes)[0]?.n) || 0;
  let weekQcsPassed = 0;
  let weekQcsFailed = 0;
  for (const r of ((weekQcRes as any).rows ?? weekQcRes) as any[]) {
    const n = Number(r.n) || 0;
    if (String(r.result) === "fail") weekQcsFailed += n;
    else weekQcsPassed += n;
  }
  const weekHrs = (((weekQuoteRes as any).rows ?? weekQuoteRes) as any[])
    .map((r) => Number(r.hrs))
    .filter((h) => Number.isFinite(h));
  const thisWeek = {
    intakesCompleted: weekIntakesCompleted,
    qcsPassed: weekQcsPassed,
    qcsFailed: weekQcsFailed,
    avgQuotedHours: weekHrs.length ? weekHrs.reduce((a, b) => a + b, 0) / weekHrs.length : null,
  };

  return {
    generatedAt: Date.now(),
    range: { from, to },
    trackerSource: sheet ? "live" : "unavailable",
    kpi,
    daily,
    tracker7,
    byStatus,
    awaiting,
    blocked,
    deptFailRate,
    topFailedItems,
    byInspector,
    activity,
    weekly,
    thisWeek,
    aiAccuracy,
    vehicles,
    monthSummary: sheet?.summary ?? null,
  };
}

// ---------- routes ----------

export function registerDashboardRoute(app: Express) {
  app.get("/api/dashboard", requireEmployee, async (req, res, next) => {
    try {
      const today = dayOf(Date.now());
      const to = parseISODay(req.query.to) || today;
      const monthStart = `${today.slice(0, 8)}01`;
      const from = parseISODay(req.query.from) || monthStart;
      if (from > to) return res.status(400).json({ message: "from must be on or before to" });

      const key = `${from}|${to}`;
      const hit = payloadCache.get(key);
      if (hit && Date.now() - hit.at < PAYLOAD_CACHE_MS) return res.json(hit.body);

      // Single-flight per range so a burst of polls builds the payload once.
      let inflight = payloadInFlight.get(key);
      if (!inflight) {
        const genAtStart = cacheGen;
        inflight = buildPayload(from, to)
          .then((body) => {
            // Only cache if nothing invalidated the cache while we were building;
            // otherwise this snapshot is pre-invalidation and must not be reused.
            if (genAtStart === cacheGen) payloadCache.set(key, { at: Date.now(), body });
            if (payloadCache.size > 20) payloadCache.delete(payloadCache.keys().next().value as string);
            return body;
          })
          .finally(() => payloadInFlight.delete(key));
        payloadInFlight.set(key, inflight);
      }
      res.json(await inflight);
    } catch (err) {
      next(err);
    }
  });

  // Full TR-INTAKE-V2 intake record for one VIN (photos, steps, RO-Ready check),
  // for the vehicle card, read from this app's local intakes table.
  // found:false = the intake predates this system.
  app.get("/api/intake/:vin", requireEmployee, async (req, res, next) => {
    try {
      const vin = String(req.params.vin || "").trim().toUpperCase();
      if (vin.length < 6) return res.status(400).json({ message: "Invalid VIN" });
      res.json(await lookupIntakeByVin(vin));
    } catch (err) {
      next(err);
    }
  });
}
