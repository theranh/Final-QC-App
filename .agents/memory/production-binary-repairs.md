---
name: Production binary repairs
description: Safety requirements for narrow, agent-driven replacement of production image or file bytes
---

Rule: a production binary repair must validate the real decoded format and pixels, not just headers, extensions, MIME labels, or dimensions. Constrain each write by exact record identity and original version, make it idempotent and audited, and retain recoverable originals until post-write verification succeeds. When the desired change is deterministic, derive the replacement from the locked production source rather than accepting caller-supplied bytes.

**Why:** container formats can be mislabeled or shaped to pass superficial marker checks while remaining corrupt or decoding as another format. Caller-supplied replacements can also be valid but unrelated. Replacing valid production bytes without a full decode and rollback source turns a repair into permanent data loss.

**How to apply:** use the application’s token-guarded production write path; require a reviewed manifest plus exact id/owner/slot/timestamp checks inside a locked transaction; bound decoder resources, fully decode the locked source, and generate metadata-free output server-side. Save original bytes and source/result hashes in the same transaction, then permit rollback only while the repaired timestamp and hash still match. Re-check the live manifest immediately before invoking the repair. Judge each damage photo separately: later damage captures can be upright even when every walk-around frame in the same gallery is physically sideways, and dimensions alone cannot distinguish them.