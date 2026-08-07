# Migration — fold the Body Quoter into the Final QC app

Paste this into the **Final QC Repl**. The goal is one app: intake, body quoting, and final
QC all in `final-qc-app`, with the Body Quoter retired as a separate URL.

This is a migration, not a feature. Work in the order below. The Body Quoter stays live and
untouched the whole time — it only goes read-only at step 6, after everything else is
verified.

Do not change the QC checklist, the FQ-#### counter, the re-check logic, or the sign-off.
Those are correct and in production.

---

## 1. Bring the schema across

The Body Quoter's Postgres has `settings`, `quotes`, `corrections`, `photos`, and `intakes`.
Create the same tables in this app's database, keeping the column names and types identical
so the import is a straight copy. Namespace nothing, rename nothing — a rename here means
every query has to be rewritten and re-verified for no gain.

Add one column to `quotes` and one to `intakes`:

```sql
ALTER TABLE quotes  ADD COLUMN committed_by TEXT;
ALTER TABLE intakes ADD COLUMN committed_by TEXT;
```

These hold the name of the person who signed the record off — see section 4.

## 2. Move the intake and quoting screens in

Port from the Body Quoter, in this order:

1. **Intake checklist** — the four TR-INTAKE-V2 steps with their sub-steps (UVEye Scan 3,
   vAuto Appraisal & Photos 6, Body Quoter App 6, Enter Everything in MDD 5) and the 9-item
   RO-Ready check. Wording verbatim; do not rewrite it.
2. **VIN scanner** — the same barcode path, with manual entry as the fallback.
3. **Damage capture** — photo per damage or fix, tied to the quote line.
4. **Quoting** — the rate table, pricing logic, and the `corrections` mechanism. The pricing
   model does not change. If a quote produced $1,736 in the old app it produces $1,736 here.

The Intake tab in the dashboard stops being a deep link and becomes these screens.

Match this app's existing visual language. Don't carry the Quoter's styling across — the
point of merging is that it stops looking like two apps.

## 3. Migrate the data

A one-time script, run once with both apps quiet. Order matters — `photos` and `corrections`
reference `quotes`.

1. `settings`
2. `quotes`
3. `corrections`
4. `photos`
5. `intakes`

**Photos are the hard part.** They're image bytes in Postgres and they're the bulk of the
data. Move them in batches with a resumable cursor, not one transaction — a timeout halfway
through a single statement leaves you with nothing. Log a count per batch.

Verify before moving on:

- Row counts match, per table, old versus new.
- Every `photos` row still resolves to its `quotes` row.
- Spot-check five quotes end to end: same VIN, same line items, same hours, same total.
- Total photo bytes match.

Set `committed_by` to the existing estimator name where there is one, and leave it null where
there isn't. Don't guess.

## 4. PIN sign-off

This app already has PIN sign-in. Extend the same mechanism to cover intake and quoting.

The rule: **the PIN is required at commit, not at the start.** Anyone can pick up a
half-finished walk-around — that's normal in a shop, phones get handed around. What's fixed
is the name on the finished record.

- Committing an intake (all 9 RO-Ready items checked) prompts for name + PIN, and writes
  `intakes.committed_by`.
- Committing a quote prompts the same way, writing `quotes.committed_by`.
- Final QC sign-off keeps working exactly as it does now.

Two things that must hold:

- `committed_by` is written from the PIN that was entered, never from a dropdown. There is
  no screen anywhere that lets someone pick a name that isn't theirs.
- Once written, `committed_by` is not editable in the UI. A correction is a new record with
  its own signature, not an edit to the old one.

Write every commit to `audit_log` with the person, the action, the VIN, and the timestamp.
That table stays append-only.

### PIN administration

Everyone with access to the app gets a PIN. Add an admin-only People screen:

```sql
ALTER TABLE employees ADD COLUMN pin_hash    TEXT;
ALTER TABLE employees ADD COLUMN can_override BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE employees ADD COLUMN active       BOOLEAN NOT NULL DEFAULT TRUE;
```

