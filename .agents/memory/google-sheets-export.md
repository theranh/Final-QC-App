---
name: Google Sheets export
description: How QC results flow into the user's VPC tracker spreadsheet and why a service account is used
---
Replit's built-in Google Sheets connector grants **read-only** scopes (spreadsheets.readonly + drive.readonly) — it can never append/write, regardless of what the user approves at OAuth. Writing requires a Google service account key stored as secret `GOOGLE_SERVICE_ACCOUNT_JSON` plus env `GOOGLE_SHEETS_SPREADSHEET_ID`, with the sheet shared to the service-account email as Editor.

**Why:** Discovered July 2026 when building auto-export of finalized QC inspections; connector proxy returned 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT on every write attempt, including after re-auth.

**How to apply:** For any Sheets *write* feature, go straight to the service-account route. Also: the user's target spreadsheet ("VPC-Metric- Manual-Tracker") has formula-laden monthly tabs ("Jul 2026" etc., table header at row 20); only fill columns A, C, K–Q and send `null` for all other cells so formulas/manual data stay untouched. Service accounts cannot create their own spreadsheets (Google Drive policy) — always write into a user-shared sheet.
