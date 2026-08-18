---
name: Reliability hardening invariants
description: Concurrency/durability rules added in the reliability pass — guards belong inside transactions, rates are versioned, deletes tombstone, exports queue durably.
---

Rules future changes must preserve:

- **Every integrity guard runs inside the transaction that acts on it.** Photo-upload committed/ownership/tombstone checks, tracker snapshot count guard, and the commit-time ratesVersion check all execute inside their tx (with the relevant advisory or FOR UPDATE lock). **Why:** a code-review round found each pre-tx check was a TOCTOU race (e.g. PIN commit landing between a committed-by read and a photo insert).
- **Rates are versioned via a separate `ratesMeta` settings key** ({version, updatedAt, updatedBy}); the `rates` payload shape is unchanged for old clients. PUT /api/quoter/rates is admin-only, completeness-validated (partial objects would wipe groups after shallow merge — `flags` is an ARRAY of chips, not an object), and bumps the version under an advisory lock. Commits send optional `ratesVersion`; mismatch → 409 `code:'rates_changed'` checked inside the commit tx with FOR UPDATE.
- **Quote deletes tombstone into `deleted_quotes`** inside a tx holding the same per-quote advisory lock uploads use; photo POST returns 410 on tombstone (photoQueue drops 410 permanently); an explicit full quote PUT clears the tombstone. No FK on photos by design (orphan risk in prod).
- **Sheet exports go through the durable `sheet_export_jobs` queue**, never fire-and-forget. Jobs are claimed atomically via UPDATE…SKIP LOCKED (dev workspace + published VM can share a DB); stuck 'running' jobs reclaim after 15 min; backoff 1m→60m, 8 auto attempts then 'failed' (manual admin retry in Settings).
- **Startup migrations** live in server/migrations.ts (`schema_migrations` table). The whole critical section runs in ONE transaction with `pg_advisory_xact_lock` — session-scoped `pg_advisory_lock` across separate pool calls is wrong (different connections; lock can strand).
- **Client pending-commit slot** (`fq_pending_commit_v1`): payload saved before create/recheck commit, cleared only on confirmed success or an authoritative already-saved response (create 409 dup-VIN, recheck 400/409); banner offers RETRY/DISCARD. One slot is enough — save buttons are disabled while in flight.
- **Tracker re-snapshot guard**: refuse empty or <half-size overwrites unless force; replaced rows always archived to `production_tracker_archive`; per-month advisory lock serializes re-runs.
- PIN endpoints rate-limit per signer/IP; tests must call the exported `resetPinRateLimits()` in beforeEach or unrelated cases 429.
