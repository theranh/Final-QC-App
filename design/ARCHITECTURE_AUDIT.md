# Truck Ranch OS + TR Intake & QC — Read-Only Architecture Audit

**Date:** 2026-08-25 · **Status:** analysis only — nothing modified in either system.
**Sources inspected:** this Claude project (all root `.dc.html` files, `CLAUDE.md`, `DESIGN_SYSTEM.md`, `PROJECT_CONTEXT.md`) and `github.com/theranh/Final-QC-App@main` (tree `e644b5a0c29c`) — READMEs, `package.json`, `server/*`, `shared/schema.ts`, `vite.config.js`, route surface, Replit/Claude guidance files.
**Not inspected:** the running Replit instance, the production database, and its secrets (no access). Two additional repos exist and are addressed in §12: `theranh/intake-body-quoter`, `theranh/paint-body-quoter`. A fourth, `theranh/Truck-Ranch-final-QC`, returns 409 (empty or unreadable).

---

## 1. Executive Recommendation

**Option E, implemented as a single-repo monorepo (Option C) inside `Final-QC-App`. Truck Ranch OS gets built into the Intake & QC codebase — not the other way around.**

The audit turned up one fact that decides the whole question:

> **Truck Ranch OS is not an application. It is a design prototype.** Every OS screen is a static `.dc.html` Design Component with hard-coded demo data, no server, no database, no auth, no API, no build step, no deployment. `TR-OS-V3.dc.html` is ~19,000 lines of inline-styled markup and demo-data logic; its only persistence anywhere is one `localStorage` key (`trDealsOS_v1`) in the Deals tracker.
>
> **TR Intake & QC is a real application** — Express 5 + TypeScript, PostgreSQL via Drizzle, Replit Auth (OIDC), server-enforced allowlist, PIN sign-off, append-only audit log, transactional QC numbering, durable export queues, 51 unit tests, autoscale deployment with a health check.

So there is nothing to "merge." There is a production application, and there is a very detailed specification for the platform that should surround it. The correct move is to **promote the existing Final-QC-App server into the Truck Ranch OS platform shell**, and let the OS prototypes act as the design spec for the screens that get built into it.

Concretely:

- One repo (`Final-QC-App`, eventually renamed `truck-ranch-os`), restructured into `apps/` + `packages/`.
- One Express server, one Postgres database, one session — so the OS shell and the Intake & QC client are **same-origin**. That single decision removes every problem an iframe would have created (auth, cookies, history, uploads, mobile, cross-origin messaging) without any of the cost.
- Intake & QC keeps its current client, its current URL behavior, and its current pricing/PIN/tracker logic **untouched** while the shell is built around it. It becomes a route inside the OS, not a rewrite.
- The `.dc.html` prototypes stay prototypes. They are the spec and the visual reference; they are never compiled into the product.

Rejected: **A** (separate app/domain) — duplicates auth, sessions and vehicle identity, and the OS's whole value is cross-module context. **D** (native merge now) — would require rewriting a working production module before the platform exists. **Iframe** — unnecessary once both live in one origin.

---

## 2. Current Truck Ranch OS Architecture

