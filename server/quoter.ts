import type { Express, RequestHandler, Request, Response } from "express";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { requireEmployee } from "./access";
import { aiAnalyses, corrections, intakes, photos, quotes, settings } from "@shared/schema";
import { bestWalkPhotoIds } from "./localQuote";

// ---------------------------------------------------------------------------
// Body Quoter API, ported from the old standalone server (attached_assets/
// quoter-src/server.js) into this app as LOCAL routes under /api/quoter/*.
//
// The old device-token (x-shop-token), estimator-PIN, and x-fleet-key schemes
// are gone: every route here is gated by this app's requireEmployee auth.
// The /api/auth, /api/pin, /api/estauth, /api/estnames-PIN, /api/migrate, and
// the fleet read-only endpoints are intentionally not ported (they belonged to
// the standalone deployment / are served elsewhere in this app).
//
// Table names are untouched (settings, quotes, corrections, photos, intakes).
// ---------------------------------------------------------------------------

const ALLOWED_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-4-5"];
const CLASSIFY_MAX_BODY = 12 * 1024 * 1024;

// TR-INTAKE-V2 payload: 4 steps (3/6/6/5 sub-steps), 9 RO-Ready items.
const INTAKE_STEP_SIZES: Record<string, number> = { "1": 3, "2": 6, "3": 6, "4": 5 };

function sanitizeIntakeData(raw: unknown) {
  const d = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
  const steps: Record<string, boolean[]> = {};
  for (const k of ["1", "2", "3", "4"]) {
    const arr = d.steps && Array.isArray(d.steps[k]) ? d.steps[k] : [];
    steps[k] = Array.from({ length: INTAKE_STEP_SIZES[k] }, (_, i) => !!arr[i]);
  }
  const ro = Array.isArray(d.roReady) ? d.roReady : [];
  return {
    steps,
    roReady: Array.from({ length: 9 }, (_, i) => !!ro[i]),
    photoCount: Math.max(0, Math.min(999, Number(d.photoCount) || 0)),
    notes: String(d.notes || "").slice(0, 2000),
    mddTags: !!d.mddTags,
  };
}

// Estimator list is stored as [{ name, pin }] (pin: 4-digit string or null).
// Older deployments stored plain name strings — normalize on read.
function normalizeEstNames(value: unknown): { name: string; pin: string | null }[] {
  if (!Array.isArray(value)) return [];
  const out: { name: string; pin: string | null }[] = [];
  for (const e of value) {
    const name = String((e && typeof e === "object" ? (e as any).name : e) || "")
      .trim()
      .slice(0, 40);
    if (!name || out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const pin =
      e && typeof e === "object" && /^\d{4}$/.test(String((e as any).pin || ""))
        ? String((e as any).pin)
        : null;
    out.push({ name, pin });
    if (out.length >= 30) break;
  }
  return out;
}

// Simple per-IP rate limit for classify: 30 calls per minute.
const rlBuckets = new Map<string, { start: number; count: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  let b = rlBuckets.get(ip);
  if (!b || now - b.start > 60000) {
    b = { start: now, count: 0 };
    rlBuckets.set(ip, b);
  }
  if (rlBuckets.size > 1000) {
    for (const [k, v] of rlBuckets) {
      if (now - v.start > 60000) rlBuckets.delete(k);
    }
  }
  b.count++;
  return b.count > 30;
}

// Prefer Express's req.ip (derived from the trusted proxy hop configured in
// server/index.ts) over parsing the raw X-Forwarded-For header, which a client
// can freely spoof to dodge rate limits.
function clientIp(req: Request): string {
  return String(req.ip || req.socket.remoteAddress || "").trim();
}

// A larger JSON body limit just for the quoter router (photo uploads are big).
const quoterJson = express.json({ limit: "8mb" });

// Compose two handlers into one (Express 5 TS overload inference breaks on arrays).
function withBody(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    quoterJson(req, res, (err) => {
      if (err) {
        if ((err as any).type === "entity.too.large") {
          return res.status(413).json({ error: "Body too large" });
        }
        return res.status(400).json({ error: "Invalid JSON" });
      }
      Promise.resolve(handler(req, res, next)).catch(next);
    });
  };
}

