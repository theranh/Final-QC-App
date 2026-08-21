---
name: Live camera orientation authority
description: Browser-presented MediaStream frames are authoritative; gravity must not rotate captured pixels
---
Rule: capture live-camera pixels exactly as the browser presents the MediaStream frame. Do not apply a universal DeviceMotion/gravity transform. Keep explicit EXIF 1–8 normalization for file imports and metadata-free JPEG output.

**Why:** modern iPhone and Android browsers already normalize live video presentation. Gravity plus frame dimensions cannot distinguish raw sensor pixels from browser-normalized pixels, so a second transform rotated already-upright photos by 90° or 180° across multiple phones.
**How to apply:** live shutter code may crop/scale the presented frame but must not rotate it from gravity. Stored-photo repair must canonicalize source EXIF before one deliberate user-requested turn, and replacement uploads must retain durable queue/version conflict handling.

Also: keep the shop-requested opening permission gate if motion permission remains part of the product flow, but motion readings must never influence photo pixels.

Link-quote 409 means "committed OR not found"; repair by VIN (adopt the server row's id) — never blindly re-push the local intake row, another phone may own that VIN under a different id.

Related: intake-screen quote notes are saved via a notes-only PATCH endpoint (atomic jsonb_set, committed-guarded) — never PUT a stale full quote document from outside the quote screen, it clobbers newer lines/totals.
