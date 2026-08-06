import type { Express } from "express";
import { requireEmployee } from "./access";

// Read-only intake damage quote for a VIN, proxied from the Intake & Body Quoter.
// The shared FLEET_KEY never reaches the browser: the client calls this route with
// its normal session cookie, and only the server holds the key.

type CacheEntry = { at: number; body: unknown };
const CACHE_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * Shared quoter lookup used by both the /api/intake-quote route and the
 * dashboard feed — one cache, one FLEET_KEY code path. Returns the raw quoter
 * payload, or null when unconfigured/unreachable/non-OK (callers degrade).
 */
export async function lookupQuoteByVin(vin: string): Promise<unknown | null> {
  const clean = vin.trim().toUpperCase();
  if (clean.length < 6) return null;
  const hit = cache.get(clean);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;

  const base = process.env.QUOTER_URL;
  const key = process.env.FLEET_KEY;
  if (!base || !key) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(
      `${base.replace(/\/+$/, "")}/api/quote-by-vin?vin=${encodeURIComponent(clean)}`,
      { headers: { "x-fleet-key": key }, signal: ctl.signal }
    );
    if (!r.ok) return null;
    const body = await r.json();
    cache.set(clean, { at: Date.now(), body });
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function registerIntakeQuoteRoute(app: Express) {
  app.get("/api/intake-quote/:vin", requireEmployee, async (req, res, next) => {
    try {
      const vin = String(req.params.vin || "").trim().toUpperCase();
      if (vin.length < 6) return res.status(400).json({ message: "Invalid VIN" });

      const hit = cache.get(vin);
      if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.body);

      const base = process.env.QUOTER_URL;
      const key = process.env.FLEET_KEY;
      if (!base || !key) {
        return res.status(503).json({ message: "Quoter link not configured" });
      }

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(
          `${base.replace(/\/+$/, "")}/api/quote-by-vin?vin=${encodeURIComponent(vin)}`,
          { headers: { "x-fleet-key": key }, signal: ctl.signal }
        );
        if (!r.ok) {
          console.error("intake quote lookup failed:", r.status);
          return res.status(502).json({ message: "Quoter lookup failed" });
        }
        const body = await r.json();
        cache.set(vin, { at: Date.now(), body });
        // Keep the cache from growing without bound on a long-running server.
        if (cache.size > 500) cache.delete(cache.keys().next().value as string);
        res.json(body);
      } finally {
        clearTimeout(timer);
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return res.status(504).json({ message: "Quoter timed out" });
      }
      next(err);
    }
  });
}
