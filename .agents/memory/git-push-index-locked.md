---
name: gitPush INDEX_LOCKED / BRANCH_ALREADY_EXISTS
description: How to unstick agent git pushes that fail with INDEX_LOCKED or BRANCH_ALREADY_EXISTS.
---

`gitPush` (and the Git pane) can fail with `INDEX_LOCKED` even when `.git/index.lock` is absent.

**Why:** the stale lock was `.git/refs/remotes/origin/main.lock` (leftover from a crashed git action) — search `find .git -name "*.lock"`, not just the index lock. After removing it, `gitPush` may then fail with `BRANCH_ALREADY_EXISTS` if the local branch has no upstream tracking; it apparently tries to create the remote branch.

**How to apply:**
1. `find .git -name "*.lock"` — if no git process is running (`ps aux | grep git`), delete the stale lock.
2. If push then reports BRANCH_ALREADY_EXISTS, set tracking without network: `git config branch.main.remote origin && git config branch.main.merge refs/heads/main`, then `gitPush({})` succeeds.