function guard(handler: (req: any, res: Response) => Promise<unknown> | unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

export function registerQuoterRoutes(app: Express) {
  // ----- GET /api/quoter/sync -----
  app.get(
    "/api/quoter/sync",
    requireEmployee,
    guard(async (_req, res) => {
      const [st, qs, cs] = await Promise.all([
        db.execute(sql`SELECT key, value FROM settings`),
        db.execute(sql`SELECT id, data, committed_by, overridden_by FROM quotes ORDER BY updated_at DESC LIMIT 300`),
        db.execute(sql`SELECT ts, diffs FROM corrections ORDER BY id DESC LIMIT 200`),
      ]);
      const settingsMap: Record<string, unknown> = {};
      for (const r of st.rows as any[]) settingsMap[r.key] = r.value;
      // Card thumbnails: the earliest walk-around shot wins (front driver
      // corner, else next in line); the stored damage-thumb cover is only a
      // fallback for trucks with no walk photos at all.
      const walkCovers = await bestWalkPhotoIds((qs.rows as any[]).map((r) => String(r.id)));
      res.set("Cache-Control", "no-store");
      res.json({
        rates: (settingsMap as any).rates || null,
        estNames: (settingsMap as any).estNames
          ? normalizeEstNames((settingsMap as any).estNames).map((e) => ({
              name: e.name,
              hasPin: !!e.pin,
            }))
          : null,
        quotes: (qs.rows as any[]).map((r) => {
          const walk = walkCovers.get(String(r.id));
          // Sign-off state lives in the DB COLUMNS, not the data blob — the
          // client must see it or it lets you edit a locked quote while the
          // server silently rejects every save.
          const base = {
            ...r.data,
            committedBy: r.committed_by || null,
            overriddenBy: r.overridden_by || null,
          };
          return walk ? { ...base, cover: `/api/quoter/photo?id=${encodeURIComponent(walk.id)}` } : base;
        }),
        corrections: cs.rows,
      });
    }),
  );

  // ----- PUT /api/quoter/rates -----
  app.put(
    "/api/quoter/rates",
    requireEmployee,
    withBody(async (req: any, res) => {
      const value = req.body?.rates;
      if (value == null) return res.status(400).json({ error: "Missing rates" });
      await db
        .insert(settings)
        .values({ key: "rates", value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date() },
        });
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/quoter/intakes/:id/link-quote",
    requireEmployee,
    withBody(async (req: any, res) => {
      const id = String(req.params.id || "").slice(0, 60);
      const quoteId = String(req.body?.quoteId || "").slice(0, 60);
      if (!id || !quoteId) return res.status(400).json({ error: "Missing intake id or quoteId" });
      const r = await db.execute(sql`
        UPDATE intakes SET quote_id = COALESCE(quote_id, ${quoteId}), updated_at = NOW()
        WHERE id = ${id} AND committed_by IS NULL
        RETURNING quote_id
      `);
      const row = (r.rows as any[])[0];
      if (!row) return res.status(409).json({ error: "Intake is committed or not found" });
      res.json({ quoteId: row.quote_id });
    }),
  );

  // ----- PUT /api/quoter/estnames -----
  app.put(
    "/api/quoter/estnames",
    requireEmployee,
    withBody(async (req: any, res) => {
      const body = req.body || {};
      if (!Array.isArray(body.estNames)) return res.status(400).json({ error: "Missing estNames" });
      const [row] = await db.select().from(settings).where(eq(settings.key, "estNames"));
      const existing = normalizeEstNames(row ? row.value : []);
      const names: { name: string; pin: string | null }[] = [];
      for (const e of body.estNames) {
        const name = String((e && typeof e === "object" ? e.name : e) || "")
          .trim()
          .slice(0, 40);
        if (!name || names.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
        const sent = e && typeof e === "object" ? e.pin : undefined;
        let pin: string | null;
        if (sent === undefined) {
          // No pin field sent — keep whatever the server already has for this name.
          const old = existing.find((x) => x.name.toLowerCase() === name.toLowerCase());
          pin = old ? old.pin : null;
        } else {
          if (sent !== null && !/^\d{4}$/.test(String(sent))) {
            return res.status(400).json({ error: "PIN must be 4 digits" });
          }
          pin = sent === null ? null : String(sent);
        }
        names.push({ name, pin });
        if (names.length >= 30) break;
      }
      await db
        .insert(settings)
        .values({ key: "estNames", value: names as any, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: names as any, updatedAt: new Date() },
        });
      res.json({ ok: true, estNames: names.map((e) => ({ name: e.name, hasPin: !!e.pin })) });
    }),
  );

  // ----- PUT /api/quoter/quotes -----
  app.put(
    "/api/quoter/quotes",
    requireEmployee,
    withBody(async (req: any, res) => {
      const body = req.body || {};
      const id = String(body.id || "");
      if (!id || !body.data || typeof body.data !== "object") {
        return res.status(400).json({ error: "Missing id or data" });
      }
      // Once a quote is committed its signed content is immutable. Do the
      // insert-or-update atomically and only touch rows whose committed_by is
      // still NULL; a no-op means an existing committed row, so reject.
      const [saved] = await db
        .insert(quotes)
        .values({ id, data: body.data, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: quotes.id,
          set: { data: body.data, updatedAt: new Date() },
          setWhere: sql`${quotes.committedBy} IS NULL`,
        })
        .returning({ id: quotes.id });
      if (!saved) return res.status(409).json({ error: "Quote is committed" });
      res.json({ ok: true });
    }),
  );

  // ----- PATCH /api/quoter/quotes/notes -----
  // Notes-only update from the intake screen. An atomic jsonb_set on the
  // notes key (never a full-document PUT) so it can't clobber lines/totals
  // written by the quote screen's autosave; upserts a minimal row when only
  // a photos-link exists. Committed quotes stay immutable.
  app.patch(
    "/api/quoter/quotes/notes",
    requireEmployee,
    withBody(async (req: any, res) => {
      const body = req.body || {};
      const id = String(body.id || "");
      const notes = String(body.notes ?? "").slice(0, 2000);
      if (!id) return res.status(400).json({ error: "Missing id" });
      const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
      const minimal = {
        id, ts: Date.now(), dateISO: new Date().toISOString(),
        vin: String(meta.vin || ""), stock: String(meta.stock || ""), miles: String(meta.miles || ""),
        veh: null, vehicle: String(meta.vehicle || ""), estimator: String(meta.estimator || ""),
        cover: "", lines: [], totals: { hrs: 0, usd: 0, B: 0, P: 0, RI: 0, usdPDR: 0 },
        notes, flags: [], keep: {},
      };
      const [saved] = await db
        .insert(quotes)
        .values({ id, data: minimal, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: quotes.id,
          set: {
            data: sql`jsonb_set(${quotes.data}, '{notes}', ${JSON.stringify(notes)}::jsonb, true)`,
            updatedAt: new Date(),
          },
          setWhere: sql`${quotes.committedBy} IS NULL`,
        })
        .returning({ id: quotes.id });
      if (!saved) return res.status(409).json({ error: "Quote is committed" });
      res.json({ ok: true });
    }),
  );

  // ----- DELETE /api/quoter/quotes?id= -----
  app.delete(
    "/api/quoter/quotes",
    requireEmployee,
    guard(async (req, res) => {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ error: "Missing id" });
      // A committed quote is a permanent signed record — never deletable.
      const [del] = await db
        .delete(quotes)
        .where(sql`${quotes.id} = ${id} AND ${quotes.committedBy} IS NULL`)
        .returning({ id: quotes.id });
      if (!del) {
        // Distinguish "committed" (row exists, guard blocked it) from a plain
        // missing/already-gone row (idempotent success).
        const [row] = await db
          .select({ committedBy: quotes.committedBy })
          .from(quotes)
          .where(eq(quotes.id, id));
        if (row && row.committedBy) return res.status(409).json({ error: "Quote is committed" });
      }
      await db.delete(photos).where(eq(photos.quoteId, id));
      res.json({ ok: true });
    }),
  );

  // ----- POST /api/quoter/photos (upsert) -----
  app.post(
    "/api/quoter/photos",
    requireEmployee,
    withBody(async (req: any, res) => {
      const body = req.body || {};
      const id = String(body.id || "").slice(0, 60);
      const quoteId = String(body.quoteId || "").slice(0, 60);
      const slot = String(body.slot || "").slice(0, 40);
      const mDU = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
        String(body.dataUrl || ""),
      );
      if (!id || !quoteId || !mDU) {
        return res.status(400).json({ error: "Missing id, quoteId, or image" });
      }
      // Ownership guard: an existing photo may only be overwritten by its own
      // quote — a photo id + an unrelated quoteId must never hijack the row.
      const [existing] = await db
        .select({ quoteId: photos.quoteId })
        .from(photos)
        .where(eq(photos.id, id));
      if (existing && existing.quoteId !== quoteId) {
        return res.status(409).json({ error: "Photo belongs to another quote" });
      }
      // Photos are part of a quote's signed content — once committed, no NEW
      // photos may be added and none deleted. Overwriting an existing photo
      // in place (the lightbox ROTATE button) is allowed even after sign-off,
      // per shop policy: straightening a sideways shot isn't a content change.
      const [ownerQuote] = await db
        .select({ committedBy: quotes.committedBy })
        .from(quotes)
        .where(eq(quotes.id, quoteId));
      if (ownerQuote && ownerQuote.committedBy && !existing) {
        return res.status(409).json({ error: "Quote is committed" });
      }
      const buf = Buffer.from(mDU[2], "base64");
      if (!buf.length || buf.length > 4 * 1024 * 1024) {
        return res.status(413).json({ error: "Photo too large" });
      }
      // Acquire a per-quote advisory lock inside a transaction so that concurrent
      // uploads (e.g. close-up + wide shot fired in parallel) cannot both observe
      // a count below 160 and both insert, exceeding the cap.
      let limitReached = false;
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${quoteId})::bigint)`,
        );
        const cnt = await tx.execute(
          sql`SELECT COUNT(*)::int AS n FROM photos WHERE quote_id = ${quoteId} AND id <> ${id}`,
        );
        if (Number((cnt.rows[0] as any).n) >= 160) {
          limitReached = true;
          return;
        }
        const ts = Date.now();
        await tx
          .insert(photos)
          .values({ id, quoteId, slot, mime: mDU[1], data: buf, ts })
          .onConflictDoUpdate({
            target: photos.id,
            set: { slot, mime: mDU[1], data: buf, ts },
          });
      });
      if (limitReached) {
        return res.status(409).json({ error: "Photo limit reached for this truck" });
      }
      res.json({ ok: true, id });
    }),
  );

  // ----- GET /api/quoter/photos?quote= (metadata list) -----
  app.get(
    "/api/quoter/photos",
    requireEmployee,
    guard(async (req, res) => {
      const quoteId = String(req.query.quote || "");
      if (!quoteId) return res.status(400).json({ error: "Missing quote" });
      const r = await db.execute(
        sql`SELECT id, slot, ts, LENGTH(data) AS bytes FROM photos WHERE quote_id = ${quoteId} ORDER BY ts`,
      );
      res.set("Cache-Control", "no-store");
      res.json({ photos: r.rows });
    }),
  );

  // ----- DELETE /api/quoter/photos (body {id} or {quoteId}) -----
  app.delete(
    "/api/quoter/photos",
    requireEmployee,
    withBody(async (req: any, res) => {
      const body = req.body || {};
      // Deleting a photo mutates the owning quote's signed content, so it is
      // blocked once that quote is committed.
      const isCommitted = async (quoteId: string): Promise<boolean> => {
        if (!quoteId) return false;
        const [q] = await db
          .select({ committedBy: quotes.committedBy })
          .from(quotes)
          .where(eq(quotes.id, quoteId));
        return !!(q && q.committedBy);
      };
      if (body.id) {
        const photoId = String(body.id);
        const [ph] = await db
          .select({ quoteId: photos.quoteId })
          .from(photos)
          .where(eq(photos.id, photoId));
        if (ph && (await isCommitted(ph.quoteId))) {
          return res.status(409).json({ error: "Quote is committed" });
        }
        await db.delete(photos).where(eq(photos.id, photoId));
        return res.json({ ok: true });
      }
      if (body.quoteId) {
        const quoteId = String(body.quoteId);
        if (await isCommitted(quoteId)) {
          return res.status(409).json({ error: "Quote is committed" });
        }
        await db.delete(photos).where(eq(photos.quoteId, quoteId));
        return res.json({ ok: true });
      }
      res.status(400).json({ error: "Missing id or quoteId" });
    }),
  );

  // ----- GET /api/quoter/photo?id= (raw bytes) -----
  app.get(
    "/api/quoter/photo",
    requireEmployee,
    guard(async (req, res) => {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ error: "Missing id" });
      const [row] = await db.select({ mime: photos.mime, data: photos.data }).from(photos).where(eq(photos.id, id));
      if (!row) return res.status(404).json({ error: "Not found" });
      res.set("Content-Type", row.mime);
      res.set("Cache-Control", "private, max-age=86400");
      res.end(row.data);
    }),
  );

  // ----- POST /api/quoter/corrections -----
  app.post(
    "/api/quoter/corrections",
    requireEmployee,
    withBody(async (req: any, res) => {
      const body = req.body || {};
      const diffs = Array.isArray(body.diffs)
        ? body.diffs.map((d: unknown) => String(d).slice(0, 200)).slice(0, 10)
        : [];
      if (!diffs.length) return res.status(400).json({ error: "Missing diffs" });
      const ts = Number(body.ts) || Date.now();
      const analysisId = typeof body.analysis_id === "string" ? body.analysis_id.slice(0, 100) : null;
      // Idempotency: re-applying the same edit (reopened quote, retried
      // request, repeated commit of the same line) must not double-record the
      // correction — duplicates skew the shop-calibration corpus and can
      // evict genuine corrections from the 500-row learning cache. Enforced
      // ATOMICALLY by the corrections_analysis_diffs_key unique index (see
      // ensureAccuracySchema): concurrent identical POSTs cannot both insert.
      await db.execute(sql`
        INSERT INTO corrections (ts, diffs, analysis_id)
        VALUES (${ts}, ${JSON.stringify(diffs)}::jsonb, ${analysisId})
        ON CONFLICT (analysis_id, md5(diffs::text)) WHERE analysis_id IS NOT NULL
        DO NOTHING
      `);
      // Keep only the newest 500 corrections (shop-calibration learning cache).
      await db.execute(
        sql`DELETE FROM corrections WHERE id NOT IN (SELECT id FROM corrections ORDER BY id DESC LIMIT 500)`,
      );
      // Persist the correction flag on the analysis row so the accuracy trend
      // survives the 500-row cleanup above.  Fire-and-forget: a failure here
      // only affects the dashboard stat, not the correction record itself.
      if (analysisId) {
        db.execute(sql`UPDATE ai_analyses SET corrected = TRUE WHERE analysis_id = ${analysisId}`).catch(
          (e: any) => console.error("ai_analyses corrected flag update error:", e?.message ?? e),
        );
      }
      res.json({ ok: true });
    }),
  );

  // ----- GET /api/quoter/intakes?vin= -----
  app.get(
    "/api/quoter/intakes",
    requireEmployee,
    guard(async (req, res) => {
      const vin = String(req.query.vin || "").trim().toUpperCase();
      if (!vin && req.query.vin !== undefined) return res.status(400).json({ error: "Missing or short vin" });
      if (!vin) {
        const r = await db.execute(sql`
          SELECT i.id, i.vin, i.stock, i.vehicle, i.estimator, i.quote_id,
                 i.committed_by, i.completed_at,
                 EXTRACT(EPOCH FROM i.updated_at) * 1000 AS updated_ms,
                 EXTRACT(EPOCH FROM i.completed_at) * 1000 AS completed_ms,
                 i.data,
                 q.data AS quote_data
          FROM intakes i LEFT JOIN quotes q ON q.id = i.quote_id
          ORDER BY i.updated_at DESC LIMIT 200
        `);
        const rows = (r.rows as any[]).map((row) => {
          const d = sanitizeIntakeData(row.data);
          const q = row.quote_data || {};
          const lines = Array.isArray(q.lines) ? q.lines.filter((l: any) => l && l.cls) : [];
          const t = q.totals || {};
          const total = q.id || row.quote_id ? { usd: Number(t.usd) || 0, hrs: Number(t.hrs) || 0, lineCount: lines.length } : null;
          const done = Object.values(d.steps).reduce((n: number, a: any) => n + a.filter(Boolean).length, 0);
          return {
            id: row.id, vin: row.vin, stock: row.stock || "", vehicle: row.vehicle || "",
            estimator: row.estimator || "", quoteId: row.quote_id || null,
            completedAt: row.completed_ms ? Math.round(Number(row.completed_ms)) : null,
            updatedAt: row.updated_ms ? Math.round(Number(row.updated_ms)) : 0,
            committedBy: row.committed_by || null,
            pct: Math.round(done / 20 * 100), quote: total,
          };
        });
        res.set("Cache-Control", "no-store");
        return res.json({ intakes: rows });
      }
      if (vin.length < 6) return res.status(400).json({ error: "Missing or short vin" });
      const r = await db.execute(sql`
        SELECT id, vin, stock, vehicle, miles, estimator, quote_id, data,
               committed_by, overridden_by,
               EXTRACT(EPOCH FROM completed_at) * 1000 AS completed_ms,
               EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
        FROM intakes WHERE vin = ${vin} ORDER BY updated_at DESC LIMIT 1
      `);
      res.set("Cache-Control", "no-store");
      if (!r.rows.length) return res.json({ found: false, vin });
      const row = r.rows[0] as any;
      res.json({
        found: true,
        id: row.id,
        vin: row.vin,
        stock: row.stock,
        vehicle: row.vehicle,
        miles: row.miles,
        estimator: row.estimator,
        quoteId: row.quote_id || null,
        data: row.data,
        committedBy: row.committed_by || null,
        overriddenBy: row.overridden_by || null,
        completedAt: row.completed_ms ? Math.round(Number(row.completed_ms)) : null,
        updatedAt: row.updated_ms ? Math.round(Number(row.updated_ms)) : 0,
      });
    }),
  );

  // ----- PUT /api/quoter/intakes (upsert, last-write-wins by ts) -----
  app.put(
    "/api/quoter/intakes",
    requireEmployee,
    withBody(async (req: any, res) => {
      const body = req.body || {};
      const id = String(body.id || "").slice(0, 60);
      const vin = String(body.vin || "").trim().toUpperCase().slice(0, 20);
      if (!id || vin.length < 6) return res.status(400).json({ error: "Missing id or vin" });
      const data = sanitizeIntakeData(body.data);
      // Client edit timestamp (ms). Stale offline-queue writes from another
      // phone must never clobber newer work already on the server.
      const ts = Math.min(Date.now() + 60000, Math.max(0, Number(body.ts) || Date.now()));
      const stock = String(body.stock || "").slice(0, 40);
      const vehicle = String(body.vehicle || "").slice(0, 120);
      const miles = String(body.miles || "").slice(0, 20);
      const estimator = String(body.estimator || "").slice(0, 40);
      const quoteId = body.quoteId ? String(body.quoteId).slice(0, 60) : null;
      const dataJson = JSON.stringify(data);
      // A committed intake's signed content is immutable. Reject any update to
      // an existing row that already has committed_by set (new inserts are
      // unaffected). Do it up front so a committed row returns 409 rather than
      // silently matching the last-write-wins no-op path below.
      const [existing] = await db
        .select({ committedBy: intakes.committedBy })
        .from(intakes)
        .where(eq(intakes.id, id));
      if (existing && existing.committedBy) {
        return res.status(409).json({ error: "Intake is committed" });
      }
      await db.execute(sql`
        INSERT INTO intakes (id, vin, stock, vehicle, miles, estimator, quote_id, data, completed_at, updated_at)
        VALUES (${id}, ${vin}, ${stock}, ${vehicle}, ${miles}, ${estimator}, ${quoteId}, ${dataJson}::jsonb,
                NULL, to_timestamp(${ts} / 1000.0))
        ON CONFLICT (id) DO UPDATE SET
          vin = ${vin}, stock = ${stock}, vehicle = ${vehicle}, miles = ${miles},
          estimator = ${estimator}, quote_id = ${quoteId}, data = ${dataJson}::jsonb,
          -- Completion is now marked at PIN commit (see pin.ts), never derived
          -- from checklist state. Preserve whatever is already there.
          completed_at = intakes.completed_at,
          updated_at = to_timestamp(${ts} / 1000.0)
        WHERE intakes.updated_at <= to_timestamp(${ts} / 1000.0) AND intakes.committed_by IS NULL
      `);
      res.json({ ok: true, id });
    }),
  );

  // ----- POST /api/quoter/classify (AI damage classification) -----
  const classifyJson = express.json({ limit: CLASSIFY_MAX_BODY });
  app.post("/api/quoter/classify", requireEmployee, (req: any, res, next) => {
    const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
    const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
    if (!apiKey || !baseURL) {
      return res.status(503).json({ error: "AI classification not configured" });
    }
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return res.status(429).json({ error: "Too many requests — slow down" });
    }
    classifyJson(req, res, async (err) => {
      if (err) {
        if ((err as any).type === "entity.too.large") {
          return res.status(413).json({ error: "Photo too large" });
        }
        return res.status(400).json({ error: "Invalid JSON body" });
      }
      const { image, image2, system, prompt, model, max_tokens } = req.body || {};
      if (
        !image ||
        typeof image !== "string" ||
        !/^[A-Za-z0-9+/=\s]+$/.test(image.slice(0, 100))
      ) {
        return res.status(400).json({ error: "Missing or invalid image" });
      }
      const hasWide = image2 && typeof image2 === "string" && /^[A-Za-z0-9+/=\s]+$/.test(image2.slice(0, 100));
      try {
        const anthropic = new Anthropic({ apiKey, baseURL });
        // Build the user message content: close-up always first; wide shot
        // appended second when provided so the model can use both for panel
        // identification and severity sizing.
        const userContent: any[] = [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
        ];
        if (hasWide) {
          userContent.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image2 } });
        }
        userContent.push({ type: "text", text: String(prompt || "Classify the damage in this photo. JSON only.").slice(0, 2000) });
        const msg = await anthropic.messages.create({
          model: ALLOWED_MODELS.includes(model) ? model : "claude-haiku-4-5",
          max_tokens: Math.min(Number(max_tokens) || 2048, 8192),
          system: String(system || "").slice(0, 8000),
          messages: [{ role: "user", content: userContent }],
        });
        const text = (msg.content || [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        res.json({ text });
        // Track this analysis for accuracy trending — fire-and-forget.
        // analysis_id is client-generated; ON CONFLICT DO NOTHING ensures the
        // second-look call (same id) does not add a second row to the denominator.
        const analysisId =
          typeof req.body?.analysis_id === "string" ? (req.body.analysis_id as string).slice(0, 100) : null;
        db.execute(
          sql`INSERT INTO ai_analyses (ts, analysis_id) VALUES (${Date.now()}, ${analysisId}) ON CONFLICT (analysis_id) DO NOTHING`,
        ).catch((e: any) => console.error("ai_analyses insert error:", e?.message ?? e));
      } catch (e: any) {
        console.error("classify error:", e && e.message ? e.message : e);
        const status = e && e.status === 429 ? 429 : 502;
        res.status(status).json({ error: "AI request failed" });
      }
    });
  });
}
