---
name: Server-owned AI classify config
description: How /api/quoter/classify authority works and the SDK retry pitfall
---
The classify endpoint owns model, max_tokens, timeout, and retry policy (CLASSIFY_CONFIG in server/quoter.ts). Client-sent model/max_tokens are ignored. The client's system prompt is honored only if it starts byte-for-byte with the canonical base (CLASSIFY_BASE_SYS_PROMPT, must equal BASE_SYS_PROMPT in src/lib/quoterClassify.js); then its dynamic suffix (vehicle/calibration/second-look hints) is kept as data. Only the two canonical user prompts are honored.

**Why:** stale PWAs drifted the prompt/model; server authority prevents silent semantic drift while preserving effective behavior.

**How to apply:** any prompt text change must be made in BOTH files identically. When wrapping anthropic.messages.create in a manual transient-retry loop, pass `{ timeout, maxRetries: 0 }` — the SDK's default maxRetries=2 multiplies attempts (up to 6 calls / ~270s) otherwise.
