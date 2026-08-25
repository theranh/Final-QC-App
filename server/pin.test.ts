// @vitest-environment node
//
// PIN sign-off tests:
//  1. hashPin/verifyPin round-trip; wrong PIN and malformed hashes fail.
//  2. commit-intake / commit-quote endpoints: PIN required at commit, wrong
//     PIN rejected, committed_by immutable (409 on re-commit), supervisor
//     override writes committed_by=worker + overridden_by=supervisor, and a
//     non-override signer cannot sign for someone else.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

// ---------- shared stores + fake db (hoisted so vi.mock can see them) ----------
type EmpRow = {
  id: number;
  userId: string;
  email: string;
  name: string;
  status: string;
  active: boolean;
  canOverride: boolean;
  pinHash: string | null;
};

const H = vi.hoisted(() => {
  const emps: EmpRow[] = [];
  const intakeRows: any[] = [];
  const inspectionRows: any[] = [];
  const quoteRows: any[] = [];
  const photoRows: any[] = [];
  const intakeRelinksOnLock = new Map<string, string | null>();
  const deletedQuoteRows: string[] = [];
  const sqlTrace: string[] = [];
  const audits: any[] = [];
  const snapRows: any[] = []; // quote_snapshots (Phase 1A)
  const corrRows: any[] = []; // pricing_corrections (Phase 1A)
  const settingsRows: any[] = []; // settings key/value store (ratesMeta)

  const sqlParts = (q: any): { text: string; params: any[] } => {
    const chunks: any[] = q?.queryChunks ?? [];
    let text = "";
    const params: any[] = [];
    for (const c of chunks) {
      if (c == null) continue;
      // Bare interpolated primitive (e.g. an id) becomes a bound param.
      if (typeof c === "string" || typeof c === "number") {
        text += "?";
        params.push(c);
      } else if (c.constructor?.name === "StringChunk") {
        // Literal SQL text fragment.
        text += Array.isArray(c.value) ? c.value.join("") : String(c.value ?? "");
      } else if (typeof c === "object" && "queryChunks" in c) {
        const inner = sqlParts(c);
        text += inner.text;
        params.push(...inner.params);
      } else if (typeof c === "object" && "value" in c) {
        text += "?";
        params.push(c.value);
      }
      // Column references (PgText etc.) contribute no param and no literal text.
    }
    return { text, params };
  };

  // Lazy thenable: the insert only runs when the FINAL link in the chain is
  // awaited, so `.values().onConflictDoNothing().returning()` inserts once.
  const lazy = (fn: () => any) => ({
    then: (res: any, rej: any) => Promise.resolve().then(fn).then(res, rej),
  });

  const makeInsert = () => (_table: any) => {
    const chain: any = {
      _setWhere: undefined as any,
      values: (v: any) => {
        chain._values = v;
        // Phase 1A rows are recognized by shape (schema tables aren't
        // imported here): snapshots carry contentHash, corrections lineId.
        if (v.contentHash !== undefined || (v.snapshotId !== undefined && v.lineId !== undefined)) {
          const doInsert = () => {
            if (v.contentHash !== undefined) {
              if (snapRows.some((r) => r.quoteId === v.quoteId && r.contentHash === v.contentHash)) return [];
              const row = { id: snapRows.length + 1, ...v };
              snapRows.push(row);
              return [{ id: row.id }];
            }
            if (corrRows.some((r) => r.snapshotId === v.snapshotId && r.lineId === v.lineId)) return [];
            corrRows.push(v);
            return [];
          };
          const q: any = lazy(doInsert);
          q.onConflictDoNothing = () => {
            const r: any = lazy(doInsert);
            r.returning = () => lazy(doInsert);
            return r;
          };
          return q;
        }
        // Audit-log inserts are terminal (awaited directly).
        const p: any = Promise.resolve().then(() => {
          audits.push(v);
          return [];
        });
        p.onConflictDoUpdate = (opts: any) => {
          chain._conflict = opts;
          return chain;
        };
        p.returning = (_cols?: any) => {
          // Upsert path used by PUT /api/quoter/quotes: find existing quote row.
          const id = v.id;
          const existing = quoteRows.find((r) => r.id === id) || intakeRows.find((r) => r.id === id);
          if (existing) {
            // setWhere: committed_by IS NULL blocks committed rows.
            if (existing.committedBy) return Promise.resolve([]);
            Object.assign(existing, v);
            return Promise.resolve([{ id: existing.id }]);
          }
          const row = { ...v, committedBy: v.committedBy ?? null, overriddenBy: v.overriddenBy ?? null };
          quoteRows.push(row);
          return Promise.resolve([{ id: row.id }]);
        };
        return p;
      },
    };
    return chain;
  };

  const fakeDb: any = {
    insert: makeInsert(),
    // Raw SQL used by the Phase 1A snapshot path: the rates settings lookup
    // (no saved rates → defaults) and the FOR UPDATE quote read inside the
    // intake-commit transaction.
    execute: async (q: any) => {
      const { text, params } = sqlParts(q);
      sqlTrace.push(text);
      // (Table objects contribute no literal text in sqlParts, so match on
      // the FOR UPDATE marker — only the quote read uses it.)
      // Rates-version guard: locked read of the ratesMeta settings row.
      if (/ratesMeta/i.test(text)) {
        const row = settingsRows.find((s) => s.key === "ratesMeta");
        return { rows: row ? [{ value: row.value }] : [] };
      }
      if (/COUNT\(\*\)::int AS total/i.test(text) && /FROM/i.test(text)) {
        const quoteId = params[0];
        const owned = photoRows.filter((photo) => photo.quoteId === quoteId);
        return {
          rows: [{
            total: owned.length,
            walk: owned.filter((photo) => photo.role === "walk").length,
            damage: owned.filter((photo) => photo.role === "damage").length,
            damage_wide: owned.filter((photo) => photo.role === "damage_wide").length,
            unclassified: owned.filter(
              (photo) => !["walk", "damage", "damage_wide"].includes(photo.role),
            ).length,
          }],
        };
      }
      if (/SELECT id, ts/i.test(text) && /quote_id/i.test(text) && /id IN/i.test(text)) {
        const [quoteId, ...ids] = params;
        return {
          rows: photoRows
            .filter((photo) => photo.quoteId === quoteId && ids.includes(photo.id))
            .map((photo) => ({ id: photo.id, ts: photo.ts })),
        };
      }
      if (/UPDATE intakes/i.test(text) && /quote_id IS NULL/i.test(text)) {
        const quoteId = params[0];
        const intakeId = params[1];
        const row = intakeRows.find((intake) => intake.id === intakeId);
        if (!row || row.quoteId || row.quote_id) return { rows: [] };
        row.quoteId = quoteId;
        row.quote_id = quoteId;
        return { rows: [{ quote_id: quoteId }] };
      }
      if (/UPDATE inspections/i.test(text) && /archived IS NOT TRUE/i.test(text)) {
        const inspectionId = params[0];
        const row = inspectionRows.find((inspection) => inspection.qcNumber === inspectionId);
        if (!row || row.archived) return { rows: [] };
        row.archived = true;
        row.updatedAt = new Date();
        return {
          rows: [{
            record_id: row.qcNumber,
            vin: row.vin,
            stock: row.stock,
          }],
        };
      }
      if (/FROM inspections/i.test(text) && /archived IS TRUE/i.test(text)) {
        const inspectionId = params[0];
        const row = inspectionRows.find(
          (inspection) => inspection.qcNumber === inspectionId && inspection.archived,
        );
        return {
          rows: row ? [{
            record_id: row.qcNumber,
            vin: row.vin,
            stock: row.stock,
          }] : [],
        };
      }
      if (/UPDATE intakes/i.test(text) && /retired_at IS NULL/i.test(text)) {
        const intakeId = params[0];
        const row = intakeRows.find((intake) => intake.id === intakeId);
        if (!row || row.retiredAt) return { rows: [] };
        row.retiredAt = new Date();
        row.updatedAt = new Date();
        return {
          rows: [{
            record_id: row.id,
            vin: row.vin,
            stock: row.stock,
            quote_id: row.quoteId || row.quote_id || null,
          }],
        };
      }
      if (/FROM intakes/i.test(text) && /retired_at IS NOT NULL/i.test(text)) {
        const intakeId = params[0];
        const row = intakeRows.find((intake) => intake.id === intakeId && intake.retiredAt);
        return {
          rows: row ? [{
            record_id: row.id,
            vin: row.vin,
            stock: row.stock,
            quote_id: row.quoteId || row.quote_id || null,
          }] : [],
        };
      }
      if (/for update/i.test(text)) {
        if (intakeRelinksOnLock.has(params[0])) {
          const changing = intakeRows.find((r) => r.id === params[0]);
          if (changing) {
            changing.quoteId = intakeRelinksOnLock.get(params[0]);
            changing.quote_id = intakeRelinksOnLock.get(params[0]);
          }
          intakeRelinksOnLock.delete(params[0]);
        }
        const intake = intakeRows.find((r) => r.id === params[0]);
        if (intake) {
          return {
            rows: [{
              id: intake.id,
              vin: intake.vin,
              stock: intake.stock,
              miles: intake.miles,
              quote_id: intake.quoteId || intake.quote_id || null,
              committed_by: intake.committedBy,
            }],
          };
        }
        const row = quoteRows.find((r) => r.id === params[0]);
        return {
          rows: row
            ? [{ id: row.id, data: row.data, committed_by: row.committedBy, overridden_by: row.overriddenBy }]
            : [],
        };
      }
      return { rows: [] };
    },
    transaction: async (fn: any) => {
      const tx = {
        insert: makeInsert(),
        update: (_table: any) => fakeDb.update(_table),
        execute: fakeDb.execute,
        select: (_cols?: any) => fakeDb.select(_cols),
      };
      return fn(tx);
    },
    select: (_cols?: any) => ({
      from: (_table: any) => ({
        where: (cond: any) => {
          const { params } = sqlParts(cond);
          const id = params[0];
          return {
            then: (res: any, rej: any) => {
              let rows: any[] = [];
               if (deletedQuoteRows.includes(id)) rows = [{ id }];
               else if (settingsRows.some((s) => s.key === id)) rows = settingsRows.filter((s) => s.key === id);
              else if (emps.some((e) => e.id === id)) rows = emps.filter((e) => e.id === id);
              else if (intakeRows.some((r) => r.id === id)) rows = intakeRows.filter((r) => r.id === id);
              else if (quoteRows.some((r) => r.id === id)) rows = quoteRows.filter((r) => r.id === id);
              return Promise.resolve(rows).then(res, rej);
            },
          };
        },
        orderBy: () => ({ then: (res: any) => Promise.resolve(emps.filter((e) => e.active)).then(res) }),
      }),
    }),
    update: (_table: any) => ({
      set: (patch: any) => ({
        where: (cond: any) => ({
          returning: async () => {
            const { text, params } = sqlParts(cond);
            const id = params[0];
            // ids are unique across stores in these tests; find whichever holds it.
            const row =
              intakeRows.find((r) => r.id === id) || quoteRows.find((r) => r.id === id);
            if (!row) return [];
            // Normal commits require an unlocked row; the narrow stock/miles
            // correction route deliberately requires an already-committed row.
            const requiresCommitted = /IS NOT NULL/i.test(text);
            if ((requiresCommitted && !row.committedBy) || (!requiresCommitted && row.committedBy)) return [];
            const persistedPatch = { ...patch };
            // The real database evaluates COALESCE(completed_at, NOW()) and
            // returns a Date. Mirror that instead of retaining Drizzle's SQL
            // expression object in the in-memory adapter.
            if (persistedPatch.completedAt?.queryChunks) {
              persistedPatch.completedAt = row.completedAt || new Date();
            }
            Object.assign(row, persistedPatch);
            return [row];
          },
        }),
      }),
    }),
    delete: (_table: any) => ({
      where: (cond: any) => {
        const { text, params } = sqlParts(cond);
        // Committed-guarded delete (quotes) uses a sql`` fragment with the id
        // as first param and "committed_by IS NULL" in the text; the plain
        // photo/quote deletes pass eq() with the id as the only param.
        const guarded = /committed_by/i.test(text);
        const doDelete = () => {
          const id = params[0];
          const qi = quoteRows.findIndex((r) => r.id === id);
          if (qi >= 0) {
            if (guarded && quoteRows[qi].committedBy) return [];
            const [gone] = quoteRows.splice(qi, 1);
            return [{ id: gone.id }];
          }
          // photos store not modeled; treat as no-op success.
          return [];
        };
        const p: any = Promise.resolve().then(doDelete);
        p.returning = (_cols?: any) => Promise.resolve(doDelete());
        return p;
      },
    }),
  };
  return { emps, intakeRows, inspectionRows, quoteRows, photoRows, intakeRelinksOnLock, deletedQuoteRows, sqlTrace, audits, snapRows, corrRows, settingsRows, fakeDb };
});

