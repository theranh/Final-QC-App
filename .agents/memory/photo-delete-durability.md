---
name: Photo delete durability
description: How offline damage-photo deletions stay durable and how EXIF parsing is centralized
---
- Deleting a damage photo persists an owed server-DELETE in the photoQueue IndexedDB `pendingDeletes` store (DB v4); `flushQueue` runs `flushServerDeletes` FIRST (drops stale queued uploads for the id, then retries the DELETE). Records clear only on 2xx or permanent 404/409/403 verdicts.
- **Why:** a fire-and-forget DELETE while offline left the server copy forever; the in-flight PUT race also needs a durable corrective delete, not `.catch(()=>{})`.
- **How to apply:** any new photo-deletion path must go through `queueServerDelete` + `attemptServerDelete`, never a bare `api.deleteQuotePhoto().catch()`.
- EXIF orientation parsing lives ONLY in `server/photoExif.ts` — never re-add a private copy in routes. Walker contract: segLen<2 stops; BOM must be exactly II/MM; an oversized segment length still allows a bounds-checked APP1 parse (truncated real camera files must keep yielding orientation) but stops the walk afterwards.
- Corrections idempotency is enforced by a partial unique index `corrections (analysis_id, md5(diffs::text)) WHERE analysis_id IS NOT NULL` + `INSERT ... ON CONFLICT DO NOTHING` — SELECT-then-INSERT dedupe is a race and was rejected in review.
