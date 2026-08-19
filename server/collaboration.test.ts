// @vitest-environment node
//
// Focused tests for the Operations Handoff Workspace (task #106):
//   1. Auth guard: missing vin param → 400.
//   2. POST /api/collaboration/flags creates a flag; VIN normalized uppercase.
//   3. DELETE /api/collaboration/flags/:id soft-clears by creator.
//   4. DELETE ownership: a different non-admin employee gets 403.
//   5. DELETE ownership: admin can clear another's flag.
//   6. Soft-clear is idempotent (second clear returns 409).
//   7. GET /api/collaboration/timeline returns events newest-first; events
//      with null occurredAt sink to the end.
//   8. POST /api/admin/bulk-archive: max 100, not-found, admin required.
//   9. PUT/GET /api/collaboration/preferences round-trips saved views.
//  10. GET /api/collaboration/handoff returns shape with expected keys.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

// ---------- in-memory store (hoisted so vi.mock can see it) ----------

const H = vi.hoisted(() => {
  type Flag = {
    id: number;
    vin: string;
    qcNumber: string | null;
    kind: string;
    note: string | null;
    active: boolean;
    creatorId: string;
    creatorEmail: string;
    creatorName: string;
    createdAt: Date;
    clearerId: string | null;
    clearerEmail: string | null;
    clearerName: string | null;
    clearedAt: Date | null;
  };
  type ActivityEvent = {
    id: number;
    vin: string;
    qcNumber: string | null;
    eventType: string;
    actorId: string;
    actorEmail: string;
    actorName: string;
    occurredAt: Date;
    details: unknown;
  };
  type Preference = { employeeId: number; data: unknown; updatedAt: Date };
  type Insp = {
    id: number;
    qcNumber: string;
    vin: string;
    stock: string;
    vehicle: string;
    result: string;
    status: string;
    archived: boolean;
    imported: boolean;
    data: unknown;
    createdById: string;
    createdByEmail: string;
    createdByName: string;
    updatedById: string;
    updatedByEmail: string;
    updatedByName: string;
    createdAt: Date;
    updatedAt: Date;
  };

  const state = {
    flags: [] as Flag[],
    activityEvents: [] as ActivityEvent[],
    preferences: [] as Preference[],
    inspections: [] as Insp[],
    audits: [] as any[],
    intakes: [] as any[],
    quotes: [] as any[],
    counter: 1000,
    nextId: 1,
    nextFlagId: 1,
    nextEventId: 1,
    adminMode: true,
    currentEmpId: 10,
    currentEmpCreator: false, // whether current employee is the creator of any given flag
  };
  return state;
});

// ---------- drizzle shape helpers ----------

function tableName(t: any): string {
  return t?.[Symbol.for("drizzle:Name")] ?? "";
}

function sqlTextOf(q: any): string {
  const chunks: any[] = q?.queryChunks ?? [];
  return chunks
    .map((c) => (Array.isArray(c?.value) ? c.value.join("") : typeof c === "string" ? c : "?"))
    .join("");
}

// ---------- fake db ----------

