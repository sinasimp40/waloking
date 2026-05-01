# Fix Build Console Crash On Multi-Customer Builds

## What & Why
Building 2+ customers (or "Build all customers") crashes the OTA update-server with
`ERR_STREAM_WRITE_AFTER_END`, which kills the process and makes the admin panel
show "Failed to load: Failed to fetch". The root cause is a race in the
job-runner / SSE plumbing:

1. When a build job ends, `job.runner` calls `finishJob()` first, which calls
   `emitJobEnd()` and broadcasts `{end:true}` to every SSE listener.
2. The listener in `/api/admin/jobs/:id/stream` reacts to `end:true` by calling
   `res.end()` — but the listener is **never removed from `job.listeners`**.
3. Then `onComplete` runs and calls `jobAppend(job, '[cleanup] …')`,
   `jobAppend(job, '[db] …')`, and `jobAppend(job, '[live-push] …')` for every
   channel. Each `jobAppend` iterates `job.listeners` and calls `res.write` on
   the already-ended response.
4. `res.write` is wrapped in `try/catch`, but the resulting
   `ERR_STREAM_WRITE_AFTER_END` is emitted **asynchronously** as an `'error'`
   event on the `ServerResponse`. There is no `res.on('error')` handler, so
   Node treats it as unhandled and kills the entire update-server process.
5. The frontend's subsequent `/api/admin/customers` fetch then fails with
   "Failed to fetch" because the server is down.

A second, real bug hides behind the crash: even if the server didn't die, the
`[cleanup]`, `[db]`, and `[live-push]` lines never reach the operator's live
build console, because the SSE stream is closed before they are appended. The
operator only sees them by refreshing the page (via the replay buffer).

This fix addresses both: post-build messages stream live, and any future late
write can never crash the process.

## Done looks like
- "Build all customers" with multiple customers completes without crashing the
  update-server. The admin panel keeps working — no "Failed to load: Failed to
  fetch" error appears in the customers card after a build.
- Building two single customers back-to-back (or in parallel under the
  `MAX_CONCURRENT_BUILDS=2` slot model) also completes without crashing.
- The build console shows the post-build lines live during the same SSE
  session that streamed the build itself: the per-channel `[cleanup] …`,
  `[db] …`, and `[live-push] <channel> v<x.y.z> -> N online client(s)`
  messages all appear before the stream closes, in the same order they do
  today on a page refresh.
- The new regression case in `walok/update-server/test-job-runner.js` passes:
  registering an SSE-style listener, finishing a job, and then calling
  `jobAppend` (simulating an `onComplete` write) does not throw and does not
  re-invoke the listener after the end event.
- All existing tests in `test-job-runner.js` still pass.

## Out of scope
- Changing the queue / slot / channel-conflict model in `job-runner.js`.
- Changing how the admin UI renders the build console.
- Touching the `live` SSE module that pushes update notifications to launchers
  (separate code path, separate listener set).
- The unrelated Node deprecation warning `[DEP0190]` about `shell:true` —
  noisy but not a bug, and changing it risks breaking the Windows build chain.

## Steps
1. **Make `onComplete` run before `finishJob` in `job-runner.js`'s build
   runner.** Today the runner calls `finishJob` then `onComplete`, which means
   the SSE stream is already closed by the time the post-build messages are
   appended. Swap the order so `onComplete` runs first (still inside the same
   `try`) and `finishJob` is the last thing the runner does. Keep the existing
   try/catch around `onComplete` so a buggy callback never blocks the job from
   being marked finished. This makes `[cleanup] / [db] / [live-push]` appear
   live in the build console and removes the primary trigger for the
   write-after-end race.

2. **Detach SSE listeners on stream end inside the job stream handler.** In
   the `/api/admin/jobs/:id/stream` route in `server.js`, when the `send`
   helper sees `entry.end`, it should also call the `detach` returned by
   `jobRunner.attachListener` (in addition to `clearInterval(heartbeat)` and
   `res.end()`). Today only the `req.on('close')` handler detaches, which
   fires asynchronously and leaves a window where `jobAppend` can still write
   to the dead response.

3. **Belt-and-braces in the runner: clear all listeners after `emitJobEnd`.**
   In `job-runner.js`'s `emitJobEnd()`, after broadcasting the end payload,
   call `job.listeners.clear()`. This guarantees that any future `jobAppend`
   for this job is a no-op for listeners no matter where it comes from
   (current `onComplete` callback, future code paths, late retries). Combined
   with step 1, this makes the bug structurally impossible.

4. **Defensive: attach an error handler to the SSE response.** In the
   `/api/admin/jobs/:id/stream` route, add `res.on('error', () => {})` right
   after `res.flushHeaders()`. This ensures that if a write-after-end (or any
   other late socket error) ever does occur in the future, it cannot bubble
   up as an unhandled `'error'` event and crash the process. Apply the same
   one-line guard to the other admin SSE routes in `server.js`
   (`/api/admin/jobs/stream` and `/api/admin/online/stream`) for consistency
   — same failure mode, same fix.

5. **Add a regression test in `test-job-runner.js`.** Add a case that:
   enqueues a trivially-short stub job, attaches a fake SSE-style listener
   via `jobRunner.attachListener`, lets the job finish, then calls
   `jobRunner.jobAppend(job, 'late line')` to simulate an `onComplete` write
   that arrives after the end event. The test must assert (a) no exception is
   thrown, (b) the listener is no longer in `job.listeners` after the end
   event, and (c) the late line is still appended to `job.output` (so the
   replay buffer keeps working for late subscribers). This locks the fix in
   place across all three layers (steps 1, 2, 3).

6. **Run the test suite to verify.** Execute
   `node walok/update-server/test-job-runner.js` from the repo root. All
   existing cases plus the new regression case must pass on this Replit
   (Linux) environment. The Windows-specific build chain (start.bat, real
   electron-builder) is out of scope for this test — the runner code paths
   being changed are platform-agnostic and fully covered by the existing
   stub-step tests.

## Relevant files
- `walok/update-server/job-runner.js:185-199`
- `walok/update-server/job-runner.js:266-296`
- `walok/update-server/job-runner.js:374-449`
- `walok/update-server/server.js:684-756`
- `walok/update-server/server.js:1067-1089`
- `walok/update-server/server.js:1109-1138`
- `walok/update-server/server.js:1146-1160`
- `walok/update-server/test-job-runner.js`
