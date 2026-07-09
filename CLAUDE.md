# CLAUDE.md

Guidance for Claude Code (or any coding agent) working in this repository.

## What this repo is

This repo is a Claude Design handoff bundle (`README.md`, `chats/`, `project/*.dc.html`, `project/uploads/`) that was implemented as a real application in **`project/replit-app/`**. That directory is the actual, deployable app — everything else in the repo (`project/Final QC.dc.html`, `project/support.js`, `project/uploads/`, `chats/`) is the original design source material, kept for reference, and is not part of what gets built or deployed.

**Always `cd project/replit-app` before running any npm command.** There is no root-level `package.json`.

## Architecture

- **React 18 + Vite 5, client-only SPA. No backend, no database, no authentication — by design**, not by omission. The original build brief explicitly asked for "no backend... works offline after first load" and "no passwords/auth needed." This was re-confirmed explicitly with the project owner mid-implementation (client-only vs. adding a backend was asked as a direct question; the answer was "client-only, as designed").
- **Persistence is `window.localStorage`**, read once into React state at boot (`src/lib/storage.js#initBoot`) and written back on every relevant state change. See `src/App.jsx`'s persistence `useEffect`s.
- **No router.** Single `/` route; in-app navigation (`tab`, `stage`) is plain React state, not URLs.
- **PWA**: `vite-plugin-pwa` precaches the app shell + Google Fonts so the app works fully offline after the first load.
- Do not add a backend, database, or auth provider without first re-confirming with the project owner and explaining why — this has been asked and answered before, and doing so silently would contradict an explicit design decision.

## Directory layout (inside `project/replit-app/`)

```
src/
  lib/            pure logic, no React or DOM assumptions except where noted:
    constants.js    categories/checklist items/colors — the source of truth for inspection content
    format.js       date/label formatting, CSV escaping, file download helper
    vin.js          ISO 3779 VIN check-digit validation + Code 39 barcode decode
    photo.js        canvas-based photo compression (also re-encodes/sanitizes uploads)
    storage.js      localStorage load/save, boot/migration, draft persistence
    records.js      per-record derived data: status labels, fail lists, search/filter
    stats.js        period definitions (WTD/MTD/past months) + aggregate stats
    exports.js      CSV export, JSON backup export/import
    *.test.js       Vitest unit tests, colocated with the module they cover
  components/     one file per screen or shared UI piece — see README.md's feature list
  App.jsx         top-level state (draft/marks/notes/photos/etc.), screen routing, all handlers
  App.css         design tokens (Truck Ranch palette) + shared classes; screens mix these with inline styles for per-item dynamic values
```

## Commands

Run from `project/replit-app/`:

```bash
npm install       # or: npm ci
npm run dev       # Vite dev server, 0.0.0.0, port from $PORT (default 5173)
npm run lint      # ESLint (eslint.config.js) — must be zero errors/warnings before committing
npm run test      # Vitest, jsdom environment — unit tests for src/lib/*
npm run build     # production build → dist/
npm run preview   # serve dist/ locally for a final smoke test
```

There is no `typecheck` script — this is plain JS/JSX, not TypeScript, by original choice; don't introduce TypeScript without discussing it first, it'd touch every file.

## Conventions

- **Match the design exactly.** `project/Final QC.dc.html`'s `renderVals()` method (bottom of the file, inside `class Component extends DCLogic`) is the literal source of truth for every computed label, validation gate, and color rule. If you're changing behavior in `src/components/` or `src/lib/`, check that file first — it is denser but authoritative. `project/uploads/Final QC Build Package.1.md` (top ~56 lines) is the original text brief; lines 58+ are a *different, larger* reference app (FRPS Mobile, with Pipeline/Escapes/Vendor features) that was explicitly out of scope — don't resurrect those.
- **Category list is fixed and ordered**: Mechanical, Cosmetic (P&B), Detail, Bed Liner, Ceramic Coating, Undercoating (`src/lib/constants.js#CATS`). Bed Liner/Ceramic/Undercoating are the only ones with a per-inspection opt-out toggle.
- **Photos are always re-encoded through `<canvas>`** before being stored (`src/lib/photo.js`) — this caps size and incidentally sanitizes uploaded images (strips EXIF/embedded scripts). Keep this when touching photo capture; don't store raw File/Blob data.
- **Every localStorage write's success/failure matters.** `saveLS()` returns a boolean; `App.jsx` checks it and shows a "Storage full" toast on failure (`warnIfStorageFailed`). Don't add a new `saveLS()` call without wiring its result the same way.
- **`marks`/`notes`/`photosMap` are flat objects keyed by string**, not nested per-screen state: `"<categoryKey>|<itemIndex>"` for the checklist, `"rc|<index>"` for an active re-check, `"vin"` for the VIN photo. `stripRc()` clears re-check-scoped keys when entering/leaving a re-check so they don't leak into the resumable new-inspection draft.
- **No component library / CSS framework.** Design tokens live in `App.css` as CSS custom properties (`--red`, `--brown`, etc.) and a handful of reusable classes (`.card`, `.btn`, `.pill-btn`, `.seg-btn`, ...); per-item dynamic values (colors depending on state, computed widths) are inline `style` objects. Follow this pattern rather than introducing a new styling approach.
- **No `dangerouslySetInnerHTML`, ever.** All dynamic text goes through normal JSX interpolation. The one place raw string interpolation touches CSS is `url('${src}')` for photo/signature backgrounds, and `src` there must always be an internally-generated `data:` URI (canvas output), never raw user text — this is what keeps that pattern XSS-safe.
- **Interactive elements are mostly `<div onClick>`, matching the original prototype's HTML.** This is a known, documented accessibility gap (see `PRODUCTION_AUDIT.md`), not a pattern to keep extending — new primary actions should be real `<button>` elements where practical.

## Deployment requirements

See `REPLIT_DEPLOYMENT.md` for the full checklist. Summary: **Static** deployment target (already configured in `project/replit-app/.replit`), because there is no backend to run. No environment variables are required (`.env.example` documents the one optional dev-only `PORT` override). Build command `npm run build`; publish directory `dist/`.

## Testing expectations

- `src/lib/*.js` is unit-tested with Vitest (`npm run test`) — VIN checksum, stats/period math, CSV formatting, record filtering, and the localStorage migration/boot logic. Add a test alongside any new pure-logic function here.
- There is no component/E2E test suite committed to the repo. Manual verification during development has used headless Chromium via Playwright (not a project dependency) to drive the full create → fail → sign → commit → re-check → export flow — see `PRODUCTION_AUDIT.md` for what was verified and how, if you need to reproduce that style of check.
