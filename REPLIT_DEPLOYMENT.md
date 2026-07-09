# Replit Deployment Guide — Truck Ranch Final QC

Scope: `project/replit-app/`. This is the only deployable artifact in this repo.

## Application architecture

Client-only React 18 + Vite 5 single-page app. No backend server, no API routes, no database, no authentication provider. All persistence is the browser's `localStorage` on whichever device opens the app. Offline support is provided by a `vite-plugin-pwa`-generated service worker that precaches the built app shell and fonts on first load. There is nothing dynamic on the server side to run, scale, or monitor — `npm run build` produces a static `dist/` folder and that folder *is* the entire production artifact.

## Required runtime

Node.js 20 (already pinned in `project/replit-app/replit.nix` via `pkgs.nodejs_20`). Not required at all for serving the built app (Static deployments serve pre-built files) — only required to run the build step itself.

## Package manager

npm (a committed `package-lock.json` is present and kept in sync — verified with `npm ci`).

## Install command

```bash
cd project/replit-app
npm install
```

(`npm ci` also works and is what CI/clean-room verification used for this audit.)

## Build command

```bash
npm run build
```

Produces `project/replit-app/dist/` — this directory is what gets published.

## Production run command

**There is no production server process.** The recommended deployment (Static, see below) serves `dist/` directly; nothing needs to be started or kept alive.

If you ever need to run the production build as a long-lived process instead (e.g., to smoke-test it, or if a future requirement forces Autoscale/Reserved VM instead of Static):

```bash
npm run preview
```

This binds `0.0.0.0` and listens on `$PORT` (falls back to `5173` if unset) — confirmed by testing both the default port and a `PORT=5555` override.

## Required environment variables

**None.** (`PORT` is recognized but optional and dev/preview-only — see `.env.example` in `project/replit-app/`.)

## Database migration command

**N/A — there is no database.** The closest equivalent is `src/lib/storage.js#migrateRecord`, an in-memory shim that upgrades older-shaped localStorage records to the current shape; it runs automatically on every app boot and on every backup import. There is nothing to run manually.

## Recommended Replit publishing type

**Static.** Already configured in `project/replit-app/.replit`:

```toml
[deployment]
deploymentTarget = "static"
publicDir = "dist"
build = ["npm", "run", "build"]
```

Do not use Autoscale or Reserved VM — there is no server process for either of those targets to run or keep warm, so they'd add operational overhead (a port to bind, a process to restart on crash, compute cost while idle) for zero benefit over Static.

## Port and host configuration

- **Production (Static deployment)**: not applicable — Replit serves the static files directly; there is no process that binds a host/port.
- **Development / `npm run preview`**: binds `0.0.0.0` (required so Replit's proxy can reach it) on `$PORT` if set, else `5173`. `project/replit-app/.replit` sets `[env] PORT = "5173"` and maps `[[ports]] localPort = 5173 → externalPort = 80` for the Replit "Run" workflow.

## Health-check path

**N/A — no backend process to health-check.** Replit Static deployments don't use a custom health-check endpoint; they serve files directly. If this app is ever migrated to a server-based deployment target, a health check would need to be added at that time (there is currently no server code to attach one to).

## Post-deployment verification checklist

After deploying (or before, against a local `npm run preview`):

- [ ] App loads and shows the "Final QC" home screen with the bottom nav (Inspect/Records/Reports/Settings).
- [ ] Settings → Inspectors shows the three seeded inspectors (R. Delgado, Theran, Ryan) with no import needed.
- [ ] Tap **+ New Inspection** → fill VIN (17 chars) + stock # + vehicle → add the VIN photo → **Start Checklist** becomes enabled.
- [ ] Mark at least one item **Fail**, add a note + photo, finish the checklist, sign, and **Commit** — confirm it lands in Records with the correct FQ-#### ID and an "OPEN RE-CHECK" badge.
- [ ] From Records, open that inspection, **Start re-check**, clear the item, sign, commit — confirm status flips to "PASS · RE-CHECK".
- [ ] Reports tab shows non-zero totals for the current period; **Excel (CSV)** and **PDF Report** both produce output.
- [ ] Settings → **Export backup** downloads a JSON file and the "last backup" note updates.
- [ ] Reload the page after the first load with the network disabled (e.g., DevTools → Offline) — the app should still render fully (confirms the service worker installed).
- [ ] Open the app in a second tab and commit something in the first — the second tab should show the "changed in another tab" banner.

## Known limitations

- **No multi-device sync.** Data lives on one device/browser; moving it requires a manual Export/Import of the JSON backup.
- **No access control.** Anyone with the URL or device can view and modify all data, including a destructive full-data Import. Do not publish this deployment's URL somewhere public without a plan for that (see `PRODUCTION_AUDIT.md` §6).
- **Finite local storage.** Measured photo compression produces roughly 45–90 KB per photo; typical mobile browser `localStorage` quotas (5–10 MB) give headroom for roughly 60–100+ photos before the device risks running out, with no automatic pruning. The app now warns on a failed write instead of silently losing it, but there's still no proactive "you're getting close" meter.
- **No automated multi-tab data merge.** Concurrent tabs/windows of the same browser are detected and warned about (not silently corrupted), but not merged — reload the stale tab rather than continuing in it.
- **Minimal accessibility support.** Most interactive elements are non-semantic `<div onClick>` (inherited from the original design prototype), with limited keyboard/screen-reader support beyond the bottom navigation.
