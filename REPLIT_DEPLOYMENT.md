# Replit Deployment — Truck Ranch Intake & QC

> **Status:** rewritten 2026-08-25. The previous version of this file described a client-only static app with no backend, no database and `deploymentTarget = "static"`. That is not this application. Deploying Static would publish the client with no API behind it. See `design/ARCHITECTURE_AUDIT.md` §12 R1.

## What is being deployed

A long-running Node process: Express 5 (TypeScript) serving both the `/api/*` surface and the built React client, backed by PostgreSQL and Replit Auth. There is server-side state, an identity provider, scheduled/queued background work, and reviewed schema migrations that run at startup.

## Runtime

Node.js 20+. Required both to build and to run.

## Package manager

npm. `package-lock.json` is committed; `npm ci` for clean installs.

## Commands

| Step | Command |
|---|---|
| Install | `npm install` (or `npm ci`) |
| Build | `npm run build` → Vite client build into `dist/` + esbuild server bundle into `dist-server/index.js` |
| Run (production) | `npm run start` → `node dist-server/index.js`, `NODE_ENV=production`, port 5000 |
| Run (development) | `PORT=5000 npm run dev` → `tsx server/index.ts` with Vite middleware |
| Migrations | Automatic at startup (`server/migrations.ts`). Schema changes during development: `npm run db:push` |
| Validate | `npm run test` · `npm run lint` · `npx tsc --noEmit` |

## Deployment target

**Reserved VM** (currently 0.5 vCPU / 2 GiB RAM), North America, production database connected. Live at `https://tr-intake-and-qc-live.replit.app`.

This is a defensible choice, not a legacy artifact: the server runs the durable Google Sheets export worker on an interval, so a warm always-on process is genuinely useful, and it avoids cold-start latency for shop-floor users. Autoscale would also work; Reserved VM trades idle cost for predictable response.

*Verify the live `.replit` `[deployment]` block matches the Reserved VM configuration and that no stale `deploymentTarget = "static"` / `publicDir = "dist"` block survives from the earlier client-only architecture.*

Do not switch to Static under any circumstances — there is no API behind it.

### Sizing note

0.5 vCPU / 2 GiB is modest for a process that accepts 40 MB JSON bodies containing base64 photo payloads. Several concurrent inspection commits with photos can contend for memory. Watch the Monitoring tab for memory pressure and restarts — that would be a symptom of the photo-storage issue in audit phase 8, not a configuration mistake.

## Host, port, health check

- Binds `0.0.0.0` on `$PORT`, default **5000**.
- Health check: **`GET /api/health`**.
- The port opens *immediately* at startup; requests then wait behind an internal readiness gate while migrations and auth initialize. So a passing health check means "process is up," not "fully ready" — that's deliberate, to avoid a bricked publish.

## Required secrets

`DATABASE_URL`, `SESSION_SECRET`, `REPL_ID`, `REPLIT_DOMAINS`, and — **in production** — `QUOTER_SYNC_TOKEN`. Optional: `QUOTER_DATABASE_URL` (read-only legacy source), Anthropic credentials (classification; absent → 503 + manual fallback), Google service credentials (tracker sheet + export queue).

Any missing required secret is logged as an explicit `STARTUP ERROR:` line. **Read the deploy logs after every publish** — the process intentionally keeps serving rather than crashing, so a missing secret shows up as a log line, not an outage.

## Migrations

Versioned, reviewed migrations in `server/migrations.ts` run before the request gate opens. On total failure (database unreachable after bounded retries) the server logs `STARTUP ERROR: serving with incomplete migrations` and still serves. **That line means stop and investigate immediately** — do not treat a green deploy as success without checking for it.

Never run ad-hoc `db:push` against production. Take a database snapshot before any migration that touches existing rows.

## Post-deployment verification

- [ ] `GET /api/health` returns OK.
- [ ] Deploy logs contain no `STARTUP ERROR:` lines.
- [ ] Signed-out `/api/*` request → 401. Non-company email → 403. New company email → `pending` row and "Access pending approval."
- [ ] Sign in as an active employee; the app loads (`/api/bootstrap` succeeds).
- [ ] Create an inspection → next `FQ-####`, no gap, no collision.
- [ ] Fail an item with note + photo → sign → commit → re-check → clear → commit. Original fail preserved.
- [ ] Commit a quote with PIN sign-off → a `quote_snapshots` row exists and its totals equal what the UI displayed.
- [ ] Walk-around camera: capture / skip / retake — retake replaces, does not duplicate.
- [ ] Photo upload works from a phone on cellular, including after a brief offline period (durable queue drains).
- [ ] Admin: `GET /api/sheet-exports` shows no stuck `failed` jobs.
- [ ] Install the PWA to a home screen and confirm it opens and authenticates.

## Rollback

1. Redeploy the previous known-good commit (deploy from `main` at that SHA).
2. If a migration is implicated, restore from the pre-migration database snapshot — application rollback alone does not revert schema changes.
3. Record the SHA of every deploy. Consider having `/api/health` report the build SHA so a running instance can be traced to a commit.

## Known operational limits

- Photos are stored in Postgres (`photos.data` bytea) and inspection photos as data URLs inside `inspections.data` jsonb, with a 40 MB JSON body limit. Backup size and memory pressure grow with usage — see audit phase 8.
- Auth is tied to Replit (`REPL_ID` / `REPLIT_DOMAINS`); a custom domain requires updating the allowed domains.
- External users (vendors, carriers) have no path into this app today, by design.
