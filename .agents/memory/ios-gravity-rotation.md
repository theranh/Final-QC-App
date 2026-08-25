---
name: Live camera orientation authority
description: Safely reconcile live-camera backing frames with the preview without gravity guesses
---
Rule: never infer live-camera pixel rotation from DeviceMotion, gravity, or dimensions alone. On Apple mobile browsers, confirm the actual captured backing-frame direction once per browser/camera/screen-orientation profile, then apply that explicit correction before preview-equivalent crop and zoom. Unknown profiles must pause before upload; non-Apple profiles default to no turn. Keep explicit EXIF 1–8 normalization for file imports and metadata-free JPEG output.

**Why:** some browsers normalize live video presentation, while an observed iPhone WebKit path displayed an upright preview but exposed a quarter-turned canvas backing frame and produced metadata-free sideways pixels. Gravity previously double-rotated already-correct iPhone and Android captures. No standards API can infer semantic direction reliably.
**How to apply:** freeze the unknown profile's exact backing frame, show it before upload, persist the explicit turn separately for browser engine, camera, screen angle, and frame/preview orientation, then rotate before object-fit crop and digital zoom. If persistence is blocked, retain the correction for the session. Stored-photo repair must canonicalize source EXIF before one deliberate user-requested turn, and replacement uploads must retain durable queue/version conflict handling.

Also: auto-start the live camera without a custom opening permission gate. Only show a clearly labeled dark Enable Camera fallback after automatic access fails, always keep file selection available, and do not request DeviceMotion permission.

Link-quote 409 means "committed OR not found"; repair by VIN (adopt the server row's id) — never blindly re-push the local intake row, another phone may own that VIN under a different id.

Related: intake-screen quote notes are saved via a notes-only PATCH endpoint (atomic jsonb_set, committed-guarded) — never PUT a stale full quote document from outside the quote screen, it clobbers newer lines/totals.
