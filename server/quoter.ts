import type { Express, RequestHandler, Request, Response } from "express";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { requireEmployee, requireAdmin } from "./access";
import { aiAnalyses, corrections, deletedQuotes, intakes, photos, quotes, settings } from "@shared/schema";
import { validateRates } from "./ratesValidation";
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

// ---------------------------------------------------------------------------
// Server-authoritative AI classification config. Production behavior (model,
// output cap, prompt base, timeout, retry) is owned HERE — a stale client can
// no longer drift it by sending its own model/max_tokens/base prompt. The
// values below are exactly what the current client requests, so effective
// behavior is unchanged; classification semantics and output schema are the
// prompt text, which is byte-identical to src/lib/quoterClassify.js.
export const CLASSIFY_CONFIG = {
  promptVersion: "tr-classify-v1",
  model: "claude-sonnet-4-6",
  maxTokens: 700,
  timeoutMs: 45_000, // bounded — a hung upstream must not pin the request
  transientRetries: 1, // one retry on transient upstream failure only
} as const;

// Canonical base system prompt — MUST stay byte-identical to BASE_SYS_PROMPT
// in src/lib/quoterClassify.js (the client composes base + dynamic vehicle/
// shop-calibration hints; the server verifies the base and keeps the hints).
export const CLASSIFY_BASE_SYS_PROMPT = `You are the damage classifier for Truck Ranch, a used truck dealership. You will be shown ONE photo of a possibly damaged area on a pickup truck or SUV.

Return ONLY a single JSON object. No markdown, no code fences, no preamble, no explanation.

Schema (every key required):
{"panel": one of "front_bumper","grille","hood","left_fender","right_fender","left_front_door","right_front_door","left_rear_door","right_rear_door","left_cab_corner","right_cab_corner","left_bedside","right_bedside","left_front_flare","right_front_flare","left_rear_flare","right_rear_flare","rocker_panel","roof","tailgate","rear_bumper","mirror","unknown",
"damage_type": one of "dent","crease","scratch","crack","rust","missing_part","paint_only",
"severity": one of "minor","moderate","heavy","replace",
"paint_damaged": true or false,
"pdr_candidate": true or false,
"blend_adjacent_recommended": true or false,
"ri_parts_needed": array from "door_handle","mirror","molding","bumper_cover","headlamp","tail_lamp","grille","emblem","fender_liner","tailgate_handle","mudflap","step_bar","antenna","door_panel","wheel_flare","other" (empty array if none),
"confidence": one of "high","medium","low",
"notes": one sentence describing what is visible}

Severity is the SIZE of the damage. Judge size against reference objects in frame (door handles are ~6 inches, emblems ~3 inches). Apply exactly:
- "minor" = damage under ~3 inches across (nickel to fist size)
- "moderate" = damage 3 to 8 inches across
- "heavy" = damage over 8 inches across, or buckled/torn metal, or misaligned panel gaps
- "replace" = holes, tears, severe rust-through, or damage crossing structural lines
BUMP RULE: if the metal is creased (a sharp line, not a smooth dent) OR the paint is broken/cracked through, move severity UP one level (minor->moderate, moderate->heavy). Never bump past "heavy" on the size rule alone.
Set "pdr_candidate" true ONLY when ALL of these hold: damage_type is "dent", severity is "minor" or "moderate", paint is NOT broken (paint_damaged false), no crease, and the panel is metal (never front_bumper, rear_bumper, grille, mirror, or flares). PDR means paintless dent repair — a smooth shallow dent with intact factory paint.

Each photo shows ONE damage area. Classify the panel the damage is centered on — the panel filling most of the frame. If damage continues onto an adjacent panel (example: a bedside corner next to a damaged rear bumper), classify ONLY the primary panel in this photo; the adjacent panel is photographed separately. The same panel may appear in several photos showing different damage areas — classify each photo independently on its own damage only.
Left and right mean the VEHICLE's left and right (driver side is left on US trucks). If you cannot tell which side or which panel, use panel "unknown" with confidence "low" rather than guessing.
Set "paint_damaged" true only if the finish is visibly broken, scratched through, cracked, or missing.
Set "blend_adjacent_recommended" true when a refinish would end mid-panel or color-match risk is high (metallic or pearl paint, repair near a panel edge).
List "ri_parts_needed" only for parts that must come off to repair or refinish properly.
If the photo is not a vehicle exterior, is too blurry or dark, or has heavy glare: panel "unknown", confidence "low", and say why in notes.
Never estimate labor hours, cost, or repair time. Classification only.`;

const CLASSIFY_PROMPT_SINGLE = "Classify the damage in this photo. JSON only.";
const CLASSIFY_PROMPT_PAIR =
  "The first image is a close-up of the damage area; the second is a wide shot of the same area showing its panel location on the vehicle. Use both to classify the damage. JSON only.";

