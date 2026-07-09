# Production Readiness Audit — Truck Ranch Final QC

Audit date: 2026-07-09 (initial audit), remediation pass same day.
Scope: `project/replit-app/` (the React implementation). `project/*.dc.html`, `project/support.js`, `project/uploads/`, and `chats/` are the original Claude Design handoff bundle — source material, not part of the deployable app (see "Repo hygiene" note below).

_The initial audit (§1-§13 below) made no code changes beyond three trivial, cosmetic, pre-approved pixel fixes. A follow-up remediation pass then fixed all P0/P1 findings from that audit; the original findings are left in place below with **[RESOLVED — see §0]** annotations rather than rewritten, so this document remains an honest record of what was found and what was subsequently done about it._

---

## 0. Remediation status (second pass, same day)

All P1 findings from the original audit were code-fixed and re-verified; there were no P0s. Nothing below required a database, an authentication provider, or a change of core architecture, and none of those were added — see the reasoning under each item.

| # | Finding | Status | What changed |
|---|---|---|---|
| P1-1 | No access control on a device-local, no-login app | **Addressed operationally, not with code** | Deliberately **not** implementing login: the original design brief explicitly and repeatedly states "no passwords/auth needed," and this was independently re-confirmed with the project owner earlier in this project (client-only architecture, chosen on purpose). Adding authentication now would silently reverse an explicit decision. Instead, this is now a documented deployment requirement: see `REPLIT_DEPLOYMENT.md`'s "Known limitations" and the README's "Known safety nets" section — don't publish the URL somewhere public without a plan for that. |
| P1-2 | Silent `localStorage` write failures | **Fixed** | `App.jsx`'s persistence effects (users/inspections/seq/default/draft) now check `saveLS()`'s return value and show a persistent toast — *"Storage full — could not save. Export a backup and free up space (Settings)."* — on failure, instead of failing silently. Verified by forcing `Storage.prototype.setItem` to throw and confirming the toast appears (see §10). |
| P1-3 | Concurrent multi-tab writes not handled safely | **Mitigated (detected + warned, not merged)** | Added a `window.addEventListener('storage', ...)` guard in `App.jsx`: when another tab/window writes any `fqc_*` key, the current tab now shows a sticky amber banner — *"This app changed in another tab/window. Reload now to avoid overwriting that data."* — with a Reload button. This doesn't make concurrent writes safe to merge (still architecturally impossible without a backend), but it replaces a silent, invisible data-loss race with a visible, actionable one. Verified with two pages sharing one browser context (see §10). |
| P1-4 | No recurring backup habit/reminder | **Fixed with a UI nudge** | Settings' Data & Backup card now tracks `fqc_lastBackupAt` and shows *"Never backed up on this device — export one now"* (or "Last backup: N days ago") in amber whenever it's been 7+ days or never. Doesn't replace a real process/habit, but removes the need to remember unprompted. |
| — | (Replit compat) dev/preview port hardcoded, not reading `$PORT` | **Fixed** | `vite.config.js` now resolves `Number(process.env.PORT) || Number(process.env.VITE_PORT) || 5173` for both `server.port` and `preview.port`; `package.json` scripts no longer hardcode `--port`; `.replit`'s `[env]` block now sets `PORT` instead of the unused `VITE_PORT`. Verified with `PORT=5555 npm run preview` actually listening on 5555, and the unset-default case still resolving to 5173 (see §10). This was N/A for the recommended Static deployment target either way (no server process to bind a port), but is now correct if a future deploy ever needs Autoscale/Reserved VM. |
| — | (Process gap) no lint config, no tests | **Added** | ESLint (`eslint.config.js`, flat config, `eslint-plugin-react-hooks` + `eslint-plugin-react-refresh`) — zero errors/warnings. Vitest (`vitest.config.js`, jsdom environment) — 51 unit tests across `src/lib/*` (VIN checksum, stats/period math, CSV escaping, record filtering/status, localStorage migration+boot). `npm run lint` and `npm run test` are now real, passing commands, not gaps. |
| — | (Housekeeping) no `.env.example`, `.gitignore` didn't explicitly cover `.env*` | **Added** | `.env.example` documents the one optional, non-secret `PORT` variable and explains explicitly that no secrets exist. `.gitignore` now explicitly ignores `.env`/`.env.*` (keeping `.env.example` itself trackable). |

**P2/P3 items were intentionally left as documented recommendations, not implemented**, per the remediation instructions ("resolve P0/P1... document P2/P3"). See the updated checklist in §13.

