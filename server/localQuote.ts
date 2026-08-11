import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireEmployee } from "./access";

// Local replacements for what used to be remote Body Quoter reads. The Quoter's
// data now lives in this app's Postgres (quotes / intakes tables), so these
// helpers query it directly. Each mirrors the exact shape the old fleet
// endpoints returned (attached_assets/quoter-src/server.js) so every consumer —
// the dashboard payload, the vehicle card, and the intake damage-quote card —
// keeps its response contract byte-for-byte identical.

const rowsOf = (res: any): any[] => (res?.rows ?? res) as any[];

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
    SELECT vin, stock, vehicle, miles, estimator, quote_id, data,
           EXTRACT(EPOCH FROM completed_at) * 1000 AS completed_ms
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
  return {
    found: true,
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
    quote,
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
      LEFT JOIN intakes i ON i.completed_at::date = d.day::date
      GROUP BY d.day ORDER BY d.day
    `),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM intakes WHERE completed_at IS NULL`),
  ]);
  const days = rowsOf(byDay).map((r) => ({ day: String(r.day), intakes: Number(r.intakes) || 0 }));
  const openIntakes = Number(rowsOf(open)[0]?.n) || 0;
  return { days, total: days.reduce((a, d) => a + d.intakes, 0), openIntakes };
}

// ---------- completed intakes list (was /api/intakes-completed) ----------

export type CompletedIntake = {
  vin: string;
  stock: string;
  vehicle: string;
  estimator: string | null;
  completedAt: number | null;
  inProgress: boolean;
};

/** All intakes for the In-Take Quotes bucket — committed (completed) ones plus
 *  in-progress ones still being worked, newest activity first, VIN normalized. */
export async function fetchCompletedIntakes(): Promise<CompletedIntake[]> {
  const r = await db.execute(sql`
    SELECT vin, stock, vehicle, estimator,
           EXTRACT(EPOCH FROM completed_at) * 1000 AS completed_ms,
           EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
    FROM intakes
    ORDER BY COALESCE(completed_at, updated_at) DESC
  `);
  return rowsOf(r)
    .map((row) => ({
      vin: String(row.vin ?? "").trim().toUpperCase(),
      stock: String(row.stock ?? "").trim(),
      vehicle: String(row.vehicle ?? "").trim(),
      estimator: row.estimator != null ? String(row.estimator).trim() || null : null,
      completedAt: row.completed_ms != null
        ? Math.round(Number(row.completed_ms))
        : row.updated_ms != null ? Math.round(Number(row.updated_ms)) : null,
      inProgress: row.completed_ms == null,
    }))
    .filter((row) => row.vin.length >= 6);
}

// ---------- quote covers for the In-Take Quotes bucket ----------

export type QuoteCover = { cover: string | null; hrs: number | null; usd: number | null; lineCount: number };

/** Latest quote per VIN → its cover thumbnail (first damage-line thumb stored
 *  as `data.cover`) plus hrs/usd/lineCount. Used to enrich the awaiting-QC
 *  cards with a photo, mirroring the old all-quotes list. Read-only. */
export async function fetchQuoteCovers(vins: string[]): Promise<Map<string, QuoteCover>> {
  const out = new Map<string, QuoteCover>();
  const unique = [...new Set(vins.map((v) => String(v || "").trim().toUpperCase()).filter((v) => v.length >= 6))];
  if (!unique.length) return out;
  const res = await db.execute(sql`
    SELECT DISTINCT ON (UPPER(data->>'vin')) UPPER(data->>'vin') AS vin, data
    FROM quotes
    WHERE UPPER(data->>'vin') = ANY(${sql.raw(`ARRAY[${unique.map((v) => `'${v.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
    ORDER BY UPPER(data->>'vin'), (data->>'ts')::bigint DESC
  `);
  const rows = rowsOf(res);
  // The card thumbnail should always be the first walk-around shot — the
  // front driver-side corner — when it exists. Those photos live in the
  // photos table under the deterministic id `<quoteId>_ext_fd_corner`, so one
  // existence check per quote tells us whether to point the card at it.
  const cornerIds = rows
    .map((r) => `${String((r.data as any)?.id || "")}_ext_fd_corner`.slice(0, 60))
    .filter((id) => id.length > "_ext_fd_corner".length);
  const haveCorner = new Set<string>();
  if (cornerIds.length) {
    const pr = await db.execute(sql`
      SELECT id FROM photos
      WHERE id = ANY(${sql.raw(`ARRAY[${cornerIds.map((v) => `'${v.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
    `);
    for (const p of rowsOf(pr)) haveCorner.add(String(p.id));
  }
  for (const r of rows) {
    const q = (r.data as any) || {};
    const lineCount = Array.isArray(q.lines) ? q.lines.filter((l: any) => l && l.cls).length : 0;
    const cornerId = `${String(q.id || "")}_ext_fd_corner`.slice(0, 60);
    // Prefer the front driver-corner walk-around shot, then the stored cover
    // (first damage-line thumb), then the first line that has a thumb.
    const cover = haveCorner.has(cornerId)
      ? `/api/quoter/photo?id=${encodeURIComponent(cornerId)}`
      : typeof q.cover === "string" && q.cover
        ? q.cover
        : Array.isArray(q.lines)
        ? (q.lines.find((l: any) => l && typeof l.thumb === "string" && l.thumb)?.thumb ?? null)
        : null;
    out.set(String(r.vin), {
      cover: cover || null,
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
