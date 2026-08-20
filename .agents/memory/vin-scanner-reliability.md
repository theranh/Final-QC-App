---
name: VIN scanner reliability
description: Durable mobile/PWA rules for barcode-decoder availability, native API timeouts, and scanner cancellation
---

Keep the ZXing VIN decoder in the primary application bundle rather than a separately lazy-loaded chunk. Treat browser `BarcodeDetector` support only as an optional accelerator: capability discovery and each detect call must be time-bounded, with bundled ZXing remaining available on every scan pass. Scanner cleanup must prevent in-flight camera or detector promises from acquiring another camera or submitting a VIN after close.

**Why:** A separately loaded barcode chunk can disappear behind a stale PWA asset URL after an update, silently reducing the scanner to a weak fallback. Mobile native barcode APIs can also hang during capability discovery or detection, permanently wedging a scan loop unless they are bounded. Async results arriving after cancellation can otherwise open a vehicle the inspector explicitly canceled.

**How to apply:** Any scanner optimization must preserve an always-available decoder path, bound optional browser APIs, show a user-visible message when camera frames never arrive, stop tracks on every exit, and re-check cancellation after every async boundary.