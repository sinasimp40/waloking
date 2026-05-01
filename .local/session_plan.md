# Objective
Pivot from the current "Build From Uploaded Source" + per-customer "Upload Update"
flow to a simpler model: operator uploads a .zip ONCE that replaces the master
source on disk (`walok/src/` for launcher, `walok/server/` for server), then the
existing "Build All Customers" runs against the freshly-updated master. Add
per-customer **Launcher** and **Server** build buttons so a one-off rebuild can
ship just one role.

# Tasks

### T001: db.js — source-updated-at kv
- **Blocked By**: []
- Add `getSourceUpdatedAt(kind)` / `setSourceUpdatedAt(kind, ts)` (kv via existing meta table, key `source_<kind>_updated_at`). Distinct from the now-dead baseline kv.
- Files: `walok/update-server/db.js`

### T002: backend — `/api/admin/update-source` endpoint
- **Blocked By**: [T001]
- New `POST /api/admin/update-source` (multipart: `kind` field + `file` field).
- Refuses 409 while ANY build job is RUNNING (read job-runner.listJobs).
- Validates zip: PK magic, zip-slip refusal, per-entry cap 200 MB, total cap 500 MB.
- Atomic replace: extract into `walok/src.tmp-<stamp>/` (or `walok/server.tmp-<stamp>/`), rename old → `.trash-<stamp>`, rename tmp → final, async rmrf trash.
- After replace: `setSourceUpdatedAt(kind, Date.now())`.
- Also new `GET /api/admin/source-status` → `{ launcher: {present, updatedAt}, server: {present, updatedAt} }` for the UI.
- Files: `walok/update-server/server.js`

### T003: backend — role filter on `/api/admin/build`
- **Blocked By**: []
- Accept optional `roles: ['launcher']` | `['server']` | undefined (=both) on build body.
- Plumb to per-job step env as `BUILD_ROLE=launcher|server` (omitted = both).
- Modify `scripts/build-customer.js`: when `BUILD_ROLE=launcher`, skip the server electron-builder substep; when `=server`, skip vite + launcher electron-builder. (Publish-update.js already only packs `*-unpacked/` dirs that exist, so no changes needed there.)
- Files: `walok/update-server/server.js`, `walok/scripts/build-customer.js`

### T004: backend — remove dead routes + source-build.js
- **Blocked By**: [T003]
- Delete: `/api/admin/build-from-source`, `/api/admin/upload-update`, `/api/admin/upload-update-bulk`, `/api/admin/customers/:channel/upload-update`, `/api/admin/baseline-status`.
- Delete: `walok/update-server/source-build.js`, `test-source-build.js`, the `_baselineWriterClaim` closure + `getBaselineRefreshedAt`/`setBaselineRefreshedAt` (db.js can keep them in case anyone still calls them — they're harmless — but UNwire the routes).
- Remove unused multer config blocks.
- Files: `walok/update-server/server.js`, `walok/update-server/source-build.js` (delete), test file (delete)

### T005: frontend HTML — swap panels + customer card buttons
- **Blocked By**: [T002, T003]
- Remove `<section>` "Build From Uploaded Source" + the `<div id="upload-modal">`.
- Add new `<section>` "Update Source Files" with two side-by-side cards (Launcher Source / Server Source), each with file input + "Replace Source" button + status line.
- Customer card: drop "Upload Update" button; replace single "Build" button with three: "Build" (both), "Launcher" (role-filtered), "Server" (role-filtered).
- Files: `walok/update-server/public/admin/index.html`, `walok/update-server/public/admin/admin.css`

### T006: frontend JS — wire new panel + per-role buttons; rip dead code
- **Blocked By**: [T005]
- Remove: `submitBulkUpload`, `submitUpload`, `openUploadModal`, `closeUploadModal`, `applyBuildModeUI`, `wireBuildModeToggle`, `refreshBaselineStatus` and their event listeners.
- Add: `submitUpdateSource(kind)`, `refreshSourceStatus()` (called on load + after each successful upload).
- Customer card click router: handle `launcher-only` and `server-only` actions → `triggerBuild({ channel, roles: [...] })`.
- Files: `walok/update-server/public/admin/admin.js`

### T007: tests
- **Blocked By**: [T002, T003, T004]
- New `test-update-source.js`: zip-slip refusal, missing-package-json refusal, atomic replace happy path, 409 refusal while job is RUNNING.
- Update `package.json` `test` script to drop the deleted `test-source-build.js` and add the new one.
- Files: `walok/update-server/test-update-source.js`, `walok/update-server/package.json`

### T008: architect review + screenshot
- **Blocked By**: [T005, T006, T007]
- Architect review with full diff.
- Screenshot the new admin UI.
- Files: (review only)
