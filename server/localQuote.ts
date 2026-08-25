import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireEmployee } from "./access";
import { walkCoverRank } from "@shared/photoRoles";

// Local replacements for what used to be remote Body Quoter reads. The Quoter's
// data now lives in this app's Postgres (quotes / intakes tables), so these
// helpers query it directly. Each mirrors the exact shape the old fleet
// endpoints returned (attached_assets/quoter-src/server.js) so every consumer —
// the dashboard payload, the vehicle card, and the intake damage-quote card —
// keeps its response contract byte-for-byte identical.

const rowsOf = (res: any): any[] => (res?.rows ?? res) as any[];

export type IntakeGalleryCandidate = {
  intakeId: string;
  quoteId: string;
  stock: string;
  miles: string;
  vehicle: string;
  createdAt: number | null;
  completedAt: number | null;
  updatedAt: number | null;
  photoCount: number;
  walkPhotoCount: number;
  damagePhotoCount: number;
  damageWidePhotoCount: number;
  unclassifiedPhotoCount: number;
};
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
  };
}

// ---------- damage quote by VIN (was GET /api/quote-by-vin) ----------

export type QuoteByVin = {
  found: boolean;
  vin: string;
  id?: string;
  stock?: string;
  miles?: string;
  vehicle?: string;
  estimator?: string;
  quotedAt?: number;
  totals?: { hrs?: number; usd?: number };
  lineCount?: number;
  lines?: {
    panel: string;
    damage: string;
    severity: string;
    paint: boolean;
    parts: unknown[];
    needsReview: boolean;
    setByEstimator: boolean;
  }[];
};

/** Latest quote for a VIN, sanitized to the fleet quote-by-vin shape.
 *  Matching semantics mirror the old server: VIN trim/uppercase, newest by
 *  the quote's stored `ts`, no photos/notes/PII in the payload. */
export async function lookupQuoteByVin(vin: string): Promise<QuoteByVin> {
  const clean = vin.trim().toUpperCase();
  if (clean.length < 6) return { found: false, vin: clean };
  const r = await db.execute(sql`
    SELECT data FROM quotes
    WHERE UPPER(data->>'vin') = ${clean}
    ORDER BY (data->>'ts')::bigint DESC
    LIMIT 1
  `);
  const rows = rowsOf(r);
  if (!rows.length) return { found: false, vin: clean };
  const q = (rows[0].data as any) || {};
  const veh = q.veh || {};
  const lines = (q.lines || [])
    .filter((l: any) => l && l.cls)
    .map((l: any) => ({
      panel: l.cls.panel || "",
      damage: String(l.cls.damage_type || "").replace(/_/g, " "),
      severity: l.cls.severity || "",
      paint: !!l.cls.paint_damaged,
      parts: l.cls.ri_parts_needed || [],
      needsReview: !!l.review,
      setByEstimator: !!l.manual,
    }));
  return {
    found: true,
    id: q.id || "",
    vin: q.vin || clean,
    stock: q.stock || "",
    miles: q.miles || "",
    vehicle: [veh.year, veh.make, veh.model, veh.trim].filter(Boolean).join(" "),
    estimator: q.estimator || "",
    quotedAt: q.ts || 0,
    totals: q.totals || { hrs: 0, usd: 0 },
    lineCount: lines.length,
    lines,
  };
}

// ---------- full intake record by VIN (was GET /api/intake-by-vin) ----------

/** The latest intake for a VIN plus its linked quote totals, in the exact
 *  shape the vehicle card consumes. found:false = intake predates the system. */
export async function lookupIntakeByVin(vin: string): Promise<any> {
  const clean = vin.trim().toUpperCase();
  if (clean.length < 6) return { found: false, vin: clean };
  const r = await db.execute(sql`
    SELECT id, vin, stock, vehicle, miles, estimator, quote_id, data,
           EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms,
           EXTRACT(EPOCH FROM completed_at) * 1000 AS completed_ms,
           EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
    FROM intakes WHERE vin = ${clean} ORDER BY updated_at DESC LIMIT 1
  `);
  const rows = rowsOf(r);
  if (!rows.length) return { found: false, vin: clean };
  const row = rows[0];
  const data = sanitizeIntakeData(row.data);
  let quote: { id: string; hrs: number; usd: number; lineCount: number } | null = null;
  if (row.quote_id) {
    const q = await db.execute(sql`SELECT data FROM quotes WHERE id = ${row.quote_id}`);
    const qrows = rowsOf(q);
    if (qrows.length) {
      const qd = (qrows[0].data as any) || {};
      const lines = (qd.lines || []).filter((l: any) => l && l.cls);
      quote = {
        id: qd.id || row.quote_id,
        hrs: (qd.totals && qd.totals.hrs) || 0,
        usd: (qd.totals && qd.totals.usd) || 0,
        lineCount: lines.length,
      };
    }
  }
  const galleryConflict = row.quote_id ? null : await findIntakeGalleryConflict(String(row.id));
  return {
    found: true,
    intakeId: row.id,
    vin: row.vin,
    stock: row.stock,
    vehicle: row.vehicle,
    miles: row.miles,
    estimator: row.estimator,
    completedAt: row.completed_ms ? Math.round(Number(row.completed_ms)) : null,
    roReadyCount: data.roReady.filter(Boolean).length,
    roReady: data.roReady,
    steps: data.steps,
    photoCount: data.photoCount,
    quoteId: row.quote_id || null,
    quote,
    galleryConflict,
  };
}

