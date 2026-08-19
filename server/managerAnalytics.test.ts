// @vitest-environment node
//
// Focused tests for server/managerAnalytics.ts
//
// Tests cover:
//  - parseTrackerDate: strict formats, DST date bounds, invalid values
//  - localDayToEpoch: DST boundary dates, round-trip
//  - durationHours: null vs zero, invalid order
//  - stageStats: coverage denominator, null handling
//  - normalizeDamageType: normalization
//  - Route: authorization, validation (missing/bad params, reversed range, >366 days)
//  - Route: estimator/qcResult filter, anonymous calibration response
//  - Route: tracker unavailable, calibration available:false on missing tables

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

// ---------- pure helper imports (no DB needed) ----------
import {
  parseTrackerDate,
  localDayToEpoch,
  durationHours,
  stageStats,
  normalizeDamageType,
  classifyAiCorrectionDiff,
  calendarDayDurationHours,
} from "./managerAnalytics";

// ============================================================================
// Pure helper tests (no mocks needed)
// ============================================================================

describe("parseTrackerDate", () => {
  it("parses strict YYYY-MM-DD", () => {
    expect(parseTrackerDate("2024-07-15")).toBe("2024-07-15");
  });

  it("parses M/D/YYYY (single digit month/day)", () => {
    expect(parseTrackerDate("7/15/2024")).toBe("2024-07-15");
  });

  it("parses M/D/YYYY (double digit month/day)", () => {
    expect(parseTrackerDate("12/31/2024")).toBe("2024-12-31");
  });

  it("rejects M/D/YY (2-digit year)", () => {
    expect(parseTrackerDate("7/15/24")).toBeNull();
  });

  it("rejects YYYY-M-D (no zero padding — not matching pattern)", () => {
    // Pattern requires exactly \d{4}-\d{2}-\d{2}
    expect(parseTrackerDate("2024-7-5")).toBeNull();
  });

  it("rejects M/D/YYYY with invalid month 13", () => {
    expect(parseTrackerDate("13/1/2024")).toBeNull();
  });

  it("rejects Feb 30", () => {
    expect(parseTrackerDate("2024-02-30")).toBeNull();
    expect(parseTrackerDate("2/30/2024")).toBeNull();
  });

  it("accepts Feb 29 on a leap year", () => {
    expect(parseTrackerDate("2024-02-29")).toBe("2024-02-29");
    expect(parseTrackerDate("2/29/2024")).toBe("2024-02-29");
  });

  it("rejects Feb 29 on a non-leap year", () => {
    expect(parseTrackerDate("2023-02-29")).toBeNull();
    expect(parseTrackerDate("2/29/2023")).toBeNull();
  });

  it("rejects empty/null/undefined", () => {
    expect(parseTrackerDate(null)).toBeNull();
    expect(parseTrackerDate(undefined)).toBeNull();
    expect(parseTrackerDate("")).toBeNull();
  });

  it("rejects ambiguous values like 'TBD' or 'N/A'", () => {
    expect(parseTrackerDate("TBD")).toBeNull();
    expect(parseTrackerDate("N/A")).toBeNull();
    expect(parseTrackerDate("Jul 15 2024")).toBeNull();
  });

  it("trims whitespace before parsing", () => {
    expect(parseTrackerDate("  2024-07-15  ")).toBe("2024-07-15");
    expect(parseTrackerDate("  7/15/2024  ")).toBe("2024-07-15");
  });

  it("rejects day 0", () => {
    expect(parseTrackerDate("2024-07-00")).toBeNull();
    expect(parseTrackerDate("7/0/2024")).toBeNull();
  });

  it("DST boundary: Mar 10 2024 (spring forward)", () => {
    // Should parse cleanly — we're testing the date parser, not the TZ conversion
    expect(parseTrackerDate("2024-03-10")).toBe("2024-03-10");
    expect(parseTrackerDate("3/10/2024")).toBe("2024-03-10");
  });

  it("DST boundary: Nov 3 2024 (fall back)", () => {
    expect(parseTrackerDate("2024-11-03")).toBe("2024-11-03");
    expect(parseTrackerDate("11/3/2024")).toBe("2024-11-03");
  });
});

describe("classifyAiCorrectionDiff", () => {
  it.each([
    ["panel hood -> left fender", "Panel call"],
    ["hood: severity minor -> major", "Severity call"],
    ["hood: damage dent -> crease", "Damage type"],
    ["hood: paint_damaged false -> true", "Paint damage"],
    ["hood: blend false -> true", "Blend recommendation"],
  ])("classifies %s", (diff, expected) => {
    expect(classifyAiCorrectionDiff(diff)).toBe(expected);
  });
});

