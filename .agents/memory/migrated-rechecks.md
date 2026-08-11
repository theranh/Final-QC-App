---
name: Migrated re-checks & stale PWA sessions
description: Why imported Final QC re-checks couldn't be completed, the admin repair path, and the 401/auth-expired PWA behavior.
---

**Rule:** Inspections imported from the legacy app can pass import validation without `data.openItems`; the re-check endpoint requires items to exactly match `openItems`, so such rows are stuck open. Repair path: admin-only endpoint rebuilds `openItems` from `data.items` marks (`f`), clears zero-fail rows; the UPDATE re-asserts eligibility (`status='open' AND imported AND openItems IS NULL`) so concurrent runs/re-checks are never clobbered. Settings has a "Repair migrated re-checks" button. User must run it on the LIVE app (prod DB is read-only to the agent).

**Also:** A phone PWA left open for weeks keeps a dead session — API 401s while the UI looks signed in. `src/lib/api.js` dispatches `auth:expired` on any 401 and `useAuth` flips to signed_out, forcing the sign-in screen. "Sign out" / "Could not load employees" complaints usually mean an expired session, not broken employee data.

**How to apply:** For any future prod-data repair, ship it as an idempotent admin endpoint + Settings button and have the user run it on the published app.
