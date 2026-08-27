---
name: Photo object verification
description: Governing byte-integrity rule for migrating PostgreSQL photo data into private App Storage.
---

Every photo object write must use uncompressed raw bytes and must be accepted only after a complete read-back matches both the source byte length and SHA-256.

**Why:** The current Replit App Storage JavaScript SDK does not expose a metadata `head` checksum API, and photo bytes must never be altered or trusted based only on upload success.

**How to apply:** Use the shared storage adapter for photo migration and verification work. Treat any read-back mismatch as a row failure, leave database source bytes authoritative, log the row ID, and continue.

Every application read must fully buffer and integrity-check the private object before writing response bytes. A missing, stalled, truncated, or corrupt object must be logged with its key and photo identity, then served from the retained PostgreSQL source.

**Why:** Directly piping an Object Storage stream allowed an asynchronous 404 to become an unhandled stream error that terminated the entire application; mid-response fallback is impossible after bytes have been sent.

**How to apply:** Keep storage streams inside the shared bounded adapter, attach an error handler immediately, destroy timed-out streams, and route table rows, inspection references, exports, sync, and EXIF/orientation consumers through the shared fallback accessor.