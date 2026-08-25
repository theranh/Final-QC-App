import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireEmployee } from "./access";

// ---------------------------------------------------------------------------
// Global truck search: VIN, stock number, or QC/FQ number, across
//  - inspections (active + historical + archived Final QC records),
//  - intakes (active and committed),
//  - quotes (quote-only records whose VIN/stock live in the JSON blob).
// Read-only; one endpoint so the client can show a single merged result list
// with full VINs (wrong-truck ambiguity is resolved by showing the whole VIN).
// ---------------------------------------------------------------------------

const rowsOf = (r: any): any[] => (r as any).rows ?? r;

export type SearchResult = {
  kind: "inspection" | "intake" | "quote";
  vin: string;
  stock: string;
  vehicle: string;
  qcNumber: string | null;
  status: string | null; // inspection status (pass/open/cleared) when kind=inspection
  archived: boolean;
  committed: boolean;
  quoteId: string | null;
  intakeId: string | null;
  inspectionId: number | null;
  updatedAt: number | null;
};

export async function searchTrucks(qRaw: string): Promise<SearchResult[]> {
  const q = String(qRaw || "").trim().toUpperCase().slice(0, 40);
  if (q.length < 2) return [];
  // Escape LIKE wildcards typed by the user; match anywhere in the field.
  const like = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";

  const [insp, intk, qts] = await Promise.all([
    db.execute(sql`
      SELECT insp.id, insp.qc_number, insp.vin, insp.stock,
             insp.data->>'vehicle' AS vehicle, insp.status, insp.archived,
             EXTRACT(EPOCH FROM insp.updated_at) * 1000 AS updated_ms,
             linked.id AS intake_id, linked.stock AS intake_stock,
             linked.vehicle AS intake_vehicle, linked.quote_id AS intake_quote_id,
             linked.committed_by AS intake_committed_by,
             EXTRACT(EPOCH FROM linked.updated_at) * 1000 AS intake_updated_ms
      FROM inspections insp
      LEFT JOIN LATERAL (
        SELECT id, stock, vehicle, quote_id, committed_by, updated_at
        FROM intakes
        WHERE UPPER(vin) = UPPER(insp.vin)
          AND retired_at IS NULL
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
      ) linked ON TRUE
      WHERE UPPER(insp.vin) LIKE ${like} OR UPPER(insp.stock) LIKE ${like} OR UPPER(insp.qc_number) LIKE ${like}
      ORDER BY insp.updated_at DESC NULLS LAST
      LIMIT 20
    `),
    db.execute(sql`
      SELECT id, vin, stock, vehicle, quote_id, committed_by,
             EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
      FROM intakes
      WHERE retired_at IS NULL
        AND (UPPER(vin) LIKE ${like} OR UPPER(stock) LIKE ${like})
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 20
    `),
    db.execute(sql`
      SELECT id, committed_by,
             UPPER(COALESCE(data->>'vin', '')) AS vin,
             COALESCE(data->>'stock', '') AS stock,
             COALESCE(data->>'vehicle', '') AS vehicle,
             EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
      FROM quotes
      WHERE UPPER(COALESCE(data->>'vin', '')) LIKE ${like}
         OR UPPER(COALESCE(data->>'stock', '')) LIKE ${like}
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 20
    `),
  ]);

  const out: SearchResult[] = [];
  const intakeVins = new Set<string>();
  for (const r of rowsOf(insp)) {
    const vin = String(r.vin ?? "").trim().toUpperCase();
    const hasIntake = r.intake_id != null;
    if (hasIntake && intakeVins.has(vin)) continue;
    if (hasIntake) intakeVins.add(vin);
    out.push({
      kind: hasIntake ? "intake" : "inspection",
      vin,
      stock: String((hasIntake ? r.intake_stock : null) ?? r.stock ?? "").trim(),
      vehicle: String((hasIntake ? r.intake_vehicle : null) ?? r.vehicle ?? "").trim(),
      qcNumber: r.qc_number != null ? String(r.qc_number) : null,
      status: r.status != null ? String(r.status) : null,
      archived: !!r.archived,
      committed: hasIntake ? r.intake_committed_by != null : true,
      quoteId: hasIntake && r.intake_quote_id != null ? String(r.intake_quote_id) : null,
      intakeId: hasIntake ? String(r.intake_id) : null,
      inspectionId: Number(r.id),
      updatedAt: Math.max(Number(r.updated_ms) || 0, Number(r.intake_updated_ms) || 0) || null,
    });
  }
  for (const r of rowsOf(intk)) {
    const vin = String(r.vin ?? "").trim().toUpperCase();
    if (intakeVins.has(vin)) continue;
    out.push({
      kind: "intake",
      vin,
      stock: String(r.stock ?? "").trim(),
      vehicle: String(r.vehicle ?? "").trim(),
      qcNumber: null,
      status: null,
      archived: false,
      committed: r.committed_by != null,
      quoteId: r.quote_id != null ? String(r.quote_id) : null,
      intakeId: String(r.id) as any,
      inspectionId: null,
      updatedAt: r.updated_ms != null ? Math.round(Number(r.updated_ms)) : null,
    });
  }
  // Quote-only rows: skip quotes whose VIN already has an intake or inspection
  // hit — the richer record is the navigation target and duplicate rows for
  // the same truck are exactly the wrong-truck ambiguity we're avoiding.
  const coveredVins = new Set(out.map((r) => r.vin).filter(Boolean));
  for (const r of rowsOf(qts)) {
    const vin = String(r.vin ?? "").trim().toUpperCase();
    if (vin && coveredVins.has(vin)) continue;
    out.push({
      kind: "quote",
      vin,
      stock: String(r.stock ?? "").trim(),
      vehicle: String(r.vehicle ?? "").trim(),
      qcNumber: null,
      status: null,
      archived: false,
      committed: r.committed_by != null,
      quoteId: String(r.id),
      intakeId: null,
      inspectionId: null,
      updatedAt: r.updated_ms != null ? Math.round(Number(r.updated_ms)) : null,
    });
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return out.slice(0, 40);
}

export function registerSearchRoute(app: Express) {
  app.get("/api/search", requireEmployee, async (req, res) => {
    try {
      const results = await searchTrucks(String(req.query.q ?? ""));
      res.json({ results });
    } catch (e: any) {
      console.error("search error:", e?.message ?? e);
      res.status(500).json({ error: "Search failed" });
    }
  });
}