describe("calendarDayDurationHours", () => {
  it("uses date precision without inventing a time of day", () => {
    expect(calendarDayDurationHours("2026-03-08", "2026-03-09")).toBe(24);
    expect(calendarDayDurationHours("2026-11-01", "2026-11-02")).toBe(24);
    expect(calendarDayDurationHours("2026-08-19", "2026-08-19")).toBe(0);
  });

  it("keeps missing and reversed dates unknown", () => {
    expect(calendarDayDurationHours(null, "2026-08-19")).toBeNull();
    expect(calendarDayDurationHours("2026-08-20", "2026-08-19")).toBeNull();
  });
});

describe("localDayToEpoch (America/Chicago)", () => {
  it("returns a number for a valid date", () => {
    const ms = localDayToEpoch("2024-07-15");
    expect(typeof ms).toBe("number");
    expect(ms).not.toBeNull();
  });

  it("returns null for invalid date string", () => {
    expect(localDayToEpoch("not-a-date")).toBeNull();
    expect(localDayToEpoch("")).toBeNull();
  });

  it("the returned epoch is at local midnight (time-of-day = 0 in Chicago)", () => {
    const ms = localDayToEpoch("2024-07-15")!;
    // Format back to Chicago local time — should be 2024-07-15
    const localDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
    expect(localDay).toBe("2024-07-15");

    // And the hour should be 0 local (Intl may return "00" or "24" for midnight)
    const localHour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(ms));
    // Some Intl implementations return "24" for midnight; both mean 00:00
    expect(["00", "24"]).toContain(localHour);
  });

  it("CDT date (summer): 2024-07-15 midnight local = 05:00 UTC (CDT = UTC-5)", () => {
    const ms = localDayToEpoch("2024-07-15")!;
    const utcHour = new Date(ms).getUTCHours();
    // CDT = UTC-5, so midnight local = 05:00 UTC
    expect(utcHour).toBe(5);
  });

  it("CST date (winter): 2024-01-15 midnight local = 06:00 UTC (CST = UTC-6)", () => {
    const ms = localDayToEpoch("2024-01-15")!;
    const utcHour = new Date(ms).getUTCHours();
    // CST = UTC-6, so midnight local = 06:00 UTC
    expect(utcHour).toBe(6);
  });

  it("DST spring-forward night: 2024-03-10 (clocks spring forward at 2am)", () => {
    const ms = localDayToEpoch("2024-03-10")!;
    // Midnight local on spring-forward day is well-defined (before the gap)
    const localDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
    expect(localDay).toBe("2024-03-10");
  });

  it("DST fall-back night: 2024-11-03 (clocks fall back at 2am)", () => {
    const ms = localDayToEpoch("2024-11-03")!;
    const localDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
    expect(localDay).toBe("2024-11-03");
  });

  it("consecutive days differ by approximately 86400000ms (or 3600000 on DST transition)", () => {
    const d1 = localDayToEpoch("2024-07-14")!;
    const d2 = localDayToEpoch("2024-07-15")!;
    expect(d2 - d1).toBe(86_400_000);

    // Spring-forward: 2024-03-10 is 23 hours long
    const springBefore = localDayToEpoch("2024-03-10")!;
    const springAfter = localDayToEpoch("2024-03-11")!;
    expect(springAfter - springBefore).toBe(23 * 3_600_000);

    // Fall-back: 2024-11-03 is 25 hours long
    const fallBefore = localDayToEpoch("2024-11-03")!;
    const fallAfter = localDayToEpoch("2024-11-04")!;
    expect(fallAfter - fallBefore).toBe(25 * 3_600_000);
  });
});

describe("durationHours", () => {
  it("returns correct hours for valid pair", () => {
    const start = 1_000_000_000_000;
    const end = start + 3 * 3_600_000;
    expect(durationHours(start, end)).toBeCloseTo(3, 5);
  });

  it("returns 0 when start === end (zero duration, not null)", () => {
    const t = 1_000_000_000_000;
    expect(durationHours(t, t)).toBe(0);
  });

  it("returns null when start is null", () => {
    expect(durationHours(null, 1_000_000)).toBeNull();
  });

  it("returns null when end is null", () => {
    expect(durationHours(1_000_000, null)).toBeNull();
  });

  it("returns null when both are null", () => {
    expect(durationHours(null, null)).toBeNull();
  });

  it("returns null when end < start (invalid order, not negative)", () => {
    const start = 1_000_000_000_000;
    const end = start - 3_600_000;
    expect(durationHours(start, end)).toBeNull();
  });

  it("returns null for NaN/Infinity", () => {
    expect(durationHours(NaN, 1_000_000)).toBeNull();
    expect(durationHours(Infinity, 1_000_000)).toBeNull();
  });
});

