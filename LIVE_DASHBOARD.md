# Live dashboard ← one aggregate feed

The dashboard is read-only. It polls **one** endpoint on the Final QC server and
renders whatever comes back. Nothing new is written anywhere.

```
Dashboard browser → Final QC server ─┬─ Postgres (inspections, audit_log)
                                     ├─ Body Quoter /api/quote-by-vin  (x-fleet-key)
                                     └─ VPC Production Tracker sheet   (service account)
```

## Why Final QC is the host

It is the only place that already touches all three sources. It owns the
inspections, it already proxies the Quoter (`server/intakeQuote.ts`), and it
already authenticates to the tracker sheet (`server/googleSheets.ts`). Serving
the dashboard from the same origin means it inherits the existing Replit Auth
session and the `requireEmployee` allowlist — no second login, no second
database, no webhooks to keep in step.

## 1. Add the endpoint

New file `server/dashboard.ts`, registered from `registerAppRoutes` the same way
`registerIntakeQuoteRoute` is. Employee-gated. Cache the whole payload for
20–30 seconds so a room full of phones polling doesn't hammer Sheets.

```
GET /api/dashboard
```

Response:

```json
{
  "generatedAt": 1786060000000,
  "summary": {
    "completed": 22,
    "retailPlan": 45074.00,
    "closedRO": 111106.72,
    "variance": 66032.72,
    "claimsApproved": 0
  },
  "daily": [
    { "day": "2026-08-06", "intakes": 3, "qcs": 5 }
  ],
  "vehicles": [
    {
      "vin": "1FTEW1E42LKD90890",
      "stock": "TR-4119",
      "vehicle": "2020 Ford F-150 XLT",
      "qcNumber": "FQ-1042",
      "result": "fail",
      "status": "open",
      "inspector": "D. Whitmore",
      "qcAt": "08/03",
      "failKeys": ["mech"],
      "fails": [
        { "k": "mech", "item": "HVAC heat & A/C", "note": "Blower noisy." }
      ],
      "intake": {
        "found": true,
        "estimator": "Ryan",
        "stock": "TR-4119",
        "quotedAt": 1784126053924,
        "totals": { "hrs": 12.4, "usd": 1736 },
        "lineCount": 3
      },
      "tracker": {
        "roOpen": "06/12",
        "completed": "08/03",
        "pictureReceived": "08/03",
        "retailPlan": 2800,
        "closedRO": 4938.20,
        "daysPictureToClose": 0,
        "daysInProduction": 52,
        "notes": "Sunroof took us over budget"
      }
    }
  ]
}
```

### Where each field comes from

| Block | Source |
| --- | --- |
| `vehicles[].vin/stock/vehicle/qcNumber/result/status/inspector` | `inspections` table, via the existing `toClientRecord` |
| `vehicles[].qcAt` | `data.clearedTs` if `status === "cleared"`, else `data.ts` |
| `vehicles[].failKeys` / `fails` | `data.openItems` (category key, item, note) — drop the photo blobs, the dashboard doesn't render them |
| `vehicles[].intake` | `/api/quote-by-vin` per VIN, through the existing 60s cache. Batch it: one pass over the VIN list, `{found:false}` on miss |
| `vehicles[].tracker` | The monthly tab of the tracker sheet, joined on column A (VIN) — columns B, C, D, E, F, G, H, Q |
| `summary` | The sheet's month-summary block (rows 4–18), read as-is rather than recomputed |
| `daily` | `COUNT(*) FROM inspections GROUP BY date(created_at)` for `qcs`; intakes need the counter below |

Dates are accepted as ISO (`2026-08-06`) or `MM/DD` — the client parses both, in
`daily[].day` and in every `tracker` date field.

**Do not recompute the money.** Retail Plan and Closed RO are typed into the
sheet by hand (the export deliberately never writes E or F). Read them.

### Daily intake count

Nothing counts intakes today — the Body Quoter's in-app intake checklist was
removed in July 2026. Cheapest fix: count quotes created per day in the Quoter's
`quotes` table and expose it as

```
GET /api/intakes-by-day?days=14
Header: x-fleet-key: <FLEET_KEY>
```

alongside the existing `/api/quote-by-vin` in `server.js`. A quote created is an
intake done — same event, one row per truck. The Final QC server folds the result
into `daily[].intakes`.

