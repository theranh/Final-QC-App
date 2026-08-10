---
name: Hours-only quote display
description: Quote UI shows hours only; dollars stay server-side for tracker sync
---
Rule: quote totals are displayed as labor hours everywhere in the UI (quote screen, intake cards, vehicles list, exports). Dollar amounts are still computed and stored verbatim (totals.usd etc.) because the tracker sync depends on them — never strip the math, only the display. Client forces `rates.showPricing = false` at init and hydration, which gates the copy summary, PNG export and PDF worksheet.

Also: the In-Take Quotes (awaiting Final QC) bucket now includes uncommitted intakes with an IN PROGRESS badge, deduped one card per VIN with committed preferred; flags/keep/notes are editable on the confirm and photos steps, and autosave creates the quote id on first extras edit so nothing is lost pre-photo.

**Why:** shop bills by fixed rate-table hours; dollars confused staff, but tracker $ figures are a hard invariant.
**How to apply:** any new quote-facing UI must show hrs, not usd; never remove usd from saved quote data.
