// @vitest-environment node
//
// Body Quoter server-side immutability tests: once a quote/intake is committed
// (committed_by IS NOT NULL) its signed content is frozen. Proves:
//   - PUT  /api/quoter/quotes on a committed quote  -> 409
//   - DELETE /api/quoter/quotes on a committed quote -> 409
//   - POST /api/quoter/photos when owning quote committed  -> 409
//   - DELETE /api/quoter/photos (by quoteId and by photo id) when committed -> 409
//   - PUT  /api/quoter/intakes on a committed intake -> 409
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

// ---------- in-memory stores + fake db (hoisted for vi.mock) ----------
const H = vi.hoisted(() => {
  const quoteRows: any[] = [];
  const intakeRows: any[] = [];
  const photoRows: any[] = [];

  const sqlParts = (q: any): { text: string; params: any[] } => {
    const chunks: any[] = q?.queryChunks ?? [];
    let text = "";
    const params: any[] = [];
    for (const c of chunks) {
      if (c == null) continue;
      if (typeof c === "string" || typeof c === "number" || typeof c === "boolean") {
        text += "?";
        params.push(c);
      } else if (c.constructor?.name === "StringChunk") {
        text += Array.isArray(c.value) ? c.value.join("") : String(c.value ?? "");
      } else if (typeof c === "object" && "queryChunks" in c) {
        const inner = sqlParts(c);
        text += inner.text;
        params.push(...inner.params);
      } else if (typeof c === "object" && "value" in c) {
        text += "?";
        params.push(c.value);
      }
    }
    return { text, params };
  };

  // Reads a bound id out of an eq()/sql`` where-condition (first param).
  const idOf = (cond: any) => sqlParts(cond).params[0];

  const fakeDb: any = {
    // ----- insert (upsert) : PUT /api/quoter/quotes -----
    insert: (_table: any) => ({
      values: (v: any) => {
        const applyUpsert = () => {
          const existing = quoteRows.find((r) => r.id === v.id);
          if (existing) {
            if (existing.committedBy) return []; // setWhere: committed_by IS NULL blocked
            Object.assign(existing, v);
            return [{ id: existing.id }];
          }
          const row = { ...v, committedBy: null, overriddenBy: null };
          quoteRows.push(row);
          return [{ id: row.id }];
        };
        const builder: any = {
          onConflictDoUpdate: () => ({
            returning: (_c?: any) => Promise.resolve(applyUpsert()),
          }),
        };
        return builder;
      },
    }),
    // ----- select : committed-by lookups -----
    select: (_cols?: any) => ({
      from: (table: any) => ({
        where: (cond: any) => {
          const id = idOf(cond);
          const p: any = Promise.resolve().then(() => {
            // pick store by which one holds the id
            if (quoteRows.some((r) => r.id === id)) return quoteRows.filter((r) => r.id === id);
            if (intakeRows.some((r) => r.id === id)) return intakeRows.filter((r) => r.id === id);
            if (photoRows.some((r) => r.id === id)) return photoRows.filter((r) => r.id === id);
            return [];
          });
          return p;
        },
      }),
    }),
    // ----- delete : DELETE quotes/photos -----
    delete: (_table: any) => ({
      where: (cond: any) => {
        const { text, params } = sqlParts(cond);
        // The committed-guard delete uses a sql`` fragment ending in
        // "IS NULL"; plain eq()-based deletes do not. (Column refs contribute
        // no text, so we key off the literal "IS NULL" fragment.)
        const guarded = /IS NULL/i.test(text);
        const doDelete = () => {
          const id = params[0];
          // Quote delete (guarded) vs photo delete (by id or quoteId).
          const qi = quoteRows.findIndex((r) => r.id === id);
          if (guarded) {
            if (qi < 0) return [];
            if (quoteRows[qi].committedBy) return [];
            const [gone] = quoteRows.splice(qi, 1);
            return [{ id: gone.id }];
          }
          // Non-guarded: could be photos by id or quoteId, or a quote row.
          if (qi >= 0) {
            quoteRows.splice(qi, 1);
            return [];
          }
          for (let i = photoRows.length - 1; i >= 0; i--) {
            if (photoRows[i].id === id || photoRows[i].quoteId === id) photoRows.splice(i, 1);
          }
          return [];
        };
        const p: any = Promise.resolve().then(doDelete);
        p.returning = (_c?: any) => Promise.resolve(doDelete());
        return p;
      },
    }),
    // ----- execute : intakes upsert + photo count -----
    execute: async (q: any) => {
      const { text, params } = sqlParts(q);
      if (/FROM intakes i LEFT JOIN quotes/i.test(text)) {
        return { rows: intakeRows.map((i) => ({ ...i, quote_data: quoteRows.find((q) => q.id === i.quote_id)?.data || null })) };
      }
      if (/UPDATE intakes SET quote_id/i.test(text)) {
        const id = params.find((x: any) => x === "cas") || params[0];
        const requested = params.find((x: any) => x === "q-a" || x === "q-b") || params[1];
        const row = intakeRows.find((x) => x.id === id);
        if (!row || row.committedBy) return { rows: [] };
        row.quote_id = row.quote_id || requested;
        return { rows: [{ quote_id: row.quote_id }] };
      }
      if (/FROM photos WHERE quote_id/i.test(text)) {
        return { rows: [{ n: 0 }] };
      }
      if (/INSERT INTO intakes/i.test(text)) {
        const id = params[0];
        const existing = intakeRows.find((r) => r.id === id);
        if (existing) {
          // The route already 409s committed intakes before calling execute,
          // so here we only model the last-write-wins upsert of open rows.
          if (!existing.committedBy) Object.assign(existing, { id });
          return { rows: [] };
        }
        intakeRows.push({ id, committedBy: null, overriddenBy: null });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  return { quoteRows, intakeRows, photoRows, fakeDb };
});

const { quoteRows, intakeRows, photoRows } = H;

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
  const { registerQuoterRoutes } = await import("./quoter");
  const app = express();
  registerQuoterRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => server?.close());

async function req(method: string, path: string, body?: any) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const PNG_DATAURL = "data:image/png;base64," + Buffer.from("hello-png").toString("base64");

beforeEach(() => {
  quoteRows.length = 0;
  intakeRows.length = 0;
  photoRows.length = 0;
});

describe("quote immutability once committed", () => {
  it("PUT /api/quoter/quotes updates an open quote (200) but 409s a committed one", async () => {
    quoteRows.push({ id: "open1", data: { a: 1 }, committedBy: null, overriddenBy: null });
    quoteRows.push({ id: "done1", data: { a: 1 }, committedBy: "Worker", overriddenBy: null });

    const ok = await req("PUT", "/api/quoter/quotes", { id: "open1", data: { a: 2 } });
    expect(ok.status).toBe(200);

    const blocked = await req("PUT", "/api/quoter/quotes", { id: "done1", data: { a: 2 } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("Quote is committed");
    // committed content untouched
    expect(quoteRows.find((r) => r.id === "done1").data).toEqual({ a: 1 });
  });

  it("DELETE /api/quoter/quotes 409s a committed quote and leaves it in place", async () => {
    quoteRows.push({ id: "done2", data: {}, committedBy: "Worker", overriddenBy: null });
    const r = await req("DELETE", "/api/quoter/quotes?id=done2");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Quote is committed");
    expect(quoteRows.some((x) => x.id === "done2")).toBe(true);
  });

  it("DELETE /api/quoter/quotes removes an open quote (200)", async () => {
    quoteRows.push({ id: "open2", data: {}, committedBy: null, overriddenBy: null });
    const r = await req("DELETE", "/api/quoter/quotes?id=open2");
    expect(r.status).toBe(200);
    expect(quoteRows.some((x) => x.id === "open2")).toBe(false);
  });
});

describe("photo mutations blocked once owning quote committed", () => {
  it("POST /api/quoter/photos 409s when owning quote is committed", async () => {
    quoteRows.push({ id: "cq", data: {}, committedBy: "Worker", overriddenBy: null });
    const r = await req("POST", "/api/quoter/photos", {
      id: "p1",
      quoteId: "cq",
      slot: "front",
      dataUrl: PNG_DATAURL,
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Quote is committed");
  });

  it("POST /api/quoter/photos allows in-place overwrite of an EXISTING photo on a committed quote (rotate)", async () => {
    quoteRows.push({ id: "cqr", data: {}, committedBy: "Worker", overriddenBy: null });
    photoRows.push({ id: "pr", quoteId: "cqr" });
    const r = await req("POST", "/api/quoter/photos", {
      id: "pr",
      quoteId: "cqr",
      slot: "front",
      dataUrl: PNG_DATAURL,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("POST /api/quoter/photos 409s when the photo id belongs to another quote", async () => {
    quoteRows.push({ id: "qa", data: {}, committedBy: null, overriddenBy: null });
    photoRows.push({ id: "ph-owned", quoteId: "some-other-quote" });
    const r = await req("POST", "/api/quoter/photos", {
      id: "ph-owned",
      quoteId: "qa",
      slot: "front",
      dataUrl: PNG_DATAURL,
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Photo belongs to another quote");
  });

  it("DELETE /api/quoter/photos by quoteId 409s when quote committed", async () => {
    quoteRows.push({ id: "cq2", data: {}, committedBy: "Worker", overriddenBy: null });
    photoRows.push({ id: "px", quoteId: "cq2" });
    const r = await req("DELETE", "/api/quoter/photos", { quoteId: "cq2" });
    expect(r.status).toBe(409);
    expect(photoRows.some((p) => p.id === "px")).toBe(true);
  });

  it("DELETE /api/quoter/photos by photo id 409s when its quote committed", async () => {
    quoteRows.push({ id: "cq3", data: {}, committedBy: "Worker", overriddenBy: null });
    photoRows.push({ id: "py", quoteId: "cq3" });
    const r = await req("DELETE", "/api/quoter/photos", { id: "py" });
    expect(r.status).toBe(409);
    expect(photoRows.some((p) => p.id === "py")).toBe(true);
  });

  it("DELETE /api/quoter/photos succeeds for an open quote's photo", async () => {
    quoteRows.push({ id: "oq", data: {}, committedBy: null, overriddenBy: null });
    photoRows.push({ id: "pz", quoteId: "oq" });
    const r = await req("DELETE", "/api/quoter/photos", { id: "pz" });
    expect(r.status).toBe(200);
    expect(photoRows.some((p) => p.id === "pz")).toBe(false);
  });
});

describe("intake immutability once committed", () => {
  it("PUT /api/quoter/intakes 409s a committed intake", async () => {
    intakeRows.push({
      id: "in1",
      vin: "1FTFW1E81NKD72360",
      committedBy: "Worker",
      overriddenBy: null,
    });
    const r = await req("PUT", "/api/quoter/intakes", {
      id: "in1",
      vin: "1FTFW1E81NKD72360",
      data: { roReady: Array(9).fill(false) },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Intake is committed");
  });

  it("PUT /api/quoter/intakes upserts an open intake (200)", async () => {
    const r = await req("PUT", "/api/quoter/intakes", {
      id: "in2",
      vin: "1FTFW1E81NKD72360",
      data: { roReady: Array(9).fill(false) },
    });
    expect(r.status).toBe(200);
  });

  it("GET /api/quoter/intakes lists trimmed progress rows without photo bytes", async () => {
    intakeRows.push({
      id: "in1", vin: "VIN123456", stock: "T1", vehicle: "2022 Ford", estimator: "Alex",
      quote_id: "q1", committed_by: null, completed_at: null, updated_ms: 20,
      data: { steps: { "1": [true, true, true], "2": [true], "3": [], "4": [] } },
    });
    quoteRows.push({ id: "q1", data: { id: "q1", lines: [{ cls: {} }], totals: { hrs: 2, usd: 300 } } });
    const r = await req("GET", "/api/quoter/intakes");
    expect(r.status).toBe(200);
    expect(r.body.intakes).toHaveLength(1);
    expect(r.body.intakes[0]).toMatchObject({ id: "in1", pct: 20, quote: { lineCount: 1, hrs: 2, usd: 300 } });
    expect(r.body.intakes[0].data).toBeUndefined();
    expect(r.body.intakes[0].photoCount).toBeUndefined();
  });

  it("POST link-quote uses compare-and-set and returns the canonical quote", async () => {
    intakeRows.push({ id: "cas", quote_id: null, committedBy: null });
    const a = await req("POST", "/api/quoter/intakes/cas/link-quote", { quoteId: "q-a" });
    const b = await req("POST", "/api/quoter/intakes/cas/link-quote", { quoteId: "q-b" });
    expect(a.body.quoteId).toBe("q-a");
    expect(b.body.quoteId).toBe("q-a");
  });
});