---

## 1. Executive summary

**The app is functionally complete, faithfully matches the design spec, builds cleanly, contains no secrets, and needs no backend/database because it was explicitly designed not to have one.** All P1 findings from the initial audit have since been fixed or mitigated (§0). It is ready for GitHub. For a public/shared deployment URL, the one remaining item is a **decision, not a code gap**: this is a no-login tool by design, so treat the deployed URL/device with the same care as a shared drive — see `REPLIT_DEPLOYMENT.md`'s Known Limitations.

There were no P0s in the initial audit, and none have appeared since. All P1s identified — storage-full, two-tabs-open, and stale-backup risk — are now either fixed (visible warnings instead of silent failure) or, for access control specifically, deliberately left as an operational decision rather than a code change that would contradict the approved no-auth design.

## 2. Architecture summary

- **Frontend-only React 18 + Vite 5 SPA.** No router (single `/` route, in-app screens are React state, not URLs).
- **No backend.** Zero `fetch`/`XHR`/`axios` calls anywhere in the app. Zero server code, zero backend dependencies in `package.json`. Confirmed by grep across `src/`.
- **No database.** Persistence is entirely `window.localStorage` on whatever device/browser the app is opened in, under keys `fqc_users`, `fqc_inspections`, `fqc_seq`, `fqc_default`, `fqc_draft`.
- **No authentication.** By design — the original brief explicitly says "No passwords/auth needed." There is no concept of a logged-in user; "who's inspecting" is just a picker.
- **PWA/offline**: `vite-plugin-pwa` generates a service worker that precaches the app shell + fonts, so the app keeps working with no signal after the first load.
- This is a deliberate architecture choice confirmed with the user earlier in this project (client-only vs. add-a-backend was explicitly asked and answered: "Client-only, as designed"). This audit does not relitigate that decision, but it does audit its consequences honestly (see §6, §9).

## 3. Implemented functionality (verified by driving the app, not just reading code)

Verified end-to-end in a headless browser against both the Vite dev server and the production build:

- New Inspection: 17-char VIN entry with live ISO 3779 check-digit validation and color/label feedback, required door-jamb VIN photo (client-side JPEG compression via canvas), stock #/vehicle fields, inspector picker, Bed Liner/Ceramic/Undercoating opt-out toggles, and the exact "Start Checklist → N items" / blocking-reason button label logic.
- Checklist: per-category Pass/Fail/N/A, category-colored progress segments, required note+photo gate on Fail, correct pluralized helper text at every state.
- Result screen: pass/fail banner, per-category breakdown, canvas signature pad (pointer events, clear button), commit gated on signature.
- Commit → sequential `FQ-100x` ID, correct pass/open status, and the record appears immediately in Records.
- Re-check flow: only previously-failed items shown, independently clearable, its own signature, original fail record preserved, status transitions `open → cleared` correctly, `clearedTs` set.
- Records: search (stock/vehicle/VIN/inspector/ID), Pass/Fail-open filter, date range, locked detail view with photos and full re-check history.
- Reports: WTD/MTD/past-months period picker, stats tiles, fails-by-category bars, most-failed items, per-inspector rollup.
- **CSV export**: downloaded file inspected — correct summary block + Final QC Rate + one row per inspection.
- **PDF/print report**: renders with real data, correct layout, Print/Save-as-PDF affordance.
- Settings: add/edit/delete inspector, set default inspector, and a **full backup export → mutate → import round-trip was tested and correctly replaced all local data**, including the confirm-before-overwrite dialog.
- Draft resilience: filled out a form, hard-reloaded the page (simulating a crash/accidental close), and the in-progress stock/vehicle/VIN/marks were still there after reload.
- Offline: after the service worker installs on first load, the app was tested with the network fully disabled and reloaded — it still rendered completely.

No placeholder/mock data exists. The three seeded users (R. Delgado/VRA, Theran/Dir. Bus Dev., Ryan/Director) are the **real names specified in the original brief**, not test fixtures — confirmed against `project/uploads/Final QC Build Package.1.md` line 27, and `theran@truckranch.com` matches this session's actual account email. Inspections start empty (`[]`), matching the "zero fake seeded records" requirement.

## 4. Missing or incomplete functionality

