// @vitest-environment node
//
// Backup export & safe import tests:
//  1. GET /api/export returns a versioned backup (inspections + employees +
//     QC counter + metadata) with no PIN hashes, and audits the action.
//  2. POST /api/import adds missing inspections, skips duplicates by FQ number,
//     merges missing employees without touching existing rows, and advances
//     the QC counter past every imported number.
//  3. Non-admins cannot restore the employee list.
//  4. Malformed payloads are rejected with a 400 and import nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { createHash } from "node:crypto";

// ---------- in-memory stores (hoisted so vi.mock can see them) ----------

const H = vi.hoisted(() => {
  const state = {
    inspections: [] as any[],
    employees: [] as any[],
    audits: [] as any[],
    quotes: [] as any[],
    intakes: [] as any[],
    corrections: [] as any[],
    photos: [] as any[],
    tracker: [] as any[],
    counter: 1000,
    nextId: 1,
    nextEmpId: 1,
    nextCorrId: 1,
    adminMode: true,
    storageError: null as Error | null,
    storageBytes: null as Buffer | null,
  };
  return state;
});

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

function fakeExecute(q: any) {
  const { text, params } = sqlParts(q);
  if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
  if (text.includes("UPDATE qc_counter") && text.includes("GREATEST")) {
    H.counter = Math.max(H.counter, Number(params[0]));
    return { rows: [] };
  }
  if (text.includes("UPDATE qc_counter") && text.includes("RETURNING")) {
    H.counter += 1;
    return { rows: [{ value: H.counter }] };
  }
  if (text.includes("data->>'ts'") && text.includes("imported = true")) {
    return {
      rows: H.inspections
        .filter((r) => r.imported)
        .map((r) => ({ vin: r.vin, ts: String(r.data?.ts ?? "") })),
    };
  }
  if (text.includes("upper(trim(vin))")) {
    const vin = params[0];
    const hit = H.inspections.find((r) => r.vin.trim().toUpperCase() === vin);
    return { rows: hit ? [{ qc_number: hit.qcNumber }] : [] };
  }
  if (text.includes("length(data)") && text.includes("FROM photos")) {
    return {
      rows: H.photos.map((p) => ({
        id: p.id,
        quote_id: p.quoteId,
        slot: p.slot ?? null,
        role: p.role ?? "unclassified",
        mime: p.mime,
        ts: p.ts,
        bytes: p.data.length,
        object_key: p.objectKey ?? null,
        sha256: p.sha256 ?? null,
      })),
    };
  }
  if (text.includes("SELECT data") && text.includes("FROM photos")) {
    const hit = H.photos.find((p) => p.id === params[0]);
    return {
      rows: hit
        ? [{
            data: hit.data,
            object_key: hit.objectKey ?? null,
            sha256: hit.sha256 ?? null,
            mime: hit.mime,
          }]
        : [],
    };
  }
  if (text.includes("pg_get_serial_sequence")) return { rows: [] };
  return { rows: [] };
}

// Identify which schema table a drizzle table object refers to.
function tableName(t: any): string {
  return t?.[Symbol.for("drizzle:Name")] ?? "";
}

function selectRows(table: any) {
  const name = tableName(table);
  if (name === "inspections") return H.inspections.slice();
  if (name === "employees") return H.employees.slice();
  if (name === "qc_counter") return [{ id: 1, value: H.counter }];
  if (name === "audit_log") return H.audits.slice();
  if (name === "quotes") return H.quotes.slice();
  if (name === "intakes") return H.intakes.slice();
  if (name === "corrections") return H.corrections.slice();
  if (name === "production_tracker") return H.tracker.slice();
  if (name === "photos") return H.photos.slice();
  return [];
}

