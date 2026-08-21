// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("./db", () => ({ db: { execute } }));
vi.mock("./access", () => ({ requireEmployee: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { bestWalkPhotoIds, fetchQuoteCovers } from "./localQuote";

describe("intake vehicle-card cover selection", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("selects Front · driver corner regardless of database row order", async () => {
    execute.mockResolvedValue({
      rows: [
        { id: "rear", quote_id: "q1", slot: "ext_rear" },
        { id: "damage", quote_id: "q1", slot: "dmg_door" },
        { id: "driver-side", quote_id: "q1", slot: "ext_driver" },
        { id: "front-driver-corner", quote_id: "q1", slot: "ext_fd_corner" },
      ],
    });

    await expect(bestWalkPhotoIds(["q1"])).resolves.toEqual(new Map([
      ["q1", { id: "front-driver-corner", rank: 0 }],
    ]));
  });

  it("uses the intake-linked Front · driver corner over quote covers and only falls back when absent", async () => {
    execute
      .mockResolvedValueOnce({
        rows: [{
          vin: "1FTFW1E50MFA00001",
          id: "quote-row",
          data: { vin: "1FTFW1E50MFA00001", cover: "data:image/jpeg;base64,DAMAGE", lines: [] },
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: "latest-quote-front", quote_id: "quote-row", slot: "ext_front" },
          { id: "intake-rear", quote_id: "intake-quote", slot: "ext_rear" },
          { id: "intake-front-driver", quote_id: "intake-quote", slot: "ext_fd_corner" },
        ],
      });

    const covers = await fetchQuoteCovers([
      { vin: "1FTFW1E50MFA00001", quoteId: "intake-quote" },
    ]);

    expect(covers.get("1FTFW1E50MFA00001")?.cover)
      .toBe("/api/quoter/photo?id=intake-front-driver");
  });
});