Verified two ways: my own side-by-side reading of `Final QC.dc.html`'s `renderVals()` against every component, plus an independent second-pass audit by a fresh agent with no prior context on this codebase, instructed specifically to find gaps rather than confirm correctness. Both passes covered every screen (QC Home, New Inspection Form, Checklist Sheet, Result+Signature, Re-check Sheet, Records List, Record Detail, Reports, Settings, Print Report, VIN scanner, lightbox, toast) line-by-line against the original's exact computed strings, validation gates, and button-enable logic.

**Functional discrepancies found: zero.** Every `onClick` in every screen is wired to a real handler; validation gating (VIN check-digit, required fail note+photo, signature-before-commit, "keep at least one inspector," etc.) matches exactly, including exact branch order and pluralization of helper text. No dead buttons, no placeholder content, no mock/fake data, no hardcoded fake inspections — the only seed data is the three real named users the brief explicitly asked for.

**Three pixel-level styling discrepancies were found and fixed during this audit** (trivial, cosmetic, no logic/behavior change — in scope per audit instructions):
- `HomeScreen.jsx`: the "+ New Inspection" button rendered at the shared `.btn` class's default 52px height instead of the spec's 56px. Fixed with an explicit height override.
- `PhotoRow.jsx`: the VIN door-jamb photo tile rendered at a ratio-derived 64×51 instead of the spec's exact 64×48. `PhotoRow` now accepts an explicit `height` prop (used by the VIN row only; checklist/re-check photo tiles are unaffected).
- `ReportsScreen.jsx`: the "Most-Failed Items" and "By Inspector" lists were missing a divider above their first row (the original applies `border-top` unconditionally on every row in those two lists specifically). Fixed.

All three were re-verified with a production build after the fix (see §10).

**One scope note, not a defect**, flagged again here for visibility even though it was already a conscious decision during implementation: the *original text prompt* (build package, line 12) asked for a Location/rooftop picker (Logan, American Fork, West Jordan, Twin Falls, Frederick). The *final iterated design* (`Final QC.dc.html` — which the handoff README explicitly says to treat as authoritative, "almost certainly the primary design they want built") **does not include this field anywhere**, confirmed by grepping the final design file for every location name and "rooftop": zero matches. The implementation correctly follows the final design. If Truck Ranch actually wants per-rooftop tracking, that's a real, deliberate feature gap versus the *original* prompt — worth a explicit go/no-go decision, not a bug.

No pipeline/escapes/vendor/tech-performance features exist — correct, these were explicitly out of scope (build package line 5: "Final QC inspections ONLY — no pipeline board, no escapes, no vendor features").

## 5. Critical deployment blockers

**None.** `npm ci`, `npm run build`, and serving `dist/` all succeed with no errors. See §10 for exact commands and output.

## 6. Security findings

No secrets found anywhere in the working tree or git history (single-commit history, scanned with pattern matching for API keys/tokens/private keys/AWS keys/Slack/GitHub/OpenAI-style tokens — zero hits). No `.env` files. Zero `process.env` / `import.meta.env` usage in the app — there is nothing to configure and nothing that could leak.

No XSS surface found: no `dangerouslySetInnerHTML` anywhere; all dynamic text goes through normal JSX interpolation (React-escaped); the only "raw" interpolation is `url('${src}')` for photo/signature backgrounds, and `src` is always an internally-generated `data:image/...;base64,...` string (canvas `toDataURL()` output or a FileReader result re-encoded through `<canvas>`), which cannot contain a quote or `)` character — this also means **any uploaded photo is force-re-encoded as a JPEG through canvas before it's ever stored or displayed**, which incidentally strips EXIF/metadata and neutralizes any embedded-script tricks in a malicious image file. This is a good existing practice worth keeping.

No SQL injection / path traversal / insecure file upload risk — there is no server to attack; "file upload" is 100% client-side (canvas re-encode; JSON.parse of a backup file, never written to any filesystem).

No CORS/cookie/session/auth-redirect surface exists to review — there is no server and no login.

**Real findings, not "no backend so nothing to say":**

