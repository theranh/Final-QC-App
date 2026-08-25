# Truck Ranch — Intake & QC

Employee-facing web application for vehicle **intake**, **body quoting**, and **Final QC inspection**, used by Truck Ranch VPC and store staff. Mobile-first PWA client, server-authenticated, backed by PostgreSQL.

> **Status of this document:** rewritten 2026-08-25 to describe the application as it actually exists. Earlier versions of this file described an earlier, client-only architecture (no backend, `localStorage` persistence, Static deployment). That description is obsolete and following it would break the API or lose data. See `design/ARCHITECTURE_AUDIT.md` §12 R1.

## Architecture

```text
browser (React 18 + Vite 8 PWA)
   │  JSON over /api/*
   ▼
Express 5 + TypeScript  (server/, run via tsx in dev, esbuild bundle in prod)
   ├── Replit Auth (OIDC) + Postgres-backed sessions
   ├── access control: verified @truckranch.com + active employees row
   ├── ~47 /api routes
   └── append-only audit log on every mutation
   ▼
PostgreSQL (Drizzle ORM) · Anthropic (damage classification) · Google Sheets (production tracker)
```

Not a static site. There is a long-running server process, a database, an identity provider, and background workers.

- **Client:** `src/` — React 18, Vite 8, `vite-plugin-pwa` (installable, offline app shell). `src/App.jsx` holds top-level state and screen routing; `src/components/` is one component per screen/UI piece; `src/lib/` is pure logic with co-located tests.
- **Server:** `server/` — Express 5. `server/index.ts` binds the port immediately, then holds incoming requests behind a readiness gate while migrations and auth initialize, so a deploy health check never hits a half-migrated schema.
- **Shared:** `shared/schema.ts` (Drizzle schema, re-exports `shared/models/auth.ts`), `shared/photoRoles.ts`.

## Commands

Run from the repository root:

```bash
npm install          # or npm ci — lockfile is committed
npm run dev          # NODE_ENV=development tsx server/index.ts (Vite middleware)
npm run test         # Vitest
npm run lint         # ESLint
npx tsc --noEmit     # TypeScript check
npm run build        # Vite client build + esbuild server bundle → dist/ and dist-server/
npm run start        # production server, port 5000
npm run db:push      # push Drizzle schema changes
```

Replit development workflow: **Start application** → `PORT=5000 npm run dev`.

## Environment variables

All required unless noted. Provisioned by Replit in that environment.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. The server refuses to start without it. |
| `SESSION_SECRET` | Session cookie signing. |
| `REPL_ID` | Replit Auth OIDC client id. |
| `REPLIT_DOMAINS` | Allowed callback domains for Replit Auth. |
| `QUOTER_SYNC_TOKEN` | Required **in production** — gates the quoter admin sync route. |
| `QUOTER_DATABASE_URL` | Optional. Legacy Quoter database, **read-only** migration/sync source. Never written to. |
| Anthropic credentials | Optional. Damage classification; absent → the classify endpoint returns 503 and the UI falls back to manual classification. |
| Google service credentials | Optional. Production-tracker sheet reads and the sheet-export queue. |
| `PORT` | Optional in dev. Defaults to 5000. |

Missing required variables are logged as explicit `STARTUP ERROR:` lines rather than failing silently.

## Access control

Server-enforced, never client-trusted (`server/access.ts`):

1. Sign in through Replit Auth. Sessions live in the `sessions` table.
2. The email claim must be **verified** and end in `@truckranch.com`.
3. The employee must also have an `active` row in the `employees` allowlist.

First sign-in from a valid company email creates a `pending` row — the user sees "Access pending approval" until an admin approves them in Settings. Guards: `requireEmployee` (401 signed out, 403 blocked/pending/inactive) and `requireAdmin`. Inspector identity is always the signed-in user; records carry creator and last-modifier attribution.

Sign-off on commits uses a separate hashed 4-digit PIN (`employees.pin_hash`, scrypt, reset-not-lookup). Supervisor override is a countersign recorded in `overridden_by`, audited as a distinct action.

