// @vitest-environment node
//
// Rates hardening: PUT /api/quoter/rates only accepts COMPLETE, numeric rate
// objects, so a malformed/partial save can never break the shallow-merged
// pricing engine. Values are never altered — pricing math stays untouched.
import { describe, expect, it } from "vitest";
import { validateRates } from "./ratesValidation";
import { defaultRates } from "../src/lib/quoterPricing.js";

const clone = () => JSON.parse(JSON.stringify(defaultRates()));

describe("validateRates", () => {
  it("accepts the default rates verbatim", () => {
    expect(validateRates(defaultRates()).ok).toBe(true);
  });

  it("accepts a fully-specified custom rate sheet (values unchanged)", () => {
    const r = clone();
    r.dollars.body = 85;
    r.body.hood.moderate = 3.25;
    expect(validateRates(r).ok).toBe(true);
  });

  it("rejects non-objects and arrays", () => {
    expect(validateRates(null).ok).toBe(false);
    expect(validateRates("rates").ok).toBe(false);
    expect(validateRates([1, 2]).ok).toBe(false);
  });

  it("rejects a missing group (partial object would wipe the whole group after merge)", () => {
    const r = clone();
    delete r.body;
    const v = validateRates(r);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/body/);
  });

  it("rejects a missing panel inside a group", () => {
    const r = clone();
    delete r.refinish.hood;
    expect(validateRates(r).ok).toBe(false);
  });

  it("rejects a missing per-panel leaf (e.g. body.hood.replace)", () => {
    const r = clone();
    delete r.body.hood.replace;
    expect(validateRates(r).ok).toBe(false);
  });

  it("rejects non-numeric, negative, NaN, and absurd values", () => {
    for (const bad of ["80", -1, NaN, Infinity, 1e9, null]) {
      const r = clone();
      r.dollars.paint = bad;
      expect(validateRates(r).ok, `dollars.paint=${String(bad)}`).toBe(false);
    }
  });

  it("allows extra keys and the flags array; rejects a non-object flags", () => {
    const r = clone();
    r.someFutureKey = { x: 1 };
    expect(validateRates(r).ok).toBe(true);
    r.flags = "nope";
    expect(validateRates(r).ok).toBe(false);
  });
});
