---
name: Intake photo ordering
description: Durable rules for rearranging photos in Intake galleries
---
Rule: photo order is presentation-only metadata. It may be changed after intake commit, but every change must be narrowly scoped, audited, and serialized with uploads/deletes under the canonical quote lock. Ordering never changes photo bytes, slots, roles, or signed intake fields.

**Why:** completed Intake galleries still need usable visual sequencing, while signed business data and gallery ownership must remain immutable. Sharing the quote lock prevents reorder snapshots from racing a photo upload or deletion.

**How to apply:** verify the intake’s exact canonical quote, reconcile only currently owned photo IDs, append new IDs deterministically, preserve order across broad intake saves, and keep touch plus accessible keyboard controls available in completed galleries.