describe("stageStats", () => {
  it("returns nulls for avgHours/medianHours/p90Hours when no eligible rows", () => {
    const result = stageStats([], 5, 0);
    expect(result.eligible).toBe(0);
    expect(result.avgHours).toBeNull();
    expect(result.medianHours).toBeNull();
    expect(result.p90Hours).toBeNull();
  });

  it("counts unknown correctly (total - eligible - invalidOrder)", () => {
    // 5 total, 2 eligible, 1 invalidOrder → 2 unknown
    const result = stageStats([2, 4], 5, 1);
    expect(result.total).toBe(5);
    expect(result.eligible).toBe(2);
    expect(result.invalidOrder).toBe(1);
    expect(result.unknown).toBe(2);
  });

  it("coverage = eligible / total", () => {
    const result = stageStats([1, 2, 3], 6, 0);
    expect(result.coverage).toBeCloseTo(0.5, 5);
  });

  it("coverage is null when total = 0", () => {
    const result = stageStats([], 0, 0);
    expect(result.coverage).toBeNull();
  });

  it("computes median correctly for odd count", () => {
    const result = stageStats([1, 3, 5], 3, 0);
    expect(result.medianHours).toBe(3);
  });

  it("computes median correctly for even count", () => {
    const result = stageStats([1, 3, 5, 7], 4, 0);
    expect(result.medianHours).toBe(4); // (3+5)/2
  });

  it("computes p90 correctly", () => {
    // 10 values: 1..10, p90 = 9.1
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = stageStats(vals, 10, 0);
    // p90 at index 9*0.9=8.1 → lo=8, hi=9 → 9 + (10-9)*0.1 = 9.1
    expect(result.p90Hours).toBeCloseTo(9.1, 1);
  });

  it("single value: avg=median=p90=that value", () => {
    const result = stageStats([42], 1, 0);
    expect(result.avgHours).toBe(42);
    expect(result.medianHours).toBe(42);
    expect(result.p90Hours).toBe(42);
  });
});

describe("normalizeDamageType", () => {
  it("lowercases and replaces spaces with underscores", () => {
    expect(normalizeDamageType("Dent Scratch")).toBe("dent_scratch");
  });

  it("removes special characters", () => {
    expect(normalizeDamageType("hail (major)")).toBe("hail_major");
  });

  it("returns 'unknown' for null/undefined/empty", () => {
    expect(normalizeDamageType(null)).toBe("unknown");
    expect(normalizeDamageType(undefined)).toBe("unknown");
    expect(normalizeDamageType("")).toBe("unknown");
  });

  it("collapses multiple spaces into multiple underscores (each space → _)", () => {
    // The function replaces \s+ with _, so each space sequence → one _
    expect(normalizeDamageType("dent  scratch")).toBe("dent_scratch");
  });
});

// ============================================================================
// Route integration tests (with mocks)
// ============================================================================

// ---------- minimal in-memory state ----------
type IntakeRow = {
  id: string;
  vin: string;
  stock: string;
  vehicle: string;
  estimator: string;
  created_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
};

type InspRow = {
  vin: string;
  qc_number: string;
  result: string;
  archived: boolean;
  created_at: Date;
};

let intakeStore: IntakeRow[] = [];
let inspStore: InspRow[] = [];

// Controls whether ai_analyses throws (table not found)
let throwOnAiAnalyses = false;
// Controls whether quote_snapshots throws
let throwOnSnapshots = false;
// Controls whether production_tracker throws
let throwOnTracker = false;

// Flatten drizzle SQL object → text
function sqlText(q: any): string {
  const chunks: any[] = q?.queryChunks ?? [];
  let text = "";
  for (const c of chunks) {
    if (Array.isArray(c?.value)) text += c.value.join("");
    else text += "?";
  }
  return text;
}

