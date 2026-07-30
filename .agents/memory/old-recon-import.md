---
name: Old Truck Recon Checklist migration
description: How the legacy Expo app stores data and how this app imports it
---
The user's earlier app (truck-recon-checklist--theran.replit.app, an Expo web app) stores inspections **on-device only** under storage key `truck_inspections` — no server, no export UI. Records look like `{id, stockNumber, mileage, truckInfo:{year,make,model,vin}, inspector, notes, status:'in-progress'|'passed'|'failed', createdAt, completedAt, checklist:[{category,label,checked,failed,deferred,note,photos}]}`.

**Why:** an employee kept logging QCs there; data can only leave via code served from that app's own domain, so the old Repl must add an export button — cannot be done from this project.

**How to apply:** this app's Settings → Import auto-detects that format (bare array or `{inspections:[...]}`) and converts it (`convertOldReconBackup` in the exports lib). Legacy records are sent WITHOUT FQ numbers; the server allocates them atomically from qc_counter to avoid collisions. Old failed QCs import as open re-checks; in-progress or undated records are skipped; only `data:` photos ≤2MB (max 12/item) survive.