- **P1 — No access control on a device-local, no-login app. [ADDRESSED OPERATIONALLY — see §0]** Anyone who opens the app's URL (or picks up the phone it's installed on) can view every inspection, add/edit/delete inspectors, and use **Import backup to wipe and replace 100% of the shop's inspection history** with only a native `confirm()` dialog standing in the way. This is by design (matches the brief), but it means the *deployment* choice carries real weight: this must not be deployed to a public, guessable, or shared URL without some access gate (Replit's App-level access control / a private link / kept on a single dedicated phone). This is an operational/deployment decision, not a code bug — deliberately not adding login, since that would contradict the brief's explicit "no passwords/auth needed."
- **P1 — Silent write failures. [FIXED — see §0]** `saveLS()` in `src/lib/storage.js` catches `localStorage.setItem` errors (quota exceeded, Safari private-mode restrictions) and returns `false`, but **nothing in `App.jsx` checked that return value** — every persistence `useEffect` (users/inspections/seq/default/draft) called it fire-and-forget. If a write silently failed, the user saw no toast, no warning — they believed an inspection was committed and locked when it may not have actually persisted. The original `.dc.html` design explicitly surfaced a "Storage full — could not save" toast on this exact failure path; that behavior did not carry over to the initial React port. Now fixed: every persistence effect checks the result and shows that same toast on failure.
- **P1 — Concurrent multi-tab writes are not handled safely. [MITIGATED — see §0]** All inspections live under one `fqc_inspections` localStorage key, read into React state once at boot and written back as a full array on every change. If the app is open in two tabs/windows of the same browser (e.g., an old tab left open plus a freshly opened one), each tab holds its own stale in-memory copy; whichever tab saves last **overwrites the other tab's entire inspections array**, silently discarding any inspection the other tab committed — including duplicate `FQ-` IDs being issued from each tab's own stale `seq`. A `storage` event listener now detects this and shows a persistent "reload now" banner in the other tab(s); the underlying race is still architecturally present (no merge is possible without a backend), but it is no longer silent.
- **P2 — No rate limiting / brute-force concerns** — N/A, there's no login to brute-force and no server to rate-limit.

## 7. Database and persistence findings

There is no database. Persistence is `localStorage`, which is:

- **Not lost on app restart** — confirmed: data survives page reload and even a full "crash" reload mid-form (debounced 250ms autosave of in-progress drafts).
- **Lost if**: the browser's site data is cleared, the device is reset/lost/replaced, or the user is in a private/incognito session (some browsers restrict or wipe localStorage after the session). **There is no server-side copy of anything, ever.** The only recovery path is a previously-exported JSON backup file.
- **Finite and measured**: I measured the app's actual photo compression pipeline (max 1000px edge, JPEG quality 0.55) against a realistic busy 3024×4032 phone-camera-resolution test photo: it compresses to a **~46 KB** data URL. Typical mobile-browser localStorage quotas run ~5 MB (notably restrictive on iOS Safari) to ~10 MB (most desktop/Android Chrome). At ~45-90 KB per photo (simpler photos compress smaller), that's roughly **60-100+ photos of headroom** — i.e., a few weeks to a couple of months of realistic daily use at one rooftop before the quota is at risk, with no in-app pruning or usage meter. **A failed write is no longer silent** (§0) — the user is now warned the moment a save fails, with a pointer to Settings to back up and free space, though there is still no proactive "you're getting close" meter before that point.
- **No schema/migrations in the traditional sense** — `migrateRecord()` in `src/lib/storage.js` is a lightweight forward-compat shim (adds `status`/`rechecks`/`openItems` to older-shaped records) and is exercised correctly by both normal boot and backup-import paths. It's now also unit-tested (`src/lib/storage.test.js`).
- **Destructive actions**: Delete Inspector and Import Backup are both gated behind native `window.confirm()`. Import Backup is explicitly a full, non-mergeable replace — this is documented in-app and in the README, not a bug, but it is a one-way door with only a browser dialog as friction.
- **Concurrent updates**: the underlying race (two tabs, last-write-wins on a full-array key) is still architecturally present — it cannot be made safe without a backend — but it is now **detected and visibly warned about** rather than silent (§0, §6).

## 8. Replit compatibility findings

- `.replit`'s `[deployment]` block is already correctly configured for what this app actually is: `deploymentTarget = "static"`, `publicDir = "dist"`, `build = ["npm","run","build"]`. **Static deployment does not run a server process at all** — Replit serves the `dist/` files directly — so "binds to 0.0.0.0" and "reads `PORT`" **do not apply** to the production deployment of this app, because there is no production server. This is correct for this architecture.
- Those two checks *do* apply to the **development** server (used by the Replit "Run" button / workflow, not by Deployments), and it already correctly does both: `vite.config.js` sets `server.host = '0.0.0.0'` and `preview.host = '0.0.0.0'`, and `.replit`'s `[[ports]]` maps `localPort 5173 → externalPort 80`.
- **Caveat, now fixed [see §0]**: the dev/preview port used to be hardcoded to `5173` in `package.json` scripts and `vite.config.js`, not read from `process.env.PORT`. This was irrelevant for the recommended Static deployment (no server), but would have broken a future Autoscale/Reserved VM switch. `vite.config.js` now resolves the port from `PORT` (falling back to the legacy `VITE_PORT`, then `5173`), and this was verified with `PORT=5555 npm run preview` actually binding 5555.
- `entrypoint = "src/App.jsx"` is now valid (the file exists — it did not exist before this implementation pass).
- Frontend and "backend" are trivially "one deployment" because there is no backend to separate.
- No SPA client-side routing exists to configure rewrites for (single `/`, no deep links) — nothing to break on refresh.

