---
name: Photo object verification
description: Governing byte-integrity rule for migrating PostgreSQL photo data into private App Storage.
---

Every photo object write must use uncompressed raw bytes and must be accepted only after a complete read-back matches both the source byte length and SHA-256.

**Why:** The current Replit App Storage JavaScript SDK does not expose a metadata `head` checksum API, and photo bytes must never be altered or trusted based only on upload success.

**How to apply:** Use the shared storage adapter for photo migration and verification work. Treat any read-back mismatch as a row failure, leave database source bytes authoritative, log the row ID, and continue.