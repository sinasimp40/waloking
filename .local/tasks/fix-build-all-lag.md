# Fix Build All Lag (Terminal + Admin UI)

## What & Why
When the operator clicks BUILD ALL with two or more customers configured, both the local terminal/cmd window AND the admin site become laggy/unresponsive while the builds run. The user reports it feels like a freeze, not just slow. This is a UX-blocking problem: operators can't tell if the system is healthy or hung, and on under-spec workstations the OS may even start dropping input.

Likely contributing factors (to be confirmed during investigation):
- Two parallel `electron-builder` invocations saturate CPU and disk I/O on the host. The job runner currently allows concurrency of 2.
- `Compress-Archive` on Windows can emit a high-rate stream of progress lines per zip; `publish-update.js` already mitigates this with `$ProgressPreference='SilentlyContinue'` and `-NoProfile -NonInteractive` (`walok/scripts/publish-update.js:88-110`), but two zips in flight may still flood the SSE pipe.
- The admin UI keeps the entire log buffer of every recent build in the DOM (`public/admin/admin.js`), which grows without bound during long builds and can pin the renderer.
- The `/api/admin/build` install pre-flight is now lock-protected (Task #7), so it can't be a node_modules race anymore — but the synchronous `spawnSync('npm install', ...)` inside the request handler still blocks the event loop while it runs, freezing every other admin request including SSE flushes.

## Done looks like
- Running BUILD ALL with 2+ customers no longer makes the admin site unresponsive — the customer panel, the build queue panel, and other admin pages all stay clickable while builds run.
- The local terminal/cmd window the operator launched the OTA server in stays responsive (no input lag, no frozen scrollback).
- Build durations are unchanged or better (we don't accept a fix that just makes builds slower to feel smoother).
- The fix is verified with a 2-customer Build All exercise in Replit and the architect signs off on the approach.
- Any new tunables (e.g. concurrency cap, log-rate limiter) are documented in `replit.md`.

## Out of scope
- The "[file missing — rebuild]" correctness bug (separate task).
- Replacing the build console with a progress bar (separate task — though the per-line log volume reduction here may help that task too).

## Steps
1. Profile a 2-customer Build All in Replit to identify the dominant lag source. Measure: event-loop lag in the OTA server during the install pre-flight and during publish, SSE message rate per second to the admin browser, and admin DOM node count growth.
2. Fix the dominant source. Probable candidates: move the install pre-flight off the request thread (spawn async, await with backpressure) so the event loop stays responsive; rate-limit or coalesce SSE log lines so a burst of 1000 lines/sec gets batched into ~30 frames/sec; or cap the in-DOM log buffer per console card with a "scroll for older" affordance.
3. Re-measure to confirm the lag is gone. Capture before/after numbers in the architect review.
4. Add or extend a test if the fix touches the job runner or SSE pipe (`test-job-runner.js`, `test-build-endpoint.js`).
5. Update `replit.md` with the new behavior and any new env vars or limits introduced.

## Relevant files
- `walok/update-server/server.js:750-900`
- `walok/update-server/job-runner.js`
- `walok/update-server/public/admin/admin.js:500-620`
- `walok/scripts/publish-update.js:84-120`
- `walok/update-server/test-job-runner.js`
- `walok/update-server/test-build-endpoint.js`
- `replit.md`
