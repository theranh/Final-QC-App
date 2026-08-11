---
name: iOS gravity sign in camera rotation fix
description: devicemotion accelerationIncludingGravity has opposite sign on iOS vs Android
---
Rule: the walk-around camera's rotation-lock fix (rotate portrait-feed shots upright from gravity readings) must flip the sign of x/y on iOS (`S = IS_IOS ? -1 : 1`) before the rotation branches. Held upright, iOS reports y ≈ -9.8 while Android reports +9.8.

**Why:** without the flip, every upright portrait photo on iPhone matched the "upside down" branch and was saved rotated 180°. The old Body Quoter never hit this because motion permission was never granted there.
**How to apply:** any code interpreting accelerationIncludingGravity must normalize the platform sign first; IS_IOS = iP(hone|ad|od) UA or MacIntel + maxTouchPoints > 1.

Also: iOS grants motion access only from a user gesture — request it on the camera's first pointerdown AND have the shutter await a bounded gravity-sample wait, or the first portrait-locked landscape shot saves sideways (no reading yet).

Link-quote 409 means "committed OR not found"; repair by VIN (adopt the server row's id) — never blindly re-push the local intake row, another phone may own that VIN under a different id.

Related: intake-screen quote notes are saved via a notes-only PATCH endpoint (atomic jsonb_set, committed-guarded) — never PUT a stale full quote document from outside the quote screen, it clobbers newer lines/totals.
