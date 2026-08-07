# PAINT & BODY QUOTER

A mobile-first damage-quoting web app for Truck Ranch, exported from Claude Design and unpacked to run and be edited in Replit.

## Architecture

- **Client-side single-page app.** All UI and logic live in `index.html`:
  - `<x-dc>` holds the app template.
  - The `script[data-dc-script]` block holds the app class (`class Component extends DCLogic`) — this is the main editable app logic (~880 lines).
- **`assets/dc-runtime.js`** — the "Design Claude" runtime that boots the app, loads React 18 + ReactDOM from unpkg CDN, and renders the component into `#dc-root`.
- **`assets/html5-qrcode.js`** — the html5-qrcode library, used for the live VIN barcode scanner.
- **`assets/fonts/*.woff2`** — self-hosted Barlow / Barlow Condensed fonts.
- **`assets/icon.png`** — app / apple-touch icon.
- **`server.js`** — Node static file server (serves `index.html`, `/assets/*`, `manifest.json`) plus the API. Dependencies: `@anthropic-ai/sdk`, `pg`. Listens on `PORT` (5000 in Replit).
- **`manifest.json`** — PWA manifest.

No build step, no npm install. Editing `index.html` (the app class) is the primary way to change the app.

## Data & state

- **Shared PostgreSQL database** (Replit built-in, `DATABASE_URL`): tables `settings` (rates, pin, `_secret`), `quotes` (full quote JSON per id), `corrections` (AI correction log, capped 500), `photos` (full-size walk-around/damage JPEGs per quote, bytea, 80/truck cap, deleted with the quote). Schema auto-created by `server.js` on boot.
- **API on server.js** (all JSON): `POST /api/auth` (PIN → device token, 10/min/IP limit), and token-gated (`x-shop-token` header, HMAC of a DB-stored secret) `GET /api/sync`, `PUT /api/rates`, `PUT /api/pin`, `PUT/DELETE /api/quotes`, `POST/GET/DELETE /api/photos`, `GET /api/photo?id=` (serves image bytes; this one endpoint also accepts the token as `?t=` so `<img>` tags can load), `POST /api/corrections`, `POST /api/migrate` (one-time upload of a phone's legacy localStorage data).
- **localStorage is an offline cache + write queue**, per device:
  - `pdq_rates_v1`, `pdq_quotes_v1` (capped 50), `pdq_corrections_v1` — caches of shared data
  - `pdq_draft_v1` — in-progress draft (per device by design)
  - `pdq_estimator_v1` — estimator name (per device)
  - `pdq_pin_v1` — cached admin PIN (default `5701`; source of truth is the DB)
  - `pdq_token_v1` — device token; `pdq_pending_v1` — queued writes replayed on reconnect; `pdq_migrated_v1` — migration flag
- Devices auto-pair using the cached/default PIN; if the shop PIN changes, a device re-pairs by entering the new PIN on the Admin screen. Quote writes are last-write-wins per quote id.
- **Demo data** is generated on the fly ("Demo: load a sample quote") — inline SVG thumbnails and hardcoded sample classifications. No mock data is used for normal operation.
- **VIN decode** calls the public NHTSA vPIC API directly from the browser (no key, no backend).
- **AI damage classification** works for real: the client first tries `window.claude.complete()` (Claude Design host only), and otherwise POSTs to `/api/classify` on `server.js`, which proxies to Anthropic via Replit AI Integrations (`AI_INTEGRATIONS_ANTHROPIC_BASE_URL` / `AI_INTEGRATIONS_ANTHROPIC_API_KEY`, auto-set, keyless, billed to Replit credits). The endpoint has a per-IP rate limit (30/min), 12MB body cap, and a model whitelist (haiku-4-5 default).

## Intake walk-around (in-app)

- **Free-form walk-around** (`walk` screen, between Confirm and Photos): no fixed slots — the estimator takes as many photos as needed. TAKE PHOTOS opens an **in-app live camera** (getUserMedia full-screen overlay) that stays open between shots — each shutter press auto-adds to the gallery. It shows zoom preset buttons (0.5x–5x, filtered by `track.getCapabilities().zoom`; hidden if unsupported) and falls back to a hidden `capture="environment"` file input when permission is denied. Known web-platform limits (user accepted): per-session permission prompt and OS camera-in-use indicator. The "ADD WALK-AROUND PHOTOS" button on the quote screen also shows on saved read-only quotes so photos can be added after take-in. Each fallback-input shot is EXIF-orientation-corrected (`createImageBitmap` with `imageOrientation:'from-image'`, FileReader fallback) and resized to 1600px JPEG and uploaded live to `/api/photos` (retry jobs with the quote id pinned per job). Keys: `wa<ts>_<seq>` for walk shots, `dmg<ts>_dmg` for the separate "DAMAGE FOR THE QUOTE" close-ups that feed the AI quote pipeline. A clean truck (no damage) can finish straight to a saved zero-line quote. Quote id is generated at Confirm so photos have a home. Walk meta is stored in the quote JSON as `walk:{slot:{id,dmg}}`.
- **Walk-around gallery** on the quote screen loads via `GET /api/photos?quote=` and shows full images from `/api/photo` (src carries a `&v=ts` cache-buster; server caches photos for a day; tap opens a lightbox). Each photo has RETAKE (re-uploads under the same photo id via the POST upsert) and a two-tap ✕ delete (queued `DELETE /api/photos {id}`; matching `walkShots` slot meta removed and autosaved). "ADD WALK-AROUND PHOTOS · N SO FAR" button on the quote screen reopens the walk screen.
- **Walk-photo upload durability**: pending full-size uploads persist in IndexedDB (`pdq` db, `walkjobs` store) and resume on next app open; deleting a photo or quote purges its pending jobs and blocklists the ids for the session so retries can't resurrect them.
- The former in-app **intake checklist** was removed (July 2026) at the user's request; old quotes may still carry an `intake:{checks,note}` blob in their JSON, which is simply ignored.
- **Blend overlap credit** was removed from quote totals (overlap is always 0).

## Features that would require more backend work

- **Per-quote conflict resolution** — concurrent edits of the same quote from two devices are last-write-wins.

## Intake SOP context (TR-INTAKE-V2)

The app is Step 3 of Truck Ranch's vehicle intake: UVEye scan → vAuto appraisal/photos → **Body Quoter** (scan VIN, verify truck info, add stock # + estimator, upload damage photos, confirm quote, export quote and attach to the MDD card) → enter everything in MDD (recon tasks, flags, and a Communications write-up detailing each damage, the panels affected, and what gets repaired/replaced). The IMAGE export and COPY summary are tailored to feed the MDD attachment and Communications write-up.

## User preferences

- Keep the exported design intact — do not redesign or simplify.
- When the user says "push to GitHub", commit any new changes and push main to `theranh/paint-body-quoter` (GitHub integration is connected).
