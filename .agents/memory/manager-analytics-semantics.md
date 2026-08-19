---
name: Manager analytics semantics
description: Durable interpretation rules for cycle-time and coaching reports.
---

Manager reporting uses completed-intake cohorts bounded by America/Chicago calendar dates. Missing authoritative endpoints remain unknown. Tracker RO-open and release values are date-only, so their cycle stages use whole calendar-day precision rather than fabricated timestamps.

**Why:** Intake/QC milestones have real timestamps, while tracker dates do not carry a trustworthy time of day. Mixing those precisions would create false negative durations or imply accuracy the source does not provide.

**How to apply:** Keep exact-hour metrics for timestamp-to-timestamp stages; label tracker stages as day-precision and report coverage/unknown counts. Keep capped AI correction telemetry separate from immutable committed pricing corrections, disclose its pre-commit possibility, and never blend either into employee rankings.