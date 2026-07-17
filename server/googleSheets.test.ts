import { describe, expect, it } from "vitest";
import { buildRow } from "./googleSheets";
import type { Inspection } from "@shared/schema";

function fakeRecord(overrides: Partial<Inspection> & { data?: any } = {}): Inspection {
  return {
    id: 1,
    qcNumber: "FQ-1234",
    stock: "S1",
    vehicle: "2024 F-150",
    vin: "1FTFW1E81NKD72360",
    result: "fail",
    status: "open",
    imported: false,
    createdById: "u1",
    createdByEmail: "a@truckranch.com",
    createdByName: "A",
    createdAt: new Date("2026-07-17T12:00:00-05:00"),
    updatedById: "u1",
    updatedByEmail: "a@truckranch.com",
    updatedByName: "A",
    updatedAt: new Date(),
    data: {
      ts: new Date("2026-07-17T12:00:00-05:00").getTime(),
      optOut: { ceramic: true, under: true },
      items: {
        mech: [{ item: "Cold start & idle", mark: "f" }],
        cosm: [{ item: "Panel paint match", mark: "p" }],
        detail: [{ item: "Interior surfaces", mark: "p" }],
        bed: [{ item: "Coverage & thickness", mark: "p" }],
      },
    },
    ...overrides,
  } as Inspection;
}

describe("buildRow (VPC tracker mapping)", () => {
  it("maps VIN, date, category outcomes, QC result, and notes to A..Q", () => {
    const rec = fakeRecord();
    const row = buildRow(rec, new Date((rec.data as any).ts));
    expect(row).toHaveLength(17);
    expect(row[0]).toBe(rec.vin); // A: VIN
    expect(row[1]).toBeNull(); // B: RO Open Date untouched
    expect(row[2]).toBe("07/17/2026"); // C: Completed Date (Central)
    for (const i of [3, 4, 5, 6, 7, 8, 9]) expect(row[i]).toBeNull(); // D-J untouched
    expect(row[10]).toBe("Fail"); // K: Mechanic
    expect(row[11]).toBe("Pass"); // L: Paint & Body
    expect(row[12]).toBe("Pass"); // M: Detail
    expect(row[13]).toBe("N/A"); // N: Undercoat (opted out)
    expect(row[14]).toBe("Pass"); // O: Bedliner
    expect(row[15]).toBe("Fail"); // P: QC Result
    expect(row[16]).toBe("FQ-1234"); // Q: Notes carries the FQ number
  });

  it("marks all-pass inspections Pass and missing categories N/A", () => {
    const rec = fakeRecord({
      result: "pass",
      status: "pass",
      data: {
        ts: Date.now(),
        optOut: {},
        items: { mech: [{ item: "Brakes — pads & rotors", mark: "p" }] },
      },
    });
    const row = buildRow(rec, new Date());
    expect(row[10]).toBe("Pass"); // mech
    expect(row[11]).toBe("N/A"); // cosm absent
    expect(row[15]).toBe("Pass");
  });

  it("surfaces ceramic-coating fails in the notes column", () => {
    const rec = fakeRecord({
      data: {
        ts: Date.now(),
        optOut: {},
        items: {
          mech: [{ item: "Cold start & idle", mark: "p" }],
          ceramic: [{ item: "Water bead test", mark: "f" }],
        },
      },
    });
    const row = buildRow(rec, new Date());
    expect(row[16]).toBe("FQ-1234 — Ceramic Coating: Fail");
  });
});
