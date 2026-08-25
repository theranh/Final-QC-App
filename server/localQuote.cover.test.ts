// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("./db", () => ({ db: { execute } }));
vi.mock("./access", () => ({ requireEmployee: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { fetchQuoteCovers, firstGalleryPhotoIds } from "./localQuote";

describe("canonical intake gallery cover selection", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("uses earliest photos.ts, then photos.id, regardless of slot, role, or row order", async () => {
    execute.mockResolvedValue({
      rows: [
        { id: "later", quote_id: "q1", ts: 20, slot: "ext_fd_corner", role: "walk" },
        { id: "same-ts-z", quote_id: "q1", ts: 10, slot: "ext_front", role: "walk" },
        { id: "same-ts-a", quote_id: "q1", ts: 10, slot: "dmg_door", role: "damage" },
      ],
    });

    await expect(firstGalleryPhotoIds(["q1"])).resolves.toEqual(new Map([
      ["q1", "same-ts-a"],
    ]));
  });

  it("promotes the next surviving row when the former first photo is deleted", async () => {
    execute.mockResolvedValue({
      rows: [
        { id: "third", quote_id: "q1", ts: 30 },
        { id: "second", quote_id: "q1", ts: 20 },
      ],
    });

    expect((await firstGalleryPhotoIds(["q1"])).get("q1")).toBe("second");
  });

  it("keys exact intake/quote galleries independently even when their VIN is the same", async () => {
    execute
      .mockResolvedValueOnce({
        rows: [
          { id: "quote-a", data: { vin: "SAMEVIN", totals: { hrs: 1 }, lines: [] } },
          { id: "quote-b", data: { vin: "SAMEVIN", totals: { hrs: 2 }, lines: [] } },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: "b-first", quote_id: "quote-b", ts: 1 },
          { id: "a-first", quote_id: "quote-a", ts: 1 },
        ],
      });

    const covers = await fetchQuoteCovers([
      { intakeId: "intake-a", quoteId: "quote-a" },
      { intakeId: "intake-b", quoteId: "quote-b" },
    ]);

    expect(covers.get("intake-a")).toMatchObject({
      cover: "/api/quoter/photo?id=a-first",
      hrs: 1,
    });
    expect(covers.get("intake-b")).toMatchObject({
      cover: "/api/quoter/photo?id=b-first",
      hrs: 2,
    });
  });

  it("ignores quote cover, damage thumb, and intake photoOrder when no canonical photo survives", async () => {
    execute
      .mockResolvedValueOnce({
        rows: [{
          id: "quote-a",
          data: {
            cover: "data:image/jpeg;base64,WRONG",
            lines: [{ cls: { panel: "door" }, thumb: "data:image/jpeg;base64,ALSO_WRONG" }],
            photoOrder: ["missing-photo"],
          },
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const covers = await fetchQuoteCovers([{ intakeId: "intake-a", quoteId: "quote-a" }]);
    expect(covers.get("intake-a")).toEqual({
      cover: null,
      hrs: null,
      usd: null,
      lineCount: 1,
    });
  });
});