## 9. Required environment variables

**None.** Grepped the entire `src/` tree and config files for `process.env` / `import.meta.env` / `VITE_` — the only usage is the optional, non-secret `PORT` (dev/preview server port, added during remediation — see §0). Nothing needs to be configured in Replit Secrets for this app to run. `.env.example` documents this; `.gitignore` explicitly excludes any real `.env`/`.env.*` file from ever being committed.

## 10. Commands attempted and their results

| Command | Result |
|---|---|
| `rm -rf node_modules && npm ci` | ✅ Succeeds, 510 packages (up from 351 after adding ESLint/Vitest toolchains during remediation), exact lockfile match (no `package.json` drift) |
| `npm run build` (`vite build`) | ✅ Succeeds. Output: `dist/index.html`, one JS chunk (~224 KB / ~68 KB gzip), one CSS file (7.6 KB / 1.9 KB gzip), service worker + manifest + workbox runtime. Build time ~1s. |
| `npm run lint` (ESLint, added during remediation) | ✅ Zero errors, zero warnings (13 unused-catch-variable warnings found on first run, all fixed by converting to bare `catch {}` where the error was genuinely unused; one unused import removed) |
| `npm run test` (Vitest, added during remediation) | ✅ 51/51 tests pass across 5 files (`vin.test.js`, `format.test.js`, `records.test.js`, `stats.test.js`, `storage.test.js`) |
| Type checking | **N/A** — plain JS/JSX project, no TypeScript, by original design choice. |
| `npm run dev` / `npm run preview`, driven with headless Chromium | ✅ Full create → fail → sign → commit → re-check → clear → CSV export → PDF report → backup export/import flows all completed successfully with zero application errors, both before and after the remediation pass |
| `npm audit` | 2 vulnerabilities: 1 moderate (`esbuild` — dev-server-only request/response exposure) + 1 high (`vite` — dev-server path traversal in `.map` handling / Windows-specific UNC path issues / `server.fs.deny` bypass). **Both are exclusively about the Vite *development* server; none of the affected code ships in the static production `dist/` output.** No non-breaking fix is available (fix requires Vite 8, a breaking major upgrade) — left as-is with this note rather than force-upgrading during an audit. |
| Console/error check across mobile/tablet/desktop viewports | ✅ Zero console errors or React warnings in all three, in a real network environment. (In this sandboxed audit environment specifically, a Google Fonts request fails with a cert error — that's this sandbox's network policy, not an app bug; it will not occur on Replit or in production.) |
| Keyboard navigation spot-check | Bottom nav is keyboard-reachable (real `<button>` elements). Most other primary actions ("+ New Inspection", history rows, Pass/Fail/N/A, etc.) are plain `<div onClick>` with no keyboard/ARIA support — inherited from the original design's own HTML structure, not introduced during the React port. See checklist (P2). |
| Secret scan (working tree + `git log -p --all`) | ✅ Zero matches for API keys, tokens, private keys, AWS/Slack/GitHub-style credential patterns. Repo has a single commit (the original design handoff). |
| Independent design-diff re-audit (fresh agent, no prior context) | Confirmed zero functional discrepancies and the silent-storage-failure finding independently; found 3 pixel-level styling gaps (button height, VIN photo tile size, missing list dividers) — all three fixed during the initial audit, then re-verified with a clean `npm run build` |
| Remediation verification: forced `Storage.prototype.setItem` to throw, then triggered a save | ✅ "Storage full — could not save..." toast appeared, confirming the fix actually works end-to-end, not just in code review |
| Remediation verification: two browser tabs sharing one profile, committed data in tab A | ✅ Tab B showed the "changed in another tab/window — reload now" banner |
| Remediation verification: `PORT=5555 npm run preview` | ✅ Server bound `0.0.0.0:5555`, confirmed via `curl -I`; unset-`PORT` case still resolves to `5173` |

