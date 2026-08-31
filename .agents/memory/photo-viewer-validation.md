---
name: Photo viewer validation
description: How to validate photo enlargement changes beyond isolated component tests.
---

Photo enlargement work is not complete based only on DOM click tests. Confirm the published PWA serves the expected asset bundle and mount full-screen viewers at the document root rather than inside the clipped application frame.

**Why:** Desktop users can remain on a stale service-worker-controlled bundle, while nested fixed overlays can behave differently from the isolated DOM test environment. Both cases look like a photo click doing nothing even when the callback test passes.

**How to apply:** For photo-viewer changes, compare the live and local asset hashes after publishing, test the exact reopened-photo flow, and keep modal overlays in a document-level portal.