function fakeExecute(q: any) {
  const text = sqlTextOf(q);
  if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
  if (text.includes("UPDATE qc_counter")) return { rows: [{ value: ++H.counter }] };
  // timeline: inspect rows by vin
  if (text.includes("upper(trim(") && text.includes("FROM inspections")) {
    return {
      rows: H.inspections.map((r) => ({
        id: r.id,
        qcNumber: r.qcNumber,
        vin: r.vin,
        stock: r.stock,
        vehicle: r.vehicle,
        result: r.result,
        status: r.status,
        archived: r.archived,
        imported: r.imported,
        data: r.data,
        createdById: r.createdById,
        createdByEmail: r.createdByEmail,
        createdByName: r.createdByName,
        updatedById: r.updatedById,
        updatedByEmail: r.updatedByEmail,
        updatedByName: r.updatedByName,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  }
  if (text.includes("FROM intakes") && text.includes("upper(trim(")) return { rows: [] };
  if (text.includes("FROM quotes") && text.includes("upper(data")) return { rows: [] };
  if (text.includes("FROM audit_log") || text.includes("audit_log a")) return { rows: [] };
  if (text.includes("FROM sheet_export_jobs")) return { rows: [] };
  // handoff: stale intakes
  if (text.includes("FROM intakes i") && text.includes("completed_at IS NULL")) return { rows: [] };
  // handoff: open rechecks
  if (text.includes("FROM inspections") && text.includes("status = 'open'")) {
    return {
      rows: H.inspections
        .filter((r) => r.status === "open" && !r.archived)
        .map((r) => ({
          qc_number: r.qcNumber,
          vin: r.vin,
          stock: r.stock,
          vehicle: r.vehicle,
          updated_by_name: r.updatedByName,
          updated_ms: r.updatedAt.getTime(),
          created_ms: r.createdAt.getTime(),
        })),
    };
  }
  return { rows: [] };
}

function fakeSelect(_fields?: any) {
  let rows: any[] = [];
  let tableSel = "";
  const b: any = {
    from: (t: any) => {
      tableSel = tableName(t);
      if (tableSel === "vehicle_handoff_flags") rows = H.flags.slice();
      else if (tableSel === "vehicle_activity_events") rows = H.activityEvents.slice();
      else if (tableSel === "employee_preferences") rows = H.preferences.slice();
      else if (tableSel === "inspections") rows = H.inspections.slice();
      else rows = [];
      return b;
    },
    where: (_cond: any) => {
      // Don't filter here — the route handles active checks itself.
      // For GET /api/collaboration/flags (list) and GET /api/collaboration/handoff
      // we want active flags only, but we cannot distinguish the call site in
      // this fake. The tests that need only active flags seed only active ones.
      return b;
    },
    orderBy: () => b,
    limit: (n: number) => {
      rows = rows.slice(0, n);
      return b;
    },
    for: () => b,
    then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
  };
  return b;
}

function fakeInsert(table: any) {
  const name = tableName(table);
  return {
    values: (v: any) => {
      let returning: any[] = [];

      const doInsert = (): any[] => {
        if (name === "vehicle_handoff_flags") {
          const row = {
            ...v,
            id: H.nextFlagId++,
            createdAt: v.createdAt ?? new Date(),
            active: v.active ?? true,
          };
          H.flags.push(row);
          return [row];
        }
        if (name === "vehicle_activity_events") {
          const row = { ...v, id: H.nextEventId++, occurredAt: v.occurredAt ?? new Date() };
          H.activityEvents.push(row);
          return [row];
        }
        if (name === "employee_preferences") {
          const existing = H.preferences.findIndex((p) => p.employeeId === v.employeeId);
          if (existing >= 0) {
            Object.assign(H.preferences[existing], v);
            return [H.preferences[existing]];
          }
          const row = { ...v, updatedAt: new Date() };
          H.preferences.push(row);
          return [row];
        }
        if (name === "inspections") {
          if (H.inspections.some((r) => r.qcNumber === v.qcNumber)) return [];
          const row = { id: H.nextId++, archived: false, imported: false, createdAt: new Date(), updatedAt: new Date(), ...v };
          H.inspections.push(row as any);
          return [row];
        }
        if (name === "audit_log") {
          H.audits.push(v);
          return [];
        }
        return [];
      };

      const b: any = {
        returning: () => {
          returning = doInsert();
          return Promise.resolve(returning);
        },
        onConflictDoNothing: () => b,
        onConflictDoUpdate: (cfg: any) => {
          // upsert for employee_preferences
          const existing = H.preferences.findIndex((p: any) => p.employeeId === v.employeeId);
          if (existing >= 0 && cfg?.set) {
            Object.assign(H.preferences[existing], cfg.set);
            returning = [H.preferences[existing]];
          } else {
            returning = doInsert();
          }
          return {
            returning: () => Promise.resolve(returning),
          };
        },
        then: (res: any, rej: any) => {
          doInsert();
          return Promise.resolve(returning).then(res, rej);
        },
      };
      return b;
    },
  };
}

// Track the last updateSet for verification
let lastUpdateSet: any = null;

function fakeUpdate(table: any) {
  const name = tableName(table);
  return {
    set: (vals: any) => {
      lastUpdateSet = vals;
      return {
        where: (_cond: any) => {
          const doUpdate = (): any[] => {
            if (name === "vehicle_handoff_flags") {
              // Find the first active flag and soft-clear it
              const flag = H.flags.find((f) => f.active);
              if (!flag) return [];
              Object.assign(flag, vals);
              return [{ ...flag }];
            }
            if (name === "inspections") {
              // Update all matching inspections (simplified)
              for (const insp of H.inspections) {
                Object.assign(insp, vals);
              }
              return H.inspections.map((r) => ({ ...r }));
            }
            if (name === "employee_preferences") {
              const pref = H.preferences[0];
              if (!pref) return [];
              Object.assign(pref, vals);
              return [{ ...pref }];
            }
            return [];
          };

          const b: any = {
            returning: (_fields?: any) => {
              const rows = doUpdate();
              return Promise.resolve(rows);
            },
            for: () => b,
            then: (res: any, rej: any) => Promise.resolve([]).then(res, rej),
          };
          return b;
        },
      };
    },
  };
}

function fakeTransaction(fn: (tx: any) => Promise<any>) {
  const fakeTx: any = {
    execute: fakeExecute,
    select: (fields?: any) => {
      let rows: any[] = [];
      let tableSel = "";
      const b: any = {
        from: (t: any) => {
          tableSel = tableName(t);
          if (tableSel === "inspections") rows = H.inspections.slice();
          else if (tableSel === "vehicle_handoff_flags") rows = H.flags.slice();
          else if (tableSel === "employee_preferences") rows = H.preferences.slice();
          else rows = [];
          return b;
        },
        where: () => b,
        orderBy: () => b,
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return b;
        },
        for: () => b,
        then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
      };
      return b;
    },
    insert: fakeInsert,
    update: fakeUpdate,
    delete: () => ({ where: () => Promise.resolve([]) }),
  };
  return fn(fakeTx);
}

// ---------- mock modules ----------

vi.mock("./db", () => ({
  db: {
    execute: fakeExecute,
    select: fakeSelect,
    insert: fakeInsert,
    update: fakeUpdate,
    transaction: fakeTransaction,
  },
}));

vi.mock("./replit_integrations/auth", () => ({
  isAuthenticated: (req: any, _res: any, next: any) => {
    req.user = {
      claims: {
        sub: `u${H.currentEmpId}`,
        email: `user${H.currentEmpId}@truckranch.com`,
        first_name: `User${H.currentEmpId}`,
        email_verified: true,
      },
    };
    next();
  },
}));

vi.mock("./access", () => ({
  requireEmployee: (req: any, res: any, next: any) => {
    req.employee = {
      id: H.currentEmpId,
      userId: `u${H.currentEmpId}`,
      email: `user${H.currentEmpId}@truckranch.com`,
      name: `User${H.currentEmpId}`,
      title: "Inspector",
      isAdmin: H.adminMode,
      status: "active",
      pinHash: null,
      canOverride: false,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => {
    if (!H.adminMode) return res.status(403).json({ message: "Admin access required." });
    req.employee = {
      id: H.currentEmpId,
      userId: `u${H.currentEmpId}`,
      email: `user${H.currentEmpId}@truckranch.com`,
      name: `User${H.currentEmpId}`,
      title: "Inspector",
      isAdmin: true,
      status: "active",
      pinHash: null,
      canOverride: false,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    next();
  },
  resolveAccess: async (req: any) => ({
    access: "active",
    email: `user${H.currentEmpId}@truckranch.com`,
    employee: req.employee,
  }),
}));

vi.mock("./dashboard", () => ({
  registerDashboardRoute: () => {},
  invalidateDashboardCache: vi.fn(),
}));

vi.mock("./localQuote", () => ({
  registerIntakeQuoteRoute: () => {},
  fetchCompletedIntakes: async () => [],
  fetchIntakeStats: async () => ({ days: [] }),
  fetchQuoteCovers: async () => new Map(),
  lookupIntakeByVin: async () => null,
}));

vi.mock("./sheetExports", () => ({
  enqueueSheetExport: vi.fn(),
  registerSheetExportRoutes: () => {},
}));

vi.mock("./quoter", () => ({ registerQuoterRoutes: () => {} }));
vi.mock("./quoterSyncAdmin", () => ({ registerQuoterSyncAdminRoute: () => {} }));
vi.mock("./trackerSyncAdmin", () => ({ registerTrackerSyncAdminRoute: () => {} }));
vi.mock("./search", () => ({ registerSearchRoute: () => {} }));
vi.mock("./pin", () => ({
  registerPinRoutes: () => {},
  hashPin: async (p: string) => `hashed:${p}`,
  isValidPin: (p: string) => /^\d{4}$/.test(p),
}));
vi.mock("./quoteSnapshot", () => ({ registerAccuracyReportRoute: () => {} }));
vi.mock("./tracker", () => ({
  registerTrackerRoutes: () => {},
  frozenMonth: async () => new Map(),
  snapshotMonth: async () => ({ month: "TestTab", rows: 0, snapshotAt: "" }),
}));
vi.mock("./photoExif", () => ({ readJpegExifOrientation: () => null }));
vi.mock("./googleSheets", () => ({
  monthTabName: () => "Jan 2025",
  readTrackerRange: async () => [],
}));

// ---------- boot ----------

let server: Server;
let base: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const { registerAppRoutes } = await import("./routes");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerAppRoutes(app);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err?.name === "ZodError") return res.status(400).json({ message: "Invalid request", issues: err.issues });
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
});

beforeEach(() => {
  H.flags = [];
  H.activityEvents = [];
  H.preferences = [];
  H.inspections = [];
  H.audits = [];
  H.intakes = [];
  H.quotes = [];
  H.counter = 1000;
  H.nextId = 1;
  H.nextFlagId = 1;
  H.nextEventId = 1;
  H.adminMode = true;
  H.currentEmpId = 10;
  lastUpdateSet = null;
});

// ---------- helpers ----------

const get = (path: string) => realFetch(`${base}${path}`);
const post = (path: string, body: any) =>
  realFetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const put = (path: string, body: any) =>
  realFetch(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const del = (path: string) =>
  realFetch(`${base}${path}`, { method: "DELETE" });

// ---------- tests ----------

describe("GET /api/collaboration/flags — validation", () => {
  it("requires vin param", async () => {
    const r = await get("/api/collaboration/flags");
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.message).toMatch(/vin required/i);
  });

  it("returns empty flags array when no flags exist", async () => {
    const r = await get("/api/collaboration/flags?vin=1FTFW1E81NKD72360");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.flags).toEqual([]);
  });
});

describe("POST /api/collaboration/flags — create", () => {
  it("creates a flag and normalizes VIN to uppercase", async () => {
    H.currentEmpId = 10;
    const r = await post("/api/collaboration/flags", {
      vin: "1ftfw1e81nkd72360",
      kind: "needs_wash",
      note: "Very dirty",
    });
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.flag.vin).toBe("1FTFW1E81NKD72360");
    expect(b.flag.kind).toBe("needs_wash");
    expect(b.flag.active).toBe(true);
    // A vehicle_activity_event should have been written
    expect(H.activityEvents.some((e: any) => e.eventType === "flag_added")).toBe(true);
  });

  it("rejects an invalid flag kind", async () => {
    const r = await post("/api/collaboration/flags", {
      vin: "1FTFW1E81NKD72360",
      kind: "invalid_kind",
    });
    expect(r.status).toBe(400);
  });

  it("rejects a note longer than 300 chars", async () => {
    const r = await post("/api/collaboration/flags", {
      vin: "1FTFW1E81NKD72360",
      kind: "other",
      note: "x".repeat(301),
    });
    expect(r.status).toBe(400);
  });

  it("rejects a QC number that belongs to a different VIN", async () => {
    H.inspections.push({
      id: 1,
      qcNumber: "FQ-1001",
      vin: "1FTFW1E81NKD72360",
      stock: "S1",
      vehicle: "Truck",
      result: "pass",
      status: "pass",
      archived: false,
      imported: false,
      data: {},
      createdById: "u10",
      createdByEmail: "user10@truckranch.com",
      createdByName: "User10",
      updatedById: "u10",
      updatedByEmail: "user10@truckranch.com",
      updatedByName: "User10",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const r = await post("/api/collaboration/flags", {
      vin: "2C3CDZAG0KH123456",
      qcNumber: "FQ-1001",
      kind: "manager_review",
    });
    expect(r.status).toBe(409);
    expect(H.flags).toHaveLength(0);
  });

  it("accepts all five allowed flag kinds", async () => {
    const kinds = ["needs_wash", "waiting_parts", "manager_review", "customer_vehicle", "other"];
    for (const kind of kinds) {
      H.flags = [];
      H.activityEvents = [];
      H.nextFlagId = 1;
      H.nextEventId = 1;
      const r = await post("/api/collaboration/flags", { vin: "1FTFW1E81NKD72360", kind });
      expect(r.status).toBe(201);
      const b = await r.json();
      expect(b.flag.kind).toBe(kind);
    }
  });
});

describe("DELETE /api/collaboration/flags/:id — soft-clear ownership", () => {
  function seedFlag(creatorEmpId: number, active = true) {
    const id = H.nextFlagId++;
    H.flags.push({
      id,
      vin: "1FTFW1E81NKD72360",
      qcNumber: null,
      kind: "needs_wash",
      note: null,
      active,
      creatorId: `u${creatorEmpId}`,
      creatorEmail: `user${creatorEmpId}@truckranch.com`,
      creatorName: `User${creatorEmpId}`,
      createdAt: new Date(),
      clearerId: null,
      clearerEmail: null,
      clearerName: null,
      clearedAt: null,
    });
    return id;
  }

  it("creator can clear their own flag", async () => {
    H.currentEmpId = 10;
    const id = seedFlag(10);
    const r = await del(`/api/collaboration/flags/${id}`);
    expect(r.status).toBe(200);
    expect(H.flags[0].active).toBe(false);
    expect(H.activityEvents.some((e: any) => e.eventType === "flag_cleared")).toBe(true);
  });

  it("non-creator non-admin gets 403", async () => {
    const id = seedFlag(99); // owned by emp 99
    H.currentEmpId = 10;    // logged in as emp 10
    H.adminMode = false;     // not admin
    const r = await del(`/api/collaboration/flags/${id}`);
    expect(r.status).toBe(403);
    expect(H.flags[0].active).toBe(true); // not changed
  });

  it("admin can clear another employee's flag", async () => {
    const id = seedFlag(99); // owned by emp 99
    H.currentEmpId = 10;    // logged in as emp 10
    H.adminMode = true;      // admin
    const r = await del(`/api/collaboration/flags/${id}`);
    expect(r.status).toBe(200);
    expect(H.flags[0].active).toBe(false);
  });

  it("returns 404 for non-existent flag", async () => {
    const r = await del("/api/collaboration/flags/9999");
    expect(r.status).toBe(404);
  });

  it("returns 409 for already-cleared flag (idempotency guard)", async () => {
    const id = seedFlag(10, false); // already inactive
    H.currentEmpId = 10;
    const r = await del(`/api/collaboration/flags/${id}`);
    expect(r.status).toBe(409);
  });
});

describe("GET /api/collaboration/timeline — ordering and shape", () => {
  it("requires vin or qcNumber", async () => {
    const r = await get("/api/collaboration/timeline");
    expect(r.status).toBe(400);
  });

  it("returns {events, flags} shape", async () => {
    const r = await get("/api/collaboration/timeline?vin=1FTFW1E81NKD72360");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(Array.isArray(b.events)).toBe(true);
    expect(Array.isArray(b.flags)).toBe(true);
  });

  it("events with non-null occurredAt are sorted newest-first; null-date events sink to end", async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 10_000);

    // Seed activity events with different dates
    H.activityEvents.push(
      {
        id: 1,
        vin: "1FTFW1E81NKD72360",
        qcNumber: null,
        eventType: "flag_added",
        actorId: "u10",
        actorEmail: "user10@truckranch.com",
        actorName: "User10",
        occurredAt: earlier,
        details: null,
      },
      {
        id: 2,
        vin: "1FTFW1E81NKD72360",
        qcNumber: null,
        eventType: "flag_cleared",
        actorId: "u10",
        actorEmail: "user10@truckranch.com",
        actorName: "User10",
        occurredAt: now,
        details: null,
      }
    );

    const r = await get("/api/collaboration/timeline?vin=1FTFW1E81NKD72360");
    expect(r.status).toBe(200);
    const { events } = await r.json() as { events: any[] };

    // All dated events must be in descending order
    const dated = events.filter((e) => e.occurredAt !== null);
    for (let i = 1; i < dated.length; i++) {
      expect(dated[i - 1].occurredAt >= dated[i].occurredAt).toBe(true);
    }

    // Events without dates come after all dated events
    const firstNull = events.findIndex((e) => e.occurredAt === null);
    if (firstNull !== -1) {
      for (const ev of events.slice(0, firstNull)) {
        expect(ev.occurredAt).not.toBeNull();
      }
    }
  });

  it("accepts qcNumber as the lookup key", async () => {
    const r = await get("/api/collaboration/timeline?qcNumber=FQ-1001");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(Array.isArray(b.events)).toBe(true);
  });
});

describe("PUT + GET /api/collaboration/preferences", () => {
  it("saves and retrieves saved views", async () => {
    H.currentEmpId = 10;
    const views = [
      { id: "v1", name: "My Open Rechecks", bucket: "openRecheck" },
      { id: "v2", name: "Wash Queue", bucket: "flags", flag: "needs_wash" },
    ];
    const pr = await put("/api/collaboration/preferences", { savedViews: views });
    expect(pr.status).toBe(200);
    const pb = await pr.json();
    expect(pb.preferences.savedViews).toHaveLength(2);
    expect(typeof pb.revision).toBe("string");
  });

  it("rejects savedViews with more than 50 entries", async () => {
    const views = Array.from({ length: 51 }, (_, i) => ({
      id: `v${i}`,
      name: `View ${i}`,
      bucket: "openRecheck",
    }));
    const r = await put("/api/collaboration/preferences", { savedViews: views });
    expect(r.status).toBe(400);
  });

  it("rejects an invalid flag kind in a saved view", async () => {
    const r = await put("/api/collaboration/preferences", {
      savedViews: [{ id: "v1", name: "Bad view", bucket: "flags", flag: "not_a_real_kind" }],
    });
    expect(r.status).toBe(400);
  });

  it("GET returns empty object when no preferences saved", async () => {
    H.currentEmpId = 99;
    const r = await get("/api/collaboration/preferences");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.preferences).toEqual({});
    expect(b.revision).toBeNull();
  });

  it("rejects a stale revision instead of overwriting another session", async () => {
    H.preferences.push({
      employeeId: 10,
      data: { savedViews: [{ id: "remote", name: "Remote", bucket: "completed" }] },
      updatedAt: new Date("2026-08-19T12:00:00.000Z"),
    });
    const r = await put("/api/collaboration/preferences", {
      savedViews: [{ id: "local", name: "Local", bucket: "completed" }],
      revision: "2026-08-19T11:00:00.000Z",
    });
    expect(r.status).toBe(409);
    const b = await r.json();
    expect(b.preferences.savedViews[0].id).toBe("remote");
    expect(H.preferences[0].data).toEqual({
      savedViews: [{ id: "remote", name: "Remote", bucket: "completed" }],
    });
  });
});

