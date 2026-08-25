---
name: Vehicle retirement semantics
description: Product and safety rules for deleting units from the Vehicles experience
---
Rule: a user-facing Delete action in Vehicles retires the exact intake or archives the exact completed inspection after an admin PIN. It removes the unit from active search, dashboard, handoff, and Vehicles surfaces but preserves historical records, quote links, and gallery bytes.

**Why:** hard-deleting by VIN can remove the wrong repeat visit, orphan a gallery, or destroy signed history. The user needs operational removal, while the system still needs recoverability and auditability.

**How to apply:** always target stable intake IDs or QC numbers, verify the admin PIN server-side, audit the action, invalidate active-data caches, and apply retired filtering consistently to every operational query. Never cascade-delete a linked gallery as part of vehicle retirement.

Repeated retirement is idempotent: return success for an already-retired exact record without changing timestamps, invalidating caches, or writing another audit event. Only the request that performs the state transition is audited.

Rule: completed Vehicles visibility must not depend solely on the enriched dashboard payload. The active inspection bootstrap is the authoritative fallback; dashboard data should enrich matching QC rows rather than determine whether those rows exist.

**Why:** a transient dashboard miss during a publish made every completed card appear gone even though production still held all active inspections and no retirement events had occurred.

**How to apply:** merge by exact QC number, prefer enriched cards, exclude archived bootstrap rows before merging, and keep intake-only retirement filtering in the server-owned awaiting source. A failed enrichment request must never render a truthful active inspection as deleted.