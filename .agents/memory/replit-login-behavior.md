---
name: Replit login behavior
description: The intended balance between explicit authentication and repeated OAuth consent.
---

Keep an explicit Replit login prompt when a user is signed out, but do not force the OAuth consent prompt on every login.

**Why:** The repeated Allow/Deny permissions screen creates unnecessary friction after a user has already approved the app, while an explicit login still makes account authentication clear.

**How to apply:** Preserve normal Replit authentication and existing scopes, request login without forced consent, and require consent again only if permissions materially change or Replit requires it.