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
 *  - `repair_a23137_photo_slots` phase: one audited, idempotent correction for
 *    the known A23137 guided-photo route mismatch. It only relabels the exact
 *    existing photo rows; image bytes and timestamps are never changed.
 *  - `repair_bc23139_photo_link` phase: one audited, idempotent correction for
 *    the duplicate Tacoma intake whose newer committed row lost the link to
 *    its only verified quote/photo gallery. It changes no quote or photo data.
 *  - `repair_bc23115_sideways_photo` phase: accepts one pre-inspected,
 *    left-turned JPEG at a time. A fixed id/slot/timestamp allowlist prevents
 *    the operation from touching newer retakes or the six already-upright rows.
 *  - `photo_batch` phase: token-guarded, read-only export of selected photo
 *    bytes for an operator audit.
 *  - `repair_photo_orientation` phase: one exact, audited replacement for a
 *    manually confirmed photo, guarded by its current id/slot/timestamp and
 *    owner intake. The server rotates its locked source and retains a backup.
 *  - `rollback_photo_orientation` phase: restores that retained original only
 *    when the repaired bytes and timestamp still match the audited result.
 */
import type { Express, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { pool } from "./db";
import { snapshotMonth } from "./tracker";
import { inferPhotoRole } from "@shared/photoRoles";
import {
  BC23115_ORIENTATION_REPAIR,
  decodeBc23115Replacement,
  getBc23115RepairPhoto,
  rotateStoredJpeg,
  type PhotoTurn,
} from "./bc23115PhotoRepair";

const { Pool } = pg;
const PHOTO_BATCH = 25;
const SETTINGS_SKIP = ["_secret", "_import_v1"];
const A23137_PHOTO_REPAIR = {
  repairKey: "a23137-guided-photo-route-v1",
  stock: "A23137",
  vin: "1FTFW1E52NFB62557",
  intakeId: "in1787316303068duqe",
  quoteId: "q1787316310269inp5",
  moves: [
    // The eight wheel/tire captures were taken first, while the old hidden
    // route was assigning the six interior slots and then the first wheel pair.
    ["int_driver", "whl_lf"],
    ["int_dash", "trd_lf"],
    ["int_console", "whl_lr"],
    ["int_rear_d", "trd_lr"],
    ["int_rear_p", "whl_rr"],
    ["int_passenger", "trd_rr"],
    ["whl_lf", "whl_rf"],
    ["trd_lf", "trd_rf"],
    // The best six interior views are promoted from the later wheel/extra rows.
    ["whl_lr", "int_driver"],
    ["trd_lr", "int_dash"],
    ["whl_rr", "int_console"],
    ["xtra_1787316507812ym4c", "int_rear_d"],
    ["xtra_1787316495928bhh2", "int_rear_p"],
    ["xtra_1787316515476ngjm", "int_passenger"],
    // Preserve the three displaced detail shots as the same three extras.
    ["trd_rr", "xtra_1787316495928bhh2"],
    ["whl_rf", "xtra_1787316507812ym4c"],
    ["trd_rf", "xtra_1787316515476ngjm"],
  ] as const,
};
const BC23139_PHOTO_LINK_REPAIR = {
  repairKey: "bc23139-intake-photo-link-v1",
  vin: "3TMCZ5AN7PM564911",
  stock: "BC23139",
  miles: "98903",
  targetIntakeId: "in17872487015441szr",
  sourceIntakeId: "in1787241427970g3w6",
  quoteId: "q17872414337397s4t",
  committedBy: "Brandon",
  expectedPhotos: 32,
  expectedWalk: 29,
  expectedDamage: 3,
} as const;

function canonicalPhotoId(quoteId: string, slot: string): string {
  return slot.startsWith("xtra_")
    ? `${quoteId}_x${slot.slice("xtra_".length)}`
    : `${quoteId}_${slot}`;
}

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

      if (phase === "photo_batch") {
        const quoteIds = Array.isArray(req.body?.quoteIds)
          ? req.body.quoteIds
              .filter((id: unknown): id is string => typeof id === "string" && id.length <= 120)
              .slice(0, 25)
          : [];
        if (!quoteIds.length) return res.status(400).json({ message: "quoteIds are required" });
        const cursor = typeof req.body?.cursor === "string" ? req.body.cursor.slice(0, 160) : "";
        const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 10);
        const rows = (
          await destQuery(
            `SELECT id, quote_id, slot, role, mime, ts,
                    translate(encode(data, 'base64'), chr(10) || chr(13), '') AS data_base64
             FROM photos
             WHERE quote_id = ANY($1::text[]) AND id > $2
             ORDER BY id
             LIMIT $3`,
            [quoteIds, cursor, limit],
          )
        ).rows;
        return res.json({
          phase,
          photos: rows.map((row: any) => ({
            id: row.id,
            quoteId: row.quote_id,
            slot: row.slot,
            role: row.role,
            mime: row.mime,
            ts: row.ts,
            dataBase64: row.data_base64,
          })),
          nextCursor: rows.length ? rows[rows.length - 1].id : null,
          done: rows.length < limit,
        });
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
              `INSERT INTO photos (id, quote_id, slot, role, mime, data, ts)
               VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
              [p.id, p.quote_id, p.slot, inferPhotoRole(p.slot), p.mime, p.data, p.ts],
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

      if (phase === "repair_a23137_photo_slots") {
        const repair = A23137_PHOTO_REPAIR;
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            [repair.repairKey],
          );

          const priorAudit = await client.query(
            `SELECT 1
             FROM audit_log
             WHERE action = 'photo_slots_corrected'
               AND details->>'repairKey' = $1
             LIMIT 1`,
            [repair.repairKey],
          );
          if (priorAudit.rowCount) {
            await client.query("COMMIT");
            return res.json({
              phase,
              repairKey: repair.repairKey,
              alreadyApplied: true,
              moved: 0,
            });
          }

          const intake = await client.query(
            `SELECT id, vin, stock, quote_id
             FROM intakes
             WHERE id = $1
               AND UPPER(vin) = $2
               AND UPPER(stock) = $3
               AND quote_id = $4
             FOR UPDATE`,
            [repair.intakeId, repair.vin, repair.stock, repair.quoteId],
          );
          if (intake.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "A23137 intake identity no longer matches; repair refused",
            });
          }

          const sourceIds = repair.moves.map(([fromSlot]) =>
            canonicalPhotoId(repair.quoteId, fromSlot),
          );
          const targetIds = repair.moves.map(([, toSlot]) =>
            canonicalPhotoId(repair.quoteId, toSlot),
          );
          if (
            new Set(sourceIds).size !== repair.moves.length ||
            new Set(targetIds).size !== repair.moves.length ||
            sourceIds.some((id) => !targetIds.includes(id))
          ) {
            throw new Error("A23137 repair map must be a closed permutation of unique photo IDs");
          }

          const lockedPhotos = await client.query(
            `SELECT id, slot, role
             FROM photos
             WHERE quote_id = $1 AND id = ANY($2::text[])
             FOR UPDATE`,
            [repair.quoteId, sourceIds],
          );
          if (lockedPhotos.rowCount !== repair.moves.length) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: `Expected ${repair.moves.length} A23137 source photos, found ${lockedPhotos.rowCount}`,
            });
          }
          const byId = new Map(
            lockedPhotos.rows.map((photo) => [String(photo.id), photo]),
          );
          for (const [fromSlot] of repair.moves) {
            const sourceId = canonicalPhotoId(repair.quoteId, fromSlot);
            const photo = byId.get(sourceId);
            if (photo?.slot !== fromSlot || photo?.role !== "walk") {
              await client.query("ROLLBACK");
              return res.status(409).json({
                message: `A23137 source ${fromSlot} no longer matches the audited repair plan`,
              });
            }
          }

          const temporaryIds: string[] = [];
          for (let index = 0; index < repair.moves.length; index += 1) {
            const [fromSlot] = repair.moves[index];
            const sourceId = canonicalPhotoId(repair.quoteId, fromSlot);
            const temporaryId = `__photo_repair__${repair.repairKey}__${index}`;
            temporaryIds.push(temporaryId);
            await client.query(
              `UPDATE photos SET id = $1 WHERE quote_id = $2 AND id = $3`,
              [temporaryId, repair.quoteId, sourceId],
            );
          }

          for (let index = 0; index < repair.moves.length; index += 1) {
            const [, toSlot] = repair.moves[index];
            await client.query(
              `UPDATE photos
               SET id = $1, slot = $2
               WHERE quote_id = $3 AND id = $4`,
              [
                canonicalPhotoId(repair.quoteId, toSlot),
                toSlot,
                repair.quoteId,
                temporaryIds[index],
              ],
            );
          }

          await client.query(
            `INSERT INTO audit_log
               (action, actor_id, actor_email, actor_name, details)
             VALUES
               ('photo_slots_corrected', 'replit-agent', 'system@truckranch.com', 'Replit Agent',
                $1::jsonb)`,
            [JSON.stringify({
              repairKey: repair.repairKey,
              stock: repair.stock,
              vin: repair.vin,
              intakeId: repair.intakeId,
              quoteId: repair.quoteId,
              moved: repair.moves.length,
              imageBytesChanged: false,
              timestampsChanged: false,
            })],
          );
          await client.query("COMMIT");
          return res.json({
            phase,
            repairKey: repair.repairKey,
            alreadyApplied: false,
            moved: repair.moves.length,
            imageBytesChanged: false,
            timestampsChanged: false,
          });
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      }

      if (phase === "repair_bc23139_photo_link") {
        const repair = BC23139_PHOTO_LINK_REPAIR;
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            [repair.repairKey],
          );

          const priorAudit = await client.query(
            `SELECT 1
             FROM audit_log
             WHERE action = 'intake_photo_link_repaired'
               AND details->>'repairKey' = $1
             LIMIT 1`,
            [repair.repairKey],
          );
          if (priorAudit.rowCount) {
            await client.query("COMMIT");
            return res.json({
              phase,
              repairKey: repair.repairKey,
              alreadyApplied: true,
              quoteId: repair.quoteId,
              photos: repair.expectedPhotos,
            });
          }

          const target = await client.query(
            `SELECT id, vin, stock, miles, quote_id, committed_by, completed_at
             FROM intakes
             WHERE id = $1
               AND UPPER(TRIM(vin)) = $2
               AND UPPER(TRIM(stock)) = $3
               AND TRIM(miles) = $4
               AND committed_by = $5
               AND completed_at IS NOT NULL
             FOR UPDATE`,
            [
              repair.targetIntakeId,
              repair.vin,
              repair.stock,
              repair.miles,
              repair.committedBy,
            ],
          );
          if (target.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "BC23139 target intake identity no longer matches; repair refused",
            });
          }
          const currentQuoteId = String(target.rows[0].quote_id || "");
          if (currentQuoteId && currentQuoteId !== repair.quoteId) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "BC23139 target intake already links to a different quote; repair refused",
            });
          }

          const source = await client.query(
            `SELECT id
             FROM intakes
             WHERE id = $1
               AND UPPER(TRIM(vin)) = $2
               AND UPPER(TRIM(stock)) = $3
               AND TRIM(miles) = $4
               AND quote_id = $5
               AND committed_by = $6
               AND completed_at IS NOT NULL
             FOR UPDATE`,
            [
              repair.sourceIntakeId,
              repair.vin,
              repair.stock,
              repair.miles,
              repair.quoteId,
              repair.committedBy,
            ],
          );
          if (source.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "BC23139 source intake/quote identity no longer matches; repair refused",
            });
          }

          const quote = await client.query(
            `SELECT id
             FROM quotes
             WHERE id = $1
               AND UPPER(COALESCE(data->>'vin', '')) = $2
               AND UPPER(COALESCE(data->>'stock', '')) = $3
             FOR UPDATE`,
            [repair.quoteId, repair.vin, repair.stock],
          );
          if (quote.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "BC23139 quote identity no longer matches; repair refused",
            });
          }

          const photoStats = await client.query(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE role = 'walk')::int AS walk,
                    COUNT(*) FILTER (WHERE role = 'damage')::int AS damage,
                    COUNT(*) FILTER (WHERE data IS NULL OR OCTET_LENGTH(data) = 0)::int AS empty
             FROM photos
             WHERE quote_id = $1`,
            [repair.quoteId],
          );
          const stats = photoStats.rows[0];
          if (
            Number(stats?.total) !== repair.expectedPhotos
            || Number(stats?.walk) !== repair.expectedWalk
            || Number(stats?.damage) !== repair.expectedDamage
            || Number(stats?.empty) !== 0
          ) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "BC23139 photo manifest changed; repair refused",
            });
          }

          if (!currentQuoteId) {
            const linked = await client.query(
              `UPDATE intakes
               SET quote_id = $1, updated_at = NOW()
               WHERE id = $2 AND quote_id IS NULL`,
              [repair.quoteId, repair.targetIntakeId],
            );
            if (linked.rowCount !== 1) {
              await client.query("ROLLBACK");
              return res.status(409).json({
                message: "BC23139 target intake changed while repair was running; repair refused",
              });
            }
          }

          await client.query(
            `INSERT INTO audit_log
               (action, actor_id, actor_email, actor_name, details)
             VALUES
               ('intake_photo_link_repaired', 'replit-agent', 'system@truckranch.com', 'Replit Agent',
                $1::jsonb)`,
            [JSON.stringify({
              repairKey: repair.repairKey,
              stock: repair.stock,
              vin: repair.vin,
              targetIntakeId: repair.targetIntakeId,
              sourceIntakeId: repair.sourceIntakeId,
              quoteId: repair.quoteId,
              photos: repair.expectedPhotos,
              walkPhotos: repair.expectedWalk,
              damagePhotos: repair.expectedDamage,
              imageBytesChanged: false,
              sourceLinkChanged: false,
            })],
          );
          await client.query("COMMIT");
          return res.json({
            phase,
            repairKey: repair.repairKey,
            alreadyApplied: currentQuoteId === repair.quoteId,
            quoteId: repair.quoteId,
            photos: repair.expectedPhotos,
            imageBytesChanged: false,
          });
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      }

      if (phase === "repair_bc23115_sideways_photo") {
        const repair = BC23115_ORIENTATION_REPAIR;
        const photo = getBc23115RepairPhoto(String(req.body?.photoId || ""));
        if (!photo) {
          return res.status(400).json({ message: "Photo is not in the inspected BC23115 repair set" });
        }

        let replacement: Awaited<ReturnType<typeof decodeBc23115Replacement>>;
        try {
          replacement = await decodeBc23115Replacement(req.body?.dataUrl);
        } catch (error) {
          return res.status(400).json({
            message: error instanceof Error ? error.message : "Invalid replacement JPEG",
          });
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            [`${repair.repairKey}:${photo.id}`],
          );

          const priorAudit = await client.query(
            `SELECT details
             FROM audit_log
             WHERE action = 'photo_orientation_repaired'
               AND details->>'repairKey' = $1
               AND details->>'photoId' = $2
             LIMIT 1`,
            [repair.repairKey, photo.id],
          );
          if (priorAudit.rowCount) {
            await client.query("COMMIT");
            return res.json({
              phase,
              repairKey: repair.repairKey,
              photoId: photo.id,
              alreadyApplied: true,
            });
          }

          const current = await client.query(
            `SELECT p.id, p.ts, OCTET_LENGTH(p.data)::int AS bytes
             FROM photos p
             WHERE p.id = $1
               AND p.quote_id = $2
               AND p.slot = $3
               AND p.ts = $4
               AND EXISTS (
                 SELECT 1
                 FROM intakes i
                 WHERE i.id = $5
                   AND i.quote_id = $2
                   AND UPPER(TRIM(i.stock)) = $6
               )
             FOR UPDATE`,
            [
              photo.id,
              repair.quoteId,
              photo.slot,
              photo.expectedTs,
              repair.intakeId,
              repair.stock,
            ],
          );
          if (current.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "BC23115 photo changed or no longer matches the inspected repair plan; repair refused",
            });
          }

          const repairedTs = Math.max(Date.now(), photo.expectedTs + 1);
          const updated = await client.query(
            `UPDATE photos
             SET data = $1, mime = 'image/jpeg', ts = $2
             WHERE id = $3
               AND quote_id = $4
               AND slot = $5
               AND ts = $6`,
            [
              replacement.bytes,
              repairedTs,
              photo.id,
              repair.quoteId,
              photo.slot,
              photo.expectedTs,
            ],
          );
          if (updated.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "BC23115 photo changed while the repair was running; repair refused",
            });
          }

          await client.query(
            `INSERT INTO audit_log
               (action, actor_id, actor_email, actor_name, details)
             VALUES
               ('photo_orientation_repaired', 'replit-agent', 'system@truckranch.com', 'Replit Agent',
                $1::jsonb)`,
            [JSON.stringify({
              repairKey: repair.repairKey,
              stock: repair.stock,
              intakeId: repair.intakeId,
              quoteId: repair.quoteId,
              photoId: photo.id,
              slot: photo.slot,
              direction: repair.direction,
              oldTs: photo.expectedTs,
              newTs: repairedTs,
              oldBytes: Number(current.rows[0].bytes),
              newBytes: replacement.bytes.length,
              width: replacement.width,
              height: replacement.height,
            })],
          );
          await client.query("COMMIT");
          return res.json({
            phase,
            repairKey: repair.repairKey,
            photoId: photo.id,
            alreadyApplied: false,
            direction: repair.direction,
            width: replacement.width,
            height: replacement.height,
          });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      }

      if (phase === "repair_photo_orientation") {
        const repairKey = typeof req.body?.repairKey === "string"
          ? req.body.repairKey.trim().slice(0, 160)
          : "";
        const photoId = typeof req.body?.photoId === "string"
          ? req.body.photoId.trim().slice(0, 160)
          : "";
        const quoteId = typeof req.body?.quoteId === "string"
          ? req.body.quoteId.trim().slice(0, 160)
          : "";
        const slot = typeof req.body?.slot === "string"
          ? req.body.slot.trim().slice(0, 160)
          : "";
        const intakeId = typeof req.body?.intakeId === "string"
          ? req.body.intakeId.trim().slice(0, 160)
          : "";
        const stock = typeof req.body?.stock === "string"
          ? req.body.stock.trim().slice(0, 80).toUpperCase()
          : "";
        const expectedTs = Number(req.body?.expectedTs);
        const direction = typeof req.body?.direction === "string" ? req.body.direction : "";
        if (
          !repairKey
          || !photoId
          || !quoteId
          || !slot
          || !intakeId
          || !stock
          || !Number.isSafeInteger(expectedTs)
          || !["left", "right", "180"].includes(direction)
        ) {
          return res.status(400).json({ message: "Incomplete orientation repair identity" });
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            [`${repairKey}:${photoId}`],
          );

          const priorAudit = await client.query(
            `SELECT details
             FROM audit_log
             WHERE action = 'photo_orientation_repaired'
               AND details->>'repairKey' = $1
               AND details->>'photoId' = $2
             LIMIT 1`,
            [repairKey, photoId],
          );
          if (priorAudit.rowCount) {
            await client.query("COMMIT");
            return res.json({
              phase,
              repairKey,
              photoId,
              alreadyApplied: true,
            });
          }

          const current = await client.query(
            `SELECT p.data, p.ts, p.mime,
                    EXISTS (
                      SELECT 1
                      FROM intakes i
                      WHERE i.id = $5
                        AND i.quote_id = $2
                        AND UPPER(TRIM(i.stock)) = $6
                    ) AS owner_matches
             FROM photos p
             WHERE p.id = $1
               AND p.quote_id = $2
               AND p.slot = $3
               AND p.ts = $4
             FOR UPDATE`,
            [photoId, quoteId, slot, expectedTs, intakeId, stock],
          );
          if (current.rowCount !== 1 || !current.rows[0].owner_matches) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "Photo changed or no longer matches the requested repair identity",
            });
          }

          const originalBytes = Buffer.from(current.rows[0].data);
          let rotated: Awaited<ReturnType<typeof rotateStoredJpeg>>;
          try {
            rotated = await rotateStoredJpeg(originalBytes, direction as PhotoTurn);
          } catch (error) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: error instanceof Error ? error.message : "Stored photo cannot be safely rotated",
            });
          }

          const originalSha256 = createHash("sha256").update(originalBytes).digest("hex");
          const repairedSha256 = createHash("sha256").update(rotated.bytes).digest("hex");
          const repairedTs = Math.max(Date.now(), expectedTs + 1);
          await client.query(
            `INSERT INTO photo_orientation_backups
               (repair_key, photo_id, quote_id, intake_id, stock, slot, direction,
                original_mime, original_data, original_ts, original_sha256,
                repaired_sha256, repaired_ts)
             VALUES
               ($1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13)`,
            [
              repairKey,
              photoId,
              quoteId,
              intakeId,
              stock,
              slot,
              direction,
              String(current.rows[0].mime || "image/jpeg"),
              originalBytes,
              expectedTs,
              originalSha256,
              repairedSha256,
              repairedTs,
            ],
          );
          const updated = await client.query(
            `UPDATE photos
             SET data = $1, mime = 'image/jpeg', ts = $2
             WHERE id = $3
               AND quote_id = $4
               AND slot = $5
               AND ts = $6`,
            [rotated.bytes, repairedTs, photoId, quoteId, slot, expectedTs],
          );
          if (updated.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({ message: "Photo changed while repair was running" });
          }

          await client.query(
            `INSERT INTO audit_log
               (action, actor_id, actor_email, actor_name, details)
             VALUES
               ('photo_orientation_repaired', 'replit-agent', 'system@truckranch.com', 'Replit Agent',
                $1::jsonb)`,
            [JSON.stringify({
              repairKey,
              photoId,
              quoteId,
              intakeId,
              stock,
              slot,
              direction,
              oldTs: expectedTs,
              newTs: repairedTs,
              oldBytes: originalBytes.length,
              newBytes: rotated.bytes.length,
              oldWidth: rotated.sourceWidth,
              oldHeight: rotated.sourceHeight,
              width: rotated.width,
              height: rotated.height,
              originalSha256,
              repairedSha256,
            })],
          );
          await client.query("COMMIT");
          return res.json({
            phase,
            repairKey,
            photoId,
            alreadyApplied: false,
            direction,
            width: rotated.width,
            height: rotated.height,
            originalSha256,
            repairedSha256,
          });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      }

      if (phase === "rollback_photo_orientation") {
        const repairKey = typeof req.body?.repairKey === "string"
          ? req.body.repairKey.trim().slice(0, 160)
          : "";
        const photoId = typeof req.body?.photoId === "string"
          ? req.body.photoId.trim().slice(0, 160)
          : "";
        if (!repairKey || !photoId) {
          return res.status(400).json({ message: "repairKey and photoId are required" });
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            [`${repairKey}:${photoId}`],
          );
          const backupResult = await client.query(
            `SELECT *
             FROM photo_orientation_backups
             WHERE repair_key = $1 AND photo_id = $2
             FOR UPDATE`,
            [repairKey, photoId],
          );
          if (backupResult.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Orientation repair backup not found" });
          }
          const backup = backupResult.rows[0];
          if (backup.rolled_back_at) {
            await client.query("COMMIT");
            return res.json({
              phase,
              repairKey,
              photoId,
              alreadyRolledBack: true,
              rollbackTs: Number(backup.rollback_ts),
            });
          }

          const current = await client.query(
            `SELECT data, ts
             FROM photos
             WHERE id = $1
               AND quote_id = $2
               AND slot IS NOT DISTINCT FROM $3
               AND ts = $4
             FOR UPDATE`,
            [photoId, backup.quote_id, backup.slot, backup.repaired_ts],
          );
          if (current.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "Repaired photo changed after the repair; rollback refused",
            });
          }
          const currentSha256 = createHash("sha256")
            .update(Buffer.from(current.rows[0].data))
            .digest("hex");
          if (currentSha256 !== backup.repaired_sha256) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              message: "Repaired bytes no longer match the backup; rollback refused",
            });
          }

          const rollbackTs = Math.max(Date.now(), Number(current.rows[0].ts) + 1);
          const restored = await client.query(
            `UPDATE photos
             SET data = $1, mime = $2, ts = $3
             WHERE id = $4 AND ts = $5`,
            [
              backup.original_data,
              backup.original_mime,
              rollbackTs,
              photoId,
              backup.repaired_ts,
            ],
          );
          if (restored.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({ message: "Photo changed while rollback was running" });
          }
          await client.query(
            `UPDATE photo_orientation_backups
             SET rolled_back_at = NOW(), rollback_ts = $1
             WHERE repair_key = $2 AND photo_id = $3 AND rolled_back_at IS NULL`,
            [rollbackTs, repairKey, photoId],
          );
          await client.query(
            `INSERT INTO audit_log
               (action, actor_id, actor_email, actor_name, details)
             VALUES
               ('photo_orientation_repair_rolled_back',
                'replit-agent', 'system@truckranch.com', 'Replit Agent', $1::jsonb)`,
            [JSON.stringify({
              repairKey,
              photoId,
              quoteId: backup.quote_id,
              intakeId: backup.intake_id,
              stock: backup.stock,
              slot: backup.slot,
              repairTs: Number(backup.repaired_ts),
              rollbackTs,
              restoredSha256: backup.original_sha256,
            })],
          );
          await client.query("COMMIT");
          return res.json({
            phase,
            repairKey,
            photoId,
            alreadyRolledBack: false,
            rollbackTs,
            restoredSha256: backup.original_sha256,
          });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
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