Add a person, set or reset their 4-digit PIN, toggle `can_override`, deactivate someone who
leaves. Store PINs hashed, never in plain text, and never display one back — a forgotten PIN
is reset, not looked up. Deactivating a person removes them from the sign-off list but
leaves every record they signed intact.

### Supervisor override

A person with `can_override` can sign off on behalf of someone else — the case this exists
for is a truck finished by someone who has already gone home.

An override is an **addition to the record, not a replacement**:

- The supervisor enters their own PIN, then picks whose work they're signing for.
- `committed_by` holds the person who did the work.
- A second field, `overridden_by`, holds the supervisor. Null on a normal sign-off.
- Any record with `overridden_by` set displays as signed by the worker, *countersigned* by
  the supervisor. Both names show wherever a signature shows — on the vehicle card, in
  Reports, in the audit log.

```sql
ALTER TABLE quotes  ADD COLUMN overridden_by TEXT;
ALTER TABLE intakes ADD COLUMN overridden_by TEXT;
```

The override never hides that it happened. A supervisor cannot sign as someone else — only
*for* them, on the record, with their own name attached. Log overrides to `audit_log` as a
distinct action so they can be counted; a rising override count is a signal worth seeing.

## 4b. Freeze closed months from the spreadsheet

Retail plan $, closed RO $, variance, and days-picture-to-close live only in the VPC
Production Tracker sheet. The dashboard reads them live, which is fine for the month in
progress and fragile for months already closed — an edited cell silently changes last
month's reported numbers.

Add a table:

```sql
CREATE TABLE IF NOT EXISTS production_tracker (
  vin             TEXT NOT NULL,
  month           TEXT NOT NULL,          -- 'Jul 2026'
  retail_plan_usd NUMERIC,
  closed_ro_usd   NUMERIC,
  days_to_close   INTEGER,
  snapshot_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (vin, month)
);
```

Add an admin-only action that reads one month's sheet tab and writes its rows in. Run it
once per month after that month closes. Re-running it for the same month overwrites those
rows and updates `snapshot_at` — that's the correction path.

Reports then reads **closed months from `production_tracker`, the current month live from
the sheet**. Values are stored exactly as typed in the sheet; never recompute them. Where a
VIN has no row and no live cell, show the figure as unavailable, not `$0`.

Snapshot `Jul 2026` and `Aug 2026` as part of this migration so the existing history is
frozen before anything else changes.

## 5. Simplify what the merge makes redundant

Once the data is in and verified:

- Delete `server/intakeQuote.ts` and the `quoteCache` — the quote is a local query now.
- Remove the `/api/dashboard` calls out to `/api/intake-by-vin`, `/api/intake-stats`, and
  `/api/intakes-completed`. Same numbers, computed locally.
- Remove `QUOTER_URL` and `FLEET_KEY` from this app's secrets.
- Drop `intakeSource` from the dashboard payload and the "intake data unavailable" state
  from the UI. There's no remote half left to be unavailable.
- "Awaiting Final QC" becomes a plain join: an intake with `completed_at` set and no
  inspection. No endpoint needed.

The vehicle card gets materially simpler — one query, both halves.

## 6. Cut over

Do not hard-cut. Run in parallel:

1. Deploy the merged app with the migrated data.
2. Put the Body Quoter in read-only mode — it still serves its existing records, but new
   intakes and quotes are rejected with a message pointing at the new app.
3. Run a week that way. Anything missing surfaces while the old app is still there to
   check against.
4. Re-run the migration script for anything created in the gap, then retire the Quoter URL.

Keep the Body Quoter's database indefinitely. It is the only original copy of every intake,
quote and photo made before the merge, and it costs almost nothing to leave in place. Retire
the URL, not the data.

---

## Don't

- Don't rename tables or columns during the move. Migrate first, tidy later if ever.
- Don't migrate photos in one transaction.
- Don't change the pricing model or the rate table as part of this. One change at a time —
  if a total comes out different, you need to know it was the migration.
- Don't let `committed_by` be set from a dropdown, ever.
- Don't let an override overwrite `committed_by`, and don't hide that one happened.
- Don't store or display a PIN in plain text.
- Don't delete the Body Quoter database on cutover day.
