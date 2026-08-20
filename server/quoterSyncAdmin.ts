/**
 * Token-guarded, insert-only sync of Body Quoter data from the OLD Quoter
 * production database (QUOTER_DATABASE_URL, strictly read-only source) into
 * THIS server's own database (whichever environment it runs in).
 *
 * Purpose: the workspace agent cannot write to the production database
 * directly, but the deployed server can — so the sync is driven through this
 * endpoint in small resumable batches.
 *
 * Safety rules (per operator instruction):
 *  - Registered ONLY when env QUOTER_SYNC_TOKEN is set; requests must present
 *    the same token (timing-safe compare). Otherwise 404.
 *  - Insert-only: match on primary key, insert what's missing, NEVER update
 *    or delete an existing destination row.
 *  - Photos are copied in keyset-paginated batches (one short transaction per
 *    batch, cursor returned to the caller) — never one big transaction.
 *  - Order driven by the caller: settings → quotes → corrections → photos → intakes.
 *  - Never touches inspections or employees.
 *  - `tracker_snapshot` phase: re-reads one month from the VPC sheet via
 *    snapshotMonth (delete-then-insert for that month — re-running IS the
 *    correction path).
 *  - `tracker` phase: insert-only push of frozen snapshot rows sent in the
 *    request body (source is the workspace/dev DB); frozen months are copied
 *    verbatim and never overwritten.
 *  - `correct_stock` phase: narrow metadata correction for one exact VIN +
 *    old-stock pair. Updates the canonical intake and linked quote together,
 *    writes an audit row, and never rewrites immutable pricing snapshots.
 */
