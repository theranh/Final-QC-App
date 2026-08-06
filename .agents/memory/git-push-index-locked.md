---
name: gitPush INDEX_LOCKED
description: The gitPush callback repeatedly fails with INDEX_LOCKED in this repl even when no .git lock file exists.
---

The `gitPush` callback returns `CLI_ERROR: INDEX_LOCKED` persistently (across sessions, many retries over minutes), while:
- no `.git/index.lock` exists in the workspace,
- the working tree is clean and the remote commit is an ancestor (fast-forward would be fine),
- direct `git push` from the shell fails auth (credentials only exist in the platform git service).

**Why:** the lock appears to live on the platform's git service side, not in the workspace `.git`; local cleanup and waiting do not clear it.

**How to apply:** after 2–3 failed gitPush retries, stop retrying and tell the user to push from the Git pane (one-click Push works for them). Local commits are safe; only the transport is blocked.
