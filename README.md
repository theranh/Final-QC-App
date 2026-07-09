# Truck Ranch — Final QC

A mobile-first, offline-capable Final QC inspection app for Truck Ranch FRPS. Built with React + Vite. No backend — everything (inspections, photos, inspectors, ID counter) is stored locally in the browser via `localStorage`, matching the original design brief: something a VRA can run on his phone today with zero server setup.

For a full production-readiness assessment, see [`PRODUCTION_AUDIT.md`](../../PRODUCTION_AUDIT.md). For exact Replit deployment steps, see [`REPLIT_DEPLOYMENT.md`](../../REPLIT_DEPLOYMENT.md).

## Running on Replit

This repo is already wired for Replit:

1. Import/open this folder as a Repl (Node.js template is auto-detected via `replit.nix` / `.replit`).
2. Click **Run** — it installs dependencies and starts the Vite dev server, proxied through Replit's `https://*.replit.dev` domain.
3. Open the webview. The app should load full-screen, phone-width.

## Running locally

```bash
npm install          # or: npm ci (lockfile is committed and kept in sync)
npm run dev           # dev server — http://localhost:5173 (or $PORT if set)
npm run lint          # ESLint
npm run test          # Vitest — unit tests for src/lib/*
npm run build         # production build to dist/
npm run preview       # serve the production build locally, for a final smoke test
```

## Environment variables

**None are required.** This app has no backend, no API keys, and no secrets — see `.env.example` for the one *optional* variable (`PORT`, which only affects the local dev/preview server, not the deployed static site). Copy it to `.env` only if you want to override the default dev port locally; nothing needs to be set for Replit or for `npm run build`.

## Deployment

`npm run build` produces a fully static `dist/` folder (HTML/CSS/JS + a service worker). Deploy it to any static host:

- **Replit Deployments**: the `.replit` file already sets `deploymentTarget = "static"` with `publicDir = "dist"` and the build command — use Replit's Deploy button. See `REPLIT_DEPLOYMENT.md` for the full checklist.
- **Anywhere else** (Netlify, Vercel, GitHub Pages, S3, etc.): upload the contents of `dist/` as-is. No server-side code, no environment variables, no database.

## Offline support

The app registers a service worker (via `vite-plugin-pwa`) that precaches the app shell and fonts on first load, so it keeps working with no signal after that — matching the "works offline after first load" requirement from the original design brief. It's also installable as a home-screen PWA on iOS/Android (Add to Home Screen).

## Data model — no backend, by design

This mirrors the original design brief exactly: no login, no server, no database. All state lives in the browser's `localStorage` on whichever device/browser opened the app:

- `fqc_users` — inspectors (name, title, email)
- `fqc_inspections` — every committed inspection + its re-check history, with photos stored as compressed JPEG data URLs
- `fqc_seq` — the next sequential inspection ID (`FQ-1001`, `FQ-1002`, …)
- `fqc_default` — the default inspector shown pre-selected on a new inspection
- `fqc_draft` — an in-progress (uncommitted) inspection, auto-saved every 250ms so a refresh or crash mid-inspection doesn't lose data
- `fqc_lastBackupAt` — timestamp of the last successful "Export backup," used only to nudge you in Settings if it's been a while

**Because storage is per-device, there is no automatic multi-device sync.** Settings → Data & Backup has an Export/Import JSON button for moving data between phones or backing it up:

- **Export backup** downloads a single JSON file with everything.
- **Import backup** replaces *all* data on the current device with a chosen backup file — only do this on a device you're OK overwriting.
- Settings shows a reminder if this device has never been backed up, or hasn't been in 7+ days.

For a single inspector on a single phone (the original use case), this is sufficient. If Truck Ranch later needs multiple inspectors entering data concurrently from separate devices with real-time sync, that's the point at which this app would need a real backend (API + database) instead of `localStorage` — a deliberate, documented tradeoff, not an oversight.

### Known safety nets (and their limits)

- **Storage-full warnings**: if a `localStorage` write ever fails (device quota exceeded, private-browsing restrictions), the app shows a persistent toast telling you to back up and free up space, instead of silently losing the write.
- **Multi-tab guard**: if this app is open in two tabs/windows of the same browser and one of them commits an inspection, the *other* tab shows a banner telling you to reload before doing anything else. There is no cross-tab merge — the fix is to only ever use one tab, and reload when warned.
- **No access control**: there is no login, by design (see the original brief). Anyone with the device or the URL can view all records and use Import Backup to replace all data. Treat the deployed URL/device accordingly — don't publish it somewhere public without a plan for that.

## Project structure

```
src/
  lib/          pure logic: constants, formatting, VIN validation + barcode decode,
                localStorage persistence, stats/period math, CSV/backup export
                (each has a co-located *.test.js — run with `npm run test`)
  components/   one component per screen/UI piece (NewInspectionForm, ChecklistSheet,
                ResultScreen, RecheckSheet, RecordsList, RecordDetail, ReportsScreen,
                PrintReport, SettingsScreen, SignaturePad, VinScanner, ...)
  App.jsx       top-level state + screen routing
  App.css       design tokens (Truck Ranch palette) + shared UI classes
```

## Feature checklist (matches the Final QC design spec)

- New inspection: VIN scan (camera + Code 39/128 barcode detection, with a manual-entry fallback) or manual 17-character VIN entry with ISO 3779 check-digit validation, required door-jamb VIN photo, stock #, vehicle, inspector picker, optional Bed Liner / Ceramic Coating / Undercoating toggles.
- Checklist grouped by category (Mechanical, Cosmetic, Detail, Bed Liner, Ceramic, Undercoating) with Pass/Fail/N/A per item; a Fail requires a note and a photo.
- Result screen with pass/fail banner, per-category breakdown, and a draw-to-sign signature pad that locks the inspection on commit.
- Re-check flow: only previously-failed items are re-tested, each clearable independently, its own signature, and the original fail record is preserved for reporting.
- Records: search by stock #/vehicle/VIN/inspector, filter by result and date range, full locked detail view with fail photos and re-check history.
- Reports: week-to-date / month-to-date / any past month with data, fails-by-category, most-failed items, per-inspector breakdown, Excel (CSV) export, and a print-ready PDF report.
- Settings: manage inspectors (name/title/email, no passwords), set a default inspector, export/import a full JSON backup, backup-staleness reminder.
