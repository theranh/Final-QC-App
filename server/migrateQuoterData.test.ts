import { describe, expect, it } from "vitest";
import {
  LEGACY_PHOTO_INSERT_SQL,
  legacyPhotoInsertParams,
  type LegacyQuoterPhoto,
} from "../scripts/migrate-quoter-photo";

const row = (slot: string | null): LegacyQuoterPhoto => ({
  id: `photo-${slot ?? "null"}`,
  quote_id: "quote-1",
  slot,
  mime: "image/jpeg",
  data: Buffer.from("photo"),
  ts: 123,
});

describe("legacy Quoter photo copy", () => {
  it("writes role explicitly instead of relying on the database default", () => {
    expect(LEGACY_PHOTO_INSERT_SQL).toMatch(
      /INSERT INTO photos \(id, quote_id, slot, role, mime, data, ts\)/,
    );
    expect(LEGACY_PHOTO_INSERT_SQL).toContain(
      "VALUES ($1, $2, $3, $4, $5, $6, $7)",
    );
  });

  it.each([
    ["ext_front", "walk"],
    ["wa1785157071621_0001", "walk"],
    ["dmg1785275438138_dmg", "damage"],
    ["ext_driver_dmg", "damage"],
    ["dmg_wide_w1787155976774pwtu", "damage_wide"],
    ["unknown_old_slot", "unclassified"],
    [null, "unclassified"],
  ])("copies legacy slot %s with canonical role %s", (slot, expectedRole) => {
    expect(legacyPhotoInsertParams(row(slot))[3]).toBe(expectedRole);
  });
});