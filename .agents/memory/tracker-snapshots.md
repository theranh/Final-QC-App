---
name: Production tracker snapshots
description: How frozen monthly tracker rows get into the production DB and the rules around them
---

The rule: frozen month rows in `production_tracker` are created by the `tracker_snapshot` phase of the token-guarded admin sync endpoint (same door as the quoter data sync, guarded by `QUOTER_SYNC_TOKEN`). It calls the canonical snapshotMonth helper, which reads the month tab from the VPC Production Tracker sheet and delete-then-inserts that month's rows in one transaction.

**Why:** the workspace cannot reach the production DATABASE_URL, so prod writes must go through the deployed server; and per operator instruction re-running a month IS the correction path (overwrite that month only, refresh snapshot_at), while values are stored as typed in the sheet — never recomputed — and quotes/photos/inspections/employees must never be touched by this path.

**How to apply:** to freeze or correct a month in prod, POST `{phase:"tracker_snapshot", month:"Jul 2026"}` with the `x-sync-token` header to `/api/quoter/admin/sync` on the published app (endpoint only exists after a republish that includes it). Reports read closed months from `production_tracker` and the current month live from the sheet; missing values render as "unavailable", never $0.
