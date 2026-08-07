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
 *  - Never touches inspections, employees, or production_tracker.
 */
import type { Express, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import pg from "pg";
import { pool } from "./db";

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

      return res.status(400).json({ message: `Unknown phase: ${phase}` });
    } catch (err) {
      console.error("quoter sync error:", err);
      return res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });
}
