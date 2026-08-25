---
name: Vehicle retirement semantics
description: Product and safety rules for deleting units from the Vehicles experience
---
Rule: a user-facing Delete action in Vehicles retires the exact intake or archives the exact completed inspection after an admin PIN. It removes the unit from active search, dashboard, handoff, and Vehicles surfaces but preserves historical records, quote links, and gallery bytes.

**Why:** hard-deleting by VIN can remove the wrong repeat visit, orphan a gallery, or destroy signed history. The user needs operational removal, while the system still needs recoverability and auditability.

**How to apply:** always target stable intake IDs or QC numbers, verify the admin PIN server-side, audit the action, invalidate active-data caches, and apply retired filtering consistently to every operational query. Never cascade-delete a linked gallery as part of vehicle retirement.