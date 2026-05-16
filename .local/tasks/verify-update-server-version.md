## What & Why
The user is still seeing the `ERR_STREAM_WRITE_AFTER_END` crash even though Task #1
shipped a fix that's verified by tests on Replit. The stack trace they posted points to
line numbers (`job-runner.js:443:27`, `server.js:1130:15`) that match the OLD pre-fix
code, not the current code. This strongly suggests their Windows install has a stale
copy of `update-server/`.

There is currently no way to tell from the admin UI which build of the update-server
is running. We need a tiny visibility hook so this kind of "is my fix deployed?"
question can be answered in five seconds, not by reading stack traces.

## Done looks like
- The admin panel header shows a small build identifier next to the server version
  (e.g. "update-server build 2026-04-30 7ca8680" or similar — date + short git rev).
- A read-only `/api/admin/version` endpoint returns the same identifier as JSON.
- When the operator says "I'm still seeing the crash", we (or they) can immediately
  read the build stamp and confirm whether they're running the fix or stale code.
- No behavior change to anything else. No new dependencies. No restart-on-deploy
  surprises.

## Out of scope
- Auto-updating the update-server itself (it's a Node process the user starts via
  `start.bat`; remote auto-update of it is a separate, much bigger discussion).
- Any new auth, secrets, or permissions surface — endpoint piggybacks on the
  existing `requireAdmin` middleware.
- Touching the SSE crash fix code from Task #1 (already shipped, already tested).

## Steps
1. **Compute a build identifier at server boot.** On startup, read the package
   version from `package.json`, plus a build timestamp (mtime of `server.js` is
   fine — no git binary required on Windows). Cache the result in memory.
2. **Expose `/api/admin/version`.** Add a tiny GET endpoint behind `requireAdmin`
   that returns `{ version, builtAt, node }`. Mirror the same payload into the
   existing `/api/admin/status` response so the admin UI gets it for free with the
   data it already fetches at boot.
3. **Render the stamp in the admin header.** In the admin UI, show the build stamp
   in muted small text next to the existing server-version pill. Click-to-copy is
   nice-to-have, not required.
4. **Add a one-line note to `update-server/README.md`** explaining how to verify
   the running build matches the source folder on disk (so the user knows the
   build stamp is the source of truth when debugging).
5. **No new tests required.** This is a read-only metadata endpoint. The existing
   admin auth tests (if any) are sufficient. Manually load the admin page in this
   Replit environment after the change to confirm the stamp renders.

## Relevant files
- `walok/update-server/server.js:1063-1116`
- `walok/update-server/package.json`
- `walok/update-server/public/admin/index.html`
- `walok/update-server/public/admin/admin.js:90-145`
- `walok/update-server/README.md`
