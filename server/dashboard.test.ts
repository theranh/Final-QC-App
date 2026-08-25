// @vitest-environment node
//
// Regression tests for the "Awaiting Final QC" list:
//  1. Committing an inspection invalidates the dashboard payload cache, so the
//     very next /api/dashboard read no longer lists that VIN as awaiting.
//  2. An inspection stored with a whitespace-padded / lowercase VIN still
//     suppresses its completed intake (VIN normalization in fetchLiteRows).
//  3. The server rejects a second original inspection for a VIN that already
//     has one (409 guard in POST /api/inspections).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const VIN_A = "1FTFW1E81NKD72360";
const VIN_B = "1GCUYDED5KZ111111";
const VIN_C = "3GTU9DED7LG222222";

// ---------- in-memory "intakes" table (Body Quoter data, now local) ----------
// Three completed intakes, mirroring the old remote /api/intakes-completed stub.
type IntakeRow = {
  id: string;
  vin: string;
  stock: string;
  vehicle: string;
  quoteId?: string | null;
  completedAt: number | null;
  updatedAt?: number | null;
  retiredAt?: number | null;
};
const intakeStore: IntakeRow[] = [
  { id: "intake-a", vin: VIN_A, stock: "S-A", vehicle: "2024 F-150", completedAt: 3 },
  { id: "intake-b", vin: VIN_B, stock: "S-B", vehicle: "2023 Silverado", completedAt: 2 },
  { id: "intake-c", vin: VIN_C, stock: "S-C", vehicle: "2022 Sierra", completedAt: 1 },
];

// ---------- in-memory "inspections" table ----------

type StoreRow = {
  id: number;
  qcNumber: string;
  stock: string;
  vehicle: string;
  vin: string;
  result: string;
  status: string;
  imported: boolean;
  data: any;
  createdById: string;
  createdByEmail: string;
  createdByName: string;
  updatedById: string;
  updatedByEmail: string;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
};

const store: StoreRow[] = [];
let counter = 1000;
let nextId = 1;

// Flatten a drizzle SQL object into text + params, so the fake db can route queries.
function sqlParts(q: any): { text: string; params: any[] } {
  const chunks: any[] = q?.queryChunks ?? [];
  let text = "";
  const params: any[] = [];
  for (const c of chunks) {
    if (Array.isArray(c?.value)) text += c.value.join("");
    else if (c && typeof c === "object" && "value" in c) {
      text += "?";
      params.push(c.value);
    } else {
      text += "?";
      params.push(c);
    }
  }
  return { text, params };
}

function liteRowsResult() {
  return {
    rows: store.map((r) => ({
      qc_number: r.qcNumber,
      stock: r.stock,
      vehicle: r.vehicle,
      vin: r.vin,
      result: r.result,
      status: r.status,
      inspector: r.data?.inspector ?? null,
      title: r.data?.title ?? null,
      ts: r.data?.ts != null ? String(r.data.ts) : null,
      cleared_ts: r.data?.clearedTs != null ? String(r.data.clearedTs) : null,
      created_ms: r.createdAt.getTime(),
      open_items: [],
      fail_items: [],
    })),
  };
}

// Configurable accuracy rows returned for the ai_analyses JOIN query.
// Each entry mirrors one GROUP BY week row from the real SQL:
//   { week: 'YYYY-MM-DD', analyses: number, corrected: number }
// Reset per-test to avoid cross-test pollution.
let accuracyRows: { week: string; analyses: number; corrected: number }[] = [];

// When true, the ai_analyses query throws (simulates table-not-yet-created on
// first boot, before ensureAiAnalysesTable completes).
let throwOnAiAnalyses = false;
let quoteRows: any[] = [];
let photoRows: any[] = [];