| Aspect | Finding |
|---|---|
| Structure | 10 standalone `.dc.html` files at project root, each opening directly in a browser. No shared modules except `support.js` (the DC runtime) and `ios-frame.jsx`. |
| Framework | The DC runtime — a template/logic split (`class Component extends DCLogic`, `renderVals()`) over React, with `sc-if` / `sc-for` control flow. No bundler, no npm, no build. |
| Navigation | In-file screen switching: one `sc-if` per screen (`isTodos`, `isDeals`, `isAcq`, `isInv`, `isVfile`, `isDispatch`, `isPartner`, …), each root carrying `data-screen-label`. Sidebar module list + two flyout mega-menus + a back-navigation strip. No URL routing, no browser history. |
| State | Component state and instance fields inside one logic class per file. Demo data is seeded in methods (`dtSeed()` and siblings). No store, no server state, no cache layer. |
| Persistence | None, except `localStorage['trDealsOS_v1']` in the Deals & Titles tracker (`dtPersist`). |
| API / data | No `fetch` anywhere. All numbers are literals. Comments name the intended real sources: Tekion/DMS, Sales, the VPC production tracker. |
| Auth | Simulated. A "Viewing as" persona switcher (L1–L5 levels) drives `LOCKED` pills on modules and locations. This is a permissions *specification*, not an implementation — and it is the most valuable artifact in the OS for integration purposes. |
| Data model | Implied, not declared. The key concept is the **Vehicle File** (permanent per-vehicle record, "VF #", searchable forever by VIN / VF # / any past stock # / customer) plus the Location↔Status correlation rule and Received-based escape windows. |
| Design system | Strong and documented: `DESIGN_SYSTEM.md` + `CLAUDE.md` + `UI Standard.dc.html`. Fixed tokens, four fonts, a fixed status vocabulary, shell layout rules, table/form rules, all styling inline. |
| Mock vs production-ready | 100% mock at the data layer; the **interaction, information architecture, permission model and visual system are production-grade thinking** and should be treated as requirements, not sketches. |
| Modules present | FRPS pipeline, Store FRPS, Buy Center Command, Buy Planner, Buy Guidance, Market Intelligence, Source Performance, Buyer Performance/Profile, Lifecycle Ledger, Production Estimate Accuracy, DMS Action Queue, Inventory Intelligence, Take-Offs, Parts Catalog, Sale Window, Incoming Inventory, Transport (loads/builder/reports), Deals & Titles, Trades & Payoffs, To-Dos, Vehicle File, VPC Settings, Partner Portal. Plus separate mobile and vendor-portal prototypes. |

---

## 3. Current Intake & QC Architecture

| Aspect | Finding |
|---|---|
| Frontend | React 18 + Vite 8, plain `.jsx`, one `App.jsx` (~39k) doing top-level state + screen routing, ~51 files under `src/components`, ~39 under `src/lib`. Class-based CSS in one `App.css` (~17k) holding the same Truck Ranch tokens. PWA via `vite-plugin-pwa` (installable, offline shell, Google-fonts runtime cache). |
| Backend | Express 5 + TypeScript run through `tsx` in dev, esbuild-bundled for prod. `server/index.ts` opens the port immediately, then gates requests behind a `ready` promise while migrations + auth initialize — a deliberately deploy-safe startup. Versioned migrations in `server/migrations.ts`. |
| Routing | Server: ~47 routes, all under `/api/*`. Client: no router — screen state in `App.jsx`. `/dashboard` 301s to `/`. |
| Database | Replit PostgreSQL, Drizzle ORM, `pg.Pool` (max 10, keepalive, idle-error handler). `npm run db:push` for schema. |
| Auth | Replit Auth (OIDC, `passport` + `openid-client`), sessions in Postgres via `connect-pg-simple`. `server/access.ts`: verified `@truckranch.com` email **and** an `active` row in `employees`. First company-email sign-in creates a `pending` row → "Access pending approval." `resolveAccess` / `requireEmployee` / `requireAdmin`; trusts session claims only, never body/query. |
| Permissions | Two booleans: `employees.isAdmin`, `employees.canOverride`. Plus a hashed 4-digit `pinHash` for commit sign-off. **No roles. No location scoping.** |
| Vehicle data | No `vehicles` table. VIN is the de-facto join key: `intakes.vin` (indexed), `quote_snapshots.vin`, `pricing_corrections.vin`, `repair_actuals.vin`, `production_tracker` PK `(vin, month)`, `vehicle_activity_events.vin` (normalized uppercase, indexed). But `inspections.vin` is `varchar not null default ''` — not normalized, not unique, and optional in practice. |
| Intake model | `intakes` — vin, stock, vehicle, miles, estimator, `quote_id`, jsonb `data`, immutable `created_at`, `completed_at`, `committed_by`, `overridden_by`. Checklist wording is verbatim TR-INTAKE-V2. |
| QC model | `inspections` — unique `qc_number` (FQ-####, handed out transactionally from the single-row `qc_counter`), stock, vehicle, vin, result, status (`pass|open|cleared`), full payload in jsonb `data`, `imported`, `archived`, and creator + last-modifier attribution (id/email/name each). Rechecks use `FOR UPDATE`, 409 if not open, and verify submitted items exactly match the record's open items. `DELETE` returns 405 and is audited. |
| Quoter model | `quotes`, `corrections`, `ai_analyses`, `photos`, `settings` copied from the legacy Quoter with no renames; plus `quote_snapshots` (immutable commit snapshot with `content_hash` idempotency, rates in force, server-recomputed engine breakdown) and `pricing_corrections` (per-line engine-vs-approved deltas) and `repair_actuals` (outcomes, awaiting a recon feed). |
| Photos | Two different mechanisms. Quoter/walk-around photos → Postgres `bytea` (`photos.data`), 24 named slots with stable ids `quoteId_slotKey`, offline upload/delete queues, `deleted_quotes` tombstones so a queued upload can't resurrect deleted data. QC inspection photos → compressed JPEG **data URLs inside `inspections.data` jsonb**, with `express.json({limit:'40mb'})` to accommodate them. |
| Workflow logic | QC: pass/fail per item → fail requires note + photo → signature → commit locks → recheck only re-tests failed items, original fails preserved. Quoter: pricing engine ported verbatim (`src/lib/quoterPricing.js`, "identical totals is a hard requirement"), AI classify via Anthropic with a 503 → manual fallback, PIN commit with `committed_by` immutable server-side and supervisor countersign as a distinct audit action. Tracker: closed months frozen in `production_tracker`, never recomputed, prior versions archived on re-snapshot. |
| Audit | Append-only `audit_log` on every mutation, plus append-only `vehicle_activity_events` and soft-clearable `vehicle_handoff_flags` (needs_wash, waiting_parts, manager_review, customer_vehicle, other). |
| External services | Anthropic (damage classification), Google Sheets (`googleSheets.ts`, `sheetExports.ts` durable retry queue, VPC production tracker source), `@replit/connectors-sdk`, legacy Quoter DB read-only via `QUOTER_DATABASE_URL`. |
| Env | `DATABASE_URL`, `SESSION_SECRET`, `REPL_ID`, `REPLIT_DOMAINS`, `QUOTER_SYNC_TOKEN` (required in prod), `QUOTER_DATABASE_URL`, Anthropic + Google credentials. |
| Deployment | Replit Autoscale: `npm run build` → `npm run start` (port 5000), health check `/api/health`. |
| Coupling | Frontend↔backend is loose (JSON over `/api`), but frontend is one monolithic `App.jsx` and the backend has two 35k+ analytics modules (`dashboard.ts`, `managerAnalytics.ts`) computing KPIs independently. |

---

## 4. Integration Compatibility

**Fits naturally**

1. **Same design system already.** `App.css` and the OS DCs use the same tokens (`#CE1B1B`, `#6E6253`, `#262220`, `#E7E1DA`/`#F4F1ED`) and the same four fonts (Oswald / IBM Plex Sans / IBM Plex Mono / Rye). The manifest even names the app "Truck Ranch — Intake & QC" with `theme_color: #CE1B1B`. Visual convergence is mostly already done.
2. **Same domain vocabulary.** VIN, stock #, FRPS, VPC, Retail Plan, closed RO, escapes, rechecks, employees-as-inspectors. No translation layer needed.
3. **The OS's Vehicle File and the app's VIN-keyed tables are the same idea.** `vehicle_activity_events` + `vehicle_handoff_flags` are literally the OS's Vehicle File timeline, already built and already append-only.
4. **Auth model is compatible with the OS's persona spec.** Domain restriction + allowlist + admin approval is the right base; the OS's L1–L5 levels are the layer to add on top.
5. **Sign-off primitives exist.** PIN commit, immutable `committed_by`, supervisor countersign, frozen months — the OS's approval flows can lean on these instead of inventing new ones.

**Conflicts**

1. **No location dimension in the database at all.** The OS is location-scoped end to end (LOCATION selector, five rooftops, L1–L5 roll-ups, locked locations per persona, the Location↔Status correlation rule). `employees` has no location, `inspections` has no location, `intakes` has no location. This is the single largest schema gap.
2. **Two booleans vs. a role matrix.** The OS specifies ~9 roles × 5 locations × per-record/per-transition rules. `isAdmin` + `canOverride` cannot express that.
3. **`inspections.vin` is unreliable** (`default ''`, unnormalized) while every other module keys on normalized uppercase VIN. Canonical vehicle identity cannot be built on it as-is.
4. **Styling approach diverges.** OS = inline styles only, mandated. Intake & QC = a shared CSS class file. Both produce the same look; a shared UI package has to pick one, and the OS rule is the project standard.
5. **Two KPI engines.** `dashboard.ts` (35k) and `managerAnalytics.ts` (36k) both compute metrics server-side; the OS mandates one shared builder per metric. Merging surfaces will otherwise show two versions of the same number.
6. **Documentation contradicts itself** (see §12, risk R1): `README.md` and `REPLIT_DEPLOYMENT.md` still describe the app as client-only, no backend, no database, `localStorage`-only, deploy target **Static** — while `replit.md`, `CLAUDE.md`, `package.json` and `server/` describe the Express + Postgres + Replit Auth app that actually exists. Acting on the stale docs (deploying Static, or "restoring" localStorage storage) would take the app down or lose data.
7. **Photos-in-Postgres won't carry more modules.** `bytea` blobs plus 40 MB JSON bodies plus data-URL photos inside jsonb is already the heaviest thing in the system, and Photos is a planned OS module.
8. **Replit Auth ties identity to Replit.** Fine today; a `truckranch.com` OS with vendor/carrier portals (the Partner Portal is external-facing) will need either `REPLIT_DOMAINS` extended or a different IdP — and vendors are explicitly *not* `@truckranch.com` accounts.
9. **No client router.** Both sides do screen state in one big component. An OS shell needs real URLs (deep links to a vehicle, a load, an inspection) before modules can link to each other.

---

## 5. Recommended Target Architecture

```text
                          truck-ranch-os  (one GitHub repo)
                                    │
  apps/ ────────────────────────────┼───────────────────────────────
    os/            OS shell: sidebar, header, location selector,
                   title bar, drawers, module registry, router
    intake-qc/     existing Intake & QC client, moved as-is
    portal/        vendor / carrier Partner Portal (separate audience)
    server/        the one Express app: /api/*, auth, static hosting
                                    │
  packages/ ───────────────────────┼───────────────────────────────
    ui/            tokens, status pills, tables, drawers, forms
    auth/          session, roles × locations, guards
    vehicle/       canonical vehicle identity + resolvers
    data/          Drizzle schema + migrations (one database)
    api-client/    typed fetch wrappers
    kpi/           ONE builder per metric (OS rule 10)
```

Runtime:

```text
  browser ── https://os.truckranch.com ──► Express (one origin, one session)
                 /                        ├─ /api/*            shared services
                 /intake-qc               ├─ serves apps/os
                 /partner                 ├─ serves apps/intake-qc
                                          └─ serves apps/portal
                                                    │
                                          Postgres (one DB)
                                          Object storage (photos)
                                          Tekion · Sheets · Anthropic
```

Why this shape: one origin means one cookie, one session, one CSRF story, working browser history, native file uploads, no `postMessage` bridge, no cross-origin debugging — the entire iframe risk list, deleted. Each app still builds and deploys independently if you later want that; nothing here forces a lockstep release.

---

## 6. GitHub / Claude / Replit Workflow

**One rule: application code has exactly one home — GitHub `main`. Claude and Replit are both clients of it.**

```text
                        GitHub  theranh/Final-QC-App  (main)
                        SOURCE OF TRUTH — code + schema + design spec
                          ▲                         ▲
        push-then-pull    │                         │   read repo → propose diff
                          │                         │
                       Replit                    Claude
                  run · deploy · migrate     design · specify · draft code
                  (Autoscale, secrets)       (never a third copy)
```

Rules that keep this from forking into three versions:

1. **Replit** keeps the sequence already written in the repo's `CLAUDE.md`: fetch → `pull --ff-only` → work → validate (`npm run test`, `npm run lint`, `npx tsc --noEmit`) → commit → push → **pull again and confirm heads agree**. Never force-push `main`.
2. **Claude** works from the repo, not from memory: read the current files, produce a change as a reviewable diff/branch, land it on `main` through the connector. Claude never keeps an editable copy of application code in a Claude project.
3. **This Claude project holds design artifacts only** — the `.dc.html` prototypes, `DESIGN_SYSTEM.md`, `CLAUDE.md`, `PROJECT_CONTEXT.md`, and this audit. To make the spec version with the code, copy them into the repo under `design/` and treat the repo copy as canonical once implementation begins.
4. **Schema changes go through reviewed migrations** in `server/migrations.ts` (already the pattern), never ad-hoc `db:push` against production.
5. **Every deploy is tied to a commit.** Replit deploys from `main`; record the deployed SHA in the release note. `/api/health` should also report the build SHA so a running instance can be traced back to a commit.
6. **Retire the extra repos** so "source of truth" is unambiguous (§12 R6).

---

## 7. Authentication Strategy

Keep what exists, add the two layers it's missing, in this order:

1. **Now:** Replit Auth stays. It works, it's server-enforced, and the `@truckranch.com` + allowlist gate is genuinely good. Do not touch it while the shell is being built.
2. **Add roles and locations to `employees`** — a `role` (or a join table for multi-role) plus a location scope (`location_ids` array, or an `employee_locations` join, plus an `all_locations` flag for enterprise L4+). Then express the OS's L1–L5 personas as `(role, locations)` pairs and move `isAdmin`/`canOverride` behind that model rather than replacing them.
3. **One guard chain in `packages/auth`** extending today's `resolveAccess` → `requireEmployee` → `requireAdmin` with `requirePermission(action, resourceLocation)`. Module visibility in the OS sidebar reads from the same permission source, so the `LOCKED` pills the prototypes show become real.
4. **External users are a separate identity space.** Vendors, carriers and customers must never enter the employee allowlist. Give the Partner Portal its own credential type (invite + magic link or its own OIDC client) scoped to the specific loads/jobs they're on. This is a decision to make before the Partner Portal is built, not after.
5. **IdP question (business decision, §13):** Replit Auth long-term vs. Google Workspace SSO. `@truckranch.com` suggests Google Workspace exists; SSO there would give you offboarding through the same console you already use. Either way the swap is contained to `server/replit_integrations/auth/` if `packages/auth` is the only consumer.
6. Single sign-on across modules is free once they share an origin and a session — no extra work required beyond §5.

---

## 8. Vehicle Data Strategy

Additive, three steps, no breaking change to Intake & QC:

**Step 1 — normalize VIN, don't move anything.** Enforce uppercase/trim on write everywhere (already done for `vehicle_activity_events`), backfill `inspections.vin`, index it, and decide what to do with the rows where it is `''` (report them; do not guess). Nothing else can be trusted until this is true.

**Step 2 — introduce `vehicles` as an index, not a rewrite.**

```text
vehicles
  id              TR vehicle id  (surrogate — the "VF #")
  vin             unique, normalized     ← natural key, already the join key
  stock_current   varchar                ← stock # changes; VIN doesn't
  year make model trim body
  mileage
  location_id                            ← the OS's missing dimension
  lifecycle_status                       ← OS canonical states
  created_at / updated_at
vehicle_stock_history   (vin, stock, from, to)   ← "searchable by any past stock #"
```

Existing module tables keep their `vin` columns exactly as they are. `vehicles` is populated from them (and later from Tekion), and modules gradually gain an optional `vehicle_id` alongside `vin`. No table is renamed, no column is dropped, no query breaks.

**Step 3 — one resolver.** `packages/vehicle` exposes `resolveVehicle({vin|stock|vehicleId})` and every module goes through it. That is what makes the Vehicle File real: intake, quote snapshot, QC record, flags, timeline, transport, deal — all fetched by one identity.

### Tekion's place in this (resolved — Tekion is the DMS, with APIs into the OS)

**The OS mints and owns the TR Vehicle ID. Tekion is a linked system of record for the fields it owns, not the source of vehicle identity.**

The reason is operational, not architectural: **vehicles enter Truck Ranch's world before they exist in Tekion.** A truck is bought at auction (Buy Center), a transport load is built, it arrives at the VPC, gets intake, a body quote and recon work — potentially all before it's inventoried in the DMS. If identity waited on a Tekion record, the entire front half of the pipeline would have nothing to attach to. So: OS-minted ID, **late binding** to Tekion.

```text
vehicles
  id                  TR Vehicle ID (VF #)   ← minted by the OS, immutable, forever
  vin                 unique, normalized     ← the MATCHING key, not the identity
  tekion_vehicle_id   nullable               ← set when the DMS record appears
  tekion_stock        nullable               ← mirrored, Tekion-owned
  tekion_synced_at    nullable               ← staleness is always visible
  location_id, lifecycle_status, ...         ← OS-owned
```

**Field ownership — exactly one owner per field, mirrored read-only everywhere else** (this is `CLAUDE.md` rule 10 applied across a system boundary):

| Tekion owns (OS mirrors, never writes) | OS owns (Tekion never sets) |
|---|---|
| Stock number, inventory status, sold/deal status | TR Vehicle ID, lifecycle status, location assignment |
| Retail price, cost, book values | Intake, body quote, quote snapshots, pricing corrections |
| RO numbers, closed RO totals, RO dates | QC records, rechecks, escapes, sign-offs |
| Customer & deal records, F&I | Transport milestones (Scheduled/Picked Up/Delivered/**Received**) |
| Vehicle decode (year/make/model/trim) | Handoff flags, activity timeline, photos, to-dos |

This already matches the existing project rule that OS transport milestones are tagged "OS TRANSPORT RECORD" and **never overwrite Tekion inventory dates**. Generalize that rule to every field.

**Sync mechanics — never let Tekion write into `vehicles` directly:**

```text
Tekion API ──► tekion_vehicles          raw mirror: full payload as received,
               (+ tekion_sync_log)      idempotent, append-only, replayable
                    │
                    ▼
               reconciler               matches on normalized VIN → sets
                    │                   tekion_vehicle_id, updates mirrored fields
                    ▼
               vehicles                 OS-owned identity + OS-owned fields
```

Keeping the raw payload means a bad mapping is a re-run, not a data-loss incident. Unmatched or ambiguous records (VIN mismatch, duplicate VIN, reused stock #, a Tekion record with no OS vehicle) go to a **reconciliation queue for a human** — never a silent auto-merge. The prototype already has the screen for this: **DMS Action Queue**.

**Four rules for the integration layer:**

1. **One client.** `packages/tekion` is the only code that talks to Tekion. No module ever calls the DMS directly, so a Tekion API change is one file, and rate limits are enforced in one place.
2. **Read-only first.** Pull only, for at least the first two phases. Write-back to Tekion (if ever) goes through one audited, retrying queue — never inline in a UI handler.
3. **Tekion being down must not stop the shop floor.** Mirrored data is cached and served with its `tekion_synced_at` timestamp shown; intake, QC and transport keep working offline exactly as they do today. Degradation is visible, never silent.
4. **Staleness is UI, not a footnote.** Any screen showing a Tekion-owned number shows when it was last synced. This is what stops "the OS says X, Tekion says Y" from becoming a trust problem.

**What to establish with Tekion before phase 7b is scheduled:** available entities and field coverage, webhooks vs. polling (and minimum poll interval), rate limits, a sandbox/test tenant, auth model and credential rotation, whether writes are permitted at all, and PII/data-handling terms.

### Building before Tekion access exists (current situation)

No API access yet, and write-back is wanted but unconfirmed. Both are fine — **as long as nothing on the critical path waits on Tekion.** Two consequences:

**1. Vehicle identity ships without Tekion.** Phase 7 splits: **7a** builds `vehicles`, the resolver and the Vehicle File on OS-owned data alone (intake, quote, QC, transport, flags, timeline) with `tekion_vehicle_id` sitting nullable and empty. **7b** adds the mirror and reconciler when access arrives. 7a delivers real value on its own — the Vehicle File is mostly OS-owned data anyway — and 7b becomes an additive backfill rather than a migration.

**2. Design the outbound path now; leave it unwired.** Assume write-back happens, and let that shape three things that are expensive to retrofit:

- **Attribution and intent on every OS-owned write** — who, when, and *why*, not just the resulting value. A push to Tekion later needs a defensible origin for each field.
- **An outbound queue interface from day one**, with no implementation behind it. Every candidate write-back (status change, cost, RO reference) is recorded as an intent in the OS's own tables. If write-back never materializes, that log is still the reconciliation report someone types into Tekion by hand — and if it does, the queue drains it.
- **Conflict semantics decided in advance:** when the OS and Tekion disagree on a Tekion-owned field, Tekion wins and the OS surfaces the divergence in the DMS Action Queue. Never auto-correct in either direction.

What this buys: if write-back turns out to be unavailable, you lose an automation, not an architecture. The bidirectional design collapses to "one-way read plus a human worklist" without a rewrite.

---

## 9. API / Service Strategy

**Belongs to the platform** (`packages/*`, shared `/api`): authentication & sessions · employee/user management · roles & permissions · vehicle identity & resolution · location management · file/photo storage · activity timeline & audit log · handoff flags · notifications · global search (`server/search.ts` is already generic) · KPI builders · API client · database access.

**Stays inside Intake & QC** (module-owned, never called directly by another module's code): the checklist definitions and intake wording · the QC pass/fail/recheck state machine and `qc_counter` · the pricing engine, rate tables, `quote_snapshots`, `pricing_corrections` · PIN sign-off semantics · AI classification · walk-around slot logic · the production-tracker freeze rules.

**Boundary shape:** keep the existing `/api/*` surface as-is (it's the module's contract and the client depends on it), and add a thin platform-owned read layer for cross-module composition rather than letting modules query each other's tables:

```text
GET  /api/vehicles/:vin                     identity + current lifecycle
GET  /api/vehicles/:vin/summary             composed: intake · quote · qc · flags · timeline
GET  /api/vehicles/:vin/timeline            already exists as /api/collaboration/timeline
PATCH /api/vehicles/:vin/status             platform-owned; modules request, platform decides
```

Rule to enforce from day one: **a module may not read another module's tables directly.** Cross-module reads go through the platform layer. This is what stops the "everything depends on everything" outcome.

---

## 10. UI Integration Strategy

Gradual, in this order, and never at the cost of working functionality:

1. **Shell first, module untouched.** Build `apps/os` with the sidebar / 58px header / title bar / KPI strip / right-drawer shell per `DESIGN_SYSTEM.md`. Intake & QC renders inside the shell's content area at `/intake-qc`, still its own client, still its own CSS. Users get one nav and one login on day one.
2. **Extract tokens to `packages/ui`** and have both apps consume them, so a color or status change happens once. `App.css` stops being a second copy of the palette.
3. **Adopt shared primitives where they're free** — status pills, table headers, money formatting, drawers, empty/loading/error states. Replace Intake & QC's equivalents one at a time, each behind a visual diff check.
4. **Mobile stays mobile.** Intake & QC is a phone-first PWA used on the shop floor with gloves on; the OS is a desktop ops console. Do not force the desktop shell onto the phone. Keep the PWA entry (`/intake-qc` standalone, home-screen installable) as a first-class target — the OS shell should collapse away on small screens, not wrap the phone UI in a sidebar.
5. **Then, and only then**, consider rebuilding individual Intake & QC screens on shared components. Per the repo's own rule: do not redesign Intake & QC to make the code match. Preserve working behavior; converge opportunistically.

---

## 11. Migration Plan

The phase list in your prompt is right in spirit; I'd reorder it so the **hardening work lands before shared identity**, because vehicle identity built on an unnormalized VIN would have to be redone. Phases 1–3 are cheap and de-risk everything after them.

| # | Phase | Objective | Changes | Systems | Risk | Depends on | Result |
|---|---|---|---|---|---|---|---|
| 1 | Documentation truth | Stop the stale docs from causing an outage | Rewrite `README.md` + `REPLIT_DEPLOYMENT.md` to describe the Express+Postgres app; reconcile `.replit` deploy target; commit this audit to `design/` | Repo only | **None** | — | No agent or person can deploy the wrong target |
| 2 | Source-of-truth lockdown | One repo, one branch, one workflow | Archive/retire stray repos; confirm push-then-pull; expose build SHA at `/api/health`; branch protection on `main` | GitHub, Replit | Low | 1 | Every deploy traceable to a commit |
| 3 | Data hygiene | Make VIN trustworthy | Normalize VIN on write; backfill + index `inspections.vin`; report unresolvable rows; confirm the unauthenticated-looking admin sync routes are token-gated | Server, DB | **Medium** (touches production data — do it as a reviewed migration with a snapshot first) | 2 | Every module joins on the same key |
| 4 | Repo structure | Monorepo without behavior change | Move existing code into `apps/`+`packages/` with no logic edits; keep all routes and URLs identical; tests green | Repo, Replit build | Medium (build config) | 2 | Room for a second app |
| 5 | Roles & locations | Express the OS permission spec | Add role + location scope to `employees`; `packages/auth` guards; keep `isAdmin`/`canOverride` working behind it | Server, DB, Settings UI | **High** (can lock people out — ship behind a flag, default = today's behavior) | 3, 4 | L1–L5 personas become real |
| 6 | OS shell | One nav, one login | Build `apps/os` shell + router; mount Intake & QC at `/intake-qc` unchanged | New app, server static hosting | Low | 4, 5 | The OS exists as software |
| 7a | Vehicle identity | One canonical vehicle — **no Tekion dependency** | `vehicles` + `vehicle_stock_history`; resolver; nullable `tekion_vehicle_id` left empty; optional `vehicle_id` alongside existing `vin` columns | Server, DB | Medium (additive only) | 3, 5 | The Vehicle File becomes real on OS data alone |
| 7b | Tekion link | Mirror the DMS | `packages/tekion` client + `tekion_vehicles` raw mirror + reconciler + DMS Action Queue; backfill `tekion_vehicle_id` | Server, DB, Tekion | Medium | 7a · **Tekion API access (vendor-gated)** | Tekion-owned fields appear, with sync timestamps |
| 8 | Photo storage | Get blobs out of Postgres | Object storage behind a `packages/storage` interface; migrate `photos.bytea` and inspection data-URLs with a compatibility read path | Server, DB, both clients | **High** (photos are irreplaceable evidence — dual-write, verify, then cut over) | 4 | Photos module becomes feasible |
| 9 | Shared services & KPIs | Kill duplicate numbers | One builder per metric in `packages/kpi`; consolidate `dashboard.ts` / `managerAnalytics.ts`; platform read layer per §9 | Server | Medium | 6, 7 | Same number everywhere |
| 10 | Shared UI | Native feel | `packages/ui` tokens → primitives → screen-by-screen adoption | Both clients | Low, incremental | 6 | Intake & QC looks native |
| 11 | Next module | Prove the template | Build one new OS module (Transport is the best candidate — fully specified, no legacy data) entirely on the platform | New app code | Low | 6–10 | The pattern is validated |

Throughout: the current Intake & QC deployment stays live and unmodified in behavior. Nothing in phases 1–6 changes a single business calculation.

---

## 12. Risk Assessment

**Must fix before integration**

- **R1 · Contradictory documentation.** `README.md` and `REPLIT_DEPLOYMENT.md` describe a no-backend, `localStorage`-only, Static-deployed app; the real app is Express + Postgres + Replit Auth. An agent or new developer following those docs could deploy Static (breaking the API) or "restore" client-only storage (data loss). Highest-severity, lowest-cost fix in this report.
- **R2 · `inspections.vin` is `default ''` and unnormalized** while every other module keys on normalized VIN. Canonical vehicle identity is impossible until this is fixed and backfilled.
- **R3 · No location dimension anywhere in the schema**, against an OS that is location-scoped in every screen and every permission rule.
- **R4 · Permission model too small** (`isAdmin` + `canOverride`) for ~9 roles × 5 locations. Adding modules on top of it means encoding rules in UI conditionals — the exact thing that becomes unfixable later.
- **R5 · Admin sync routes registered without a `requireAdmin` guard** — `/api/quoter/admin/sync` (`quoterSyncAdmin.ts:132`), `/api/tracker/admin/sync` and `/api/tracker/admin/sync-counts` (`trackerSyncAdmin.ts:33,50`). They appear to be token-gated internally (`QUOTER_SYNC_TOKEN` is required in production), but verify the check is present, constant-time, and rate-limited before the app sits behind a wider audience.
- **R6 · Ambiguous source of truth.** Four repos exist (`Final-QC-App`, `Truck-Ranch-final-QC` — 409/empty, `intake-body-quoter`, `paint-body-quoter`) plus in-repo duplicates: `attached_assets/quoter-src/` (62 files) and `.replit_integration_files/{client,server,shared}`. Someone will eventually edit the wrong copy. Decide which are frozen history and mark them read-only/archived.
- **R7 · Photo storage ceiling.** `photos.bytea` in Postgres + inspection photos as data URLs inside jsonb + a 40 MB JSON body limit. Backup size, memory pressure and request timeouts all grow with usage, and Photos is a planned module.

**Should fix during integration**

- Monoliths: `App.jsx` (~39k), `routes.ts` (~78k), `dashboard.ts` (~35k), `managerAnalytics.ts` (~37k). Split along module lines while moving into `apps/`.
- Duplicate KPI logic across `dashboard.ts` and `managerAnalytics.ts` (violates OS rule 10).
- Two pricing read paths (`quoter.ts`, `localQuote.ts`) — confirm one is authoritative.
- No client-side router in either app; no deep links.
- Google Sheets as a live production-tracker dependency; should become an import into a platform service.
- Styling divergence (`App.css` classes vs. inline-only DC rule).
- Repo hygiene: `attached_assets/` holds phone photos, pasted transcripts and an 852 KB HTML dump; the repo's own `CLAUDE.md` says not to commit these.

**Can wait**

- Accessibility (`<div onClick>` throughout, inherited from the prototype).
- Duplicate PWA icon sets (`public/`, `public/icons/`, `attached_assets/`).
- Test-file placement next to sources vs. a `__tests__` tree.
- The `/dashboard` → `/` redirect, once no bookmarks point there.

**Operational risks**

- **Lockout during the roles migration** (phase 5) — ship behind a flag defaulting to current behavior; test with a real non-admin account before enabling.
- **Data loss during photo migration** (phase 8) — dual-write, verify counts and checksums, keep the Postgres copy until verified.
- **Pricing drift** — `quote_snapshots.content_hash` and frozen tracker months are financial records. Any refactor touching the engine needs a golden-file test proving identical totals before and after.
- **Single-person bus factor** — one person holds the whole system's context. The audit, `github.md`, and phase notes should live in the repo, not in chat history.
- **Concurrent editing across Claude/Replit** — the most likely way to lose work. §6's push-then-pull rule is the mitigation; treat it as non-negotiable.

---

## 13. Decisions Needed From You

Only the ones code inspection cannot answer:

1. ~~Is Tekion the system of record for vehicle identity?~~ **Resolved:** Tekion is the DMS with APIs into the OS. The OS mints the TR Vehicle ID and late-binds to Tekion; field ownership and sync design are in §8. **Write-back is the goal but not yet confirmed available**, and **API access is not yet in hand** — so the plan splits identity (7a, buildable now) from the Tekion link (7b, vendor-gated). Nothing on the critical path waits on Tekion.
2. **Who owns the Tekion conversation, and what's the ask?** Getting API access — sandbox tenant, credentials, documented scopes, read *and* write confirmation, webhooks vs. polling, rate limits — is a vendor timeline you don't control. Start it now, in parallel with phases 1–6; it is the longest-lead item in this document and the only one that can't be shortened by working harder.
2. **Identity provider long-term:** stay on Replit Auth, or move employees to Google Workspace SSO?
3. **Do external users (vendors, carriers, customers) get accounts in this system?** The Partner Portal is designed as if they do. If yes, that's a second identity space and it needs to be decided before phase 5, not after.
4. **Hosting destination:** stay on Replit Autoscale, or move to a `truckranch.com` subdomain elsewhere? Affects auth callback config and cost, not architecture.
5. **The role × location matrix.** Who is authoritative for "an Intake tech at American Fork may do X"? Someone has to own that table; the L1–L5 personas in the prototype are my read of it, not your sign-off.
6. **Photo retention and evidentiary policy.** How long are QC/damage photos kept, at what resolution, and are they discoverable in a dispute? Drives the storage decision in phase 8.
7. **Retire the legacy Quoter Repl and the stray repos — when?** They're currently a parallel truth.
8. **Which module comes second?** I'd propose Transport: fully specified in `PROJECT_CONTEXT.md`, no legacy data to migrate, and it exercises the platform's permissions and external-user paths hard.
9. **Are the `.dc.html` prototypes contractual?** i.e. does the shipped OS have to match them screen-for-screen, or are they direction? Changes how much of phase 6 is design work vs. transcription.

---

## 14. Recommended First Implementation Step

**Phase 1 — rewrite `README.md` and `REPLIT_DEPLOYMENT.md` so they describe the application that actually exists, and commit this audit to the repo under `design/`.**

No code, no schema, no routes, no UI. It cannot break anything. And it removes the single most dangerous condition found in this audit: authoritative-looking instructions in the repo telling the next reader (human or agent) that this app has no backend and should be deployed as a static site.

The first *code* step, immediately after, is the safest useful one: **add a read-only `GET /api/vehicles/:vin/summary` behind `requireEmployee`** that composes what already exists — intake, latest committed quote snapshot, QC record(s), active flags, activity timeline. No schema change, no writes, no existing route touched, nothing removed. It is the seam every future module needs, and it makes the Vehicle File demonstrable against real data before anything is migrated.

Not performing either change now, per your instruction.
