---
name: Express 5 + TypeScript quirks
description: Routing and typing pitfalls hit while adding an Express 5 backend to this project.
---

- Express 5 rejects `app.use("*", ...)` (path-to-regexp error crashes the server). Use a pathless `app.use(...)` for catch-alls.
  **Why:** path-to-regexp v8 no longer accepts bare `*` patterns; the crash happens at startup, not request time.
  **How to apply:** any SPA fallback / catch-all middleware in this repo must be pathless or use a named wildcard.
- Passing a `RequestHandler[]` array as a single route argument works at runtime but breaks TypeScript overload inference — later inline handlers' params become implicit `any` (TS7006).
  **Why:** Express's route method overloads don't match `(handlerArray, handler)` cleanly.
  **How to apply:** compose middleware chains into one `RequestHandler` (see `chain()` in `server/access.ts`) instead of exporting arrays.
- Newer TypeScript flags `baseUrl` (TS5102) with non-relative `paths` (TS5090): drop `baseUrl` and make `paths` targets relative (`"./shared/*"`).
