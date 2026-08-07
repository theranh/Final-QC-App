---
name: Google Sheets export
description: How QC results flow into the user's VPC tracker spreadsheet — write method, pass-only rule, and formula-safety constraints
---
Replit's built-in Google Sheets connector grants **read-only** scopes — it can never write. Writes use a service account (secret `GOOGLE_SERVICE_ACCOUNT_JSON` + env `GOOGLE_SHEETS_SPREADSHEET_ID`), sheet shared to the service-account email as Editor. Service accounts cannot create their own spreadsheets.

**Critical: never append/insert rows in the VPC tracker.** Its monthly tabs ("Jul 2026", header row 20) pre-fill formulas down columns G–J and P on empty rows. `values:append` with INSERT_ROWS created formula-less rows and knocked a neighbor's formula off-target (had to repair rows by hand, July 2026). Correct method: scan column A for the target row (match by FQ number in notes column Q first, then VIN, else first empty-VIN row) and PUT only A, C, D, K–O, Q with nulls elsewhere (D "Picture Received" auto-fills the QC-pass date, same as C) — P is a sheet formula, never write it.

**Business rule (user-set, July 2026):** failed QCs are NOT exported. A unit reaches the sheet only when status is `pass` or `cleared` (re-check fixed everything); cleared units use clearedTs as the completed date and note "Passed after re-check".

**Concurrency:** exports are serialized through an in-process promise queue because read-target-row-then-write is not atomic; FQ-number matching also makes re-exports idempotent.

## Tracker table layout (read side, row 20 headers / data from row 21)
A VIN · B RO Open · C Completed · D Picture Received · E Retail Plan $ · F Closed RO $ · G Days Pic-to-Close · H Days in Production · I Variance $ · J Variance % · K–O dept columns · P QC Result · Q notes. Per-row variance exists in I/J — read it as typed, never recompute money client- or server-side.
