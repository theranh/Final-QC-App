---
name: Intake completion semantics
description: How an intake becomes "complete" after the checklist removal (Aug 10, 2026)
---
The intake progress bar, TR-INTAKE-V2 steps, and 9-item RO-Ready checklist were all removed per the user (Aug 10, 2026). Completion is now marked solely by the PIN commit: commit-intake sets `completed_at = COALESCE(completed_at, NOW())` alongside `committed_by`, and the intake PUT never sets or clears `completed_at`.

**Why:** User wanted the intake screen to mirror the old app's simplicity — just truck details, walk-around photos (thumbnails shown inline), and quote info populating on open.

**How to apply:** Never reintroduce checklist-derived completion or progress percentages; anything that feeds the awaiting-Final-QC list depends on `completed_at`, so any new completion path must also call the dashboard cache invalidation. Legacy rows completed under the old checklist rule keep their timestamps (intentional).
