import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { inspections, type Inspection } from "@shared/schema";
import { desc } from "drizzle-orm";
import { requireEmployee } from "./access";
import { monthTabName, readTrackerRange } from "./googleSheets";

// Read-only aggregate feed for the VPC live dashboard. One endpoint, three
// sources: the inspections table, the Body Quoter (per-VIN quote lookups via
// FLEET_KEY), and the VPC Production Tracker sheet. Nothing is written
// anywhere; the whole payload is cached briefly so a room of polling phones
// doesn't hammer Sheets or the quoter.

const PAYLOAD_CACHE_MS = 25_000;
const QUOTE_CACHE_MS = 10 * 60_000; // quotes barely change; refresh every 10 min
const QUOTE_CONCURRENCY = 5;
const MAX_FRESH_QUOTES_PER_BUILD = 60; // cap upstream work per refresh
const MAX_VEHICLES = 400; // dashboard shows recent activity, not all history
const SHEETS_TIMEOUT_MS = 10_000;
const TABLE_FIRST_DATA_ROW = 21; // row 20 is the tracker's table header

let payloadCache: { at: number; body: unknown } | null = null;
let payloadInFlight: Promise<unknown> | null = null;

const quoteCache = new Map<string, { at: number; body: IntakeSummary }>();

type IntakeSummary = {
  found: boolean;
  estimator?: string;
  stock?: string;
  quotedAt?: number;
  totals?: { hrs?: number; usd?: number };
  lineCount?: number;
};

type TrackerRow = {
  roOpen: string | null;
  completed: string | null;
  pictureReceived: string | null;
  retailPlan: number | null;
  closedRO: number | null;
  daysPictureToClose: number | null;
  daysInProduction: number | null;
  notes: string | null;
};

// ---------- helpers ----------

const money = (v: unknown): number | null => {
  const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const num = (v: unknown): number | null => {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s || null;
};

/** Bounded deadline so a stalled upstream can never wedge the payload build. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

const MMDD = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "2-digit", day: "2-digit" });

// ---------- quoter (intake) lookups ----------

function quoterConfig(): { base: string; key: string } | null {
  const base = process.env.QUOTER_URL;
  const key = process.env.FLEET_KEY;
  if (!base || !key) return null;
  return { base: base.replace(/\/+$/, ""), key };
}

async function fetchQuote(vin: string): Promise<IntakeSummary> {
  const hit = quoteCache.get(vin);
  if (hit && Date.now() - hit.at < QUOTE_CACHE_MS) return hit.body;
  const cfg = quoterConfig();
  if (!cfg) return { found: false };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`${cfg.base}/api/quote-by-vin?vin=${encodeURIComponent(vin)}`, {
        headers: { "x-fleet-key": cfg.key },
        signal: ctl.signal,
      });
      if (!r.ok) return { found: false };
      const d: any = await r.json();
      const body: IntakeSummary = d?.found
        ? {
            found: true,
            estimator: d.estimator,
            stock: d.stock,
            quotedAt: d.quotedAt,
            totals: { hrs: d.totals?.hrs, usd: d.totals?.usd },
            lineCount: Array.isArray(d.lines) ? d.lines.length : d.lineCount,
          }
        : { found: false };
      quoteCache.set(vin, { at: Date.now(), body });
      if (quoteCache.size > 1000) quoteCache.delete(quoteCache.keys().next().value as string);
      return body;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { found: false };
  }
}

async function fetchQuotes(vins: string[]): Promise<Map<string, IntakeSummary>> {
  const out = new Map<string, IntakeSummary>();
  const unique = [...new Set(vins.filter((v) => v && v.length >= 6))];
  // Serve from cache first (even slightly stale beats blocking the build);
  // only a bounded number of uncached VINs hit the quoter per refresh.
  const queue: string[] = [];
  for (const vin of unique) {
    const hit = quoteCache.get(vin);
    if (hit) out.set(vin, hit.body);
    if ((!hit || Date.now() - hit.at >= QUOTE_CACHE_MS) && queue.length < MAX_FRESH_QUOTES_PER_BUILD) {
      queue.push(vin);
    }
  }
  const workers = Array.from({ length: Math.min(QUOTE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const vin = queue.shift()!;
      out.set(vin, await fetchQuote(vin));
    }
  });
  await Promise.all(workers);
  return out;
}

/** Daily intake counts from the quoter, if it exposes /api/intakes-by-day. */
async function fetchIntakesByDay(days: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const cfg = quoterConfig();
  if (!cfg) return out;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`${cfg.base}/api/intakes-by-day?days=${days}`, {
        headers: { "x-fleet-key": cfg.key },
        signal: ctl.signal,
      });
      if (!r.ok) return out; // endpoint may not exist yet — degrade to zero
      const d: any = await r.json();
      const rows: any[] = Array.isArray(d) ? d : d?.days || d?.rows || [];
      for (const row of rows) {
        const day = text(row?.day ?? row?.date);
        const count = num(row?.intakes ?? row?.count);
        if (day && count != null) out.set(day, count);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // quoter unreachable — intakes just read 0
  }
  return out;
}

// ---------- tracker sheet ----------

