# Truck Ranch — Final QC

## Overview
Mobile-first, offline-capable Final QC inspection app for Truck Ranch FRPS. Client-only React 18 + Vite 5 single-page app — no backend, no API routes, no database, no authentication. All data lives in the browser's `localStorage`. Offline support via a `vite-plugin-pwa` service worker.

See `README.md` for the full feature list and data model, and `REPLIT_DEPLOYMENT.md` for the deployment checklist.

## Running on Replit
- Workflow: **Start application** — runs `PORT=5000 npm run dev` (Vite dev server on 0.0.0.0:5000, webview).
- `vite.config.js` binds `0.0.0.0`, reads `$PORT` (falls back to 5173), sets `allowedHosts: true` and `hmr.clientPort: 443` for the Replit proxy.
- Tests: `npm run test` (Vitest, 51 unit tests). Lint: `npm run lint`. Build: `npm run build` → static `dist/`.

## Deployment
Static deployment (already configured in `.replit`): build `npm run build`, publish `dist/`. No production server process, no health check.

## Environment variables / secrets
None required. `PORT` is optional and dev/preview-only (set inline in the workflow command).

## User preferences
- Do not redesign the interface or remove functionality; this app's no-backend/localStorage architecture is a deliberate design decision.