## Data

Schema: `shared/schema.ts`. Highlights:

- `employees` — allowlist, `is_admin`, `can_override`, `pin_hash`, status `pending|active|inactive`.
- `inspections` — unique `qc_number` (`FQ-####`) handed out transactionally from the single-row `qc_counter`; full payload in jsonb `data`; `archived` rows stay viewable but leave every aggregation.
- `audit_log` — append-only. No route updates or deletes rows here.
- Quoter tables (`quotes`, `corrections`, `ai_analyses`, `photos`, `intakes`, `settings`) copied from the legacy Quoter with no renames.
- `quote_snapshots` — immutable snapshot of a quote exactly as approved at PIN commit, with the rate tables in force and a server-recomputed engine breakdown; `content_hash` makes retries idempotent.
- `pricing_corrections` — per-line engine-vs-approved deltas. Ground truth for future rate tuning.
- `production_tracker` (+ `_archive`) — closed months frozen exactly as typed in the sheet, never recomputed; every re-snapshot archives what it replaces.
- `vehicle_activity_events` (append-only) and `vehicle_handoff_flags` — the per-vehicle timeline and handoff flags.
- `deleted_quotes` — tombstones, so a queued offline photo upload can't resurrect a deliberately deleted quote.

The **in-progress inspection draft** stays in `localStorage` on purpose, so a refresh or crash mid-inspection loses nothing. Everything committed lives in the database.

## Deployment

Replit **Reserved VM** (configured in `.replit`), live at `https://tr-intake-and-qc-live.replit.app`:

- build: `npm run build`
- run: `npm run start` (port 5000)
- health check: `GET /api/health`

Do **not** use a Static deployment target. There is a server process, and static hosting would serve the client with no API behind it.

### Post-deploy checks

- [ ] `GET /api/health` returns OK.
- [ ] Signed-out request to any `/api` route returns 401; a non-allowlisted company email sees "Access pending approval."
- [ ] Sign in, create an inspection, confirm it receives the next `FQ-####` with no gap or collision.
- [ ] Fail an item (note + photo required), sign, commit; start a re-check, clear it, commit; confirm status transition and that the original fail is preserved.
- [ ] Commit a quote with PIN sign-off; confirm a `quote_snapshots` row and that totals match what was displayed.
- [ ] Walk-around camera: capture, skip, retake — confirm retake replaces rather than duplicates.
- [ ] Reports/exports produce output; the sheet-export queue drains (`GET /api/sheet-exports`, admin).
- [ ] Deploy logs contain no `STARTUP ERROR:` lines.

## Hard rules for anyone changing this code

1. **Preserve server-side auth and the database model.** Do not replace it with client-only storage.
2. **Preserve the Quoter pricing pipeline exactly.** Saved pricing, PIN sign-off, committed snapshots and frozen tracker months are financial records. Identical totals is a requirement, not a goal — prove it with a golden-file test before and after any refactor.
3. **Never recompute a frozen tracker month.**
4. Capture live camera frames as-is. File imports may need EXIF normalization; do not reintroduce universal gravity-based rotation.
5. Keep inspection data, photos and credentials out of commits.
6. `QUOTER_DATABASE_URL` is read-only. Never modify or delete the legacy Quoter database.
7. GitHub `main` is the source of truth. Sync with fetch → `pull --ff-only` → validate → commit → push → **pull again to confirm heads agree**. Never force-push `main`.

## Related documents

- `replit.md` — accurate; Replit-specific operational notes.
- `CLAUDE.md` — accurate; rules for coding agents.
- `design/ARCHITECTURE_AUDIT.md` — Truck Ranch OS integration architecture and migration plan.
- `PRODUCTION_AUDIT.md` — **stale.** Written against the earlier client-only architecture; needs the same correction this file received. Do not treat it as current.
- `LIVE_DASHBOARD.md` — verify before relying on it.
