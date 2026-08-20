// @vitest-environment node
//
// Global truck search: one query covers inspections (incl. archived),
// intakes, and quote-only records. Proves:
//   - all three record classes are searched and merged
//   - archived inspections are returned WITH their archived flag (not hidden)
//   - a quote whose VIN already matched an intake/inspection is deduped out
//   - sub-2-character queries return nothing (no table scans on one keystroke)
//   - LIKE wildcards typed by the user are escaped, not interpreted
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: { text: string; params: any[] }[] = [];
  let responses: any[][] = [[], [], []]; // inspections, intakes, quotes (per searchTrucks order)
  const sqlParts = (q: any): { text: string; params: any[] } => {
    const chunks: any[] = q?.queryChunks ?? [];
    let text = "";
    const params: any[] = [];
    for (const c of chunks) {
      if (c == null) continue;
      if (c.constructor?.name === "StringChunk") text += Array.isArray(c.value) ? c.value.join("") : String(c.value ?? "");
      else if (typeof c === "object" && "queryChunks" in c) { const i = sqlParts(c); text += i.text; params.push(...i.params); }
      else if (typeof c === "object" && "value" in c) { text += "?"; params.push(c.value); }
      else { text += "?"; params.push(c); }
    }
    return { text, params };
  };
  const fakeDb = {
    execute: async (q: any) => {
      const { text, params } = sqlParts(q);
      calls.push({ text, params });
      if (/FROM inspections/i.test(text)) return { rows: responses[0] };
      if (/FROM intakes/i.test(text)) return { rows: responses[1] };
      if (/FROM quotes/i.test(text)) return { rows: responses[2] };
      return { rows: [] };
    },
  };
  return { calls, setResponses: (r: any[][]) => { responses = r; }, fakeDb };
});

vi.mock("./db", () => ({ db: H.fakeDb }));
vi.mock("./access", () => ({
  requireEmployee: (_req: any, _res: any, next: any) => next(),
}));

import { searchTrucks } from "./search";

beforeEach(() => {
  H.calls.length = 0;
  H.setResponses([[], [], []]);
});

describe("searchTrucks", () => {
  it("returns nothing for queries under 2 characters (and runs no SQL)", async () => {
    expect(await searchTrucks("")).toEqual([]);
    expect(await searchTrucks("f")).toEqual([]);
    expect(await searchTrucks("  ")).toEqual([]);
    expect(H.calls.length).toBe(0);
  });

  it("merges all three record classes and keeps the archived flag visible", async () => {
    H.setResponses([
      [{ id: 7, qc_number: "FQ-1007", vin: "1FTFW1E55MFA00001", stock: "T101", vehicle: "2021 Ford F-150", status: "cleared", archived: true, updated_ms: 3000 }],
      [{ id: "i1", vin: "3GCUYDED5LG000002", stock: "T102", vehicle: "2020 Chevy 1500", quote_id: "q9", committed_by: "Ana", updated_ms: 2000 }],
      [{ id: "q1", committed_by: null, vin: "1C6SRFFT4MN000003", stock: "T103", vehicle: "2021 Ram 1500", updated_ms: 1000 }],
    ]);
    const out = await searchTrucks("T10");
    expect(out.map((r) => r.kind).sort()).toEqual(["inspection", "intake", "quote"]);
    const insp = out.find((r) => r.kind === "inspection")!;
    expect(insp.archived).toBe(true);
    expect(insp.qcNumber).toBe("FQ-1007");
    expect(insp.vin).toBe("1FTFW1E55MFA00001"); // full VIN, never truncated
    const intake = out.find((r) => r.kind === "intake")!;
    expect(intake.committed).toBe(true);
    expect(intake.quoteId).toBe("q9");
    const quote = out.find((r) => r.kind === "quote")!;
    expect(quote.committed).toBe(false);
    expect(quote.quoteId).toBe("q1");
    // Newest activity first.
    expect(out[0].kind).toBe("inspection");
  });

  it("drops a quote row whose VIN is already covered by an intake or inspection hit", async () => {
    const vin = "1FTFW1E55MFA00009";
    H.setResponses([
      [],
      [{ id: "i2", vin, stock: "T200", vehicle: "F-150", quote_id: "q2", committed_by: null, updated_ms: 2000 }],
      [
        { id: "q2", committed_by: null, vin, stock: "T200", vehicle: "F-150", updated_ms: 1000 },
        { id: "q3", committed_by: null, vin: "1FTFW1E55MFA00010", stock: "T201", vehicle: "F-250", updated_ms: 500 },
      ],
    ]);
    const out = await searchTrucks("T20");
    expect(out.filter((r) => r.vin === vin)).toHaveLength(1); // intake only
    expect(out.some((r) => r.kind === "quote" && r.quoteId === "q3")).toBe(true);
  });

  it("merges an inspection with its linked intake so the richer overview is the navigation target", async () => {
    const vin = "1FTFW1E55MFA00011";
    H.setResponses([
      [{
        id: 11, qc_number: "FQ-1011", vin, stock: "OLD-STOCK", vehicle: "Inspection vehicle",
        status: "cleared", archived: false, updated_ms: 3000,
        intake_id: "i11", intake_stock: "T211", intake_vehicle: "2022 Ford F-150",
        intake_quote_id: "q11", intake_committed_by: "Ana", intake_updated_ms: 4000,
      }],
      [],
      [],
    ]);

    const out = await searchTrucks("FQ-1011");

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "intake",
      vin,
      stock: "T211",
      vehicle: "2022 Ford F-150",
      qcNumber: "FQ-1011",
      quoteId: "q11",
      intakeId: "i11",
      committed: true,
    });
  });

  it("escapes user-typed LIKE wildcards instead of interpreting them", async () => {
    await searchTrucks("50%_T");
    expect(H.calls.length).toBeGreaterThan(0);
    for (const c of H.calls) {
      const likeParams = c.params.filter((p) => typeof p === "string" && p.startsWith("%"));
      expect(likeParams.length).toBeGreaterThan(0);
      for (const p of likeParams) expect(p).toBe("%50\\%\\_T%");
    }
  });
});
