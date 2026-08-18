// @vitest-environment node
//
// PIN sign-off tests:
//  1. hashPin/verifyPin round-trip; wrong PIN and malformed hashes fail.
//  2. commit-intake / commit-quote endpoints: PIN required at commit, wrong
//     PIN rejected, committed_by immutable (409 on re-commit), supervisor
//     override writes committed_by=worker + overridden_by=supervisor, and a
//     non-override signer cannot sign for someone else.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  const quoteRows: any[] = [];
  const audits: any[] = [];
  const snapRows: any[] = []; // quote_snapshots (Phase 1A)
  const corrRows: any[] = []; // pricing_corrections (Phase 1A)

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
      // (Table objects contribute no literal text in sqlParts, so match on
      // the FOR UPDATE marker — only the quote read uses it.)
      if (/for update/i.test(text)) {
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
              if (emps.some((e) => e.id === id)) rows = emps.filter((e) => e.id === id);
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
            const { params } = sqlParts(cond);
            const id = params[0];
            // ids are unique across stores in these tests; find whichever holds it.
            const row =
              intakeRows.find((r) => r.id === id) || quoteRows.find((r) => r.id === id);
            if (!row || row.committedBy) return []; // immutability guard
            Object.assign(row, patch);
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
  return { emps, intakeRows, quoteRows, audits, snapRows, corrRows, fakeDb };
});

const { emps, intakeRows, quoteRows, audits, snapRows, corrRows } = H;

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
    expect(intakeRows.find((x) => x.id === "in1").committedBy).toBe("Worker");
  });

  it("refuses to re-commit an already committed intake (409, immutable)", async () => {
    const r = await post("/api/quoter/commit-intake", { id: "in1", signerId: 2, pin: "2222" });
    expect(r.status).toBe(409);
    expect(intakeRows.find((x) => x.id === "in1").committedBy).toBe("Worker");
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
    const r = await post("/api/quoter/commit-intake", { id: "insnap", signerId: 1, pin: "1111" });
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
