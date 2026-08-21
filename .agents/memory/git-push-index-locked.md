---
name: gitPush INDEX_LOCKED / BRANCH_ALREADY_EXISTS
description: How to unstick agent git pushes that fail with INDEX_LOCKED or BRANCH_ALREADY_EXISTS.
---

`gitPush` (and the Git pane) can fail with `INDEX_LOCKED` even when `.git/index.lock` is absent.

**Why:** the stale lock was `.git/refs/remotes/origin/main.lock` (leftover from a crashed git action) — search `find .git -name "*.lock"`, not just the index lock. After removing it, `gitPush` may then fail with `BRANCH_ALREADY_EXISTS` if the local branch has no upstream tracking; it apparently tries to create the remote branch.

**How to apply:**
1. `find .git -name "*.lock"` — if no git process is running (`ps aux | grep git`), delete the stale lock.
2. If push then reports BRANCH_ALREADY_EXISTS, set tracking without network: `git config branch.main.remote origin && git config branch.main.merge refs/heads/main`, then `gitPush({})` succeeds.

Rule: a healthy Replit GitHub OAuth connection does not necessarily authenticate the workspace's local HTTPS Git remote. If CLI push reports an invalid username/token, use the authenticated GitHub connector API or repair the Git credential flow; never ask for a token in chat.

**Why:** connector credentials are injected only into connector API calls, not exposed to `git push`. An API-created snapshot commit updates GitHub safely, but it does not preserve or align the local commit graph automatically.
**How to apply:** verify the remote branch SHA and representative file bytes through GitHub after an API publication. Keep private inspection artifacts out of the published tree. Treat local/remote history reconciliation as a separate, potentially destructive operation requiring explicit consent.