/** Summary block (rows 1–19) parsed by label keywords, read as-is per the sheet. */
function parseSummary(rows: string[][] | null): Record<string, number> {
  const summary: Record<string, number> = { completed: 0, retailPlan: 0, closedRO: 0, variance: 0, claimsApproved: 0 };
  if (!rows) return summary;
  // Labels as they appear on the tracker: "Vehicles Completed",
  // "Total Retail Plan $", "Total Closed RO $", "Total Variance $" (NOT the
  // "%" row right under it), and three "Claims Approved — <dept>" rows that
  // sum into one number.
  const want: [string, RegExp, boolean][] = [
    ["completed", /^vehicles\s*completed/i, false],
    ["retailPlan", /retail\s*plan\s*\$/i, false],
    ["closedRO", /closed\s*ro\s*\$/i, false],
    ["variance", /variance\s*\$/i, false],
    ["claimsApproved", /claims?\s*approved/i, true],
  ];
  for (const row of rows) {
    const label = String(row?.[0] ?? "").trim();
    for (const [key, re, sum] of want) {
      if (!re.test(label)) continue;
      // Month value sits in the next non-empty cell to the right (column B).
      for (let v = 1; v < row.length; v++) {
        const val = money(row[v]);
        if (val != null) {
          summary[key] = sum ? summary[key] + val : val;
          break;
        }
      }
      break;
    }
  }
  return summary;
}

function parseVehicleRows(rows: string[][] | null): Map<string, TrackerRow> {
  const out = new Map<string, TrackerRow>();
  if (!rows) return out;
  for (const r of rows) {
    const vin = String(r?.[0] ?? "").trim().toUpperCase();
    if (!vin) continue;
    if (out.has(vin)) continue; // first occurrence wins; repeats keyed off qcNumber client-side
    out.set(vin, {
      roOpen: text(r[1]), // B
      completed: text(r[2]), // C
      pictureReceived: text(r[3]), // D
      retailPlan: money(r[4]), // E
      closedRO: money(r[5]), // F
      daysPictureToClose: num(r[6]), // G
      daysInProduction: num(r[7]), // H
      notes: text(r[16]), // Q
    });
  }
  return out;
}

// ---------- payload assembly ----------

export async function buildPayload(): Promise<unknown> {
  const rows = await db.select().from(inspections).orderBy(desc(inspections.createdAt)).limit(MAX_VEHICLES);

  // Vehicles straight off the inspections table (no photo blobs).
  const vehicles = rows.map((row: Inspection) => {
    const data = (row.data as any) || {};
    const finalizedTs = row.status === "cleared" && data.clearedTs ? Number(data.clearedTs) : Number(data.ts) || new Date(row.createdAt).getTime();
    const fails = ((data.openItems as any[]) || []).map((oi) => ({
      k: oi?.cat,
      item: oi?.item,
      note: oi?.note || "",
    }));
    return {
      vin: row.vin,
      stock: row.stock,
      vehicle: row.vehicle,
      qcNumber: row.qcNumber,
      result: row.result,
      status: row.status,
      inspector: data.inspector || null,
      qcAt: MMDD.format(new Date(finalizedTs)),
      failKeys: [...new Set(fails.map((f) => f.k).filter(Boolean))],
      fails,
      intake: { found: false } as IntakeSummary,
      tracker: null as TrackerRow | null,
    };
  });

  // Daily QC counts (last 14 days) + intake counts from the quoter.
  const daily: { day: string; intakes: number; qcs: number }[] = [];
  const qcByDay = await db.execute(sql`
    SELECT to_char(created_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS day, COUNT(*)::int AS qcs
    FROM inspections
    WHERE created_at > now() - interval '14 days'
    GROUP BY 1 ORDER BY 1
  `);
  const intakeDays = await fetchIntakesByDay(14);
  const qcRows: any[] = (qcByDay as any).rows ?? qcByDay;
  const dayMap = new Map<string, { intakes: number; qcs: number }>();
  for (const r of qcRows) dayMap.set(String(r.day), { intakes: 0, qcs: Number(r.qcs) || 0 });
  for (const [day, intakes] of intakeDays) {
    const cur = dayMap.get(day) || { intakes: 0, qcs: 0 };
    cur.intakes = intakes;
    dayMap.set(day, cur);
  }
  for (const [day, v] of [...dayMap.entries()].sort()) daily.push({ day, ...v });

  // Tracker sheet: current month's tab — summary block + vehicle table.
  let summary: Record<string, number> = { completed: 0, retailPlan: 0, closedRO: 0, variance: 0, claimsApproved: 0 };
  let trackerByVin = new Map<string, TrackerRow>();
  try {
    const tab = monthTabName(new Date());
    const [summaryRows, vehicleRows] = await withTimeout(
      Promise.all([
        readTrackerRange(tab, "A1:H19"),
        readTrackerRange(tab, `A${TABLE_FIRST_DATA_ROW}:Q${TABLE_FIRST_DATA_ROW + 2000}`),
      ]),
      SHEETS_TIMEOUT_MS,
      "Tracker sheet read"
    );
    summary = parseSummary(summaryRows);
    trackerByVin = parseVehicleRows(vehicleRows);
  } catch (err: any) {
    console.error("Dashboard: tracker sheet read failed:", err?.message || err);
  }

  // Intake quotes, batched over the unique VIN list.
  const quotes = await fetchQuotes(vehicles.map((v) => (v.vin || "").toUpperCase()));

  for (const v of vehicles) {
    const vin = (v.vin || "").toUpperCase();
    v.intake = quotes.get(vin) || { found: false };
    v.tracker = trackerByVin.get(vin) || null;
  }

  return { generatedAt: Date.now(), summary, daily, vehicles };
}

export function registerDashboardRoute(app: Express) {
  app.get("/api/dashboard", requireEmployee, async (_req, res, next) => {
    try {
      if (payloadCache && Date.now() - payloadCache.at < PAYLOAD_CACHE_MS) {
        return res.json(payloadCache.body);
      }
      // Single-flight so a burst of polls builds the payload once.
      if (!payloadInFlight) {
        payloadInFlight = buildPayload()
          .then((body) => {
            payloadCache = { at: Date.now(), body };
            return body;
          })
          .finally(() => {
            payloadInFlight = null;
          });
      }
      res.json(await payloadInFlight);
    } catch (err) {
      next(err);
    }
  });
}
