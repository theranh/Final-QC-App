// Production Tracker snapshots — "freeze closed months from the spreadsheet".
//
// The VPC Production Tracker sheet is a live document. Once a month closes we
// take a one-time snapshot of the three money/time columns that matter for
// reporting and store them in production_tracker, keyed by (vin, month). Closed
// months are then read from that frozen table; the current month stays live
// from the sheet (see server/dashboard.ts).
//
// Values are stored EXACTLY as typed in the sheet — never recomputed. We parse
// "$1,234" → 1234 and blank → NULL, and that is the only transformation. The
// table intentionally stores only Retail Plan $, Closed RO $, and Days
// Pic-to-Close; variance is NOT stored and is never re-derived for frozen
// months (a computed closed − retail would violate "stored exactly as typed").
import type { Express } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { productionTracker, productionTrackerArchive, auditLog, type Employee } from "@shared/schema";
import { requireAdmin } from "./access";
import { readTrackerRange } from "./googleSheets";

const TABLE_FIRST_DATA_ROW = 21; // row 20 is the tracker's table header
const MAX_DATA_ROWS = 2000;

/** Parse "$1,234.50" → 1234.5; blank/non-numeric → null. Stored as typed. */
function parseMoney(v: unknown): number | null {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse an integer day count; blank/non-numeric → null. */
function parseInt10(v: unknown): number | null {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export type SnapshotResult = {
  month: string;
  rows: number;
  snapshotAt: string;
  previousRows: number;
  archived: boolean;
};

/**
 * Guard against a suspicious re-snapshot silently replacing valid history:
 * an empty read, or one materially smaller (< half) than what is already
 * frozen, is refused unless the admin explicitly forces it.
 * Pure — unit-tested in tracker.test.ts.
 */
export function snapshotGuard(
  existingCount: number,
  newCount: number,
  force: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (force || existingCount <= 0) return { ok: true };
  if (newCount === 0) {
    return {
      ok: false,
      reason: `The sheet read returned 0 rows but ${existingCount} rows are already frozen for this month — refusing to erase them. Check the tab name/sheet, or force the overwrite if this is intentional.`,
    };
  }
  if (newCount * 2 < existingCount) {
    return {
      ok: false,
      reason: `The sheet read returned only ${newCount} rows but ${existingCount} rows are already frozen for this month — refusing a suspiciously smaller overwrite. Check the sheet, or force the overwrite if this is intentional.`,
    };
  }
  return { ok: true };
}

/** Error type the route maps to a 409 with guard context. */
export class SnapshotGuardError extends Error {
  previousRows: number;
  newRows: number;
  constructor(reason: string, previousRows: number, newRows: number) {
    super(reason);
    this.name = "SnapshotGuardError";
    this.previousRows = previousRows;
    this.newRows = newRows;
  }
}

/**
 * Read one month tab and freeze its rows into production_tracker.
 *
 * Delete-then-insert for the month in a single transaction: re-running the
 * same month overwrites every row and refreshes snapshot_at — that IS the
 * correction path. Only VINs currently in the sheet survive.
 *
 * Throws if Google Sheets is not configured (readTrackerRange → null) so the
 * caller sees a clear error rather than silently freezing nothing.
 */
export async function snapshotMonth(month: string, opts: { force?: boolean } = {}): Promise<SnapshotResult> {
  const tab = month.trim();
  if (!tab) throw new Error("month is required (e.g. 'Jul 2026')");

  const values = await readTrackerRange(
    tab,
    `A${TABLE_FIRST_DATA_ROW}:G${TABLE_FIRST_DATA_ROW + MAX_DATA_ROWS}`
  );
  if (values == null) {
    throw new Error("Google Sheets is not configured — cannot snapshot the tracker.");
  }

  // A VIN · B RO Open Date · E Retail Plan $ · F Closed RO $ · G Days Pic-to-Close.
  const seen = new Set<string>();
  const rows: {
    vin: string;
    month: string;
    retailPlanUsd: string | null;
    closedRoUsd: string | null;
    daysToClose: number | null;
    roOpen: string | null;
  }[] = [];
  for (const r of values) {
    const vin = String(r?.[0] ?? "").trim().toUpperCase();
    if (!vin || seen.has(vin)) continue; // first occurrence wins; skip blanks
    seen.add(vin);
    const retail = parseMoney(r?.[4]); // col E
    const closed = parseMoney(r?.[5]); // col F
    const days = parseInt10(r?.[6]); // col G
    // Col B RO Open Date: preserved verbatim (never parsed/recomputed) so
    // future arrival-to-frontline reporting has the raw sheet value.
    const roOpen = String(r?.[1] ?? "").trim().slice(0, 40) || null;
    rows.push({
      vin,
      month: tab,
      // numeric columns take strings via drizzle to preserve exact precision.
      retailPlanUsd: retail == null ? null : String(retail),
      closedRoUsd: closed == null ? null : String(closed),
      daysToClose: days,
      roOpen,
    });
  }

  const { snapshotAt, previousRows } = await db.transaction(async (tx) => {
    // Serialize per month: two concurrent re-snapshots of the same month
    // would otherwise both read the pre-replace count (guard on stale data)
    // and double-archive the same rows.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"tracker_snapshot:" + tab})::bigint)`);
    // Count what's already frozen (inside the transaction so a concurrent
    // re-run can't slip between check and replace).
    const cnt = await tx.execute(
      sql`SELECT COUNT(*)::int AS n FROM production_tracker WHERE month = ${tab}`,
    );
    const existing = Number((cnt.rows?.[0] as any)?.n ?? 0);

    const verdict = snapshotGuard(existing, rows.length, !!opts.force);
    if (!verdict.ok) throw new SnapshotGuardError(verdict.reason, existing, rows.length);

    // Preserve the rows being replaced — corrections stay reversible.
    if (existing > 0) {
      await tx.execute(sql`
        INSERT INTO production_tracker_archive
          (vin, month, retail_plan_usd, closed_ro_usd, days_to_close, ro_open, snapshot_at)
        SELECT vin, month, retail_plan_usd, closed_ro_usd, days_to_close, ro_open, snapshot_at
        FROM production_tracker WHERE month = ${tab}
      `);
    }

    await tx.delete(productionTracker).where(eq(productionTracker.month, tab));
    const at = new Date();
    if (rows.length) {
      await tx.insert(productionTracker).values(rows.map((r) => ({ ...r, snapshotAt: at })));
    }
    return { snapshotAt: at, previousRows: existing };
  });

  return {
    month: tab,
    rows: rows.length,
    snapshotAt: snapshotAt.toISOString(),
    previousRows,
    archived: previousRows > 0,
  };
}

/** Rows for a frozen month, keyed by VIN. Empty map when nothing is snapshotted. */
export type FrozenRow = {
  retailPlanUsd: number | null;
  closedRoUsd: number | null;
  daysToClose: number | null;
  snapshotAt: string | null;
};

export async function frozenMonth(month: string): Promise<Map<string, FrozenRow>> {
  const tab = month.trim();
  const out = new Map<string, FrozenRow>();
  if (!tab) return out;
  const rows = await db
    .select()
    .from(productionTracker)
    .where(eq(productionTracker.month, tab));
  for (const r of rows) {
    out.set(String(r.vin).trim().toUpperCase(), {
      retailPlanUsd: r.retailPlanUsd == null ? null : Number(r.retailPlanUsd),
      closedRoUsd: r.closedRoUsd == null ? null : Number(r.closedRoUsd),
      daysToClose: r.daysToClose == null ? null : Number(r.daysToClose),
      snapshotAt: r.snapshotAt ? new Date(r.snapshotAt).toISOString() : null,
    });
  }
  return out;
}

/** Months that have a snapshot, with row counts and latest snapshot_at. */
export async function listSnapshots(): Promise<
  { month: string; rows: number; snapshotAt: string | null }[]
> {
  const res = await db.execute(sql`
    SELECT month,
           COUNT(*)::int AS rows,
           to_char(MAX(snapshot_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS snapshot_at
    FROM production_tracker
    GROUP BY month
    ORDER BY MAX(snapshot_at) DESC
  `);
  return (((res as any).rows ?? res) as any[]).map((r) => ({
    month: String(r.month),
    rows: Number(r.rows) || 0,
    snapshotAt: r.snapshot_at ? String(r.snapshot_at) : null,
  }));
}

// ---------- routes ----------

export function registerTrackerRoutes(app: Express) {
  // Freeze a closed month. Re-running overwrites the month's rows (correction).
  app.post("/api/tracker/snapshot", requireAdmin, async (req: any, res, next) => {
    try {
      const month = String(req.body?.month ?? "").trim();
      const force = req.body?.force === true;
      if (!month) return res.status(400).json({ message: "month is required (e.g. 'Jul 2026')" });
      const result = await snapshotMonth(month, { force });
      const emp: Employee = req.employee;
      await db.insert(auditLog).values({
        action: "tracker_snapshot",
        actorId: emp.userId || String(emp.id),
        actorEmail: emp.email,
        actorName: emp.name,
        details: { month: result.month, rows: result.rows, previousRows: result.previousRows, force },
      });
      res.json(result);
    } catch (err: any) {
      if (err instanceof SnapshotGuardError) {
        return res.status(409).json({
          message: err.message,
          guard: true,
          previousRows: err.previousRows,
          newRows: err.newRows,
        });
      }
      // A Sheets-config / read failure is a bad-gateway condition, not a 500.
      if (/not configured|Reading tab/i.test(String(err?.message || ""))) {
        return res.status(502).json({ message: String(err.message) });
      }
      next(err);
    }
  });

  // List snapshotted months so the admin UI can show current state.
  app.get("/api/tracker/snapshots", requireAdmin, async (_req, res, next) => {
    try {
      res.json({ snapshots: await listSnapshots() });
    } catch (err) {
      next(err);
    }
  });
}