## 11. Exact commands

```bash
# install
npm install          # or: npm ci   (lockfile is present and consistent)

# development
npm run dev           # vite dev server, 0.0.0.0, port from $PORT (default 5173)

# lint / test
npm run lint          # ESLint — zero errors/warnings
npm run test          # Vitest — 51 unit tests, src/lib/*

# build
npm run build         # outputs static site to dist/

# production run
# There is no production server process — dist/ is a static site.
# Locally you can smoke-test the built output with:
npm run preview       # vite preview, 0.0.0.0, port from $PORT (default 5173), serves dist/
```

## 12. Recommended Replit publishing type

**Static.** This is already what `.replit` specifies, and it's the correct choice: there is no backend, no server-side state, and no long-running process to keep alive — `dist/` is a plain static bundle. Autoscale/Reserved VM would add operational surface (a process to keep running, a port to bind, a health check to satisfy) for zero benefit, since there's nothing dynamic to serve.

---

## 13. Prioritized remediation checklist

**P0 — deployment or security blocker**
- _None found, then or now._ Build, install, and the static-deploy configuration all work today.

**P1 — required before public launch**
- [x] ~~Decide and enforce an access-control story before sharing the URL~~ — **addressed as a documented operational requirement**, not code: this app has zero login by explicit design choice (re-confirmed with the project owner), and Import Backup can wipe all data. See `REPLIT_DEPLOYMENT.md` Known Limitations and README's "Known safety nets." (§0, §6)
- [x] **Fixed**: `saveLS()`'s failure return value is now checked in every `App.jsx` persistence effect, surfacing the original design's "Storage full — could not save" toast instead of failing silently. Verified live by forcing a write failure. (§0, §6)
- [x] **Mitigated**: added a `storage`-event guard that shows a persistent "reload now" banner in any tab/window where the app detects `fqc_*` data changed elsewhere, making the still-architecturally-present concurrent-write race visible instead of silent. Verified with two tabs in one browser profile. (§0, §6, §7)
- [x] **Fixed with an in-app nudge**: Settings now shows "Never backed up" / "Last backup: N days ago" (amber if 7+ days or never), tracked via a `fqc_lastBackupAt` timestamp set on every successful export. (§0, §7)

**P2 — recommended improvement**
- [ ] Add basic keyboard/ARIA support to primary interactive elements (currently plain `<div onClick>` almost everywhere except the bottom nav) — inherited from the original design, not introduced in the port, but worth fixing for real accessibility. **Not done in this pass** — it's a real UI change across every screen, not a targeted fix, and was left as P2 per the remediation instructions' scope (P0/P1 only).
- [x] ~~Add a lint config (ESLint) and at least minimal unit tests~~ — **done**: ESLint flat config + `eslint-plugin-react-hooks`/`react-refresh` (zero errors/warnings); Vitest + jsdom, 51 tests across `src/lib/*`.
- [ ] Add an in-app storage-usage indicator or soft warning as `localStorage` approaches its quota, given the measured ~60-100 photo ceiling — the app now warns *when* a write fails, but still has no proactive "you're getting close" meter before that point.
- [ ] If Truck Ranch wants Location/rooftop tracking, revisit — the original text prompt asked for it but the final iterated design (and this implementation) dropped it (§4).

**P3 — optional improvement**
- [ ] Add `engines.node` to `package.json` for clarity (Replit's Nix config already pins Node 20; this is just documentation).
- [ ] Consider a wider desktop/tablet layout for Reports/Records if office staff will regularly use this on a monitor — currently intentionally a fixed ~430px phone frame centered on any screen size, matching the phone-first brief.
- [ ] Revisit the `vite`/`esbuild` dev-only `npm audit` findings if/when a non-breaking upstream fix becomes available.
- [x] ~~Dev/preview server should read `$PORT`~~ — **done during remediation** (was filed as a Replit-compatibility note in §8, not originally in this P2/P3 list, but resolved alongside the P1s — see §0).

---

### Repo hygiene note (not a code issue, just visibility)

`project/*.dc.html`, `project/support.js`, `project/uploads/`, and the `.thumbnail` file are the original Claude Design export — several hundred KB of design-tool artifacts that aren't part of the deployable app and aren't referenced by anything in `project/replit-app/`. Worth deciding whether these travel to GitHub alongside the app or stay out of the repo/are moved to a `design/` folder, purely for repo cleanliness — not a functional or security concern.
