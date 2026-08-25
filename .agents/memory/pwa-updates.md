---
name: Safe PWA updates
description: Rules for applying newly published service workers during active sessions
---
Rule: a newly available PWA version must prompt an already-open session instead of silently reloading it. First-install controller acquisition may remain quiet.

**Why:** an automatic reload during Vehicles, camera, intake, or reporting work can interrupt requests and leave users looking at transient or mixed state immediately after a publish.

**How to apply:** use prompt-based registration, periodically check for updates, and let the user explicitly apply the waiting version. Never infer that an active session is safe to reload merely because no text field or dialog currently has focus.