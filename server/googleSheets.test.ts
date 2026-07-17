import { describe, expect, it } from "vitest";
import { buildRow, isExportable } from "./googleSheets";
import type { Inspection } from "@shared/schema";

function fakeRecord(overrides: Partial<Inspection> & { data?: any } = {}): Inspection {
  return {
    id: 1,
    qcNumber: "FQ-1234",
    stock: "S1",
    vehicle: "2024 F-150",
    vin: "1FTFW1E81NKD72360",
    result: "pass",
    status: "pass",
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
        mech: [{ item: "Cold start & idle", mark: "p" }],
        cosm: [{ item: "Panel paint match", mark: "p" }],
        detail: [{ item: "Interior surfaces", mark: "p" }],
        bed: [{ item: "Coverage & thickness", mark: "p" }],
      },
    },
    ...overrides,
  } as Inspection;
}

describe("isExportable (pass-only rule)", () => {
  it("exports outright passes", () => {
    expect(isExportable(fakeRecord({ result: "pass", status: "pass" }))).toBe(true);
  });
  it("does NOT export failed/open inspections", () => {
    expect(isExportable(fakeRecord({ result: "fail", status: "open" }))).toBe(false);
  });
  it("exports failed inspections once cleared by re-check", () => {
    expect(isExportable(fakeRecord({ result: "fail", status: "cleared" }))).toBe(true);
  });
});

describe("buildRow (VPC tracker mapping)", () => {
  it("fills only VIN, dates, K-O, and notes — never formula columns G-J or P", () => {
    const rec = fakeRecord();
    const row = buildRow(rec, new Date((rec.data as any).ts));
    expect(row).toHaveLength(17);
    expect(row[0]).toBe(rec.vin); // A: VIN
    expect(row[1]).toBeNull(); // B: RO Open Date untouched
    expect(row[2]).toBe("07/17/2026"); // C: Completed Date (Central)
    expect(row[3]).toBe("07/17/2026"); // D: Picture Received — auto-filled with QC pass date
    for (const i of [4, 5, 6, 7, 8, 9]) expect(row[i]).toBeNull(); // E-J untouched
    expect(row[10]).toBe("Pass"); // K: Mechanic
    expect(row[11]).toBe("Pass"); // L: Paint & Body
    expect(row[12]).toBe("Pass"); // M: Detail
    expect(row[13]).toBe("N/A"); // N: Undercoat (opted out)
    expect(row[14]).toBe("Pass"); // O: Bedliner
    expect(row[15]).toBeNull(); // P: QC Result is the sheet's formula — untouched
    expect(row[16]).toBe("FQ-1234"); // Q: Notes carries the FQ number
  });

  it("marks categories with no items N/A", () => {
    const rec = fakeRecord({
      data: {
        ts: Date.now(),
        optOut: {},
        items: { mech: [{ item: "Brakes — pads & rotors", mark: "p" }] },
      },
    });
    const row = buildRow(rec, new Date());
    expect(row[10]).toBe("Pass"); // mech
    expect(row[11]).toBe("N/A"); // cosm absent
    expect(row[13]).toBe("N/A"); // under absent
  });

  it("shows Pass for originally-failed categories once cleared, and notes the re-check", () => {
    const rec = fakeRecord({
      result: "fail",
      status: "cleared",
      data: {
        ts: Date.now(),
        clearedTs: Date.now(),
        optOut: {},
        items: {
          mech: [{ item: "Cold start & idle", mark: "f" }],
          cosm: [{ item: "Panel paint match", mark: "p" }],
        },
      },
    });
    const row = buildRow(rec, new Date());
    expect(row[10]).toBe("Pass"); // mech failed originally but was repaired & cleared
    expect(row[16]).toBe("FQ-1234 — Passed after re-check");
  });
});
