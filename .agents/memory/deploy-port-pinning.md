---
name: Deployment port pinning
description: Why the prod start script must pin PORT=5000 on this repl
---
The `.replit` `[env]` section sets `PORT=5173` (legacy vite-era default) and cannot be edited by the agent. Autoscale deployments inherit it, so an unpinned server binds 5173 while the deployment forwards local port 5000 → external 80, making the published app unreachable ("could not reach server").

**Why:** July 2026 outage — publish succeeded but healthchecks on `/` failed; app only ever worked before via a stale `[[ports]] 5173→80` mapping that was later removed.

**How to apply:** Keep `PORT=5000` hardcoded in the `start` script in package.json. Never rely on ambient PORT in production. Also: the deployed PWA's service worker can show the app's own "Could not reach the server" screen from cache even when the outage is server-side — check deployment reachability, not just app code.

**Cold starts (July 2026):** Autoscale sleeps when idle; `tsx server/index.ts` took ~10s to boot (healthchecks 500 meanwhile), so phones saw "Could not reach the server" on first visit. Fix: build bundles the server via esbuild to `dist-server/index.js` (boot ~1.4s) and `start` runs plain `node`; frontend bootstrap retries were widened to ~15s. Keep prod start on the prebuilt bundle — don't revert to tsx.