function fakeExecute(q: any) {
  const { text, params } = sqlParts(q);
  if (text.includes("UPDATE qc_counter") && text.includes("RETURNING")) {
    counter += 1;
    return { rows: [{ value: counter }] };
  }
  if (text.includes("FROM inspections") && text.includes("upper(trim(vin))")) {
    const vin = params[0];
    const hit = store.find((r) => r.vin.trim().toUpperCase() === vin);
    return { rows: hit ? [{ qc_number: hit.qcNumber }] : [] };
  }
  if (text.includes("FROM inspections")) return liteRowsResult();
  // ----- AI accuracy (FROM ai_analyses only; corrected flag is on the row) -----
  if (text.includes("FROM ai_analyses")) {
    if (throwOnAiAnalyses) throw new Error('relation "ai_analyses" does not exist');
    return { rows: accuracyRows.map((r) => ({ week: r.week, analyses: r.analyses, corrected: r.corrected })) };
  }
  // ----- local Body Quoter tables (server/localQuote.ts) -----
  // Completed intakes list (awaiting-QC source), newest first.
  if (text.includes("FROM intakes") && text.includes("ORDER BY COALESCE(completed_at, updated_at) DESC")) {
    return {
      rows: intakeStore
        .filter((i) => i.retiredAt == null)
        .slice()
        .sort((a, b) => (b.completedAt ?? b.updatedAt ?? 0) - (a.completedAt ?? a.updatedAt ?? 0))
        .map((i) => ({
          id: i.id,
          vin: i.vin,
          stock: i.stock,
          vehicle: i.vehicle,
          quote_id: i.quoteId ?? null,
          completed_ms: i.completedAt,
          updated_ms: i.updatedAt ?? null,
        })),
    };
  }
  // This Week completed-intake strip. The fake timestamps are deliberately
  // abstract; this branch models the retirement predicate under test.
  if (text.includes("FROM intakes") && text.includes("COUNT(*)") && text.includes("completed_at IS NOT NULL")) {
    return {
      rows: [{
        n: intakeStore.filter((i) => i.completedAt != null && i.retiredAt == null).length,
      }],
    };
  }
  // Open (not-yet-completed) intake count.
  if (text.includes("FROM intakes") && text.includes("completed_at IS NULL")) {
    return { rows: [{ n: intakeStore.filter((i) => i.completedAt == null).length }] };
  }
  // Per-day completed-intake counts (generate_series LEFT JOIN intakes): the
  // day granularity is irrelevant to these regression tests, so an empty set
  // (0 per day) is a faithful stand-in.
  if (text.includes("generate_series") && text.includes("LEFT JOIN intakes")) {
    return { rows: [] };
  }
  if (text.includes("FROM photos")) return { rows: photoRows };
  // Quote rows can serve both the VIN metrics query and exact-id cover metrics.
  if (text.includes("FROM quotes")) return { rows: quoteRows };
  return { rows: [] }; // audit_log aggregates, SELECT 1, etc.
}

function chainable(result: () => any) {
  const b: any = {};
  for (const m of ["from", "where", "orderBy", "limit", "for"]) b[m] = () => b;
  b.then = (res: any, rej: any) => Promise.resolve(result()).then(res, rej);
  return b;
}

const fakeTx = {
  execute: async (q: any) => fakeExecute(q),
  select: () => chainable(() => [{ value: counter }]),
  insert: (_table: any) => ({
    values: (v: any) => {
      // audit_log inserts are awaited directly; inspections use .returning().
      const isInspection = v && "vin" in v && "data" in v;
      const doInsert = async () => {
        if (!isInspection) return [];
        const row: StoreRow = {
          id: nextId++,
          imported: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...v,
        };
        store.push(row);
        return [row];
      };
      const p: any = doInsert();
      p.returning = () => p;
      return p;
    },
  }),
  transaction: undefined as any,
};

// Emulate pg_advisory_xact_lock: per-key FIFO mutex held until the
// transaction callback finishes, so the concurrency test is faithful.
const advisoryTails = new Map<string, Promise<void>>();

