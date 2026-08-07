---
name: Quoter merge decisions
description: Durable decisions from folding the Body Quoter into the Final QC app
---
- The merged Quoter API lives under `/api/quoter/*`, session-authed (requireEmployee); the old device-token/x-shop-token/x-fleet-key schemes are gone locally. Table names copied identically (settings, quotes, corrections, photos, intakes).
- Pricing parity is sacred: `src/lib/quoterPricing.js` is a verbatim port (dead code kept on purpose). Never "clean up" its math — identical inputs must give identical totals to the old app.
- PIN sign-off model: signer picks self + enters own 4-digit PIN at COMMIT (never at start, never a free-name dropdown); committed_by immutable server-side (all mutations of committed quotes/intakes/photos → 409); override = countersign (overridden_by), distinct audit action. PINs scrypt-hashed, reset-not-lookup.
- Rate limiting must key off `req.ip` with `trust proxy` set — raw x-forwarded-for parsing was a review-flagged brute-force hole.
- Closed months are frozen in `production_tracker` (values stored exactly as typed from the sheet, variance NOT recomputed — shown unavailable for frozen months); current month stays live. Re-snapshot = correction path (delete-then-insert per month).
- Section 6 of the migration doc is a PARALLEL RUN, not a cutover — the standalone Quoter is never retired without the user saying so.
- Data copy script: `scripts/migrate-quoter-data.ts` (resumable photo cursor in scripts/.quoter-photo-cursor); needs QUOTER_DATABASE_URL; section 5 cleanup only after copy verified.
