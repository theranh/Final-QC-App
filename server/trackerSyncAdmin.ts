/**
 * Token-guarded, insert-only copy of frozen production_tracker snapshot rows
 * into this server's own database (whichever environment it runs in).
 *
 * Safety rules:
 *  - Registered ONLY when env QUOTER_SYNC_TOKEN is set.
 *  - Insert-only: ON CONFLICT (vin, month) DO NOTHING — frozen rows are never
 *    overwritten or recomputed.
 *  - Rows are pushed in the request body (source is the workspace/dev database,
 *    not the old Quoter DB). The caller reads from dev and POSTs here.
 */
import type { Express, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "./db";

function tokenOk(req: Request): boolean {
  const expected = process.env.QUOTER_SYNC_TOKEN;
  const got = req.header("x-sync-token");
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function destQuery(text: string, params: unknown[] = []) {
  return pool.query(text, params as any[]);
}

export function registerTrackerSyncAdminRoute(app: Express): void {
  if (!process.env.QUOTER_SYNC_TOKEN) return;

  // Count frozen months already present in this environment's database.
  app.post("/api/tracker/admin/sync-counts", async (req: Request, res: Response) => {
    if (!tokenOk(req)) return res.status(404).end();
    try {
      const d = await destQuery(
        `SELECT month, COUNT(*)::int AS rows,
                to_char(MAX(snapshot_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS snapshot_at
         FROM production_tracker GROUP BY month ORDER BY month`,
      );
      return res.json({ months: (d as any).rows ?? d });
    } catch (err) {
      console.error("tracker sync counts error:", err);
      return res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  // Insert frozen snapshot rows. Rows already present (same VIN + month) are
  // skipped — frozen values are never overwritten.
  app.post("/api/tracker/admin/sync", async (req: Request, res: Response) => {
    if (!tokenOk(req)) return res.status(404).end();
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
      if (!rows) return res.status(400).json({ message: "rows array is required" });

      let inserted = 0;
      let present = 0;
      for (const r of rows) {
        const vin = String(r?.vin ?? "").trim().toUpperCase();
        const month = String(r?.month ?? "").trim();
        if (!vin || !month) {
          return res.status(400).json({ message: "each row needs vin and month" });
        }
        const q = await destQuery(
          `INSERT INTO production_tracker
             (vin, month, retail_plan_usd, closed_ro_usd, days_to_close, snapshot_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (vin, month) DO NOTHING`,
          [
            vin,
            month,
            r.retailPlanUsd ?? null,
            r.closedRoUsd ?? null,
            r.daysToClose ?? null,
            r.snapshotAt ?? null,
          ],
        );
        (q as any).rowCount ? inserted++ : present++;
      }
      return res.json({ read: rows.length, inserted, alreadyPresent: present });
    } catch (err) {
      console.error("tracker sync error:", err);
      return res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });
}
