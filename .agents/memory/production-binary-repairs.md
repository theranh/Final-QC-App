---
name: Production binary repairs
description: Safety requirements for narrow, agent-driven replacement of production image or file bytes
---

Rule: a production binary repair must validate the real decoded format and pixels, not just headers, extensions, MIME labels, or dimensions. Constrain each write by exact record identity and original version, make it idempotent and audited, and retain recoverable originals until post-write verification succeeds.

**Why:** container formats can be mislabeled or shaped to pass superficial marker checks while remaining corrupt or decoding as another format. Replacing valid production bytes without a full decode and rollback source turns a repair into permanent data loss.

**How to apply:** use the application’s token-guarded production write path; require a fixed allowlist plus exact id/owner/slot/timestamp checks inside a locked transaction; verify decoder-reported format, full pixel decode, and expected dimensions before opening the write transaction; archive originals and re-check the live manifest immediately before invoking the repair.