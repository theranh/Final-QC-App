---
name: Photo upload queue durability
description: Rules for the persistent walk-around photo queue (IndexedDB) and its retake race.
---
Walk-around photos persist to IndexedDB before upload and flush on next app launch; the camera pauses the global flusher while open.

**Why:** server photo ids are deterministic per quote+slot, so queue records must be keyed per CAPTURE — otherwise an in-flight older upload's cleanup deletes a retake's record (data loss). Cleanup after a successful send may only remove records at least as old as the sent capture.

**How to apply:** any change to photo upload/queueing must keep per-capture keys, treat 401 as transient (photo survives sign-out), and drop only 413/409/403 as permanent.