import type { Express, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import pg from "pg";
import { pool } from "./db";
import { snapshotMonth } from "./tracker";

const { Pool } = pg;
const PHOTO_BATCH = 25;
const SETTINGS_SKIP = ["_secret", "_import_v1"];

let srcPool: pg.Pool | null = null;
function src(): pg.Pool {
  if (!srcPool) {
    srcPool = new Pool({
      connectionString: process.env.QUOTER_DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 15_000,
    });
  }
  return srcPool;
}

function tokenOk(req: Request): boolean {
  const expected = process.env.QUOTER_SYNC_TOKEN;
  const got = req.header("x-sync-token");
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

function committedByFromData(data: unknown): string | null {
  if (data && typeof data === "object") {
    const est = (data as Record<string, unknown>).estimator;
    if (typeof est === "string" && est.trim() !== "") return est.trim();
  }
  return null;
}

async function destQuery(text: string, params: unknown[] = []) {
  // This app's own database pool (production DB when deployed).
  return pool.query(text, params as any[]);
}

export function registerQuoterSyncAdminRoute(app: Express): void {
  if (!process.env.QUOTER_SYNC_TOKEN || !process.env.QUOTER_DATABASE_URL) return;

  app.post("/api/quoter/admin/sync", async (req: Request, res: Response) => {
    if (!tokenOk(req)) return res.status(404).end();
    const phase = String(req.body?.phase || "");
    try {
      if (phase === "counts") {
        const tables = ["settings", "quotes", "corrections", "photos", "intakes"];
        const out: Record<string, { source: number; dest: number }> = {};
        for (const t of tables) {
          const s = await src().query(`SELECT COUNT(*)::bigint AS n FROM ${t}`);
          const d = await destQuery(`SELECT COUNT(*)::bigint AS n FROM ${t}`);
          out[t] = { source: Number(s.rows[0].n), dest: Number(d.rows[0].n) };
        }
        const sb = await src().query(
          `SELECT COALESCE(SUM(octet_length(data)),0)::bigint AS n FROM photos`,
        );
        const dbb = await destQuery(
          `SELECT COALESCE(SUM(octet_length(data)),0)::bigint AS n FROM photos`,
        );
        return res.json({ counts: out, photoBytes: { source: Number(sb.rows[0].n), dest: Number(dbb.rows[0].n) } });
      }

      if (phase === "settings") {
        const rows = (await src().query(`SELECT key, value, updated_at FROM settings`)).rows;
        let inserted = 0, present = 0, skipped = 0;
        for (const r of rows) {
          if (SETTINGS_SKIP.includes(r.key)) { skipped++; continue; }
          const q = await destQuery(
            `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO NOTHING`,
            [r.key, JSON.stringify(r.value), r.updated_at],
          );
          q.rowCount ? inserted++ : present++;
        }
        return res.json({ phase, read: rows.length, inserted, alreadyPresent: present, skipped });
      }

      if (phase === "quotes") {
        const rows = (await src().query(`SELECT id, data, updated_at FROM quotes ORDER BY id`)).rows;
        let inserted = 0, present = 0;
        for (const r of rows) {
          const q = await destQuery(
            `INSERT INTO quotes (id, data, updated_at, committed_by) VALUES ($1, $2, $3, $4)
             ON CONFLICT (id) DO NOTHING`,
            [r.id, JSON.stringify(r.data), r.updated_at, committedByFromData(r.data)],
          );
          q.rowCount ? inserted++ : present++;
        }
        return res.json({ phase, read: rows.length, inserted, alreadyPresent: present });
      }

      if (phase === "corrections") {
        const rows = (await src().query(`SELECT ts, diffs FROM corrections ORDER BY id`)).rows;
        let inserted = 0, present = 0;
        for (const r of rows) {
          const q = await destQuery(
            `INSERT INTO corrections (ts, diffs)
             SELECT $1::bigint, $2::jsonb
             WHERE NOT EXISTS (
               SELECT 1 FROM corrections c WHERE c.ts = $1::bigint AND c.diffs = $2::jsonb
             )`,
            [r.ts, JSON.stringify(r.diffs)],
          );
          q.rowCount ? inserted++ : present++;
        }
        return res.json({ phase, read: rows.length, inserted, alreadyPresent: present });
      }

      if (phase === "photos") {
        const cursor = typeof req.body?.cursor === "string" ? req.body.cursor : "";
        const batch = (
          await src().query(
            `SELECT id, quote_id, slot, mime, data, ts FROM photos
             WHERE id > $1 ORDER BY id LIMIT $2`,
            [cursor, PHOTO_BATCH],
          )
        ).rows;
        if (batch.length === 0) return res.json({ phase, read: 0, inserted: 0, done: true });

        const client = await pool.connect();
        let inserted = 0;
        try {
          await client.query("BEGIN");
          for (const p of batch) {
            const q = await client.query(
              `INSERT INTO photos (id, quote_id, slot, mime, data, ts)
               VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
              [p.id, p.quote_id, p.slot, p.mime, p.data, p.ts],
            );
            if (q.rowCount) inserted++;
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
        return res.json({
          phase,
          read: batch.length,
          inserted,
          alreadyPresent: batch.length - inserted,
          nextCursor: batch[batch.length - 1].id,
          done: batch.length < PHOTO_BATCH,
        });
      }

      if (phase === "intakes") {
        const rows = (
          await src().query(
            `SELECT id, vin, stock, vehicle, miles, estimator, quote_id, data, completed_at, updated_at FROM intakes`,
          )
        ).rows;
        let inserted = 0, present = 0;
        for (const r of rows) {
          const committedBy = r.estimator && r.estimator.trim() !== "" ? r.estimator.trim() : null;
          const q = await destQuery(
            `INSERT INTO intakes
               (id, vin, stock, vehicle, miles, estimator, quote_id, data, completed_at, updated_at, committed_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (id) DO NOTHING`,
            [r.id, r.vin, r.stock ?? "", r.vehicle ?? "", r.miles ?? "", r.estimator ?? "",
             r.quote_id, JSON.stringify(r.data), r.completed_at, r.updated_at, committedBy],
          );
          q.rowCount ? inserted++ : present++;
        }
        return res.json({ phase, read: rows.length, inserted, alreadyPresent: present });
      }

      if (phase === "intake_backfill") {
        // One-time backfill: the old Quoter app never had intake rows — its
        // quotes ARE the intakes. Derive one completed intake per distinct
        // VIN from THIS server's quotes table (latest quote wins), insert-only:
        // VINs that already have any intake row are skipped, so real intakes
        // made in this app are never touched. Marked in notes as imported.
        const rows = (
          await destQuery(
            `SELECT DISTINCT ON (UPPER(TRIM(data->>'vin')))
                    id, data, updated_at
             FROM quotes
             WHERE LENGTH(TRIM(COALESCE(data->>'vin',''))) >= 6
             ORDER BY UPPER(TRIM(data->>'vin')), updated_at DESC NULLS LAST, id DESC`,
          )
        ).rows;
        let inserted = 0, skippedExistingVin = 0;
        const intakeData = JSON.stringify({
          steps: { "1": [], "2": [], "3": [], "4": [] },
          roReady: [true, true, true, true, true, true, true, true, true],
          photoCount: 0,
          notes: "Imported from old Body Quoter",
          mddTags: false,
        });
        for (const r of rows) {
          const d = r.data || {};
          const vin = String(d.vin || "").trim().toUpperCase();
          const veh = d.veh && typeof d.veh === "object" ? d.veh : {};
          const vehicle = [veh.year, veh.make, veh.model].filter(Boolean).join(" ").slice(0, 120);
          const completedAt = d.dateISO ? new Date(String(d.dateISO)) : r.updated_at;
          const q = await destQuery(
            `INSERT INTO intakes
               (id, vin, stock, vehicle, miles, estimator, quote_id, data, completed_at, updated_at, committed_by)
             SELECT $1,$2,$3,$4,'',$5,$6,$7::jsonb,$8,$9,$10
             WHERE NOT EXISTS (SELECT 1 FROM intakes WHERE UPPER(TRIM(vin)) = $2)`,
            [
              `imp-${r.id}`.slice(0, 60), vin, String(d.stock || "").slice(0, 40), vehicle,
              String(d.estimator || "").slice(0, 40), r.id, intakeData,
              completedAt, r.updated_at ?? completedAt,
              d.estimator ? String(d.estimator).slice(0, 40) : null,
            ],
          );
          q.rowCount ? inserted++ : skippedExistingVin++;
        }
        return res.json({ phase, distinctVins: rows.length, inserted, skippedExistingVin });
      }

      if (phase === "correct_stock") {
        const vin = String(req.body?.vin || "").trim().toUpperCase();
        const oldStock = String(req.body?.oldStock || "").trim().toUpperCase();
        const newStock = String(req.body?.newStock || "").trim().toUpperCase();
        const stockPattern = /^[A-Z0-9-]{1,40}$/;
        if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
          return res.status(400).json({ message: "A valid 17-character VIN is required" });
        }
        if (!stockPattern.test(oldStock) || !stockPattern.test(newStock) || oldStock === newStock) {
          return res.status(400).json({ message: "Distinct valid oldStock and newStock values are required" });
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const matches = await client.query(
            `SELECT id, vin, stock, quote_id
             FROM intakes
             WHERE UPPER(vin) = $1 AND UPPER(stock) = $2
             FOR UPDATE`,
            [vin, oldStock],
          );
          if (matches.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: matches.rowCount === 0
                ? "No intake matches that VIN and old stock"
                : "Multiple intakes match; correction refused",
            });
          }

          const intake = matches.rows[0];
          const conflicts = await client.query(
            `SELECT 1
             FROM intakes
             WHERE UPPER(stock) = $1 AND id <> $2
             UNION ALL
             SELECT 1
             FROM quotes
             WHERE UPPER(COALESCE(data->>'stock', '')) = $1 AND id <> COALESCE($3, '')
             LIMIT 1`,
            [newStock, intake.id, intake.quote_id],
          );
          if (conflicts.rowCount) {
            await client.query("ROLLBACK");
            return res.status(409).json({ message: "The replacement stock number is already in use" });
          }

          let quoteUpdated = false;
          if (intake.quote_id) {
            const quote = await client.query(
              `SELECT id, data->>'stock' AS stock
               FROM quotes
               WHERE id = $1
               FOR UPDATE`,
              [intake.quote_id],
            );
            if (quote.rowCount !== 1) {
              await client.query("ROLLBACK");
              return res.status(409).json({ message: "The linked quote could not be found" });
            }
            const quoteStock = String(quote.rows[0].stock || "").trim().toUpperCase();
            if (quoteStock !== oldStock && quoteStock !== newStock) {
              await client.query("ROLLBACK");
              return res.status(409).json({ message: "The linked quote has a different stock number" });
            }
            if (quoteStock === oldStock) {
              await client.query(
                `UPDATE quotes
                 SET data = jsonb_set(data, '{stock}', to_jsonb($1::text), true),
                     updated_at = NOW()
                 WHERE id = $2`,
                [newStock, intake.quote_id],
              );
              quoteUpdated = true;
            }
          }

          await client.query(
            `UPDATE intakes SET stock = $1, updated_at = NOW() WHERE id = $2`,
            [newStock, intake.id],
          );
          const snapshots = await client.query(
            `SELECT COUNT(*)::int AS count
             FROM quote_snapshots
             WHERE intake_id = $1 OR quote_id = $2`,
            [intake.id, intake.quote_id],
          );
          const immutableSnapshots = Number(snapshots.rows[0]?.count || 0);
          await client.query(
            `INSERT INTO audit_log
               (action, actor_id, actor_email, actor_name, details)
             VALUES
               ('stock_corrected', 'replit-agent', 'system@truckranch.com', 'Replit Agent',
                $1::jsonb)`,
            [JSON.stringify({
              vin,
              intakeId: intake.id,
              quoteId: intake.quote_id || null,
              oldStock,
              newStock,
              quoteUpdated,
              immutableSnapshotsUntouched: immutableSnapshots,
            })],
          );
          await client.query("COMMIT");
          return res.json({
            phase,
            vin,
            intakeId: intake.id,
            quoteId: intake.quote_id || null,
            oldStock,
            newStock,
            quoteUpdated,
            immutableSnapshotsUntouched: immutableSnapshots,
          });
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      }

      if (phase === "spotcheck") {
        // 5 random source quotes: VIN, line count, hours, total — source vs dest.
        const rows = (
          await src().query(`SELECT id, data FROM quotes ORDER BY random() LIMIT 5`)
        ).rows;
        const out = [];
        for (const r of rows) {
          const d = (await destQuery(`SELECT data FROM quotes WHERE id = $1`, [r.id])).rows[0];
          const pick = (data: any) => ({
            vin: data?.vin ?? null,
            lines: Array.isArray(data?.lines) ? data.lines.length : 0,
            hrs: data?.totals?.hrs ?? null,
            usd: data?.totals?.usd ?? null,
          });
          out.push({
            id: r.id,
            source: pick(r.data),
            dest: d ? pick(d.data) : null,
            dataEqual: d ? JSON.stringify(d.data) === JSON.stringify(r.data) : false,
          });
        }
        return res.json({ phase, quotes: out });
      }

      if (phase === "tracker_snapshot") {
        // Freeze one month tab from the VPC Production Tracker sheet into
        // THIS server's production_tracker via the canonical snapshotMonth
        // helper (delete-then-insert for that month in one transaction —
        // re-running is the correction path). Values stored exactly as typed
        // in the sheet; never recomputed. Touches ONLY production_tracker.
        const month = String(req.body?.month || "").trim();
        if (!month) return res.status(400).json({ message: "month is required (e.g. 'Jul 2026')" });
        const result = await snapshotMonth(month);
        return res.json({ phase, ...result });
      }

      if (phase === "tracker") {
        // Insert-only copy of frozen production_tracker snapshot rows, pushed
        // by the caller (source of truth is the workspace/dev DB). Values are
        // stored exactly as sent — never recomputed from the sheet.
        const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
        if (!rows) return res.status(400).json({ message: "rows array is required" });
        let inserted = 0, present = 0;
        for (const r of rows) {
          const vin = String(r?.vin ?? "").trim().toUpperCase();
          const month = String(r?.month ?? "").trim();
          if (!vin || !month) return res.status(400).json({ message: "each row needs vin and month" });
          const q = await destQuery(
            `INSERT INTO production_tracker (vin, month, retail_plan_usd, closed_ro_usd, days_to_close, snapshot_at)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (vin, month) DO NOTHING`,
            [vin, month, r.retailPlanUsd ?? null, r.closedRoUsd ?? null, r.daysToClose ?? null, r.snapshotAt ?? null],
          );
          q.rowCount ? inserted++ : present++;
        }
        return res.json({ phase, read: rows.length, inserted, alreadyPresent: present });
      }

      if (phase === "tracker-counts") {
        const d = await destQuery(
          `SELECT month, COUNT(*)::int AS rows,
                  to_char(MAX(snapshot_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS snapshot_at
           FROM production_tracker GROUP BY month ORDER BY month`,
        );
        return res.json({ phase, months: d.rows });
      }

      return res.status(400).json({ message: `Unknown phase: ${phase}` });
    } catch (err) {
      console.error("quoter sync error:", err);
      return res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });
}
