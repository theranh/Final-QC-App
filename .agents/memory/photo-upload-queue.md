---
name: Photo upload queue durability
description: Rules for the persistent walk-around photo queue (IndexedDB) and its retake race.
---
Walk-around photos persist to IndexedDB before upload and flush on next app launch; the camera pauses the global flusher while open.

**Why:** server photo ids are deterministic per quote+slot, so queue records must be keyed per CAPTURE — otherwise an in-flight older upload's cleanup deletes a retake's record (data loss). Cleanup after a successful send may only remove records at least as old as the sent capture.

**How to apply:** any change to photo upload/queueing must keep per-capture keys, treat 401 as transient (photo survives sign-out), and drop only 413/409/403 as permanent.

**No "extras" concept in the UI (user policy, Aug 2026):** all walk-around photos are one set with no visible cap or separation — the 24 guided slots are just the shooting guide; after the 24th shot the camera stays open and every further shot saves as a new photo (internally `xtra_*` slot keys, a storage detail only). Never show "extra photos" labels, "(+N)" splits, or a /24 cap in photo counts.

## Damage close-ups
Damage close-ups now go through the same durable queue (persist before upload). Rule: any durable-queue capture path must also purge queued/in-flight copies on delete, or the launch flusher resurrects a photo the inspector removed — use an isDeleted check so an in-flight send that lands after a delete gets deleted server-side too.

**Orientation rule (Aug 2026):** every uploaded photo must pass through the shared canonicalizer, which parses EXIF, removes it from a temporary decode copy, explicitly transforms raw pixels, and re-encodes upright. Never rely on browser EXIF behavior or persist a non-upright orientation tag.
