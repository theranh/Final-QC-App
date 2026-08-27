import { describe, expect, it } from "vitest";
import { planInspectionAssets } from "./storageMigrationData";

describe("inspection photo migration planning", () => {
  it("preserves document structure and bytes while assigning stable QC indexes", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0x7f, 0xff, 0xd9]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xfe]);
    const source = {
      sibling: "unchanged",
      vinPhoto: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
      items: {
        body: [{
          item: "Door",
          photos: [
            `data:image/png;base64,${png.toString("base64")}`,
            "legacy-non-data-value",
          ],
          note: "preserved",
        }],
      },
      rechecks: [{
        items: [{
          photos: [`data:image/jpeg;base64,${jpeg.toString("base64")}`],
        }],
      }],
    };

    const planned = planInspectionAssets("FQ-1234", source);

    expect(planned.assets.map((asset) => asset.key)).toEqual([
      "inspections/FQ-1234/0",
      "inspections/FQ-1234/1",
      "inspections/FQ-1234/2",
    ]);
    expect(planned.assets.map((asset) => asset.bytes)).toEqual([jpeg, png, jpeg]);
    expect(planned.data).toMatchObject({
      sibling: "unchanged",
      items: {
        body: [{
          item: "Door",
          photos: [
            { ref: "inspections/FQ-1234/1", mime: "image/png" },
            "legacy-non-data-value",
          ],
          note: "preserved",
        }],
      },
      rechecks: [{
        items: [{
          photos: [{ ref: "inspections/FQ-1234/2", mime: "image/jpeg" }],
        }],
      }],
    });
    expect(source.vinPhoto).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
  });
});