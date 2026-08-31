---
name: Photo viewer validation
description: How to validate photo enlargement changes beyond isolated component tests.
---

Photo enlargement work is not complete based only on direct DOM click tests. Confirm the published PWA serves the expected asset bundle and exercise the real pointer-down/move/up sequence on any photo that also supports drag-to-reorder.

**Why:** Desktop users can remain on a stale service-worker-controlled bundle; the corrected viewer behavior was confirmed only after refreshing the published app. Separately, capturing the pointer on mouse-down for a reorder gesture retargets the eventual click away from the nested photo button, so the callback test passes while a real mouse click does nothing.

**How to apply:** Compare live and local asset hashes after publishing. For reorderable galleries, delay pointer capture until movement crosses the drag threshold and test both a stationary click and a drag sequence.