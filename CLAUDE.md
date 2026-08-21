# CLAUDE.md

Guidance for coding agents working in the Truck Ranch Final QC application.

## Project

This repository is the deployable application at the repository root. It is a
mobile-first Final QC and Body Quoter application, built with:

- React 18 and Vite for the frontend (`src/`);
- Express and TypeScript for the API (`server/`);
- Replit Auth and PostgreSQL through Drizzle ORM (`shared/`, `server/db.ts`);
- a PWA photo workflow, including durable offline upload/delete queues.

The old standalone Intake & Body Quoter is a separate legacy Repl. Its public
deployment is read-only and must not be merged into this application.

## Commands

Run commands from the repository root:

```bash
npm run dev          # development server
npm run test         # Vitest suite
npm run lint         # ESLint
npx tsc --noEmit     # TypeScript check
npm run build        # Vite client build plus server bundle
npm run start        # production server on port 5000
```

The Replit development workflow is `PORT=5000 npm run dev`. Production runs
the built server with `npm run start`.

## Project rules

- Preserve the server-side authentication and database model; do not replace it
  with client-only storage.
- Preserve the Quoter pricing pipeline exactly. Saved pricing, PIN sign-off,
  committed records, and frozen tracker months have business significance.
- Capture browser-presented live camera frames as-is. File imports may require
  EXIF normalization, but do not reintroduce universal gravity-based rotation.
- Keep local inspection data, photos, and credentials out of Git commits unless
  the project owner specifically authorizes them.
- The old Quoter database may be used as a read-only migration/sync source via
  `QUOTER_DATABASE_URL`; do not modify or delete it from this project.

## GitHub mirror and push-then-pull sync

The canonical remote is:

```text
origin = https://github.com/theranh/Final-QC-App
branch = main
```

Use this sequence whenever synchronizing completed work:

1. Check `git status` and review the exact files to be committed. Do not add
   screenshots, phone photos, analysis images, or pasted chat transcripts by
   default.
2. Before starting work, incorporate any remote changes with
   `git fetch origin main` followed by `git pull --ff-only origin main`. Resolve
   a divergence deliberately; never force-push `main`.
3. Run the relevant validation commands, commit the intended changes, and push
   to `origin/main`.
4. Immediately pull `origin/main` again and verify that the local and remote
   branch heads agree. This is the required push-then-pull confirmation step.

If the local Git HTTPS credential helper cannot push despite a healthy Replit
GitHub connection, do not request or paste a token. Publish through the
authenticated GitHub connector/API, verify the remote `main` SHA and file tree,
then reconcile the local branch from GitHub before additional work. Keep any
local-only reference artifacts untracked and locally ignored.