/** Compose the effective system prompt: always the canonical base. Dynamic
 *  client suffixes (vehicle context, shop-calibration hints, second-look
 *  addendum) are DATA and are kept — but only when the client's base matches
 *  the canonical prompt exactly. A stale client with a drifted base prompt is
 *  ignored wholesale (canonical base, no suffix) rather than trusted. */
export function resolveClassifySystem(clientSystem: unknown): string {
  const s = typeof clientSystem === "string" ? clientSystem : "";
  if (s.startsWith(CLASSIFY_BASE_SYS_PROMPT)) {
    const suffix = s.slice(CLASSIFY_BASE_SYS_PROMPT.length).slice(0, 4000);
    return CLASSIFY_BASE_SYS_PROMPT + suffix;
  }
  return CLASSIFY_BASE_SYS_PROMPT;
}

/** User-message text: only the two canonical instructions are honored; any
 *  other client-supplied text is replaced by the canonical one. */
export function resolveClassifyPrompt(clientPrompt: unknown, hasWide: boolean): string {
  const p = typeof clientPrompt === "string" ? clientPrompt : "";
  if (p === CLASSIFY_PROMPT_SINGLE || p === CLASSIFY_PROMPT_PAIR) return p;
  return hasWide ? CLASSIFY_PROMPT_PAIR : CLASSIFY_PROMPT_SINGLE;
}

