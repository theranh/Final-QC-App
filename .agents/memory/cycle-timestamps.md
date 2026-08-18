---
name: Cycle-time timestamps
description: Arrival (intakes.created_at) and RO-open capture rules
---
- `intakes.created_at` = arrival timestamp. Written once at INSERT (from client ts) and deliberately ABSENT from the upsert's ON CONFLICT SET list — immutability by construction, guarded by a regression test asserting the DO UPDATE clause never assigns it.
- Historical intake rows were deliberately NOT backfilled (no defensible source) — they stay NULL = "unknown". Never fake them from updated_at.
- `production_tracker(.archive).ro_open` = verbatim trimmed string from sheet column B, captured at monthly snapshot; the Sheets export still NEVER writes column B (merchant-entered).

**Why:** cycle-time/aging reports are only trustworthy if arrival can never be overwritten by later edits or offline queues.
