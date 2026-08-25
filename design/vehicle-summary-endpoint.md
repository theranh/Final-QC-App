# Spec — `GET /api/vehicles/:vin/summary`

Read-only cross-module composition. **No schema change, no writes, no existing route touched, nothing removed.** This is the seam every future OS module needs, and it makes the Vehicle File demonstrable against real data before anything is migrated.

Audit reference: §9 (API strategy), §14 (first code step).

## Contract

```
GET /api/vehicles/:vin/summary
guard: requireEmployee
```

`:vin` is normalized server-side (`trim().toUpperCase()`) before any lookup. Do not trust the caller's casing.

**200** — the vehicle is known to at least one module.
**404** — `{ "message": "No records for this VIN." }` when every section would be empty.
**400** — `{ "message": "VIN must be 17 characters." }` for a malformed VIN. (Warn-only, not blocking, if you decide legacy short VINs must remain queryable — decide once and document it here.)

## Response shape

```jsonc
{
  "vin": "1FT8W3BT5NEC12345",
  "identity": {
    "vehicle": "2022 Ford F-350 Lariat",   // best available display string
    "stock": "T4821",                      // most recent stock # seen
    "miles": "48,120",
    "source": "intake",                    // which table the display data came from
    "tekionVehicleId": null                // always null until audit phase 7b
  },
  "intake": {
    "id": "…",
    "estimator": "…",
    "createdAt": "2026-08-04T14:22:00Z",   // arrival at intake, immutable
    "completedAt": "2026-08-04T15:01:00Z",
    "committedBy": "…",
    "overriddenBy": null,
    "quoteId": "…"
  } | null,
  "quote": {                                // latest committed snapshot only
    "snapshotId": 812,
    "quoteId": "…",
    "committedBy": "…",
    "overriddenBy": null,
    "linesTotal": 7,
    "linesOverridden": 2,
    "calcUsd": "1840.00",                   // engine, no overrides
    "finalUsd": "2110.00",                  // approved
    "createdAt": "2026-08-04T15:44:00Z"
  } | null,
  "qc": {
    "latest": {
      "qcNumber": "FQ-1043",
      "result": "fail",                     // first inspection
      "status": "open",                     // pass | open | cleared
      "createdByName": "…",
      "createdAt": "2026-08-11T09:12:00Z",
      "updatedAt": "2026-08-11T09:40:00Z",
      "openItemCount": 3,
      "archived": false
    } | null,
    "history": [ { "qcNumber": "FQ-1012", "result": "pass", "status": "pass", "createdAt": "…" } ],
    "count": 2
  },
  "flags": [
    { "id": 55, "kind": "waiting_parts", "note": "rear bumper", "creatorName": "…", "createdAt": "…" }
  ],
  "timeline": [
    { "id": 9001, "eventType": "qc_recheck_committed", "qcNumber": "FQ-1043",
      "actorName": "…", "occurredAt": "…", "details": { } }
  ],
  "photoCounts": { "walkAround": 22, "damage": 6, "qcFail": 3 },
  "meta": {
    "generatedAt": "2026-08-25T13:40:00Z",
    "sections": { "intake": "ok", "quote": "ok", "qc": "ok", "flags": "ok", "timeline": "ok", "photos": "ok" }
  }
}
```

## Source of each section

| Section | Table | Query notes |
|---|---|---|
| `identity` | `intakes`, `inspections`, `quote_snapshots` | Prefer the most recently updated non-empty display data. Resolution order documented in code, not guessed per-call. |
| `intake` | `intakes` | `WHERE vin = $1` → most recent by `updated_at`. `created_at` is arrival and is never updated; may be NULL on pre-column rows — return null, do not backfill. |
| `quote` | `quote_snapshots` | Latest by `created_at`. Snapshots are immutable versions; return the newest only, with `count` if more exist. |
| `qc` | `inspections` | All rows for the VIN. `latest` = newest by `created_at`. `openItemCount` derived from `data`'s open items — reuse the existing helper, do not re-derive the rule here. Include `archived` rows in `history` but flag them; **never** let them affect a count a dashboard also reports. |
| `flags` | `vehicle_handoff_flags` | `WHERE vin = $1 AND active = true`. Uses the existing `vehicle_handoff_flags_active_idx`. |
| `timeline` | `vehicle_activity_events` | `WHERE vin = $1 ORDER BY occurred_at DESC LIMIT 50`, `?limit=` capped at 200. Never return the whole log unbounded. |
| `photoCounts` | `photos` | `COUNT(*) … GROUP BY role` via `photos_quote_idx` on the resolved quote id. **Counts only — never photo bytes.** |

## Rules

1. **Reuse existing logic; never restate a business rule.** Open-item derivation, result/status semantics and money formatting all have one home already. If a helper isn't exported, export it — do not copy it. (Project rule: one builder per metric.)
2. **Zero writes.** No audit row, no `updated_at` touch, no lazy backfill, no vehicle-record creation. A read that mutates is how a "safe" endpoint becomes a migration.
3. **Never returns photo binaries.** Counts and ids only. Keep this endpoint small enough to call on every screen.
4. **Partial failure degrades, it doesn't 500.** If one section's query fails, return the rest with that section `null` and `meta.sections.<name>` set to `"error"`. A missing quote must not blank the QC record a tech is looking at.
5. **Archived rows are visible but never counted.** They stay in `history`; they stay out of anything a dashboard also reports.
6. **`tekionVehicleId` is present and always null** until phase 7b. Shipping the key now means no client change later.
7. **Normalize once, at the edge.** One normalization helper, shared with the phase-3 VIN hygiene work, so this endpoint and the backfill agree by construction.

## Tests worth having

- Known VIN with all sections populated → full payload.
- VIN with QC only, VIN with intake only → other sections `null`, no 500.
- Lowercase / whitespace-padded VIN → same result as canonical.
- Unknown VIN → 404.
- Signed out → 401. Pending/inactive employee → 403.
- Archived inspection → appears in `history`, excluded from `count`-style aggregates.
- Timeline limit is enforced and capped.
- Simulated failure in one section → 200 with that section `"error"`.

## Why this one first

It touches nothing, it proves the Vehicle File concept against real production data, and it's the exact call the OS shell's right-hand drawer will make on every row click. If the composition turns out to be wrong, the cost of being wrong is deleting one file.
