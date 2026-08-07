# Truck Ranch — Final QC

## Overview
Mobile-first Final QC inspection app for Truck Ranch FRPS, now a shared employee app: React 18 + Vite 5 frontend served by an Express (TypeScript, `tsx`) backend with Replit Auth and Replit PostgreSQL (Drizzle ORM). Inspection records, employee allowlist, audit log, and the QC number counter live in the database; the in-progress inspection draft intentionally stays in `localStorage`.

See `README.md` for the full feature list and data model.

## Access control (server-enforced)
- Sign-in via Replit Auth (blueprint files in `server/replit_integrations/auth/`, session table in DB).
- Only verified `@truckranch.com` emails AND an `active` row in the `employees` allowlist may read/write data. First sign-in from a company email creates a `pending` row — user sees "Access pending approval" until an admin approves.
- Admins approve/deactivate/reactivate employees from Settings. Inspector identity is always the signed-in user; records carry creator + last-modifier attribution.
- `server/access.ts`: `resolveAccess` / `requireEmployee` / `requireAdmin` (401 signed-out, 403 blocked/pending/inactive).

## Body Quoter (merged in)
- The old standalone Body Quoter is folded into this app (parallel run — the old app stays up until the user retires it; see project task #6). Tables copied identically: `settings`, `quotes`, `corrections`, `photos` (bytea), `intakes`, plus `committed_by`/`overridden_by`.
- API under `/api/quoter/*` (`server/quoter.ts`, session-authed). Pricing engine ported verbatim in `src/lib/quoterPricing.js` — identical totals is a hard requirement; never simplify its math. Classify prompt/sanitize in `src/lib/quoterClassify.js` (needs Anthropic AI env vars; returns 503 → manual classification otherwise).
- Intake tab = TR-INTAKE-V2 checklist (`src/components/IntakeScreen.jsx`, wording verbatim) → Body Quoter flow (`QuoteScreen.jsx`, `VinScanner.jsx`).
- Guided walk-around camera (`WalkAroundCamera.jsx` + pure helpers in `src/lib/walkSlots.js`): 24 named slots (exterior ×10, interior ×6, wheels ×4, tread ×4) with skip/retake (stable photo id `quoteId_slotKey` so retake replaces), plus live-camera damage close-ups feeding the classify pipeline; autosaves via `/api/quoter/photos`.
- PIN sign-off at commit (`server/pin.ts`, `PinDialog.jsx`): signer picks self + own 4-digit PIN; `committed_by` immutable server-side; supervisor override = countersign (`overridden_by`), distinct audit action. PIN admin in Settings (scrypt-hashed, reset-not-lookup).
- Closed months frozen in `production_tracker` (`server/tracker.ts`, admin snapshot in Settings); current month live from the sheet; frozen values never recomputed.
- Data copy script: `scripts/migrate-quoter-data.ts` (idempotent, resumable photos cursor; source = `QUOTER_DATABASE_URL` secret, read-only).

## Backend notes
- `server/routes.ts`: `/api/health`, `/api/me`, `/api/bootstrap`, inspections (create with transactional unique FQ-#### numbers from `qc_counter` row id=1; recheck with `FOR UPDATE`, 409 if not open, and an integrity check that submitted items exactly match the record's open items; DELETE → 405 and audited), one-time legacy `localStorage` import (`/api/import`, duplicate-skip + counter bump), admin employee CRUD. All mutations write to the append-only `audit_log`.
- Schema: `shared/schema.ts` (re-exports auth models from `shared/models/auth.ts`). Push changes with `npm run db:push`.

## Running on Replit
- Workflow: **Start application** — `PORT=5000 npm run dev` → `tsx server/index.ts` on 0.0.0.0:$PORT (dev uses Vite middleware; prod serves static `dist/`).
- Tests: `npm run test` (Vitest, 51 unit tests). Lint: `npm run lint`. Typecheck: `npx tsc --noEmit`. Build: `npm run build`.

## Deployment
Autoscale (configured in `.replit`): build `npm run build`, run `npm run start`. Health check at `/api/health`.

## Environment variables / secrets
`DATABASE_URL`, `SESSION_SECRET`, `REPL_ID`, `REPLIT_DOMAINS` (all provided by Replit). `PORT` optional in dev.

## User preferences
- Do not redesign the interface or remove functionality; this app's no-backend/localStorage architecture is a deliberate design decision. (The move to a shared backend was explicitly requested later; keep the UI unchanged.)
