#!/bin/bash
# Post-merge setup for the Walok OTA system.
#
# Runs automatically after a task merges. Stdin is closed (/dev/null), so
# every command must be non-interactive. Idempotent — safe to re-run.
#
# Three package.json roots in this repo:
#   1. update-server/        — the live workflow ("Start application")  ← lives at REPO ROOT (May 2026 move)
#   2. walok/                — Electron launcher build pipeline
#   3. walok/server/         — Companion local server
#
# Only #1 is required for the workflow to come back up cleanly after a
# merge that touched dependencies. #2 and #3 are needed only when the
# operator runs build-customer.js / build-all.js, so we install them too
# (idempotent and fast when nothing changed) but tolerate failures so a
# transient hiccup in those secondary deps cannot block the merge.
set -e

echo "[post-merge] update-server: npm install"
( cd update-server && npm install --no-audit --no-fund --prefer-offline )

echo "[post-merge] walok (launcher): npm install (best-effort)"
( cd walok && npm install --no-audit --no-fund --prefer-offline ) || echo "[post-merge] WARN: walok npm install failed (non-blocking)"

echo "[post-merge] walok/server: npm install (best-effort)"
( cd walok/server && npm install --no-audit --no-fund --prefer-offline ) || echo "[post-merge] WARN: walok/server npm install failed (non-blocking)"

echo "[post-merge] OK"