const TRANSIENT_AI_STATUSES = new Set([408, 500, 502, 503, 504, 529]);
export function isTransientAiError(e: any): boolean {
  const status = Number(e?.status);
  if (TRANSIENT_AI_STATUSES.has(status)) return true;
  // Network-level failures (no HTTP status) and our own abort/timeouts.
  return !Number.isFinite(status) || status === 0;
}

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
        // Version of the rates the client just received; sent back at commit
        // so a quote can't silently commit against rates the estimator never saw.
        ratesVersion: Number((settingsMap as any).ratesMeta?.version ?? 0),
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
  // Admin-only, validated, and versioned. Every accepted change bumps
  // settings['ratesMeta'].version; commits carry the version the estimator
  // loaded so a stale-rates commit is refused instead of silently repriced.
  app.put(
    "/api/quoter/rates",
    requireAdmin,
    withBody(async (req: any, res) => {
      const value = req.body?.rates;
      if (value == null) return res.status(400).json({ error: "Missing rates" });
      const verdict = validateRates(value);
      if (!verdict.ok) return res.status(400).json({ error: verdict.error });
      const emp = req.employee;
      const ratesVersion = await db.transaction(async (tx) => {
        // Serialize concurrent rates saves even when no ratesMeta row exists
        // yet (two first-time writers would otherwise both compute version 1).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ratesMeta')::bigint)`);
        await tx
          .insert(settings)
          .values({ key: "rates", value, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });
        const metaR = await tx.execute(sql`SELECT value FROM ${settings} WHERE key = 'ratesMeta' FOR UPDATE`);
        const version = Number((metaR.rows?.[0] as any)?.value?.version ?? 0) + 1;
        const meta = {
          version,
          updatedAt: new Date().toISOString(),
          updatedBy: emp?.name || emp?.email || null,
        };
        await tx
          .insert(settings)
          .values({ key: "ratesMeta", value: meta, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: meta, updatedAt: new Date() },
          });
        return version;
      });
      res.json({ ok: true, ratesVersion });
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
      // An explicit full save re-creates the quote — clear any tombstone so
      // future photo uploads for this id are accepted again.
      await db.delete(deletedQuotes).where(eq(deletedQuotes.id, id));
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
      // Quote + photos + tombstone in ONE transaction, serialized against
      // photo uploads via the same per-quote advisory lock the upload path
      // takes — a crash or concurrent upload can no longer leave orphaned
      // photos, and queued uploads for the deleted id are refused (410).
      let committed = false;
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id})::bigint)`);
        // A committed quote is a permanent signed record — never deletable.
        const [del] = await tx
          .delete(quotes)
          .where(sql`${quotes.id} = ${id} AND ${quotes.committedBy} IS NULL`)
          .returning({ id: quotes.id });
        if (!del) {
          // Distinguish "committed" (row exists, guard blocked it) from a
          // plain missing/already-gone row (idempotent success).
          const [row] = await tx
            .select({ committedBy: quotes.committedBy })
            .from(quotes)
            .where(eq(quotes.id, id));
          if (row && row.committedBy) {
            committed = true;
            return;
          }
        }
        await tx.delete(photos).where(eq(photos.quoteId, id));
        await tx.insert(deletedQuotes).values({ id }).onConflictDoNothing();
      });
      if (committed) return res.status(409).json({ error: "Quote is committed" });
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
      const buf = Buffer.from(mDU[2], "base64");
      if (!buf.length || buf.length > 4 * 1024 * 1024) {
        return res.status(413).json({ error: "Photo too large" });
      }
      // Acquire a per-quote advisory lock inside a transaction so that concurrent
      // uploads (e.g. close-up + wide shot fired in parallel) cannot both observe
      // a count below 160 and both insert, exceeding the cap. ALL guards run
      // inside this transaction: checking committed state before it would let a
      // PIN commit land between the read and the insert.
      let limitReached = false;
      let quoteDeleted = false;
      let wrongOwner = false;
      let quoteCommitted = false;
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${quoteId})::bigint)`,
        );
        // Ownership guard: an existing photo may only be overwritten by its own
        // quote — a photo id + an unrelated quoteId must never hijack the row.
        const [existing] = await tx
          .select({ quoteId: photos.quoteId })
          .from(photos)
          .where(eq(photos.id, id));
        if (existing && existing.quoteId !== quoteId) {
          wrongOwner = true;
          return;
        }
        // Photos are part of a quote's signed content — once committed, no NEW
        // photos may be added and none deleted. Overwriting an existing photo
        // in place (the lightbox ROTATE button) is allowed even after sign-off,
        // per shop policy: straightening a sideways shot isn't a content change.
        const [ownerQuote] = await tx
          .select({ committedBy: quotes.committedBy })
          .from(quotes)
          .where(eq(quotes.id, quoteId));
        if (ownerQuote && ownerQuote.committedBy && !existing) {
          quoteCommitted = true;
          return;
        }
        // A queued upload from an offline device must not resurrect photos
        // under a quote that was deliberately deleted (tombstoned).
        const tomb = await tx.execute(
          sql`SELECT 1 FROM deleted_quotes WHERE id = ${quoteId}`,
        );
        if ((tomb.rows as any[]).length) {
          quoteDeleted = true;
          return;
        }
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
      if (wrongOwner) {
        return res.status(409).json({ error: "Photo belongs to another quote" });
      }
      if (quoteCommitted) {
        return res.status(409).json({ error: "Quote is committed" });
      }
      if (quoteDeleted) {
        return res.status(410).json({ error: "Quote was deleted — photo not saved" });
      }
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
        INSERT INTO intakes (id, vin, stock, vehicle, miles, estimator, quote_id, data, created_at, completed_at, updated_at)
        VALUES (${id}, ${vin}, ${stock}, ${vehicle}, ${miles}, ${estimator}, ${quoteId}, ${dataJson}::jsonb,
                to_timestamp(${ts} / 1000.0), NULL, to_timestamp(${ts} / 1000.0))
        ON CONFLICT (id) DO UPDATE SET
          vin = ${vin}, stock = ${stock}, vehicle = ${vehicle}, miles = ${miles},
          estimator = ${estimator},
          -- Linking is compare-and-set and server-owned. Once a quote is linked,
          -- a stale full intake save from another device must never replace or
          -- clear that canonical relationship.
          quote_id = COALESCE(intakes.quote_id, ${quoteId}),
          data = ${dataJson}::jsonb,
          -- created_at is the arrival timestamp: written once at first insert,
          -- deliberately ABSENT from this update list so no later edit (from
          -- any device, any offline queue) can ever overwrite it.
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
      // model/max_tokens from the body are deliberately IGNORED — production
      // model, output cap, timeout, and retry policy are server-owned
      // (CLASSIFY_CONFIG). system/prompt are validated against the canonical
      // prompt; only recognized dynamic suffixes/data survive.
      const { image, image2, system, prompt } = req.body || {};
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
        userContent.push({ type: "text", text: resolveClassifyPrompt(prompt, !!hasWide) });
        const request = {
          model: CLASSIFY_CONFIG.model,
          max_tokens: CLASSIFY_CONFIG.maxTokens,
          system: resolveClassifySystem(system),
          messages: [{ role: "user", content: userContent }],
        } as const;
        // Bounded timeout + one retry on transient upstream failure only.
        let msg: any;
        for (let attempt = 0; ; attempt++) {
          try {
            // maxRetries: 0 — the explicit loop below is the ONLY retry
            // authority; the SDK's implicit retries would multiply attempts.
            msg = await anthropic.messages.create(request as any, { timeout: CLASSIFY_CONFIG.timeoutMs, maxRetries: 0 });
            break;
          } catch (err: any) {
            if (attempt < CLASSIFY_CONFIG.transientRetries && isTransientAiError(err)) {
              await new Promise((r) => setTimeout(r, 750));
              continue;
            }
            throw err;
          }
        }
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
