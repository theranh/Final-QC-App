// @vitest-environment node
//
// Durable Google Sheets export queue: bounded backoff and the pending→failed
// transition (automatic retries stop, manual retry stays possible).
import { describe, expect, it } from "vitest";
import { backoffMs, failureTransition, MAX_AUTO_ATTEMPTS } from "./sheetExports";

describe("backoffMs (bounded backoff)", () => {
  it("steps 1m → 5m → 15m → 30m → 60m and stays capped at 60m", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(5 * 60_000);
    expect(backoffMs(3)).toBe(15 * 60_000);
    expect(backoffMs(4)).toBe(30 * 60_000);
    expect(backoffMs(5)).toBe(60 * 60_000);
    expect(backoffMs(50)).toBe(60 * 60_000);
  });
});

describe("failureTransition", () => {
  it("stays pending with increasing attempts below the cap", () => {
    const t = failureTransition(0);
    expect(t).toEqual({ attempts: 1, status: "pending", delayMs: 60_000 });
    expect(failureTransition(3).status).toBe("pending");
  });

  it("flips to failed at MAX_AUTO_ATTEMPTS so it can't retry silently forever", () => {
    const t = failureTransition(MAX_AUTO_ATTEMPTS - 1);
    expect(t.attempts).toBe(MAX_AUTO_ATTEMPTS);
    expect(t.status).toBe("failed");
  });

  it("delay is always bounded by the 60-minute cap", () => {
    for (let a = 0; a < 20; a++) {
      expect(failureTransition(a).delayMs).toBeLessThanOrEqual(60 * 60_000);
      expect(failureTransition(a).delayMs).toBeGreaterThan(0);
    }
  });
});
