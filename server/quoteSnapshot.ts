import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import { db } from "./db";
import { requireAdmin } from "./access";
import { pricingCorrections, quoteSnapshots, settings, type Quote } from "@shared/schema";
// The SAME verbatim pricing engine the client uses — snapshots must reproduce
// client math exactly, so the engine is imported, never re-implemented.
import { billingCls, billingMap, bodyAlloc, defaultRates, lineHours, quoteTotals, rn } from "../src/lib/quoterPricing.js";

// ---------------------------------------------------------------------------
// Phase 1A — pricing feedback capture.
//
// At PIN commit, an immutable snapshot of the approved quote is written in the
// SAME transaction as the commit itself: if the snapshot cannot be persisted,
// the whole commit fails and the estimator retries. Never fire-and-forget —
// this dataset is the ground truth for future estimating accuracy work.
//
// Idempotency: (quote_id, content_hash) is unique. Retrying the same commit
// re-derives the same hash and inserts nothing new; committing genuinely
// changed content would create a NEW version row, never overwrite history.
// ---------------------------------------------------------------------------

type Tx = Pick<typeof db, "insert" | "execute">;

// Rates exactly as the client resolves them: defaults overlaid by the saved
// settings row (QuoteScreen does `{ ...defaults, ...s.rates }` on sync).
export async function loadEffectiveRates(executor: Tx): Promise<{ rates: Record<string, any>; source: string }> {
  const st = await executor.execute(sql`SELECT value FROM ${settings} WHERE key = 'rates'`);
  const saved = (st.rows?.[0] as any)?.value;
  if (saved && typeof saved === "object") {
    return { rates: { ...defaultRates(), ...saved }, source: "settings" };
  }
  return { rates: defaultRates(), source: "default" };
}