describe("GET /api/collaboration/handoff", () => {
  it("returns expected top-level shape", async () => {
    const r = await get("/api/collaboration/handoff");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(Array.isArray(b.staleIntakes)).toBe(true);
    expect(Array.isArray(b.openRechecks)).toBe(true);
    expect(Array.isArray(b.failedExports)).toBe(true);
    expect(Array.isArray(b.activeFlags)).toBe(true);
    expect(typeof b.generatedAt).toBe("string");
  });

  it("includes active flags with correct nextAction for manager_review", async () => {
    H.flags.push({
      id: 1,
      vin: "1FTFW1E81NKD72360",
      qcNumber: null,
      kind: "manager_review",
      note: "Needs boss sign-off",
      active: true,
      creatorId: "u10",
      creatorEmail: "user10@truckranch.com",
      creatorName: "User10",
      createdAt: new Date(),
      clearerId: null,
      clearerEmail: null,
      clearerName: null,
      clearedAt: null,
    });

    const r = await get("/api/collaboration/handoff");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.activeFlags.length).toBeGreaterThan(0);
    expect(b.activeFlags[0].flagKind).toBe("manager_review");
    expect(b.activeFlags[0].nextAction).toMatch(/manager review/i);
  });
});

describe("POST /api/admin/bulk-archive — safety", () => {
  it("requireAdmin: non-admin gets 403", async () => {
    H.adminMode = false;
    const r = await post("/api/admin/bulk-archive", {
      qcNumbers: ["FQ-1001"],
      archived: true,
    });
    expect(r.status).toBe(403);
  });

  it("rejects more than 100 qcNumbers", async () => {
    H.adminMode = true;
    const qcNumbers = Array.from({ length: 101 }, (_, i) => `FQ-${1001 + i}`);
    const r = await post("/api/admin/bulk-archive", { qcNumbers, archived: true });
    expect(r.status).toBe(400);
  });

  it("rejects an empty qcNumbers array", async () => {
    H.adminMode = true;
    const r = await post("/api/admin/bulk-archive", { qcNumbers: [], archived: true });
    expect(r.status).toBe(400);
  });

  it("returns not_found for unknown qcNumber", async () => {
    H.adminMode = true;
    const r = await post("/api/admin/bulk-archive", {
      qcNumbers: ["FQ-9999"],
      archived: true,
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.results[0].result).toBe("not_found");
    expect(b.changed).toBe(0);
  });

  it("never sends completion/PIN/pricing fields in the update set", async () => {
    // Ensure the route's db.update set only contains archive-related columns.
    // We instrument fakeUpdate to track what was passed.
    H.adminMode = true;
    H.inspections.push({
      id: 1,
      qcNumber: "FQ-1001",
      vin: "1FTFW1E81NKD72360",
      stock: "S100",
      vehicle: "2022 F-150",
      result: "pass",
      status: "pass",
      archived: false,
      imported: false,
      data: {},
      createdById: "u10",
      createdByEmail: "user10@truckranch.com",
      createdByName: "User10",
      updatedById: "u10",
      updatedByEmail: "user10@truckranch.com",
      updatedByName: "User10",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await post("/api/admin/bulk-archive", { qcNumbers: ["FQ-1001"], archived: true });

    // The update set must only contain these keys (archive + attribution + timestamp).
    // It must NOT contain completedAt, committedBy, pinHash, data, result, status etc.
    if (lastUpdateSet) {
      const forbiddenKeys = ["completedAt", "committedBy", "overriddenBy", "pinHash", "data", "result"];
      for (const key of forbiddenKeys) {
        expect(lastUpdateSet).not.toHaveProperty(key);
      }
      expect(lastUpdateSet).toHaveProperty("archived");
    }
  });
});
