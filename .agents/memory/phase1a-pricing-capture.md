---
name: Phase 1A pricing feedback capture
description: Invariants of the quote-snapshot / pricing-correction system added at PIN commit
---

Rules for the pricing ground-truth dataset (quote_snapshots, pricing_corrections, repair_actuals):

- Snapshots are written in the SAME transaction as the PIN commit; a failed snapshot must fail the commit. Never downgrade to fire-and-forget — the dataset is future ground truth.
- **Why:** silent record loss would poison later rate-tuning; the user explicitly required commit-blocking persistence.
- Idempotency: unique (quote_id, content_hash) for snapshots, (snapshot_id, line_id) for corrections. Changed content = NEW version row, never overwrite.
- Per-line calc-vs-approved values MUST go through the client's full billing pipeline (billingMap → billingCls → bodyAlloc → lineHours), not bare lineHours — same-panel merge, caps, PDR suppression, and body proration change per-line numbers.
- The linked quote is read under FOR UPDATE inside the commit transaction (commit-quote uses the UPDATE...RETURNING row) so a concurrent autosave can't make the snapshot stale.
- Server imports the verbatim engine from src/lib/quoterPricing.js via a hand-written .d.ts (tsconfig has allowJs off); never re-implement the math server-side.
- Phase 1A is observation-only: nothing reads these tables to change pricing. Phase 1B+ (rates v2, parts, supplements) requires explicit user approval first.
- The user's approved phased plan lives in the Aug 2026 chat: collect first (1A), parts costs, AI schema+wide-shot gate, per-panel rates v2, ops table, supplement band — in that order.
