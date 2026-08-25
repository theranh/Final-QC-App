---
name: Vehicle thumbnail selection
description: Product rule for choosing covers in both Vehicles buckets
---
Rule: every Vehicles thumbnail is the earliest surviving photo captured in that intake’s exact quote gallery, ordered by capture timestamp with photo ID as the deterministic tie-breaker.

**Why:** preferred-angle ranking, damage-line covers, display reordering, and latest-quote-by-VIN fallbacks can show a later or unrelated image. Repeat VIN visits must never share gallery covers.

**How to apply:** resolve the selected intake’s exact quote ID, query only its current photo rows, and choose the minimum capture timestamp then ID. Gallery `photoOrder`, slot, and role do not participate. If the first photo is deleted, the next surviving capture becomes the cover; if none exists, show a placeholder rather than an unverified fallback.