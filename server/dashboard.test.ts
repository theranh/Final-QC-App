// @vitest-environment node
//
// Regression tests for the "Awaiting Final QC" list:
//  1. Committing an inspection invalidates the dashboard payload cache, so the
//     very next /api/dashboard read no longer lists that VIN as awaiting.
//  2. An inspection stored with a whitespace-padded / lowercase VIN still
//     suppresses its completed intake (VIN normalization in fetchLiteRows).
//  3. The server rejects a second original inspection for a VIN that already
//     has one (409 guard in POST /api/inspections).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const QUOTER_BASE = "http://quoter.test";
const VIN_A = "1FTFW1E81NKD72360";
const VIN_B = "1GCUYDED5KZ111111";
const VIN_C = "3GTU9DED7LG222222";

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
  exportInspectionToSheet: async () => {},
}));

// No frozen snapshots in these tests — closed months fall through to the live
// (mocked-null) sheet read, exactly as before this feature existed.
vi.mock("./tracker", () => ({
  frozenMonth: async () => new Map(),
  listSnapshots: async () => [],
  snapshotMonth: async () => ({ month: "TestTab", rows: 0, snapshotAt: "" }),
  registerTrackerRoutes: () => {},
}));

vi.mock("./intakeQuote", () => ({
  registerIntakeQuoteRoute: () => {},
  lookupQuoteByVin: async () => ({ found: false }),
}));

// Quoter HTTP stub: three completed intakes; everything else passes through.
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  if (url.startsWith(QUOTER_BASE)) {
    if (url.includes("/api/intakes-completed")) {
      return new Response(
        JSON.stringify({
          intakes: [
            { vin: VIN_A, stock: "S-A", vehicle: "2024 F-150", completedAt: 3 },
            { vin: VIN_B, stock: "S-B", vehicle: "2023 Silverado", completedAt: 2 },
            { vin: VIN_C, stock: "S-C", vehicle: "2022 Sierra", completedAt: 1 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/api/intake-stats")) {
      return new Response(JSON.stringify({ days: [], total: 0, openIntakes: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch);

process.env.QUOTER_URL = QUOTER_BASE;
process.env.FLEET_KEY = "test-key";

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
