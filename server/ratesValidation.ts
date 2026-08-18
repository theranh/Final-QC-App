// Validation for PUT /api/quoter/rates.
//
// The pricing engine (src/lib/quoterPricing.js, verbatim single source of
// truth) shallow-merges saved rates over defaultRates() on both client and
// server. A PARTIAL saved object therefore silently replaces a whole group
// (e.g. `body`) and can zero out or NaN pricing. This validator requires the
// saved object to be COMPLETE relative to defaultRates() for every numeric
// group, so malformed/partial data can never reach the engine.
//
// It never alters values — pricing math stays bit-for-bit unchanged.
import { defaultRates } from "../src/lib/quoterPricing.js";

const NUMERIC_GROUPS = ["body", "refinish", "ri", "dollars", "caps", "pdr"] as const;
const MAX_RATE = 100_000; // generous sanity ceiling for any hour/dollar figure

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_RATE;
}

export function validateRates(value: unknown): { ok: true } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Rates must be an object" };
  }
  const v = value as Record<string, any>;
  const def = defaultRates() as Record<string, any>;
  for (const group of NUMERIC_GROUPS) {
    const dg = def[group];
    const vg = v[group];
    if (!vg || typeof vg !== "object" || Array.isArray(vg)) {
      return { ok: false, error: `Missing or invalid rates group "${group}"` };
    }
    for (const key of Object.keys(dg)) {
      const dv = dg[key];
      const vv = vg[key];
      if (dv && typeof dv === "object") {
        // body group: per-panel { minor, moderate, heavy, replace }
        if (!vv || typeof vv !== "object" || Array.isArray(vv)) {
          return { ok: false, error: `Missing panel "${key}" in rates group "${group}"` };
        }
        for (const leaf of Object.keys(dv)) {
          if (!isFiniteNum(vv[leaf])) {
            return { ok: false, error: `Invalid ${group}.${key}.${leaf} — must be a number ≥ 0` };
          }
        }
      } else if (!isFiniteNum(vv)) {
        return { ok: false, error: `Invalid ${group}.${key} — must be a number ≥ 0` };
      }
    }
  }
  // flags is an ARRAY of {id,label,color} chips in this app.
  if (v.flags != null && typeof v.flags !== "object") {
    return { ok: false, error: "Invalid flags" };
  }
  if (v.showPricing != null && typeof v.showPricing !== "boolean") {
    return { ok: false, error: "Invalid showPricing" };
  }
  return { ok: true };
}
