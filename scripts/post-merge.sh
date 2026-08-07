#!/bin/bash
# Runs automatically after a task branch merges: reinstall deps and sync the
# database schema. Must stay idempotent, non-interactive, and fast.
set -e

npm install --no-audit --no-fund
npm run db:push --if-present -- --force