const { emps, intakeRows, inspectionRows, quoteRows, photoRows, intakeRelinksOnLock, deletedQuoteRows, sqlTrace, audits, snapRows, corrRows, settingsRows } = H;

describe("PIN hashing", () => {
  it("round-trips a correct PIN and rejects a wrong one", async () => {
    const { hashPin, verifyPin } = await import("./pin");
    const h = await hashPin("1234");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPin("1234", h)).toBe(true);
    expect(await verifyPin("0000", h)).toBe(false);
  });
  it("rejects null / malformed stored hashes without throwing", async () => {
    const { verifyPin } = await import("./pin");
    expect(await verifyPin("1234", null)).toBe(false);
    expect(await verifyPin("1234", "garbage")).toBe(false);
    expect(await verifyPin("1234", "scrypt$zz$zz")).toBe(false);
  });
  it("validates 4-digit PIN format", async () => {
    const { isValidPin } = await import("./pin");
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("12")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
    expect(isValidPin(1234 as any)).toBe(false);
  });
});

vi.mock("./db", () => ({ db: H.fakeDb }));
vi.mock("./access", () => ({
  requireEmployee: (req: any, _res: any, next: any) => {
    req.employee = { id: 99, userId: "u99", email: "z@truckranch.com", name: "Caller", status: "active" };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  resolveAccess: async () => ({ access: "active", email: "z@truckranch.com", employee: null }),
}));
vi.mock("./replit_integrations/auth", () => ({
  isAuthenticated: (_req: any, _res: any, next: any) => next(),
}));

let server: Server;
let base: string;

beforeAll(async () => {
  const { registerPinRoutes } = await import("./pin");
  const app = express();
  registerPinRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => server?.close());

beforeEach(async () => {
  // Each case gets a fresh PIN rate-limit window so unrelated tests' attempts
  // don't overflow the per-signer/per-IP buckets mid-suite.
  const { resetPinRateLimits } = await import("./pin");
  resetPinRateLimits();
  photoRows.length = 0;
  deletedQuoteRows.length = 0;
  sqlTrace.length = 0;
});

async function post(path: string, body: any) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("commit endpoints", () => {
  beforeAll(async () => {
    const { hashPin } = await import("./pin");
    emps.length = 0;
    intakeRows.length = 0;
    quoteRows.length = 0;
    emps.push(
      { id: 1, userId: "u1", email: "w@truckranch.com", name: "Worker", status: "active", active: true, canOverride: false, pinHash: await hashPin("1111") },
      { id: 2, userId: "u2", email: "s@truckranch.com", name: "Sup", status: "active", active: true, canOverride: true, pinHash: await hashPin("2222") },
      { id: 3, userId: "u3", email: "n@truckranch.com", name: "NoOverride", status: "active", active: true, canOverride: false, pinHash: await hashPin("3333") },
    );
    intakeRows.push({ id: "in1", vin: "1FTFW1E81NKD72360", stock: "S1", data: { roReady: Array(9).fill(true) }, committedBy: null, overriddenBy: null });
    intakeRows.push({ id: "in2", vin: "2AAAA", stock: "S2", data: { roReady: Array(9).fill(false) }, committedBy: null, overriddenBy: null });
    quoteRows.push({ id: "q1", data: { vin: "1FTFW1E81NKD72360" }, committedBy: null, overriddenBy: null });
  });

  it("rejects a wrong PIN (401)", async () => {
    const r = await post("/api/quoter/commit-intake", { id: "in1", signerId: 1, pin: "9999" });
    expect(r.status).toBe(401);
    expect(intakeRows.find((x) => x.id === "in1").committedBy).toBeNull();
  });

  it("commits an intake regardless of checklist state (RO-ready gate removed)", async () => {
    const r = await post("/api/quoter/commit-intake", { id: "in2", signerId: 1, pin: "1111" });
    expect(r.status).toBe(200);
    expect(intakeRows.find((x) => x.id === "in2").committedBy).toBe("Worker");
  });

  it("commits with the signer's own PIN and writes committed_by", async () => {
    const r = await post("/api/quoter/commit-intake", { id: "in1", signerId: 1, pin: "1111" });
    expect(r.status).toBe(200);
    expect(r.body.committedBy).toBe("Worker");
    expect(r.body.overriddenBy).toBeNull();
    expect(Number.isFinite(r.body.completedAt)).toBe(true);
    const saved = intakeRows.find((x) => x.id === "in1");
    expect(saved.committedBy).toBe("Worker");
    expect(saved.completedAt).toBeInstanceOf(Date);
    expect(r.body.completedAt).toBe(saved.completedAt.getTime());
  });

  it("refuses intake completion when a locally captured photo is absent from the locked server manifest", async () => {
    intakeRows.push({
      id: "in-photo-missing",
      vin: "1FTFW1E81NKD72361",
      stock: "S-MISSING",
      quoteId: "q-photo-missing",
      data: {},
      committedBy: null,
      overriddenBy: null,
    });
    quoteRows.push({ id: "q-photo-missing", data: {}, committedBy: null, overriddenBy: null });

    const r = await post("/api/quoter/commit-intake", {
      id: "in-photo-missing",
      signerId: 1,
      pin: "1111",
      photoManifest: [{ id: "q-photo-missing_ext_front", captureTs: 1_800_000_000_001 }],
    });

    expect(r.status).toBe(409);
    expect(r.body.missingPhotoIds).toEqual(["q-photo-missing_ext_front"]);
    expect(intakeRows.find((x) => x.id === "in-photo-missing").committedBy).toBeNull();
  });

  it("requires the photo-confirmation protocol for every linked intake", async () => {
    intakeRows.push({
      id: "in-photo-protocol",
      vin: "1FTFW1E81NKD72363",
      stock: "S-PROTOCOL",
      quoteId: "q-photo-protocol",
      data: {},
      committedBy: null,
      overriddenBy: null,
    });
    quoteRows.push({ id: "q-photo-protocol", data: {}, committedBy: null, overriddenBy: null });

    const r = await post("/api/quoter/commit-intake", {
      id: "in-photo-protocol",
      signerId: 1,
      pin: "1111",
    });

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/photo confirmation is required/i);
    expect(intakeRows.find((x) => x.id === "in-photo-protocol").committedBy).toBeNull();
  });

  it("aborts when gallery ownership changes before the intake row is locked", async () => {
    intakeRows.push({
      id: "in-photo-relinked",
      vin: "1FTFW1E81NKD72364",
      stock: "S-RELINKED",
      quoteId: "q-photo-old",
      data: {},
      committedBy: null,
      overriddenBy: null,
    });
    quoteRows.push(
      { id: "q-photo-old", data: {}, committedBy: null, overriddenBy: null },
      { id: "q-photo-new", data: {}, committedBy: null, overriddenBy: null },
    );
    intakeRelinksOnLock.set("in-photo-relinked", "q-photo-new");

    const r = await post("/api/quoter/commit-intake", {
      id: "in-photo-relinked",
      signerId: 1,
      pin: "1111",
      photoManifest: [],
    });

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/gallery ownership changed/i);
    expect(intakeRows.find((x) => x.id === "in-photo-relinked").committedBy).toBeNull();
  });

  it("commits when every local capture receipt exists at the same or newer server timestamp", async () => {
    intakeRows.push({
      id: "in-photo-complete",
      vin: "1FTFW1E81NKD72362",
      stock: "S-COMPLETE",
      quoteId: "q-photo-complete",
      data: {},
      committedBy: null,
      overriddenBy: null,
    });
    quoteRows.push({ id: "q-photo-complete", data: {}, committedBy: null, overriddenBy: null });
    photoRows.push({
      id: "q-photo-complete_ext_front",
      quoteId: "q-photo-complete",
      role: "walk",
      ts: 1_800_000_000_002,
    });

    const r = await post("/api/quoter/commit-intake", {
      id: "in-photo-complete",
      signerId: 1,
      pin: "1111",
      photoManifest: [{ id: "q-photo-complete_ext_front", captureTs: 1_800_000_000_001 }],
    });

    expect(r.status).toBe(200);
    expect(intakeRows.find((x) => x.id === "in-photo-complete").committedBy).toBe("Worker");
  });

  it("refuses to re-commit an already committed intake (409, immutable)", async () => {
    const r = await post("/api/quoter/commit-intake", { id: "in1", signerId: 2, pin: "2222" });
    expect(r.status).toBe(409);
    expect(intakeRows.find((x) => x.id === "in1").committedBy).toBe("Worker");
  });

  it("lets an admin PIN correct stock and miles on a committed intake", async () => {
    intakeRows.push({
      id: "in-correct",
      vin: "CORRECTVIN1234567",
      stock: "OLD-STOCK",
      miles: "100",
      quoteId: "q-correct",
      data: {},
      committedBy: "Worker",
      overriddenBy: null,
      completedAt: new Date(),
      updatedAt: new Date(0),
    });
    quoteRows.push({
      id: "q-correct",
      data: { stock: "QUOTE-STOCK", miles: "QUOTE-MILES" },
      committedBy: "Quote signer",
      overriddenBy: null,
    });
    const beforeAudits = audits.length;
    const r = await post("/api/quoter/intakes/in-correct/correct-stock-miles", {
      stock: "new-stock",
      miles: "456",
      signerId: 2,
      pin: "2222",
    });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stock: "NEW-STOCK", miles: "456" });
    const saved = intakeRows.find((x) => x.id === "in-correct");
    expect(saved).toMatchObject({
      stock: "NEW-STOCK",
      miles: "456",
      committedBy: "Worker",
    });
    expect(quoteRows.find((x) => x.id === "q-correct")?.data).toEqual({
      stock: "QUOTE-STOCK",
      miles: "QUOTE-MILES",
    });
    expect(audits).toHaveLength(beforeAudits + 1);
    expect(audits.at(-1)).toMatchObject({
      action: "intake_stock_miles_corrected",
      actorName: "Sup",
      details: {
        previousStock: "OLD-STOCK",
        previousMiles: "100",
        stock: "NEW-STOCK",
        miles: "456",
      },
    });
  });

  it("audits each later correction against the immediately prior committed values", async () => {
    intakeRows.push({
      id: "in-correct-sequential",
      vin: "SEQUENTIALVIN1234",
      stock: "ORIGINAL",
      miles: "1",
      data: {},
      committedBy: "Worker",
      overriddenBy: null,
      completedAt: new Date(),
    });
    const beforeAudits = audits.length;

    expect((await post("/api/quoter/intakes/in-correct-sequential/correct-stock-miles", {
      stock: "FIRST",
      miles: "2",
      signerId: 2,
      pin: "2222",
    })).status).toBe(200);
    expect((await post("/api/quoter/intakes/in-correct-sequential/correct-stock-miles", {
      stock: "SECOND",
      miles: "3",
      signerId: 2,
      pin: "2222",
    })).status).toBe(200);

    expect(audits.slice(beforeAudits).map((a) => a.details)).toEqual([
      expect.objectContaining({ previousStock: "ORIGINAL", previousMiles: "1", stock: "FIRST", miles: "2" }),
      expect.objectContaining({ previousStock: "FIRST", previousMiles: "2", stock: "SECOND", miles: "3" }),
    ]);
  });

  it("rejects a non-admin PIN for a committed intake correction", async () => {
    intakeRows.push({
      id: "in-no-admin",
      vin: "NOADMINVIN123456",
      stock: "UNCHANGED",
      miles: "999",
      data: {},
      committedBy: "Worker",
      overriddenBy: null,
      completedAt: new Date(),
    });
    const r = await post("/api/quoter/intakes/in-no-admin/correct-stock-miles", {
      stock: "SHOULD-NOT-SAVE",
      miles: "1",
      signerId: 1,
      pin: "1111",
    });

    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/admin pin/i);
    expect(intakeRows.find((x) => x.id === "in-no-admin")).toMatchObject({
      stock: "UNCHANGED",
      miles: "999",
    });
  });

  it("retires an intake by exact id with an admin PIN while retaining its gallery link", async () => {
    intakeRows.push({
      id: "retire-exact-id",
      vin: "SHAREDVIN12345678",
      stock: "RETIRE-ME",
      quoteId: "gallery-kept",
      data: {},
      committedBy: "Worker",
    });
    intakeRows.push({
      id: "same-vin-stays",
      vin: "SHAREDVIN12345678",
      stock: "KEEP-ME",
      quoteId: "other-gallery",
      data: {},
      committedBy: "Worker",
    });

    const r = await post("/api/vehicles/retire", {
      kind: "intake",
      recordId: "retire-exact-id",
      signerId: 2,
      pin: "2222",
    });

    expect(r.status).toBe(200);
    expect(intakeRows.find((x) => x.id === "retire-exact-id").retiredAt).toBeInstanceOf(Date);
    expect(intakeRows.find((x) => x.id === "retire-exact-id").quoteId).toBe("gallery-kept");
    expect(intakeRows.find((x) => x.id === "same-vin-stays").retiredAt).toBeUndefined();
    expect(audits.at(-1)).toMatchObject({
      action: "vehicle_retired",
      details: { kind: "intake", recordId: "retire-exact-id", quoteId: "gallery-kept" },
    });
  });

  it("rejects vehicle retirement by a valid non-admin PIN", async () => {
    intakeRows.push({
      id: "retire-denied",
      vin: "DENIEDVIN1234567",
      stock: "STAYS",
      quoteId: "gallery-stays",
      data: {},
      committedBy: "Worker",
    });
    const r = await post("/api/vehicles/retire", {
      kind: "intake",
      recordId: "retire-denied",
      signerId: 1,
      pin: "1111",
    });
    expect(r.status).toBe(403);
    expect(intakeRows.find((x) => x.id === "retire-denied").retiredAt).toBeUndefined();
  });

  it("returns 404 for an unknown exact vehicle id without writing an audit", async () => {
    const beforeAudits = audits.length;
    const r = await post("/api/vehicles/retire", {
      kind: "intake",
      recordId: "intake-id-that-does-not-exist",
      signerId: 2,
      pin: "2222",
    });

    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/i);
    expect(audits).toHaveLength(beforeAudits);
  });

  it("keeps the original retirement timestamp when the same exact intake is retired again", async () => {
    intakeRows.push({
      id: "retire-repeat",
      vin: "REPEATVIN1234567",
      stock: "REPEAT",
      quoteId: "repeat-gallery",
      data: {},
      committedBy: "Worker",
    });

    const beforeAudits = audits.length;
    const first = await post("/api/vehicles/retire", {
      kind: "intake",
      recordId: "retire-repeat",
      signerId: 2,
      pin: "2222",
    });
    const firstRow = intakeRows.find((x) => x.id === "retire-repeat");
    const firstRetiredAt = firstRow.retiredAt;
    const firstUpdatedAt = firstRow.updatedAt;
    const second = await post("/api/vehicles/retire", {
      kind: "intake",
      recordId: "retire-repeat",
      signerId: 2,
      pin: "2222",
    });

    expect(first.status).toBe(200);
    expect(first.body.alreadyRetired).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      ok: true,
      kind: "intake",
      recordId: "retire-repeat",
      alreadyRetired: true,
    });
    expect(intakeRows.find((x) => x.id === "retire-repeat").retiredAt).toBe(firstRetiredAt);
    expect(intakeRows.find((x) => x.id === "retire-repeat").updatedAt).toBe(firstUpdatedAt);
    expect(intakeRows.find((x) => x.id === "retire-repeat").quoteId).toBe("repeat-gallery");
    expect(audits.slice(beforeAudits)).toEqual([
      expect.objectContaining({
        action: "vehicle_retired",
        details: expect.objectContaining({
          kind: "intake",
          recordId: "retire-repeat",
        }),
      }),
    ]);
  });

  it("retires only the exact same-VIN inspection once and does not re-audit a repeat", async () => {
    inspectionRows.push(
      { qcNumber: "QC-RETIRE-EXACT", vin: "INSPECTIONSHAREDVIN", stock: "RETIRE", archived: false },
      { qcNumber: "QC-SAME-VIN-STAYS", vin: "INSPECTIONSHAREDVIN", stock: "KEEP", archived: false },
    );
    const beforeAudits = audits.length;

    const first = await post("/api/vehicles/retire", {
      kind: "inspection",
      recordId: "QC-RETIRE-EXACT",
      signerId: 2,
      pin: "2222",
    });
    const firstUpdatedAt = inspectionRows.find((row) => row.qcNumber === "QC-RETIRE-EXACT").updatedAt;
    const repeat = await post("/api/vehicles/retire", {
      kind: "inspection",
      recordId: "QC-RETIRE-EXACT",
      signerId: 2,
      pin: "2222",
    });

    expect(first.status).toBe(200);
    expect(first.body.alreadyRetired).toBe(false);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({
      kind: "inspection",
      recordId: "QC-RETIRE-EXACT",
      alreadyRetired: true,
    });
    expect(inspectionRows.find((row) => row.qcNumber === "QC-RETIRE-EXACT")).toMatchObject({
      archived: true,
      updatedAt: firstUpdatedAt,
    });
    const sameVinOther = inspectionRows.find((row) => row.qcNumber === "QC-SAME-VIN-STAYS");
    expect(sameVinOther.archived).toBe(false);
    expect(sameVinOther.updatedAt).toBeUndefined();
    expect(audits.slice(beforeAudits)).toEqual([
      expect.objectContaining({
        action: "vehicle_retired",
        details: expect.objectContaining({
          kind: "inspection",
          recordId: "QC-RETIRE-EXACT",
        }),
      }),
    ]);
  });

  it("does not allow the protected correction route on an uncommitted intake", async () => {
    intakeRows.push({
      id: "in-open",
      vin: "OPENVIN123456789",
      stock: "OPEN",
      miles: "10",
      data: {},
      committedBy: null,
      overriddenBy: null,
    });
    const r = await post("/api/quoter/intakes/in-open/correct-stock-miles", {
      stock: "NEW",
      miles: "20",
      signerId: 2,
      pin: "2222",
    });

    expect(r.status).toBe(409);
    expect(intakeRows.find((x) => x.id === "in-open").stock).toBe("OPEN");
  });

  it("uses an admin PIN to link one confirmed same-VIN gallery and audits the repair", async () => {
    intakeRows.push(
      {
        id: "in-gallery-target",
        vin: "GALLERYVIN1234567",
        stock: "NEW-STOCK",
        miles: "50000",
        quoteId: null,
        data: {},
        committedBy: "Worker",
      },
      {
        id: "in-gallery-source",
        vin: "galleryvin1234567",
        stock: "OLD-STOCK",
        miles: "49000",
        quoteId: "q-gallery-source",
        data: {},
        committedBy: "Worker",
      },
    );
    photoRows.push(
      { id: "gallery-walk", quoteId: "q-gallery-source", role: "walk" },
      { id: "gallery-damage", quoteId: "q-gallery-source", role: "damage" },
    );
    const beforeAudits = audits.length;

    const r = await post("/api/quoter/intakes/in-gallery-target/repair-gallery-link", {
      sourceIntakeId: "in-gallery-source",
      signerId: 2,
      pin: "2222",
    });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      intakeId: "in-gallery-target",
      sourceIntakeId: "in-gallery-source",
      quoteId: "q-gallery-source",
      photoCounts: { total: 2, walk: 1, damage: 1 },
    });
    expect(intakeRows.find((row) => row.id === "in-gallery-target")?.quoteId).toBe("q-gallery-source");
    expect(audits).toHaveLength(beforeAudits + 1);
    expect(audits.at(-1)).toMatchObject({
      action: "intake_gallery_link_repaired",
      actorName: "Sup",
      details: {
        targetIntakeId: "in-gallery-target",
        sourceIntakeId: "in-gallery-source",
        quoteId: "q-gallery-source",
        photoCounts: { total: 2, walk: 1, damage: 1 },
      },
    });
    const advisoryIndex = sqlTrace.findIndex((text) => /pg_advisory_xact_lock/i.test(text));
    const countIndex = sqlTrace.findIndex((text) => /COUNT\(\*\)::int AS total/i.test(text));
    const updateIndex = sqlTrace.findIndex((text) => /UPDATE intakes/i.test(text) && /quote_id IS NULL/i.test(text));
    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(countIndex).toBeGreaterThan(advisoryIndex);
    expect(updateIndex).toBeGreaterThan(countIndex);
  });

  it("refuses gallery repair without an admin PIN", async () => {
    intakeRows.push(
      { id: "in-gallery-no-admin-target", vin: "NOADMINVIN12345", quoteId: null, data: {}, committedBy: null },
      { id: "in-gallery-no-admin-source", vin: "NOADMINVIN12345", quoteId: "q-no-admin", data: {}, committedBy: "Worker" },
    );
    photoRows.push({ id: "no-admin-photo", quoteId: "q-no-admin", role: "walk" });

    const r = await post("/api/quoter/intakes/in-gallery-no-admin-target/repair-gallery-link", {
      sourceIntakeId: "in-gallery-no-admin-source",
      signerId: 1,
      pin: "1111",
    });

    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/admin pin/i);
    expect(intakeRows.find((row) => row.id === "in-gallery-no-admin-target")?.quoteId).toBeNull();
  });

  it("rejects a different-VIN source, an empty gallery, and an already-linked target", async () => {
    intakeRows.push(
      { id: "in-gallery-guard-target", vin: "TARGETVIN1234567", quoteId: null, data: {}, committedBy: null },
      { id: "in-gallery-wrong-vin", vin: "OTHERVIN12345678", quoteId: "q-wrong-vin", data: {}, committedBy: "Worker" },
      { id: "in-gallery-empty", vin: "TARGETVIN1234567", quoteId: "q-empty", data: {}, committedBy: "Worker" },
      { id: "in-gallery-linked", vin: "TARGETVIN1234567", quoteId: "q-authoritative", data: {}, committedBy: "Worker" },
      { id: "in-gallery-valid-source", vin: "TARGETVIN1234567", quoteId: "q-valid", data: {}, committedBy: "Worker" },
    );
    photoRows.push(
      { id: "wrong-vin-photo", quoteId: "q-wrong-vin", role: "walk" },
      { id: "valid-photo", quoteId: "q-valid", role: "walk" },
    );

    const wrongVin = await post("/api/quoter/intakes/in-gallery-guard-target/repair-gallery-link", {
      sourceIntakeId: "in-gallery-wrong-vin",
      signerId: 2,
      pin: "2222",
    });
    expect(wrongVin.status).toBe(409);
    expect(wrongVin.body.error).toMatch(/same vin/i);

    const empty = await post("/api/quoter/intakes/in-gallery-guard-target/repair-gallery-link", {
      sourceIntakeId: "in-gallery-empty",
      signerId: 2,
      pin: "2222",
    });
    expect(empty.status).toBe(409);
    expect(empty.body.error).toMatch(/no longer owns any photos/i);

    const linked = await post("/api/quoter/intakes/in-gallery-linked/repair-gallery-link", {
      sourceIntakeId: "in-gallery-valid-source",
      signerId: 2,
      pin: "2222",
    });
    expect(linked.status).toBe(409);
    expect(linked.body.quoteId).toBe("q-authoritative");
    expect(intakeRows.find((row) => row.id === "in-gallery-linked")?.quoteId).toBe("q-authoritative");
  });

  it("supervisor override sets committed_by=worker, overridden_by=supervisor", async () => {
    const r = await post("/api/quoter/commit-quote", { id: "q1", signerId: 2, pin: "2222", forEmployeeId: 1 });
    expect(r.status).toBe(200);
    expect(r.body.committedBy).toBe("Worker");
    expect(r.body.overriddenBy).toBe("Sup");
  });

  it("a non-override signer cannot sign for someone else (403)", async () => {
    quoteRows.push({ id: "q2", data: {}, committedBy: null, overriddenBy: null });
    const r = await post("/api/quoter/commit-quote", { id: "q2", signerId: 3, pin: "3333", forEmployeeId: 1 });
    expect(r.status).toBe(403);
    expect(quoteRows.find((x) => x.id === "q2").committedBy).toBeNull();
  });

  it("writes an audit row for each commit", async () => {
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("intake_committed");
    expect(actions).toContain("quote_committed_override");
  });

  it("commit + audit share one transaction (audit row exists after commit)", async () => {
    quoteRows.push({ id: "qtx", data: { vin: "VVV" }, committedBy: null, overriddenBy: null });
    const before = audits.length;
    const r = await post("/api/quoter/commit-quote", { id: "qtx", signerId: 1, pin: "1111" });
    expect(r.status).toBe(200);
    expect(quoteRows.find((x) => x.id === "qtx").committedBy).toBe("Worker");
    // The audit INSERT ran inside db.transaction alongside the UPDATE.
    expect(audits.length).toBe(before + 1);
    expect(audits[audits.length - 1].action).toBe("quote_committed");
  });
});