// Strip estimator hour overrides so the engine yields its own answer.
function stripOverrides(cls: Record<string, unknown>): Record<string, unknown> {
  const c = { ...cls };
  delete c.b_override;
  delete c.p_override;
  delete c.ri_override;
  return c;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.001;

interface PerLine {
  b: number;
  p: number;
  ri: number;
  usd: number;
  pdr: boolean;
  pdrUsd: number;
}

const zeroLine = (): PerLine => ({ b: 0, p: 0, ri: 0, usd: 0, pdr: false, pdrUsd: 0 });

// Per-line billed values through the SAME billingMap/billingCls/bodyAlloc
// pipeline the client uses for the quote summary: same-panel merge, severity
// winner, separate damage areas, caps, PDR suppression, and body proration.
// Paint/R&I/PDR attach to the panel's winner line, exactly like the client's
// line cards; body hours come from bodyAlloc's per-line allocation.
function perLineBreakdown(lines: any[], rates: Record<string, any>): Map<string, PerLine> {
  const out = new Map<string, PerLine>();
  const map = billingMap(lines as any);
  const d = rates.dollars || {};
  for (const panel of Object.keys(map)) {
    const m = map[panel];
    const h = lineHours(billingCls(panel, m), rates);
    if (h.pdr) {
      // PDR bills flat dollars on the panel winner (extras force pdr off, so
      // a PDR panel has exactly one line).
      out.set(String(m.winner), { b: 0, p: 0, ri: h.ri, usd: 0, pdr: true, pdrUsd: rn(h.pdrUsd) });
    } else {
      const alloc = bodyAlloc(panel, m, rates);
      for (const [id, b] of Object.entries(alloc.byId)) {
        const cur = out.get(id) || zeroLine();
        out.set(id, { ...cur, b: b as number });
      }
      const winner = out.get(String(m.winner)) || zeroLine();
      out.set(String(m.winner), { ...winner, p: h.p, ri: h.ri });
    }
  }
  for (const [id, v] of out) {
    out.set(id, {
      ...v,
      usd: Math.round(v.b * rn(d.body) + v.p * rn(d.paint) + v.ri * rn(d.ri) + v.pdrUsd),
    });
  }
  return out;
}

export interface SnapshotContext {
  quoteRow: Quote;
  intakeId: string | null;
  committedBy: string;
  overriddenBy: string | null;
}

// Build + persist the snapshot (and any pricing-correction rows) on the given
// transaction. Throws on failure so the surrounding commit rolls back.
export async function captureCommitSnapshot(tx: Tx, ctx: SnapshotContext): Promise<void> {
  const doc = (ctx.quoteRow.data as any) || {};
  const { rates, source } = await loadEffectiveRates(tx);

  const allLines: any[] = Array.isArray(doc.lines) ? doc.lines : [];
  // Billable lines — the exact filter billingMap/quoteTotals use.
  const billable = allLines.filter((l) => l && l.status === "done" && !l.review && l.cls);

  // Per-line billed values through the client's exact billing pipeline —
  // approved (overrides honored) vs the engine's own answer (overrides
  // stripped). Same-panel merges, caps, PDR and body proration all apply.
  const strippedLines = billable.map((l) => ({ ...l, cls: stripOverrides(l.cls) }));
  const finalByLine = perLineBreakdown(billable, rates);
  const calcByLine = perLineBreakdown(strippedLines, rates);

  const engineLines: any[] = [];
  const correctionRows: any[] = [];
  let overridden = 0;

  for (const l of billable) {
    const cls = l.cls as Record<string, unknown>;
    const id = String(l.id || "");
    const fin = finalByLine.get(id) || zeroLine();
    const calc = calcByLine.get(id) || zeroLine();
    const differs =
      !near(calc.b, fin.b) || !near(calc.p, fin.p) || !near(calc.ri, fin.ri) || calc.usd !== fin.usd;
    if (differs) overridden++;

    engineLines.push({
      id,
      panel: cls.panel || "unknown",
      damage: cls.damage_type || "",
      severity: cls.severity || "",
      calc,
      final: fin,
      overridden: differs,
    });

    if (differs) {
      correctionRows.push({
        quoteId: ctx.quoteRow.id,
        intakeId: ctx.intakeId,
        lineId: id,
        vin: String(doc.vin || ""),
        estimator: String(doc.estimator || ""),
        committedBy: ctx.committedBy,
        veh: doc.veh || null,
        panel: String(cls.panel || "unknown"),
        damageType: String(cls.damage_type || ""),
        severity: String(cls.severity || ""),
        aiCls: cls,
        calcB: String(calc.b),
        calcP: String(calc.p),
        calcRi: String(calc.ri),
        calcUsd: String(calc.usd),
        finalB: String(fin.b),
        finalP: String(fin.p),
        finalRi: String(fin.ri),
        finalUsd: String(fin.usd),
      });
    }
  }

  // Quote-level totals, both as approved and as the engine would have priced.
  const finalTotals = quoteTotals(allLines as any, rates);
  const calcTotals = quoteTotals(
    allLines.map((l) => (l && l.cls ? { ...l, cls: stripOverrides(l.cls) } : l)) as any,
    rates,
  );

  const contentHash = createHash("sha256")
    .update(JSON.stringify({ doc, rates }))
    .digest("hex");

  const engine = {
    calcTotals: { B: calcTotals.B, P: calcTotals.P, RI: calcTotals.RI, hrs: calcTotals.hrs, usd: calcTotals.usd, usdPDR: calcTotals.usdPDR },
    finalTotals: { B: finalTotals.B, P: finalTotals.P, RI: finalTotals.RI, hrs: finalTotals.hrs, usd: finalTotals.usd, usdPDR: finalTotals.usdPDR },
    clientTotals: doc.totals || null, // as the client displayed at last save
    lines: engineLines,
    linesSkipped: allLines.length - billable.length, // review/error/unclassified
  };

  const inserted = await tx
    .insert(quoteSnapshots)
    .values({
      quoteId: ctx.quoteRow.id,
      intakeId: ctx.intakeId,
      vin: String(doc.vin || ""),
      stock: String(doc.stock || ""),
      vehicle: String(doc.vehicle || ""),
      veh: doc.veh || null,
      estimator: String(doc.estimator || ""),
      committedBy: ctx.committedBy,
      overriddenBy: ctx.overriddenBy,
      doc,
      rates,
      ratesSource: source,
      engine,
      linesTotal: billable.length,
      linesOverridden: overridden,
      calcUsd: String(calcTotals.usd),
      finalUsd: String(finalTotals.usd),
      contentHash,
    })
    .onConflictDoNothing({ target: [quoteSnapshots.quoteId, quoteSnapshots.contentHash] })
    .returning({ id: quoteSnapshots.id });

  // Conflict = this exact content is already snapshotted (idempotent retry).
  // Its correction rows were written with it in the same transaction, so
  // there is nothing left to do.
  const snapshotId = inserted[0]?.id;
  if (snapshotId == null) return;

  for (const row of correctionRows) {
    await tx
      .insert(pricingCorrections)
      .values({ ...row, snapshotId })
      .onConflictDoNothing({ target: [pricingCorrections.snapshotId, pricingCorrections.lineId] });
  }
}

// ---------------------------------------------------------------------------
// Read-only accuracy report (admin). Observation only — nothing here feeds
// back into pricing.
// ---------------------------------------------------------------------------
export function registerAccuracyReportRoute(app: Express) {
  app.get("/api/quoter/accuracy-report", requireAdmin, (req, res, next) => {
    (async () => {
      const [summary, byPanel, bySeverity] = await Promise.all([
        db.execute(sql`
          SELECT COUNT(*)::int AS quotes,
                 COALESCE(SUM(lines_total), 0)::int AS lines,
                 COALESCE(SUM(lines_overridden), 0)::int AS overridden,
                 COALESCE(SUM(calc_usd::numeric), 0)::float AS calc_usd,
                 COALESCE(SUM(final_usd::numeric), 0)::float AS final_usd
          FROM quote_snapshots`),
        db.execute(sql`
          SELECT panel, COUNT(*)::int AS n,
                 AVG(calc_b::numeric)::float AS avg_calc_b,
                 AVG(final_b::numeric)::float AS avg_final_b,
                 AVG(final_usd::numeric - calc_usd::numeric)::float AS avg_usd_delta
          FROM pricing_corrections GROUP BY panel ORDER BY n DESC, panel`),
        db.execute(sql`
          SELECT severity, COUNT(*)::int AS n,
                 AVG(calc_b::numeric)::float AS avg_calc_b,
                 AVG(final_b::numeric)::float AS avg_final_b,
                 AVG(final_usd::numeric - calc_usd::numeric)::float AS avg_usd_delta
          FROM pricing_corrections GROUP BY severity ORDER BY n DESC, severity`),
      ]);
      const s = (summary.rows?.[0] as any) || {};
      res.set("Cache-Control", "no-store");
      res.json({
        committedQuotes: s.quotes || 0,
        billableLines: s.lines || 0,
        overriddenLines: s.overridden || 0,
        overrideRate: s.lines ? Math.round(((s.overridden || 0) / s.lines) * 1000) / 10 : 0,
        calcUsdTotal: Math.round(s.calc_usd || 0),
        finalUsdTotal: Math.round(s.final_usd || 0),
        byPanel: byPanel.rows,
        bySeverity: bySeverity.rows,
      });
    })().catch(next);
  });
}