function fakeSelect(fields?: any) {
  let rows: any[] = [];
  const b: any = {
    from: (t: any) => {
      rows = selectRows(t);
      // /api/backup-status: select({ at }) filtered to "exported", newest first.
      if (tableName(t) === "audit_log" && fields && "at" in fields) {
        rows = H.audits
          .filter((a) => a.action === "exported")
          .slice()
          .sort((a, b2) => new Date(b2.at).getTime() - new Date(a.at).getTime())
          .map((a) => ({ at: new Date(a.at) }));
      }
      return b;
    },
    where: () => b,
    orderBy: () => b,
    limit: () => b,
    for: () => b,
    then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
  };
  return b;
}

function fakeInsert(table: any) {
  const name = tableName(table);
  return {
    values: (v: any) => {
      let conflict = false;
      const doInsert = () => {
        if (name === "audit_log") {
          H.audits.push({ ...v });
          return [];
        }
        if (name === "employees") {
          if (H.employees.some((e) => e.email === v.email)) {
            conflict = true;
            return [];
          }
          const row = {
            id: H.nextEmpId++,
            userId: null,
            pinHash: null,
            canOverride: false,
            active: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...v,
          };
          H.employees.push(row);
          return [row];
        }
        if (name === "inspections") {
          if (H.inspections.some((r) => r.qcNumber === v.qcNumber)) {
            conflict = true;
            return [];
          }
          const row = { id: H.nextId++, imported: false, createdAt: new Date(), updatedAt: new Date(), ...v };
          H.inspections.push(row);
          return [row];
        }
        if (name === "quotes" || name === "intakes" || name === "photos") {
          const store = name === "quotes" ? H.quotes : name === "intakes" ? H.intakes : H.photos;
          if (store.some((r: any) => r.id === v.id)) {
            conflict = true;
            return [];
          }
          const row = { ...v };
          store.push(row);
          return [row];
        }
        if (name === "corrections") {
          if (v.id != null && H.corrections.some((r: any) => r.id === v.id)) {
            conflict = true;
            return [];
          }
          const row = { id: v.id ?? H.nextCorrId, ...v };
          H.nextCorrId = Math.max(H.nextCorrId, row.id) + 1;
          H.corrections.push(row);
          return [row];
        }
        if (name === "production_tracker") {
          if (H.tracker.some((r: any) => r.vin === v.vin && r.month === v.month)) {
            conflict = true;
            return [];
          }
          const row = { ...v };
          H.tracker.push(row);
          return [row];
        }
        return [];
      };
      const p: any = Promise.resolve().then(doInsert);
      p.onConflictDoNothing = () => p;
      p.returning = () => p.then((rows: any[]) => (conflict ? [] : rows));
      return p;
    },
  };
}

const fakeDb: any = {
  execute: async (q: any) => fakeExecute(q),
  select: (fields?: any) => fakeSelect(fields),
  insert: fakeInsert,
  update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  transaction: async (fn: any) => fn(fakeDb),
};

vi.mock("./db", () => ({ db: fakeDb }));

vi.mock("./objectStorage", async () => {
  const actual = await vi.importActual<typeof import("./objectStorage")>("./objectStorage");
  return {
    ...actual,
    objectStorage: {
      readBytes: async () => {
        if (H.storageError) throw H.storageError;
        if (H.storageBytes) return H.storageBytes;
        throw new Error("No mocked Object Storage result");
      },
    },
  };
});

const makeEmp = () => ({
  id: 1,
  userId: "u1",
  email: "admin@truckranch.com",
  name: "Test Admin",
  title: "Manager",
  isAdmin: H.adminMode,
  status: "active",
});

