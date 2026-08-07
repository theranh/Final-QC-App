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
import { productionTracker, auditLog, type Employee } from "@shared/schema";
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

export type SnapshotResult = { month: string; rows: number; snapshotAt: string };

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
export async function snapshotMonth(month: string): Promise<SnapshotResult> {
  const tab = month.trim();
  if (!tab) throw new Error("month is required (e.g. 'Jul 2026')");

  const values = await readTrackerRange(
    tab,
    `A${TABLE_FIRST_DATA_ROW}:G${TABLE_FIRST_DATA_ROW + MAX_DATA_ROWS}`
  );
  if (values == null) {
    throw new Error("Google Sheets is not configured — cannot snapshot the tracker.");
  }

  // A VIN · E Retail Plan $ · F Closed RO $ · G Days Pic-to-Close.
  const seen = new Set<string>();
  const rows: {
    vin: string;
    month: string;
    retailPlanUsd: string | null;
    closedRoUsd: string | null;
    daysToClose: number | null;
  }[] = [];
  for (const r of values) {
    const vin = String(r?.[0] ?? "").trim().toUpperCase();
    if (!vin || seen.has(vin)) continue; // first occurrence wins; skip blanks
    seen.add(vin);
    const retail = parseMoney(r?.[4]); // col E
    const closed = parseMoney(r?.[5]); // col F
    const days = parseInt10(r?.[6]); // col G
    rows.push({
      vin,
      month: tab,
      // numeric columns take strings via drizzle to preserve exact precision.
      retailPlanUsd: retail == null ? null : String(retail),
      closedRoUsd: closed == null ? null : String(closed),
      daysToClose: days,
    });
  }

  const snapshotAt = await db.transaction(async (tx) => {
    await tx.delete(productionTracker).where(eq(productionTracker.month, tab));
    const at = new Date();
    if (rows.length) {
      await tx.insert(productionTracker).values(rows.map((r) => ({ ...r, snapshotAt: at })));
    }
    return at;
  });

  return { month: tab, rows: rows.length, snapshotAt: snapshotAt.toISOString() };
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
      if (!month) return res.status(400).json({ message: "month is required (e.g. 'Jul 2026')" });
      const result = await snapshotMonth(month);
      const emp: Employee = req.employee;
      await db.insert(auditLog).values({
        action: "tracker_snapshot",
        actorId: emp.userId || String(emp.id),
        actorEmail: emp.email,
        actorName: emp.name,
        details: { month: result.month, rows: result.rows },
      });
      res.json(result);
    } catch (err: any) {
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