// ---------- daily intake counts + open intakes (was /api/intake-stats) ----------

export type IntakeStats = { days: { day: string; intakes: number }[]; total: number; openIntakes: number };

/** Per-day completed-intake counts across [from,to] plus the count of
 *  still-open (not completed) intakes. Mirrors the old /api/intake-stats. */
export async function fetchIntakeStats(from: string, to: string): Promise<IntakeStats> {
  const [byDay, open] = await Promise.all([
    db.execute(sql`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(i.id)::int AS intakes
      FROM generate_series(${from}::date, ${to}::date, '1 day') AS d(day)
      -- Chicago-local day, matching every other dashboard day bucket. The
      -- bare ::date cast previously used the server's UTC day, so intakes
      -- completed after 6-7pm local drifted into the next day's bar.
      LEFT JOIN intakes i ON (i.completed_at AT TIME ZONE 'America/Chicago')::date = d.day::date
        AND i.retired_at IS NULL
      GROUP BY d.day ORDER BY d.day
    `),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM intakes WHERE completed_at IS NULL AND retired_at IS NULL`),
  ]);
  const days = rowsOf(byDay).map((r) => ({ day: String(r.day), intakes: Number(r.intakes) || 0 }));
  const openIntakes = Number(rowsOf(open)[0]?.n) || 0;
  return { days, total: days.reduce((a, d) => a + d.intakes, 0), openIntakes };
}

// ---------- completed intakes list (was /api/intakes-completed) ----------

export type CompletedIntake = {
  intakeId: string;
  vin: string;
  stock: string;
  miles: string;
  vehicle: string;
  estimator: string | null;
  completedAt: number | null;
  inProgress: boolean;
  quoteId: string | null;
};

/** All intakes for the In-Take Quotes bucket — committed (completed) ones plus
 *  in-progress ones still being worked, newest activity first, VIN normalized. */
export async function fetchCompletedIntakes(): Promise<CompletedIntake[]> {
  const r = await db.execute(sql`
    SELECT id, vin, stock, miles, vehicle, estimator, quote_id,
           EXTRACT(EPOCH FROM completed_at) * 1000 AS completed_ms,
           EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
    FROM intakes
    WHERE retired_at IS NULL
    ORDER BY COALESCE(completed_at, updated_at) DESC
  `);
  return rowsOf(r)
    .map((row) => ({
      intakeId: String(row.id),
      vin: String(row.vin ?? "").trim().toUpperCase(),
      stock: String(row.stock ?? "").trim(),
      miles: String(row.miles ?? "").trim(),
      vehicle: String(row.vehicle ?? "").trim(),
      estimator: row.estimator != null ? String(row.estimator).trim() || null : null,
      completedAt: row.completed_ms != null
        ? Math.round(Number(row.completed_ms))
        : row.updated_ms != null ? Math.round(Number(row.updated_ms)) : null,
      inProgress: row.completed_ms == null,
      quoteId: row.quote_id != null ? String(row.quote_id).trim() || null : null,
    }))
    .filter((row) => row.vin.length >= 6);
}

// ---------- exact-gallery covers for Vehicles cards ----------

export type QuoteCover = { cover: string | null; hrs: number | null; usd: number | null; lineCount: number };

/** Legacy quote-list cover selection. The Quoter landing page prefers its
 * guided walk-around angles; Vehicles dashboard cards do not use this helper. */
export async function bestWalkPhotoIds(quoteIds: string[]): Promise<Map<string, { id: string; rank: number }>> {
  const bestWalk = new Map<string, { id: string; rank: number }>();
  const unique = [...new Set(quoteIds.filter(Boolean))];
  if (!unique.length) return bestWalk;
  const pr = await db.execute(sql`
    SELECT id, quote_id, slot FROM photos
    WHERE quote_id = ANY(${sql.raw(`ARRAY[${unique.map((v) => `'${v.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
  `);
  for (const p of rowsOf(pr)) {
    const rank = walkCoverRank(p.slot);
    if (rank < 0) continue; // not a walk-around slot (e.g. damage close-up)
    const qid = String(p.quote_id);
    const prev = bestWalk.get(qid);
    if (!prev || rank < prev.rank) bestWalk.set(qid, { id: String(p.id), rank });
  }
  return bestWalk;
}

/** The canonical Vehicles thumbnail is the first surviving database photo for
 * the exact gallery: lowest photos.ts, then photos.id. Slot, role, and intake
 * photoOrder intentionally have no effect. */
export async function firstGalleryPhotoIds(quoteIds: string[]): Promise<Map<string, string>> {
  const first = new Map<string, string>();
  const unique = [...new Set(quoteIds.filter(Boolean))];
  if (!unique.length) return first;
  const result = await db.execute(sql`
    SELECT id, quote_id, ts FROM photos
    WHERE quote_id = ANY(${sql.raw(`ARRAY[${unique.map((v) => `'${v.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
    ORDER BY quote_id, ts ASC, id ASC
  `);
  const rows = rowsOf(result).slice().sort((a, b) => {
    const quoteCmp = String(a.quote_id).localeCompare(String(b.quote_id));
    if (quoteCmp) return quoteCmp;
    const tsA = Number(a.ts);
    const tsB = Number(b.ts);
    if (tsA !== tsB) return tsA - tsB;
    const idA = String(a.id);
    const idB = String(b.id);
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
  for (const photo of rows) {
    const quoteId = String(photo.quote_id);
    if (!first.has(quoteId)) first.set(quoteId, String(photo.id));
  }
  return first;
}

/** Exact intake/quote entries → canonical first-photo thumbnail and exact quote
 * metrics. Results are keyed by intake id, never VIN. A missing gallery photo
 * stays null: quote cover blobs and damage-line thumbs can belong to a different
 * capture/order and are therefore not valid fallbacks for Vehicles. */
export async function fetchQuoteCovers(entries: Array<{ intakeId: string; quoteId?: string | null }>): Promise<Map<string, QuoteCover>> {
  const out = new Map<string, QuoteCover>();
  const exact = new Map<string, string | null>();
  for (const e of entries) {
    const intakeId = String(e.intakeId || "").trim();
    if (intakeId) exact.set(intakeId, e.quoteId ? String(e.quoteId) : null);
  }
  if (!exact.size) return out;
  const quoteIds = [...new Set([...exact.values()].filter((id): id is string => !!id))];
  const [quoteResult, firstPhotos] = await Promise.all([
    quoteIds.length
      ? db.execute(sql`
          SELECT id, data FROM quotes
          WHERE id = ANY(${sql.raw(`ARRAY[${quoteIds.map((v) => `'${v.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
        `)
      : Promise.resolve({ rows: [] }),
    firstGalleryPhotoIds(quoteIds),
  ]);
  const quoteById = new Map(rowsOf(quoteResult).map((row) => [String(row.id), (row.data as any) || {}]));
  for (const [intakeId, quoteId] of exact) {
    const q = quoteId ? quoteById.get(quoteId) || {} : {};
    const lineCount = Array.isArray(q.lines) ? q.lines.filter((l: any) => l && l.cls).length : 0;
    const photoId = quoteId ? firstPhotos.get(quoteId) : undefined;
    out.set(intakeId, {
      cover: photoId ? `/api/quoter/photo?id=${encodeURIComponent(photoId)}` : null,
      hrs: q.totals?.hrs ?? null,
      usd: q.totals?.usd ?? null,
      lineCount,
    });
  }
  return out;
}

// ---------- route: read-only intake damage quote by VIN ----------

/** Serves the vehicle-quote card. Same response shape as the old fleet
 *  /api/quote-by-vin proxy, now read straight from the local quotes table. */
export function registerIntakeQuoteRoute(app: Express) {
  app.get("/api/intake-quote/:vin", requireEmployee, async (req, res, next) => {
    try {
      const vin = String(req.params.vin || "").trim().toUpperCase();
      if (vin.length < 6) return res.status(400).json({ message: "Invalid VIN" });
      res.json(await lookupQuoteByVin(vin));
    } catch (err) {
      next(err);
    }
  });
}

export type IntakeGalleryConflict = {
  selectedIntake: {
    intakeId: string;
    stock: string;
    miles: string;
    createdAt: number | null;
    completedAt: number | null;
    updatedAt: number | null;
    photoCount: 0;
  };
  candidates: IntakeGalleryCandidate[];
};

const epochMs = (value: unknown): number | null => {
  if (value == null) return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : null;
};

/**
 * If the selected intake has no canonical quote link, return other exact
 * intake-to-quote owners for the same VIN that actually have photos. This is
 * metadata only: callers must never use it as an automatic VIN fallback.
 */
export async function findIntakeGalleryConflict(
  intakeId: string,
  executor: { execute: (query: any) => Promise<any> } = db,
): Promise<IntakeGalleryConflict | null> {
  const cleanId = String(intakeId || "").slice(0, 60);
  if (!cleanId) return null;
  const result = await executor.execute(sql`
    WITH selected AS (
      SELECT id, vin, stock, miles, quote_id, created_at, completed_at, updated_at
      FROM intakes
      WHERE id = ${cleanId}
    )
    SELECT
      s.id AS selected_intake_id,
      s.stock AS selected_stock,
      s.miles AS selected_miles,
      EXTRACT(EPOCH FROM s.created_at) * 1000 AS selected_created_ms,
      EXTRACT(EPOCH FROM s.completed_at) * 1000 AS selected_completed_ms,
      EXTRACT(EPOCH FROM s.updated_at) * 1000 AS selected_updated_ms,
      owner.id AS owner_intake_id,
      owner.quote_id AS owner_quote_id,
      owner.stock AS owner_stock,
      owner.miles AS owner_miles,
      owner.vehicle AS owner_vehicle,
      EXTRACT(EPOCH FROM owner.created_at) * 1000 AS owner_created_ms,
      EXTRACT(EPOCH FROM owner.completed_at) * 1000 AS owner_completed_ms,
      EXTRACT(EPOCH FROM owner.updated_at) * 1000 AS owner_updated_ms,
      COUNT(p.id)::int AS photo_count,
      COUNT(*) FILTER (WHERE p.role = 'walk')::int AS walk_photo_count,
      COUNT(*) FILTER (WHERE p.role = 'damage')::int AS damage_photo_count,
      COUNT(*) FILTER (WHERE p.role = 'damage_wide')::int AS damage_wide_photo_count,
      COUNT(*) FILTER (WHERE p.role NOT IN ('walk', 'damage', 'damage_wide'))::int AS unclassified_photo_count
    FROM selected s
    JOIN intakes owner
      ON owner.id <> s.id
     AND UPPER(TRIM(owner.vin)) = UPPER(TRIM(s.vin))
     AND owner.quote_id IS NOT NULL
    JOIN photos p ON p.quote_id = owner.quote_id
    WHERE s.quote_id IS NULL
    GROUP BY
      s.id, s.stock, s.miles, s.created_at, s.completed_at, s.updated_at,
      owner.id, owner.quote_id, owner.stock, owner.miles, owner.vehicle,
      owner.created_at, owner.completed_at, owner.updated_at
    ORDER BY owner.updated_at DESC, owner.id
  `);
  const rows = rowsOf(result);
  if (!rows.length) return null;
  const first = rows[0];
  return {
    selectedIntake: {
      intakeId: String(first.selected_intake_id),
      stock: String(first.selected_stock || ""),
      miles: String(first.selected_miles || ""),
      createdAt: epochMs(first.selected_created_ms),
      completedAt: epochMs(first.selected_completed_ms),
      updatedAt: epochMs(first.selected_updated_ms),
      photoCount: 0,
    },
    candidates: rows.map((row) => ({
      intakeId: String(row.owner_intake_id),
      quoteId: String(row.owner_quote_id),
      stock: String(row.owner_stock || ""),
      miles: String(row.owner_miles || ""),
      vehicle: String(row.owner_vehicle || ""),
      createdAt: epochMs(row.owner_created_ms),
      completedAt: epochMs(row.owner_completed_ms),
      updatedAt: epochMs(row.owner_updated_ms),
      photoCount: Number(row.photo_count) || 0,
      walkPhotoCount: Number(row.walk_photo_count) || 0,
      damagePhotoCount: Number(row.damage_photo_count) || 0,
      damageWidePhotoCount: Number(row.damage_wide_photo_count) || 0,
      unclassifiedPhotoCount: Number(row.unclassified_photo_count) || 0,
    })),
  };
}
