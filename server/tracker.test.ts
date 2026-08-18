// @vitest-environment node
//
// Frozen tracker month safeguard: a suspicious re-snapshot (empty or
// materially smaller sheet read) must be refused unless explicitly forced,
// so valid history can't be silently erased.
import { describe, expect, it } from "vitest";
import { snapshotGuard } from "./tracker";

describe("snapshotGuard", () => {
  it("allows a first snapshot (nothing frozen yet), even an empty one", () => {
    expect(snapshotGuard(0, 0, false).ok).toBe(true);
    expect(snapshotGuard(0, 42, false).ok).toBe(true);
  });

  it("refuses replacing frozen rows with an EMPTY read", () => {
    const v = snapshotGuard(37, 0, false);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/0 rows/);
  });

  it("refuses a materially smaller overwrite (less than half)", () => {
    expect(snapshotGuard(40, 19, false).ok).toBe(false);
    expect(snapshotGuard(10, 4, false).ok).toBe(false);
  });

  it("allows a same-size or modestly smaller re-run (the correction path)", () => {
    expect(snapshotGuard(40, 40, false).ok).toBe(true);
    expect(snapshotGuard(40, 38, false).ok).toBe(true);
    expect(snapshotGuard(40, 20, false).ok).toBe(true); // exactly half is fine
    expect(snapshotGuard(40, 55, false).ok).toBe(true); // bigger is always fine
  });

  it("force overrides every refusal", () => {
    expect(snapshotGuard(37, 0, true).ok).toBe(true);
    expect(snapshotGuard(40, 3, true).ok).toBe(true);
  });
});