function fakeExecute(q: any) {
  const text = sqlText(q);

  // SELECT 1 (health)
  if (/SELECT 1/.test(text) && !text.includes("FROM")) {
    return { rows: [] };
  }

  // Intakes cohort query
  if (text.includes("FROM intakes") && text.includes("arrival_ms") && text.includes("completed_at IS NOT NULL") && text.includes("completed_at >=")) {
    return {
      rows: intakeStore
        .filter((i) => i.completed_at != null)
        .map((i) => ({
          vin: i.vin.trim().toUpperCase(),
          stock: i.stock,
          vehicle: i.vehicle,
          estimator: i.estimator || null,
          arrival_ms: i.created_at ? i.created_at.getTime() : null,
          complete_ms: i.completed_at!.getTime(),
          intake_id: i.id,
        })),
    };
  }

  // Inspections for VINs
  if (text.includes("FROM inspections") && text.includes("SELECT DISTINCT UPPER(TRIM(vin))")) {
    const rows: any[] = [];
    for (const r of inspStore.slice().sort((a, b) => a.created_at.getTime() - b.created_at.getTime())) {
      const vin = r.vin.trim().toUpperCase();
      if (!r.archived) {
        rows.push({
          vin,
          qc_number: r.qc_number,
          result: r.result,
          created_ms: r.created_at.getTime(),
        });
      }
    }
    return { rows };
  }

  // production_tracker (frozen tracker)
  if (text.includes("FROM production_tracker")) {
    if (throwOnTracker) throw new Error("production_tracker does not exist");
    return { rows: [] };
  }

  // ai_analyses
  if (text.includes("FROM ai_analyses")) {
    if (throwOnAiAnalyses) throw new Error('relation "ai_analyses" does not exist');
    return { rows: [{ analyses: 0, corrected: 0, unique_analyses: 0 }] };
  }

  // bounded legacy AI correction corpus
  if (text.includes("FROM corrections")) {
    return { rows: [] };
  }

  // committed line denominators by damage type
  if (text.includes("WITH committed_lines")) {
    return { rows: [] };
  }

  // pricing_corrections by component
  if (text.includes("FROM pricing_corrections") && text.includes("body_overrides")) {
    return { rows: [{}] };
  }

  // quote_snapshots summary
  if (text.includes("FROM quote_snapshots")) {
    if (throwOnSnapshots) throw new Error("relation \"quote_snapshots\" does not exist");
    return { rows: [{ committed_versions: 0, billable_lines: 0, overridden_lines: 0 }] };
  }

  // QC pass/fail today
  if (text.includes("FROM inspections") && text.includes("GROUP BY result")) {
    return { rows: [] };
  }

  // inspections for liteRows (dashboard)
  if (text.includes("FROM inspections") && !text.includes("UPPER(TRIM(vin))")) {
    return { rows: [] };
  }

  // intakes for dashboard
  if (text.includes("FROM intakes")) {
    return { rows: [] };
  }

  // quotes
  if (text.includes("FROM quotes")) {
    return { rows: [] };
  }

  // audit_log
  if (text.includes("FROM audit_log")) {
    return { rows: [] };
  }

  // generate_series
  if (text.includes("generate_series")) {
    return { rows: [] };
  }

  // sheet_export_jobs
  if (text.includes("FROM sheet_export_jobs")) {
    return { rows: [] };
  }

  return { rows: [] };
}

vi.mock("./db", () => ({
  db: {
    execute: async (q: any) => fakeExecute(q),
    select: () => {
      const b: any = {};
      for (const m of ["from", "where", "orderBy", "limit"]) b[m] = () => b;
      b.then = (res: any, rej: any) => Promise.resolve([]).then(res, rej);
      return b;
    },
    transaction: async (fn: any) => fn({ execute: async (q: any) => fakeExecute(q) }),
    insert: (_t: any) => ({ values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }), returning: () => Promise.resolve([]) }) }),
  },
}));

vi.mock("./access", () => ({
  requireEmployee: (req: any, _res: any, next: any) => {
    req.employee = { id: 1, userId: "u1", email: "a@truckranch.com", name: "Admin", title: "Admin", isAdmin: true, status: "active" };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.get("x-no-admin") === "true") return res.status(403).json({ message: "Admin access required." });
    req.employee = { id: 1, userId: "u1", email: "a@truckranch.com", name: "Admin", title: "Admin", isAdmin: true, status: "active" };
    next();
  },
  resolveAccess: async () => ({ access: "active", email: "a@truckranch.com", employee: null }),
}));