describe("rates version guard at commit", () => {
  it("409s with code rates_changed when the client's ratesVersion is stale", async () => {
    settingsRows.push({ key: "ratesMeta", value: { version: 3 } });
    quoteRows.push({ id: "qrv1", data: {}, committedBy: null, overriddenBy: null });
    const r = await post("/api/quoter/commit-quote", { id: "qrv1", signerId: 1, pin: "1111", ratesVersion: 2 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("rates_changed");
    expect(r.body.currentRatesVersion).toBe(3);
    // quote NOT committed
    expect(quoteRows.find((q) => q.id === "qrv1").committedBy).toBeNull();
    settingsRows.length = 0;
  });

  it("commits when the ratesVersion matches, and when omitted (old clients)", async () => {
    settingsRows.push({ key: "ratesMeta", value: { version: 3 } });
    quoteRows.push({ id: "qrv2", data: {}, committedBy: null, overriddenBy: null });
    const ok = await post("/api/quoter/commit-quote", { id: "qrv2", signerId: 1, pin: "1111", ratesVersion: 3 });
    expect(ok.status).toBe(200);

    quoteRows.push({ id: "qrv3", data: {}, committedBy: null, overriddenBy: null });
    const legacy = await post("/api/quoter/commit-quote", { id: "qrv3", signerId: 1, pin: "1111" });
    expect(legacy.status).toBe(200);
    settingsRows.length = 0;
  });
});

// ---------------------------------------------------------------------------
// Phase 1A — commit snapshots + pricing corrections
// ---------------------------------------------------------------------------
describe("commit snapshots (Phase 1A)", () => {
  const line = (id: string, cls: any) => ({ id, status: "done", review: false, cls });

  it("a committed quote produces an immutable snapshot row", async () => {
    const before = snapRows.length;
    quoteRows.push({
      id: "qsnap",
      data: {
        vin: "SNAPVIN",
        estimator: "Worker",
        lines: [line("L1", { panel: "hood", damage_type: "dent", severity: "moderate", paint_damaged: false })],
        totals: { hrs: 2.5, usd: 188, B: 2.5, P: 0, RI: 0, usdPDR: 0 },
      },
      committedBy: null,
      overriddenBy: null,
    });
    const r = await post("/api/quoter/commit-quote", { id: "qsnap", signerId: 1, pin: "1111" });
    expect(r.status).toBe(200);
    expect(snapRows.length).toBe(before + 1);
    const snap = snapRows[snapRows.length - 1];
    expect(snap.quoteId).toBe("qsnap");
    expect(snap.vin).toBe("SNAPVIN");
    expect(snap.committedBy).toBe("Worker");
    expect(snap.linesTotal).toBe(1);
    // Engine recomputation matches the client's math for an untouched line.
    expect(snap.linesOverridden).toBe(0);
    expect(snap.engine.finalTotals.usd).toBe(188); // 2.5h × $75 body = 187.5 → 188
  });

  it("an unchanged line does NOT create a pricing correction", () => {
    expect(corrRows.filter((c) => c.quoteId === "qsnap").length).toBe(0);
  });

  it("an overridden line creates a pricing-correction record", async () => {
    quoteRows.push({
      id: "qover",
      data: {
        vin: "OVERVIN",
        estimator: "Worker",
        lines: [
          line("L1", { panel: "hood", damage_type: "dent", severity: "moderate", paint_damaged: false, b_override: "5" }),
          line("L2", { panel: "tailgate", damage_type: "scratch", severity: "minor", paint_damaged: true }),
        ],
      },
      committedBy: null,
      overriddenBy: null,
    });
    const r = await post("/api/quoter/commit-quote", { id: "qover", signerId: 1, pin: "1111" });
    expect(r.status).toBe(200);
    const snap = snapRows.find((s) => s.quoteId === "qover");
    expect(snap.linesTotal).toBe(2);
    expect(snap.linesOverridden).toBe(1);
    const corrs = corrRows.filter((c) => c.quoteId === "qover");
    expect(corrs.length).toBe(1); // only the overridden line, not the clean one
    expect(corrs[0].lineId).toBe("L1");
    expect(corrs[0].panel).toBe("hood");
    expect(Number(corrs[0].calcB)).toBe(2.5); // engine's answer
    expect(Number(corrs[0].finalB)).toBe(5); // estimator's override
  });

  it("re-running the same snapshot content is idempotent (no duplicates)", async () => {
    const { captureCommitSnapshot } = await import("./quoteSnapshot");
    const row = quoteRows.find((q) => q.id === "qover");
    const before = { snaps: snapRows.length, corrs: corrRows.length };
    // Same content, second attempt (e.g. a retried request) — nothing new.
    await captureCommitSnapshot(H.fakeDb, {
      quoteRow: row,
      intakeId: null,
      committedBy: "Worker",
      overriddenBy: null,
    });
    expect(snapRows.length).toBe(before.snaps);
    expect(corrRows.length).toBe(before.corrs);
  });

  it("changed content creates a NEW version instead of overwriting history", async () => {
    const { captureCommitSnapshot } = await import("./quoteSnapshot");
    const row = quoteRows.find((q) => q.id === "qover");
    const firstSnap = snapRows.find((s) => s.quoteId === "qover");
    const edited = { ...row, data: { ...(row.data as any), notes: "supplement found" } };
    await captureCommitSnapshot(H.fakeDb, {
      quoteRow: edited as any,
      intakeId: null,
      committedBy: "Worker",
      overriddenBy: null,
    });
    const versions = snapRows.filter((s) => s.quoteId === "qover");
    expect(versions.length).toBe(2);
    // The original committed version is untouched.
    expect(snapRows.find((s) => s.id === firstSnap.id).doc.notes).toBeUndefined();
  });

  it("commit-intake snapshots the LINKED quote", async () => {
    quoteRows.push({
      id: "qlinked",
      data: { vin: "LINKVIN", lines: [] },
      committedBy: null,
      overriddenBy: null,
    });
    intakeRows.push({ id: "insnap", vin: "LINKVIN", stock: "S9", quoteId: "qlinked", data: {}, committedBy: null, overriddenBy: null });
    const r = await post("/api/quoter/commit-intake", {
      id: "insnap",
      signerId: 1,
      pin: "1111",
      photoManifest: [],
    });
    expect(r.status).toBe(200);
    const snap = snapRows.find((s) => s.quoteId === "qlinked");
    expect(snap).toBeTruthy();
    expect(snap.intakeId).toBe("insnap");
  });

  it("commit-intake without a linked quote commits fine with no snapshot", async () => {
    intakeRows.push({ id: "innoq", vin: "NOQ", stock: "S10", quoteId: null, data: {}, committedBy: null, overriddenBy: null });
    const before = snapRows.length;
    const r = await post("/api/quoter/commit-intake", { id: "innoq", signerId: 1, pin: "1111" });
    expect(r.status).toBe(200);
    expect(snapRows.length).toBe(before);
  });
});

describe("PIN rate limiter identity", () => {
  beforeAll(async () => {
    const { hashPin } = await import("./pin");
    emps.length = 0;
    intakeRows.length = 0;
    quoteRows.length = 0;
    emps.push({
      id: 7,
      userId: "u7",
      email: "b@truckranch.com",
      name: "Brute",
      status: "active",
      active: true,
      canOverride: false,
      pinHash: await hashPin("7777"),
    });
    quoteRows.push({ id: "qrl", data: {}, committedBy: null, overriddenBy: null });
  });

  it("blocks by signerId even when the forwarded IP header is varied per request", async () => {
    // Fire more than the per-signer cap (10/min), each with a DIFFERENT
    // X-Forwarded-For so the per-IP bucket never saturates. Because the limiter
    // keys off signerId independently, we still get a 429 — spoofing the header
    // cannot unlock brute force. (trust proxy is not set on this test app, so
    // req.ip falls back to the socket address; the point proven is the
    // per-signerId axis, which is header-independent.)
    let got429 = false;
    for (let i = 0; i < 14; i++) {
      const res = await fetch(base + "/api/quoter/commit-quote", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `10.0.0.${i}`,
        },
        body: JSON.stringify({ id: "qrl", signerId: 7, pin: "0000" }),
      });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
});