vi.mock("./access", () => ({
  requireEmployee: (req: any, _res: any, next: any) => {
    req.employee = makeEmp();
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => {
    req.employee = makeEmp();
    if (!req.employee.isAdmin) return res.status(403).json({ message: "Admin access required." });
    next();
  },
  resolveAccess: async () => ({ access: "active", email: "admin@truckranch.com", employee: makeEmp() }),
}));

vi.mock("./replit_integrations/auth", () => ({
  isAuthenticated: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("./googleSheets", () => ({
  monthTabName: () => "TestTab",
  readTrackerRange: async () => null,
  exportInspectionToSheet: async () => {},
}));

vi.mock("./tracker", () => ({
  frozenMonth: async () => new Map(),
  listSnapshots: async () => [],
  snapshotMonth: async () => ({ month: "TestTab", rows: 0, snapshotAt: "" }),
  registerTrackerRoutes: () => {},
}));

// ---------- boot the real routes against the fakes ----------

let server: Server;
let base: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const { registerAppRoutes } = await import("./routes");
  const app = express();
  app.use(express.json({ limit: "5mb" }));
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
  H.inspections.length = 0;
  H.employees.length = 0;
  H.audits.length = 0;
  H.quotes.length = 0;
  H.intakes.length = 0;
  H.corrections.length = 0;
  H.photos.length = 0;
  H.tracker.length = 0;
  H.counter = 1000;
  H.nextId = 1;
  H.nextEmpId = 1;
  H.nextCorrId = 1;
  H.adminMode = true;
  H.storageError = null;
  H.storageBytes = null;
});

function seedInspection(qcNumber: string, vin: string, ts: number, imported = false) {
  H.inspections.push({
    id: H.nextId++,
    qcNumber,
    stock: "S-1",
    vehicle: "2024 F-150",
    vin,
    result: "pass",
    status: "pass",
    imported,
    data: { ts, inspector: "A", items: {}, rechecks: [], openItems: [] },
    createdById: "u1",
    createdByEmail: "admin@truckranch.com",
    createdByName: "Test Admin",
    createdAt: new Date(ts),
    updatedById: "u1",
    updatedByEmail: "admin@truckranch.com",
    updatedByName: "Test Admin",
    updatedAt: new Date(ts),
  });
}

function seedEmployee(email: string, extra: any = {}) {
  H.employees.push({
    id: H.nextEmpId++,
    userId: null,
    email,
    name: "",
    title: "Inspector",
    isAdmin: false,
    status: "pending",
    pinHash: null,
    canOverride: false,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  });
}

const post = (path: string, body: any) =>
  realFetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /api/export", () => {
  it("returns a versioned full backup with metadata, employees (no PIN hashes) and the counter", async () => {
    seedInspection("FQ-1001", "1FTFW1E81NKD72360", 1000000);
    seedEmployee("worker@truckranch.com", { name: "W", status: "active", pinHash: "secret-hash" });
    H.counter = 1001;

    const r = await realFetch(`${base}/api/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("attachment");
    const b = await r.json();

    expect(b.app).toBe("TruckRanch Final QC");
    expect(b.version).toBe(2);
    expect(typeof b.exportedAt).toBe("string");
    expect(b.seq).toBe(1001);
    expect(b.inspections).toHaveLength(1);
    expect(b.inspections[0]).toMatchObject({ id: "FQ-1001", vin: "1FTFW1E81NKD72360", result: "pass" });
    expect(b.employees).toHaveLength(1);
    expect(b.employees[0]).toEqual({
      email: "worker@truckranch.com",
      name: "W",
      title: "Inspector",
      isAdmin: false,
      status: "active",
    });
    expect(JSON.stringify(b)).not.toContain("secret-hash");
    expect(H.audits.some((a) => a.action === "exported")).toBe(true);
  });

  it("covers Quoter data with photo metadata only by default, and streams full photos with ?photos=full", async () => {
    H.quotes.push({ id: "q1", data: { total: 1200 }, updatedAt: new Date(1000), committedBy: "W", overriddenBy: null });
    H.intakes.push({
      id: "i1", vin: "VINQ0000000000001", stock: "S-9", vehicle: "2023 Ram", miles: "1", estimator: "E",
      quoteId: "q1", data: { note: "x" }, completedAt: new Date(2000), updatedAt: new Date(2000),
      committedBy: "W", overriddenBy: null,
    });
    H.corrections.push({ id: 7, ts: 3000, diffs: [{ f: "a" }] });
    H.tracker.push({ vin: "VINQ0000000000001", month: "Jul 2026", retailPlanUsd: "1500", closedRoUsd: "900", daysToClose: 4, snapshotAt: new Date(4000) });
    H.photos.push({ id: "p1", quoteId: "q1", slot: "front", mime: "image/jpeg", ts: 5000, data: Buffer.from("hello-photo-bytes") });

    // Default export: metadata only — no photo binary anywhere in the payload.
    const r = await realFetch(`${base}/api/export`);
    const b = await r.json();
    expect(b.photosIncluded).toBe(false);
    expect(b.quoter.quotes[0]).toMatchObject({ id: "q1", committedBy: "W" });
    expect(b.quoter.intakes[0]).toMatchObject({ id: "i1", vin: "VINQ0000000000001", quoteId: "q1" });
    expect(b.quoter.corrections[0]).toMatchObject({ id: 7, ts: 3000 });
    expect(b.quoter.productionTracker[0]).toMatchObject({ vin: "VINQ0000000000001", month: "Jul 2026", daysToClose: 4 });
    expect(b.quoter.photos[0]).toEqual({
      id: "p1",
      quoteId: "q1",
      slot: "front",
      role: "unclassified",
      mime: "image/jpeg",
      ts: 5000,
      bytes: 17,
      objectKey: null,
      sha256: null,
    });
    expect(b.quoterPhotos).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain(Buffer.from("hello-photo-bytes").toString("base64"));

    // Full export: photo binary rides as base64 in quoterPhotos.
    const rf = await realFetch(`${base}/api/export?photos=full`);
    const bf = await rf.json();
    expect(bf.photosIncluded).toBe(true);
    expect(bf.quoterPhotos).toHaveLength(1);
    expect(bf.quoterPhotos[0]).toMatchObject({ id: "p1", quoteId: "q1", mime: "image/jpeg", ts: 5000 });
    expect(Buffer.from(bf.quoterPhotos[0].b64, "base64").toString()).toBe("hello-photo-bytes");
  });

  it("serves PostgreSQL bytes from both gateways and stays healthy when an object is missing", async () => {
    const data = Buffer.from("postgres-fallback-bytes");
    H.photos.push({
      id: "p-missing",
      quoteId: "q1",
      slot: "front",
      role: "walkaround",
      mime: "image/jpeg",
      ts: 5001,
      data,
      objectKey: "photos/q1/p-missing",
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    H.storageError = new Error("404: No such object");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const privateGateway = await realFetch(`${base}/api/photos/p-missing`);
    expect(privateGateway.status).toBe(200);
    expect(Buffer.from(await privateGateway.arrayBuffer())).toEqual(data);

    H.storageError = new Error("ECONNRESET");
    const quoterGateway = await realFetch(`${base}/api/quoter/photo?id=p-missing`);
    expect(quoterGateway.status).toBe(200);
    expect(Buffer.from(await quoterGateway.arrayBuffer())).toEqual(data);

    const health = await realFetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(consoleError).toHaveBeenCalledWith(
      "Object Storage photo read failed; falling back to PostgreSQL",
      expect.objectContaining({
        objectKey: "photos/q1/p-missing",
        photoId: "p-missing",
      }),
    );
    consoleError.mockRestore();
  });

  it("is admin-only", async () => {
    H.adminMode = false;
    const r = await realFetch(`${base}/api/export`);
    expect(r.status).toBe(403);
  });
});

describe("GET /api/backup-status", () => {
  const seedAudit = (action: string, at: Date) =>
    H.audits.push({ action, at, actorId: "u1", actorEmail: "admin@truckranch.com", actorName: "Test Admin" });

  it("returns null when no export has ever happened", async () => {
    seedAudit("created", new Date("2026-08-01T10:00:00Z")); // other actions don't count
    const r = await realFetch(`${base}/api/backup-status`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ lastExportAt: null });
  });

  it("returns the newest 'exported' timestamp when several exist", async () => {
    seedAudit("exported", new Date("2026-08-01T08:00:00Z"));
    seedAudit("exported", new Date("2026-08-05T12:30:00Z")); // newest
    seedAudit("exported", new Date("2026-08-03T09:15:00Z"));
    seedAudit("created", new Date("2026-08-06T00:00:00Z")); // newer, but not an export
    const r = await realFetch(`${base}/api/backup-status`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ lastExportAt: "2026-08-05T12:30:00.000Z" });
  });

  it("is admin-only", async () => {
    H.adminMode = false;
    const r = await realFetch(`${base}/api/backup-status`);
    expect(r.status).toBe(403);
  });
});

describe("POST /api/import", () => {
  it("adds missing inspections, skips duplicates, merges missing employees, advances counter", async () => {
    seedInspection("FQ-1001", "VINEXISTING000001", 500);
    seedEmployee("existing@truckranch.com", { status: "active", isAdmin: true, title: "Manager" });
    H.counter = 1001;

    const r = await post("/api/import", {
      app: "TruckRanch Final QC",
      version: 1,
      exportedAt: new Date(0).toISOString(),
      seq: 2000,
      inspections: [
        { id: "FQ-1001", ts: 500, stock: "S-1", vehicle: "V", vin: "VINEXISTING000001", result: "pass", status: "pass" },
        { id: "FQ-1500", ts: 600, stock: "S-2", vehicle: "V2", vin: "VINNEW00000000002", result: "fail", status: "open" },
      ],
      employees: [
        // Existing row: must be skipped, never downgraded.
        { email: "existing@truckranch.com", name: "X", title: "Nope", isAdmin: false, status: "inactive" },
        { email: "newhire@truckranch.com", name: "New", title: "VRA", status: "active" },
      ],
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ imported: 1, skipped: 1, employeesAdded: 1, employeesSkipped: 1 });

    // Existing employee untouched.
    const existing = H.employees.find((e) => e.email === "existing@truckranch.com");
    expect(existing).toMatchObject({ status: "active", isAdmin: true, title: "Manager" });
    const added = H.employees.find((e) => e.email === "newhire@truckranch.com");
    expect(added).toMatchObject({ name: "New", title: "VRA", status: "active", isAdmin: false });

    // Counter advanced past both the backup seq (2000) and every FQ number seen.
    expect(H.counter).toBe(1999);
    expect(b.nextQc).toBe(2000);

    // Audited: per-record + summary.
    expect(H.audits.some((a) => a.action === "imported")).toBe(true);
    const summary = H.audits.find((a) => a.action === "import_summary");
    expect(summary?.details).toMatchObject({ imported: 1, skipped: 1, employeesAdded: 1, employeesSkipped: 1 });
  });

  it("re-importing the same backup is a no-op (all duplicates skipped)", async () => {
    const payload = {
      inspections: [
        { id: "FQ-1100", ts: 700, stock: "S", vehicle: "V", vin: "VINAAAA0000000001", result: "pass", status: "pass" },
      ],
    };
    const r1 = await post("/api/import", payload);
    expect((await r1.json()).imported).toBe(1);
    const r2 = await post("/api/import", payload);
    const b2 = await r2.json();
    expect(b2.imported).toBe(0);
    expect(b2.skipped).toBe(1);
    expect(H.inspections).toHaveLength(1);
  });

  it("restores missing Quoter rows and photos additively, skipping existing ones", async () => {
    H.quotes.push({ id: "q1", data: { total: 999 }, updatedAt: new Date(1), committedBy: "Keep", overriddenBy: null });
    H.photos.push({ id: "p1", quoteId: "q1", slot: null, mime: "image/jpeg", ts: 1, data: Buffer.from("orig") });

    const r = await post("/api/import", {
      inspections: [],
      quoter: {
        quotes: [
          { id: "q1", data: { total: 1 }, committedBy: "Overwrite?" }, // existing → skipped
          { id: "q2", data: { total: 2 }, updatedAt: new Date(50).toISOString() },
        ],
        intakes: [{ id: "i1", vin: "VINQ0000000000001", data: {}, completedAt: new Date(60).toISOString() }],
        corrections: [{ id: 3, ts: 70, diffs: [] }],
        productionTracker: [{ vin: "VINQ0000000000001", month: "Jun 2026", retailPlanUsd: 100 }],
      },
      quoterPhotos: [
        { id: "p1", quoteId: "q1", mime: "image/jpeg", ts: 1, b64: Buffer.from("dupe").toString("base64") },
        { id: "p2", quoteId: "q2", slot: "rear", role: "damage", mime: "image/png", ts: 2, b64: Buffer.from("new-bytes").toString("base64") },
      ],
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.quoter).toMatchObject({
      quotesAdded: 1, quotesSkipped: 1,
      intakesAdded: 1,
      correctionsAdded: 1,
      trackerRowsAdded: 1,
      photosAdded: 1, photosSkipped: 1,
    });
    // Existing rows untouched.
    expect(H.quotes.find((q) => q.id === "q1")).toMatchObject({ data: { total: 999 }, committedBy: "Keep" });
    expect(H.photos.find((p) => p.id === "p1")!.data.toString()).toBe("orig");
    // New photo decoded back to binary.
    expect(H.photos.find((p) => p.id === "p2")!.data.toString()).toBe("new-bytes");
    expect(H.photos.find((p) => p.id === "p2")!.role).toBe("unclassified");
    const summary = H.audits.find((a) => a.action === "import_summary");
    expect(summary?.details).toMatchObject({ quotesAdded: 1, photosAdded: 1 });
  });

  it("rejects Quoter restore for non-admins", async () => {
    H.adminMode = false;
    const r = await post("/api/import", {
      inspections: [],
      quoter: { quotes: [{ id: "qx", data: {} }] },
    });
    expect(r.status).toBe(403);
    expect(H.quotes).toHaveLength(0);
  });

  it("rejects employee restore for non-admins", async () => {
    H.adminMode = false;
    const r = await post("/api/import", {
      inspections: [],
      employees: [{ email: "sneaky@truckranch.com", isAdmin: true }],
    });
    expect(r.status).toBe(403);
    expect(H.employees).toHaveLength(0);
  });

  it("rejects malformed payloads with a 400 and imports nothing", async () => {
    const cases = [
      { inspections: "not-an-array" },
      { inspections: [{ id: "FQ-1", ts: -5, result: "pass", status: "pass" }] },
      { inspections: [{ ts: 1, result: "maybe", status: "pass" }] },
      { employees: [{ email: "outsider@gmail.com" }], inspections: [] },
    ];
    for (const c of cases) {
      const r = await post("/api/import", c);
      expect(r.status).toBe(400);
      const b = await r.json();
      expect(b.message).toMatch(/valid Final QC backup/);
    }
    expect(H.inspections).toHaveLength(0);
    expect(H.employees).toHaveLength(0);
  });

  it("assigns fresh FQ numbers to legacy records without ids and skips ts+vin duplicates", async () => {
    seedInspection("FQ-1001", "VINOLD00000000001", 12345, true);
    H.counter = 1001;
    const r = await post("/api/import", {
      inspections: [
        // Same vin+ts as the already-imported row: skipped.
        { ts: 12345, vin: "VINOLD00000000001", result: "pass", status: "pass" },
        // New legacy record: gets FQ-1002.
        { ts: 99999, vin: "VINOLD00000000002", result: "pass", status: "pass" },
      ],
    });
    const b = await r.json();
    expect(b).toMatchObject({ imported: 1, skipped: 1 });
    expect(H.inspections.some((x) => x.qcNumber === "FQ-1002" && x.vin === "VINOLD00000000002")).toBe(true);
  });
});