## 2. Serve the dashboard

Put the built dashboard HTML in the Final QC app's `public/` and route it, e.g.
`/dashboard`. Same origin means the browser sends the session cookie with the
poll and `requireEmployee` does the rest.

If it has to live on a separate Repl instead, the dashboard's `apiBase` prop
takes the Final QC origin — but then add CORS with credentials on the Final QC
side and pin the allowed origin. Same origin is simpler; prefer it.

### Steps in Replit

1. Drop `VPC-Dashboard.html` into `public/` in the **Final-QC-App** Repl.
2. In `server/index.ts`, before the Vite/static handler:

   ```ts
   app.get("/dashboard", (_req, res) =>
     res.sendFile(path.resolve(import.meta.dirname, "..", "public", "VPC-Dashboard.html"))
   );
   ```

   Leave it un-gated if you want the PIN screen to be the only gate; wrap it in
   `isAuthenticated` to require the Replit Auth login first (recommended — then
   the poll is guaranteed to carry a session).
3. Add `server/dashboard.ts` per section 1 and register it in `registerAppRoutes`.
4. `QUOTER_URL` and `FLEET_KEY` are already set from the `FINAL_QC_LINK.md`
   work. Add `GOOGLE_SHEETS_SPREADSHEET_ID` / `GOOGLE_SERVICE_ACCOUNT_JSON` if
   the tracker read is not already configured.
5. Open `/dashboard`. The header pill turns green once `/api/dashboard` answers.

The PIN screen is client-side only — it decides which staff member is using the
device and whether dollar figures show. It is not authentication. Keep Replit
Auth in front of it for anything that matters.

## Backfilling the data that already exists

Nothing needs migrating. Every source is already populated, and the feed reads
them in place:

| Data | Where it already lives | What the feed does |
| --- | --- | --- |
| Every past inspection, its fails, re-checks and sign-offs | `inspections` + `audit_log` in the Final QC Postgres | Read directly — full history, no import |
| Retail Plan $, Closed RO $, dates, notes | The VPC Production Tracker sheet, typed in by hand | Read per VIN off the monthly tabs |
| Past intake quotes, hours, estimator, photos | `quotes` + `photos` in the Quoter Postgres | Read per VIN via `/api/quote-by-vin` |

Two real gaps to decide on:

- **Months before the tracker sheet existed.** The feed reads whichever monthly
  tabs it is pointed at. Point it at a list of tabs (or all tabs) rather than
  just the current month if you want the dashboard to cover history.
- **Historical intake counts.** The Daily Tracker's intake number comes from
  quotes created per day. That backfills automatically the moment
  `/api/intakes-by-day` exists, because the `quotes` rows already carry their
  creation timestamps. Nothing to re-enter.

A phone that ran the old localStorage-only Final QC still has records that never
reached Postgres. The QC app already has `POST /api/import` and a Settings →
Export backup for exactly this — run that on each old device once, and those
inspections join the feed like any other.

## 3. Behavior the dashboard already implements

- Polls `/api/dashboard` on load, every 30 seconds, and on window focus.
- Weekly throughput is bucketed client-side off `vehicles[].tracker.completed`
  (six weeks ending with the current one, Monday start) — no `weekly` block
  needed in the payload.
- Header pill: green **LIVE · <time>** when the last poll succeeded, amber
  **SYNCING**, grey **DEMO DATA** when the endpoint is unreachable. Tap to
  force a pull.
- On failure it keeps the last good payload and falls back to the baked-in
  August tracker data, so a dropped signal in the shop never shows a blank
  screen.
- Anything entered in the dashboard's own Intake or Final QC screens is kept in
  `localStorage` and shown alongside the live records until the real apps carry
  it.

## Notes

- **VIN is the only join key** across all three sources — matching the rule
  already documented in `FINAL_QC_LINK.md`. Stock # is not used.
- **Repeat VINs** are legitimate (`1C6SRFFTXKN607569` appears twice in August).
  Key vehicles by `qcNumber` where present, VIN + index otherwise.
- **Failed QCs never reach the sheet** by design, so a blocked truck will have
  `tracker: null`. The dashboard handles that — it shows the QC record and
  leaves the money fields empty.
- **Rotating `FLEET_KEY`** still means changing it in both Repls together.