vi.mock("./db", () => ({
  db: {
    execute: async (q: any) => fakeExecute(q),
    select: () => chainable(() => [{ value: counter }]),
    transaction: async (fn: any) => {
      const releases: (() => void)[] = [];
      const tx = {
        ...fakeTx,
        execute: async (q: any) => {
          const { text, params } = sqlParts(q);
          if (text.includes("pg_advisory_xact_lock")) {
            const key = String(params[0]);
            const tail = advisoryTails.get(key) ?? Promise.resolve();
            let release!: () => void;
            const mine = new Promise<void>((r) => (release = r));
            advisoryTails.set(key, tail.then(() => mine));
            await tail;
            releases.push(release);
            return { rows: [] };
          }
          return fakeExecute(q);
        },
      };
      try {
        return await fn(tx);
      } finally {
        for (const r of releases) r();
      }
    },
    insert: fakeTx.insert,
  },
}));

vi.mock("./access", () => ({
  requireEmployee: (req: any, _res: any, next: any) => {
    req.employee = {
      id: 1,
      userId: "u1",
      email: "a@truckranch.com",
      name: "Test Inspector",
      title: "Inspector",
      isAdmin: false,
      status: "active",
    };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  resolveAccess: async () => ({ access: "employee", email: "a@truckranch.com", employee: null }),
}));

vi.mock("./replit_integrations/auth", () => ({
  isAuthenticated: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("./googleSheets", () => ({
  monthTabName: () => "TestTab",
  readTrackerRange: async () => null,
}));

vi.mock("./sheetExports", () => ({
  enqueueSheetExport: () => {},
  registerSheetExportRoutes: () => {},
}));

// No frozen snapshots in these tests — closed months fall through to the live
// (mocked-null) sheet read, exactly as before this feature existed.
vi.mock("./tracker", () => ({
  frozenMonth: async () => new Map(),
  listSnapshots: async () => [],
  snapshotMonth: async () => ({ month: "TestTab", rows: 0, snapshotAt: "" }),
  registerTrackerRoutes: () => {},
}));

// The Body Quoter data is local now (intakes / quotes tables in this app's
// Postgres), routed through the fake db above — no remote fetch, no FLEET_KEY.
const realFetch = globalThis.fetch;

// ---------- boot the real routes against the fakes ----------

let server: Server;
let base: string;

const passBody = (stock: string, vehicle: string, vin: string) => ({
  stock,
  vehicle,
  vin,
  optOut: {},
  items: { mech: [{ item: "Cold start & idle", mark: "p" }] },
  checked: 1,
  failCount: 0,
});

async function getDashboard(from: string, to: string) {
  const r = await realFetch(`${base}/api/dashboard?from=${from}&to=${to}`);
  expect(r.status).toBe(200);
  return r.json();
}

const awaitingVins = (payload: any) => (payload.awaiting as any[]).map((i) => i.vin);

beforeAll(async () => {
  const { registerAppRoutes } = await import("./routes");
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  registerAppRoutes(app);
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("TEST APP ERROR:", err);
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

describe("awaiting Final QC vs committed inspections", () => {
  it("drops a VIN from the awaiting list on the very next read after its inspection commits", async () => {
    // First read: nothing inspected yet — all three intakes are awaiting.
    const before = await getDashboard("2026-08-01", "2026-08-07");
    expect(awaitingVins(before)).toContain(VIN_A);

    // Commit an inspection for VIN_A.
    const post = await realFetch(`${base}/api/inspections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(passBody("S-A", "2024 F-150", VIN_A)),
    });
    expect(post.status).toBe(201);

    // Same range, immediately: the payload cache (25s TTL) would still hold the
    // stale list unless the commit invalidated it.
    const after = await getDashboard("2026-08-01", "2026-08-07");
    expect(awaitingVins(after)).not.toContain(VIN_A);
    expect(awaitingVins(after)).toContain(VIN_B);
  });

  it("suppresses a completed intake even when the stored inspection VIN is whitespace-padded", async () => {
    // Simulate a legacy/imported row saved with padding and lowercase.
    store.push({
      id: nextId++,
      qcNumber: "FQ-9001",
      stock: "S-B",
      vehicle: "2023 Silverado",
      vin: `  ${VIN_B.toLowerCase()}  `,
      result: "pass",
      status: "pass",
      imported: true,
      data: { ts: Date.now(), inspector: "Old App" },
      createdById: "u1",
      createdByEmail: "a@truckranch.com",
      createdByName: "A",
      updatedById: "u1",
      updatedByEmail: "a@truckranch.com",
      updatedByName: "A",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Distinct range → distinct cache key, so this read builds fresh.
    const payload = await getDashboard("2026-07-01", "2026-07-31");
    expect(awaitingVins(payload)).not.toContain(VIN_B);
    expect(awaitingVins(payload)).toContain(VIN_C);
  });

  it("rejects a second original inspection for a VIN that already has one", async () => {
    const post = await realFetch(`${base}/api/inspections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(passBody("S-A2", "2024 F-150", ` ${VIN_A.toLowerCase()} `)),
    });
    expect(post.status).toBe(409);
    const body = await post.json();
    expect(body.message).toMatch(/already has a Final QC/i);
    // No new row was created.
    expect(store.filter((r) => r.vin.trim().toUpperCase() === VIN_A)).toHaveLength(1);
  });

  it("allows exactly one inspection when two commits for the same VIN race", async () => {
    const fire = () =>
      realFetch(`${base}/api/inspections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(passBody("S-C", "2022 Sierra", VIN_C)),
      });
    const [r1, r2] = await Promise.all([fire(), fire()]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(store.filter((r) => r.vin.trim().toUpperCase() === VIN_C)).toHaveLength(1);
  });
});

describe("This Week intake retirement", () => {
  it("does not count retired completed intakes", async () => {
    const retired = intakeStore.find((i) => i.vin === VIN_C)!;
    retired.retiredAt = Date.now();
    try {
      const payload = await getDashboard("2024-01-01", "2024-01-02");
      expect(payload.thisWeek.intakesCompleted).toBe(2);
    } finally {
      delete retired.retiredAt;
    }
  });
});

describe("Vehicles canonical cover payloads", () => {
  it("adds the exact intake gallery's first photo to an awaiting payload", async () => {
    const intake = {
      id: "intake-awaiting-cover",
      vin: "AWAITINGCOVER12345",
      stock: "COVER-A",
      vehicle: "Awaiting cover truck",
      quoteId: "quote-awaiting-cover",
      completedAt: 100,
    };
    intakeStore.push(intake);
    quoteRows = [{ id: intake.quoteId, vin: intake.vin, data: { vin: intake.vin, totals: { hrs: 4 }, lines: [] } }];
    photoRows = [
      { id: "awaiting-later", quote_id: intake.quoteId, ts: 20 },
      { id: "awaiting-first", quote_id: intake.quoteId, ts: 10 },
    ];
    try {
      const payload = await getDashboard("2027-01-01", "2027-01-02");
      const row = payload.awaiting.find((item: any) => item.intakeId === intake.id);
      expect(row).toMatchObject({
        cover: "/api/quoter/photo?id=awaiting-first",
        hrs: 4,
      });
    } finally {
      intakeStore.splice(intakeStore.indexOf(intake), 1);
      quoteRows = [];
      photoRows = [];
    }
  });

  it("adds the selected completed intake's exact first photo to its vehicle payload", async () => {
    const intake = {
      id: "intake-completed-cover",
      vin: "COMPLETEDCOVER123",
      stock: "COVER-C",
      vehicle: "Completed cover truck",
      quoteId: "quote-completed-cover",
      completedAt: 200,
    };
    const inspection: StoreRow = {
      id: nextId++,
      qcNumber: "FQ-COVER",
      stock: intake.stock,
      vehicle: intake.vehicle,
      vin: intake.vin,
      result: "pass",
      status: "pass",
      imported: false,
      data: { ts: 200, inspector: "Cover Tester" },
      createdById: "u1",
      createdByEmail: "a@truckranch.com",
      createdByName: "A",
      updatedById: "u1",
      updatedByEmail: "a@truckranch.com",
      updatedByName: "A",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    intakeStore.push(intake);
    store.push(inspection);
    quoteRows = [{ id: intake.quoteId, vin: intake.vin, data: { vin: intake.vin, lines: [] } }];
    photoRows = [{ id: "completed-first", quote_id: intake.quoteId, ts: 10 }];
    try {
      const payload = await getDashboard("2027-02-01", "2027-02-02");
      const row = payload.vehicles.find((item: any) => item.qcNumber === inspection.qcNumber);
      expect(row).toMatchObject({
        cover: "/api/quoter/photo?id=completed-first",
        intake: { id: intake.id, quoteId: intake.quoteId },
      });
    } finally {
      intakeStore.splice(intakeStore.indexOf(intake), 1);
      store.splice(store.indexOf(inspection), 1);
      quoteRows = [];
      photoRows = [];
    }
  });
});

describe("AI accuracy trend", () => {
  beforeEach(() => {
    // Reset configurable accuracy rows and throw flag before each test.
    accuracyRows = [];
    throwOnAiAnalyses = false;
  });

  it("always returns exactly 8 entries in aiAccuracy regardless of data", async () => {
    // No accuracy data — fakeExecute returns empty rows via accuracyRows=[].
    const payload = await getDashboard("2026-04-01", "2026-04-07");
    expect(Array.isArray(payload.aiAccuracy)).toBe(true);
    expect(payload.aiAccuracy).toHaveLength(8);
  });

  it("fills weeks with zeros when no analyses exist", async () => {
    const payload = await getDashboard("2026-04-08", "2026-04-14");
    for (const w of payload.aiAccuracy as any[]) {
      expect(w.analyses).toBe(0);
      expect(w.corrections).toBe(0);
    }
  });

  it("week labels are YYYY-MM-DD strings in strict ascending order", async () => {
    const payload = await getDashboard("2026-04-15", "2026-04-21");
    const weeks: string[] = (payload.aiAccuracy as any[]).map((w: any) => w.week);
    for (const w of weeks) expect(w).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (let i = 1; i < weeks.length; i++) expect(weeks[i] > weeks[i - 1]).toBe(true);
  });

  it("maps DB rows into the correct week buckets with analyses and corrections", async () => {
    // Simulate: this Monday's week has 10 analyses, 3 corrected.
    // We insert a row using the actual Monday label that last8WeekMondays would
    // produce, so it lands in the last bucket.
    const { last8WeekMondays } = await import("./dashboard");
    const weeks = last8WeekMondays("America/Chicago");
    const thisWeekLabel = weeks[weeks.length - 1]; // most recent bucket
    accuracyRows = [{ week: thisWeekLabel, analyses: 10, corrected: 3 }];

    const payload = await getDashboard("2026-04-22", "2026-04-28");
    const ai = payload.aiAccuracy as any[];
    expect(ai).toHaveLength(8);

    const last = ai[ai.length - 1];
    expect(last.week).toBe(thisWeekLabel);
    expect(last.analyses).toBe(10);
    expect(last.corrections).toBe(3);

    // All other buckets should be zero-filled.
    for (const w of ai.slice(0, 7)) {
      expect(w.analyses).toBe(0);
      expect(w.corrections).toBe(0);
    }
  });

  it("cross-week: a correction in a later week is counted in the analysis week", async () => {
    // The LEFT JOIN attributes corrections to the analysis row's week, not to
    // the correction's own timestamp.  We simulate this by having the DB return
    // corrected=1 for the EARLIER week (where the analysis occurred) even though
    // the real correction row has a later ts — the SQL handles this correctly
    // because it groups by a.ts, not c.ts.
    const { last8WeekMondays } = await import("./dashboard");
    const weeks = last8WeekMondays("America/Chicago");
    // Put the corrected count in week[0] (oldest week), not week[7] (newest).
    accuracyRows = [{ week: weeks[0], analyses: 5, corrected: 5 }];

    const payload = await getDashboard("2026-04-29", "2026-05-05");
    const ai = payload.aiAccuracy as any[];
    // The oldest bucket should show 5 analyses all corrected.
    expect(ai[0].week).toBe(weeks[0]);
    expect(ai[0].analyses).toBe(5);
    expect(ai[0].corrections).toBe(5);
    // No leak into other weeks.
    for (const w of ai.slice(1)) expect(w.analyses).toBe(0);
  });

  it("second-look deduplication: DB returns 1 analysis per analysis_id (ON CONFLICT semantics)", async () => {
    // Simulate what the DB returns after ON CONFLICT DO NOTHING deduplication:
    // two classify calls for the same photo (initial + second look) produce
    // only one ai_analyses row.  The dashboard query receives analyses=1, not 2.
    const { last8WeekMondays } = await import("./dashboard");
    const weeks = last8WeekMondays("America/Chicago");
    const w = weeks[3]; // arbitrary mid-range bucket
    accuracyRows = [{ week: w, analyses: 1, corrected: 0 }];

    const payload = await getDashboard("2026-05-06", "2026-05-12");
    const ai = payload.aiAccuracy as any[];
    const bucket = ai.find((b: any) => b.week === w);
    expect(bucket).toBeDefined();
    expect(bucket.analyses).toBe(1); // not 2 — second-look did not inflate denominator
    expect(bucket.corrections).toBe(0);
  });

  it("returns 200 with aiAccuracy present when ai_analyses table does not exist yet (first boot)", async () => {
    // Simulate the table-not-yet-created case: the query throws a Postgres
    // "relation does not exist" error.  The .catch() in buildPayload must absorb
    // it so the dashboard endpoint still responds with HTTP 200.
    throwOnAiAnalyses = true;

    const r = await realFetch(`${base}/api/dashboard?from=2026-05-13&to=2026-05-19`);
    expect(r.status).toBe(200);

    const payload = await r.json();
    // aiAccuracy key must be present and be an array (empty/zero-filled is fine).
    expect(Object.prototype.hasOwnProperty.call(payload, "aiAccuracy")).toBe(true);
    expect(Array.isArray(payload.aiAccuracy)).toBe(true);
    // Always exactly 8 buckets regardless of the error.
    expect(payload.aiAccuracy).toHaveLength(8);
    for (const w of payload.aiAccuracy as any[]) {
      expect(w.analyses).toBe(0);
      expect(w.corrections).toBe(0);
    }
  });

  it("returns 200 with aiAccuracy present when ai_analyses table is empty (no classify calls yet)", async () => {
    // accuracyRows is already [] from beforeEach — this is the "fresh environment"
    // case where the table exists but has never had a row inserted.
    throwOnAiAnalyses = false;

    const r = await realFetch(`${base}/api/dashboard?from=2026-05-20&to=2026-05-26`);
    expect(r.status).toBe(200);

    const payload = await r.json();
    expect(Object.prototype.hasOwnProperty.call(payload, "aiAccuracy")).toBe(true);
    expect(Array.isArray(payload.aiAccuracy)).toBe(true);
    expect(payload.aiAccuracy).toHaveLength(8);
    for (const w of payload.aiAccuracy as any[]) {
      expect(w.analyses).toBe(0);
      expect(w.corrections).toBe(0);
    }
  });
});