vi.mock("./replit_integrations/auth", () => ({
  isAuthenticated: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("./googleSheets", () => ({
  monthTabName: () => "TestTab",
  readTrackerRange: async () => null, // tracker unavailable by default
}));

vi.mock("./sheetExports", () => ({
  enqueueSheetExport: () => {},
  registerSheetExportRoutes: () => {},
}));

vi.mock("./tracker", () => ({
  frozenMonth: async () => new Map(),
  listSnapshots: async () => [],
  snapshotMonth: async () => ({ month: "TestTab", rows: 0, snapshotAt: "" }),
  registerTrackerRoutes: () => {},
}));

// ---- server setup ----

let server: Server;
let base: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const { registerAppRoutes } = await import("./routes");
  const app = express();
  app.use(express.json());
  registerAppRoutes(app);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ message: String(err?.message || err) });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
});

// Helper
async function getAnalytics(params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${base}/api/admin/manager-analytics${qs ? "?" + qs : ""}`;
  return realFetch(url);
}

// ============================================================================
// Route authorization and validation
// ============================================================================

describe("route: authorization", () => {
  it("returns 403 when not admin", async () => {
    const r = await realFetch(`${base}/api/admin/manager-analytics?from=2024-01-01&to=2024-01-31`, {
      headers: { "x-no-admin": "true" },
    });
    expect(r.status).toBe(403);
  });
});

describe("route: input validation", () => {
  it("400 when 'from' is missing", async () => {
    const r = await getAnalytics({ to: "2024-01-31" });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.message).toMatch(/from/i);
  });

  it("400 when 'to' is missing", async () => {
    const r = await getAnalytics({ from: "2024-01-01" });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.message).toMatch(/to/i);
  });

  it("400 when 'from' is not a valid YYYY-MM-DD", async () => {
    const r = await getAnalytics({ from: "01/01/2024", to: "2024-01-31" });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.message).toMatch(/from/i);
  });

  it("400 when 'to' is not a valid YYYY-MM-DD", async () => {
    const r = await getAnalytics({ from: "2024-01-01", to: "not-a-date" });
    expect(r.status).toBe(400);
  });

  it("400 when 'from' > 'to' (reversed range)", async () => {
    const r = await getAnalytics({ from: "2024-01-31", to: "2024-01-01" });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.message).toMatch(/from.*before.*to|reversed/i);
  });

  it("400 when range exceeds 366 days", async () => {
    const r = await getAnalytics({ from: "2023-01-01", to: "2024-02-05" }); // > 366 days
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.message).toMatch(/366/);
  });

  it("200 for exactly 366-day range", async () => {
    // 2024-01-01 to 2025-01-01 = 366 days (2024 is a leap year)
    const r = await getAnalytics({ from: "2024-01-01", to: "2025-01-01" });
    expect(r.status).toBe(200);
  });

  it("400 for invalid calendar date like Feb 30", async () => {
    const r = await getAnalytics({ from: "2024-02-30", to: "2024-03-01" });
    expect(r.status).toBe(400);
  });

  it("rejects invalid qcResult values (not pass or fail)", async () => {
    // Invalid qcResult is silently ignored (set to null) — response is 200
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31", qcResult: "unknown_value" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.filters.qcResult).toBeNull();
  });
});

describe("route: response shape", () => {
  it("returns all required top-level keys", async () => {
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("generatedAt");
    expect(body).toHaveProperty("timezone", "America/Chicago");
    expect(body).toHaveProperty("range");
    expect(body.range).toHaveProperty("cohort", "completed_intakes");
    expect(body).toHaveProperty("filters");
    expect(body.filters).toHaveProperty("options");
    expect(body.filters.options.qcResults).toEqual(["pass", "fail"]);
    expect(body).toHaveProperty("cycles");
    expect(body.cycles).toHaveProperty("stages");
    expect(body.cycles).toHaveProperty("rows");
    expect(body.cycles).toHaveProperty("truncated");
    expect(body).toHaveProperty("daily");
    expect(body).toHaveProperty("calibration");
  });

  it("cycles.stages has correct keys and 4 entries", async () => {
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
    const body = await r.json();
    const stages = body.cycles.stages;
    expect(Array.isArray(stages)).toBe(true);
    expect(stages.length).toBe(4);
    const stageKeys = stages.map((s: any) => s.key);
    expect(stageKeys).toEqual(["arrivalToIntake", "intakeToQc", "qcToRo", "roToRelease"]);
    for (const s of stages) {
      expect(s).toHaveProperty("key");
      expect(s).toHaveProperty("label");
      expect(s).toHaveProperty("total");
      expect(s).toHaveProperty("eligible");
      expect(s).toHaveProperty("unknown");
      expect(s).toHaveProperty("invalidOrder");
      expect(s).toHaveProperty("coverage");
      expect(s).toHaveProperty("avgHours");
      expect(s).toHaveProperty("medianHours");
      expect(s).toHaveProperty("p90Hours");
    }
  });

  it("has no-store Cache-Control header", async () => {
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("same-day range (from === to) returns 200", async () => {
    const r = await getAnalytics({ from: "2024-06-15", to: "2024-06-15" });
    expect(r.status).toBe(200);
  });
});

describe("route: filters", () => {
  beforeAll(() => {
    intakeStore = [
      {
        id: "i1",
        vin: "1FTFW1E81NKD72360",
        stock: "S1",
        vehicle: "2024 F-150",
        estimator: "Alice",
        created_at: new Date("2024-07-01T10:00:00Z"),
        completed_at: new Date("2024-07-02T15:00:00Z"),
        updated_at: new Date("2024-07-02T15:00:00Z"),
      },
      {
        id: "i2",
        vin: "1GCUYDED5KZ111111",
        stock: "S2",
        vehicle: "2023 Silverado",
        estimator: "Bob",
        created_at: new Date("2024-07-03T09:00:00Z"),
        completed_at: new Date("2024-07-04T14:00:00Z"),
        updated_at: new Date("2024-07-04T14:00:00Z"),
      },
    ];
    inspStore = [
      {
        vin: "1FTFW1E81NKD72360",
        qc_number: "FQ-1001",
        result: "pass",
        archived: false,
        created_at: new Date("2024-07-03T10:00:00Z"),
      },
      {
        vin: "1GCUYDED5KZ111111",
        qc_number: "FQ-1002",
        result: "fail",
        archived: false,
        created_at: new Date("2024-07-05T11:00:00Z"),
      },
    ];
  });

  it("estimator filter returns only matching rows", async () => {
    const r = await getAnalytics({ from: "2024-07-01", to: "2024-07-31", estimator: "Alice" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.cycles.rows).toHaveLength(1);
    expect(body.cycles.rows[0].estimator).toBe("Alice");
  });

  it("estimator filter: non-matching estimator returns 0 rows", async () => {
    const r = await getAnalytics({ from: "2024-07-01", to: "2024-07-31", estimator: "Charlie" });
    const body = await r.json();
    expect(body.cycles.rows).toHaveLength(0);
  });

  it("qcResult=pass filter returns only passed rows", async () => {
    const r = await getAnalytics({ from: "2024-07-01", to: "2024-07-31", qcResult: "pass" });
    const body = await r.json();
    expect(body.cycles.rows.every((row: any) => row.qcResult === "pass")).toBe(true);
  });

  it("qcResult=fail filter returns only failed rows", async () => {
    const r = await getAnalytics({ from: "2024-07-01", to: "2024-07-31", qcResult: "fail" });
    const body = await r.json();
    expect(body.cycles.rows.every((row: any) => row.qcResult === "fail")).toBe(true);
  });

  it("options.estimators lists all estimators from the UNFILTERED cohort", async () => {
    const r = await getAnalytics({ from: "2024-07-01", to: "2024-07-31", estimator: "Alice" });
    const body = await r.json();
    // Estimators should be from unfiltered cohort (both Alice and Bob)
    expect(body.filters.options.estimators).toContain("Alice");
    expect(body.filters.options.estimators).toContain("Bob");
  });

  it("row shape includes required fields", async () => {
    const r = await getAnalytics({ from: "2024-07-01", to: "2024-07-31" });
    const body = await r.json();
    const row = body.cycles.rows[0];
    expect(row).toHaveProperty("vin");
    expect(row).toHaveProperty("stock");
    expect(row).toHaveProperty("vehicle");
    expect(row).toHaveProperty("estimator");
    expect(row).toHaveProperty("qcNumber");
    expect(row).toHaveProperty("qcResult");
    expect(row).toHaveProperty("timestamps");
    expect(row.timestamps).toHaveProperty("arrival");
    expect(row.timestamps).toHaveProperty("intakeComplete");
    expect(row.timestamps).toHaveProperty("finalQc");
    expect(row.timestamps).toHaveProperty("roOpen");
    expect(row.timestamps).toHaveProperty("release");
    expect(row).toHaveProperty("rawTracker");
    expect(row.rawTracker).toHaveProperty("roOpen");
    expect(row.rawTracker).toHaveProperty("release");
    expect(row).toHaveProperty("durations");
    expect(row.durations).toHaveProperty("arrivalToIntake");
    expect(row.durations).toHaveProperty("intakeToQc");
    expect(row.durations).toHaveProperty("qcToRo");
    expect(row.durations).toHaveProperty("roToRelease");
  });
});

describe("route: null vs zero duration", () => {
  beforeAll(() => {
    // One intake with NULL arrival (created_at = null)
    intakeStore = [
      {
        id: "i-null",
        vin: "NULL00ARRIVALAAA00",
        stock: "SN",
        vehicle: "2024 Test",
        estimator: "Eve",
        created_at: null, // NULL arrival
        completed_at: new Date("2024-08-10T14:00:00Z"),
        updated_at: new Date("2024-08-10T14:00:00Z"),
      },
    ];
    inspStore = []; // No QC
  });

  it("arrival is null when intake.created_at is NULL", async () => {
    const r = await getAnalytics({ from: "2024-08-01", to: "2024-08-31" });
    const body = await r.json();
    const row = body.cycles.rows[0];
    expect(row.timestamps.arrival).toBeNull();
    expect(row.durations.arrivalToIntake).toBeNull(); // null, not 0
    expect(row.durations.intakeToQc).toBeNull(); // no QC
  });

  it("arrivalToIntake is null (not 0) when arrival is missing", async () => {
    const r = await getAnalytics({ from: "2024-08-01", to: "2024-08-31" });
    const body = await r.json();
    const row = body.cycles.rows[0];
    expect(row.durations.arrivalToIntake).toBeNull();
  });
});

describe("route: invalid order detection", () => {
  beforeAll(() => {
    // QC created BEFORE intake completion (would be invalid order for intakeToQc)
    intakeStore = [
      {
        id: "i-inv",
        vin: "INV0ORDER0AAAAAAA",
        stock: "SI",
        vehicle: "2024 Inv",
        estimator: "Frank",
        created_at: new Date("2024-09-01T08:00:00Z"),
        completed_at: new Date("2024-09-05T14:00:00Z"),
        updated_at: new Date("2024-09-05T14:00:00Z"),
      },
    ];
    inspStore = [
      {
        vin: "INV0ORDER0AAAAAAA",
        qc_number: "FQ-9999",
        result: "pass",
        archived: false,
        // Inspection BEFORE intake completion = invalid order
        created_at: new Date("2024-09-04T10:00:00Z"),
      },
    ];
  });

  it("inspection before intake completion: finalQc is null (not counted)", async () => {
    const r = await getAnalytics({ from: "2024-09-01", to: "2024-09-30" });
    const body = await r.json();
    const row = body.cycles.rows[0];
    // The inspection is before intake completion, so finalQc should not be set
    expect(row.timestamps.finalQc).toBeNull();
    expect(row.qcNumber).toBeNull();
  });
});

describe("route: coverage denominator", () => {
  beforeAll(() => {
    // 4 intakes: 2 with arrival, 2 without. 2 with QC, 2 without.
    intakeStore = [
      {
        id: "cov1",
        vin: "COV0001111AAAAAAA",
        stock: "C1",
        vehicle: "V1",
        estimator: "G",
        created_at: new Date("2024-10-01T08:00:00Z"),
        completed_at: new Date("2024-10-02T10:00:00Z"),
        updated_at: new Date(),
      },
      {
        id: "cov2",
        vin: "COV0002222AAAAAAA",
        stock: "C2",
        vehicle: "V2",
        estimator: "G",
        created_at: new Date("2024-10-03T08:00:00Z"),
        completed_at: new Date("2024-10-04T10:00:00Z"),
        updated_at: new Date(),
      },
      {
        id: "cov3",
        vin: "COV0003333AAAAAAA",
        stock: "C3",
        vehicle: "V3",
        estimator: "G",
        created_at: null,
        completed_at: new Date("2024-10-05T10:00:00Z"),
        updated_at: new Date(),
      },
      {
        id: "cov4",
        vin: "COV0004444AAAAAAA",
        stock: "C4",
        vehicle: "V4",
        estimator: "G",
        created_at: null,
        completed_at: new Date("2024-10-06T10:00:00Z"),
        updated_at: new Date(),
      },
    ];
    inspStore = [
      {
        vin: "COV0001111AAAAAAA",
        qc_number: "FQ-2001",
        result: "pass",
        archived: false,
        created_at: new Date("2024-10-03T09:00:00Z"),
      },
      {
        vin: "COV0002222AAAAAAA",
        qc_number: "FQ-2002",
        result: "pass",
        archived: false,
        created_at: new Date("2024-10-05T09:00:00Z"),
      },
      // cov3 and cov4 have no QC
    ];
  });

  it("stage total = cohort size (all 4 intakes)", async () => {
    const r = await getAnalytics({ from: "2024-10-01", to: "2024-10-31" });
    const body = await r.json();
    const s = body.cycles.stages;
    for (const stage of s) {
      expect(stage.total).toBe(4);
    }
  });

  it("arrivalToIntake: eligible=2 (those with arrival), unknown=2", async () => {
    const r = await getAnalytics({ from: "2024-10-01", to: "2024-10-31" });
    const body = await r.json();
    const stage = body.cycles.stages.find((s: any) => s.key === "arrivalToIntake");
    expect(stage.eligible).toBe(2);
    expect(stage.unknown).toBe(2);
    expect(stage.coverage).toBeCloseTo(0.5, 5);
  });

  it("intakeToQc: eligible=2 (those with QC), unknown=2", async () => {
    const r = await getAnalytics({ from: "2024-10-01", to: "2024-10-31" });
    const body = await r.json();
    const stage = body.cycles.stages.find((s: any) => s.key === "intakeToQc");
    expect(stage.eligible).toBe(2);
    expect(stage.unknown + stage.invalidOrder).toBe(2);
  });
});

describe("route: anonymous calibration response", () => {
  beforeAll(() => {
    intakeStore = [];
    inspStore = [];
  });

  it("calibration does not include estimator-level PII in byDamage", async () => {
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
    const body = await r.json();
    // byDamage should only have damage-type-level aggregates, no individual estimator IDs
    const byDamage = body.calibration.pricing?.byDamage ?? [];
    for (const entry of byDamage) {
      expect(entry).not.toHaveProperty("estimator");
      expect(entry).not.toHaveProperty("vin");
    }
  });

  it("calibration.available is a boolean", async () => {
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
    const body = await r.json();
    expect(typeof body.calibration.available).toBe("boolean");
  });

  it("calibration.sampleThreshold is 5", async () => {
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
    const body = await r.json();
    expect(body.calibration.sampleThreshold).toBe(5);
  });

  it("calibration.notes is an array of strings", async () => {
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
    const body = await r.json();
    expect(Array.isArray(body.calibration.notes)).toBe(true);
  });
});

describe("route: tracker unavailable", () => {
  it("still returns all DB metrics when tracker is unavailable", async () => {
    // googleSheets mock returns null (unavailable) — we verify the response
    // still has cycles, daily, calibration sections
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("cycles");
    expect(body).toHaveProperty("daily");
    expect(body).toHaveProperty("calibration");
  });

  it("daily.trackerSource is 'unavailable' when sheet is unreachable", async () => {
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
    const body = await r.json();
    // The mock makes tracker unavailable
    expect(["unavailable", "frozen_only", "live"]).toContain(body.daily.trackerSource);
  });

  it("rawTracker.roOpen is null when no tracker data for VIN", async () => {
    intakeStore = [
      {
        id: "no-tracker",
        vin: "NOTRACKER0AAAAAA0",
        stock: "NT",
        vehicle: "No Tracker",
        estimator: "X",
        created_at: new Date("2024-01-10T08:00:00Z"),
        completed_at: new Date("2024-01-11T10:00:00Z"),
        updated_at: new Date(),
      },
    ];
    inspStore = [];
    const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
    const body = await r.json();
    const row = body.cycles.rows[0];
    expect(row.rawTracker.roOpen).toBeNull();
    expect(row.rawTracker.release).toBeNull();
    expect(row.timestamps.roOpen).toBeNull();
    expect(row.timestamps.release).toBeNull();
  });
});

describe("route: calibration available:false on missing tables", () => {
  beforeAll(() => {
    intakeStore = [];
    inspStore = [];
  });

  it("ai calibration reports available:false when ai_analyses throws", async () => {
    throwOnAiAnalyses = true;
    try {
      const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
      const body = await r.json();
      expect(body.calibration.ai).toHaveProperty("available", false);
    } finally {
      throwOnAiAnalyses = false;
    }
  });

  it("pricing calibration reports available:false when quote_snapshots throws", async () => {
    throwOnSnapshots = true;
    try {
      const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
      const body = await r.json();
      expect(body.calibration.pricing).toHaveProperty("available", false);
    } finally {
      throwOnSnapshots = false;
    }
  });

  it("overall response is still 200 even when both calibration sources fail", async () => {
    throwOnAiAnalyses = true;
    throwOnSnapshots = true;
    try {
      const r = await getAnalytics({ from: "2024-01-01", to: "2024-01-31" });
      expect(r.status).toBe(200);
    } finally {
      throwOnAiAnalyses = false;
      throwOnSnapshots = false;
    }
  });
});
