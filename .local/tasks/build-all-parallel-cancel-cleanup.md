# Parallel Build All with per-customer cancel

## What & Why
Today, "Build all customers" creates a SINGLE job (label `build-all`,
`channels=[]`) whose runner builds every customer one after another inside one
process. The `MAX_CONCURRENT_BUILDS=2` slot pool only kicks in when the operator
submits multiple INDIVIDUAL builds — `build-all` ignores it entirely. The user
wants:

1. "Build all" should fan out into N independent per-customer jobs and let the
   existing 2-slot pool actually run two of them in parallel, with the rest
   queued.
2. Each running job should show its own live progress (already streamed
   per-job — the admin UI just needs to render multiple at once).
3. Each running OR queued job must be individually cancellable without
   affecting any sibling.
4. When a job is cancelled (or fails after producing partial output), the
   server must clean up that customer's half-finished workspace AND any
   half-published files in `releases/<channel>/<version>/` and
   `update-server/public/updates/<channel>/<version>/` — so storage doesn't
   fill up with orphan releases.

## Done looks like
- Clicking "BUILD ALL CUSTOMERS" with N customers configured submits N
  separate per-customer jobs (one per customer). The queue view shows them all,
  with up to 2 marked "running" and the rest "queued" — verifiable with N >= 3.
- The admin console area shows a live-streaming console for EACH running job
  side-by-side (or as switchable tabs). Each console shows its own steps,
  substeps, and `[cleanup] / [db] / [live-push]` lines.
- Each job card has its own "Cancel" button. Clicking cancel on one job:
  - Stops only that job (sibling running and queued jobs keep going).
  - Removes the cancelled job's workspace under `update-server/data/jobs/<id>`.
  - Deletes the half-published payload under
    `update-server/public/updates/<channel>/<version>/` (only that channel +
    that version, never other versions) and the matching
    `releases/<channel>/<version>/` directory under the project root.
  - Releases the queue slot immediately so the next queued job starts.
- Channel-conflict avoidance still works: if the operator triggers two
  `build-all` runs back-to-back, the second wave's per-channel jobs queue
  behind the first wave's matching channels (existing `jobHasConflict` logic
  is sufficient because per-customer jobs already declare their single
  channel).
- New automated tests in `walok/update-server/test-job-runner.js` cover:
  - Submitting 3 per-channel jobs while `maxConcurrent=2` runs 2, queues 1.
  - Cancelling a running job releases its slot and starts the next queued.
  - Cancelling a queued job removes it without ever creating a workspace.
  - Cancellation cleanup removes the workspace + the half-published version
    dir (mock the filesystem; no real builds).
- Manual end-to-end check on Replit: simulate 3 stub jobs and verify the
  admin UI renders all three consoles and that cancel works on each.

## Out of scope
- Changing `MAX_CONCURRENT_BUILDS` default or making it dynamic per request
  (operator can already set it via env).
- Re-architecting the workspace allocation to share node_modules between jobs
  beyond what `createJobWorkspace` already does (junctions on Windows).
- Touching the SSE crash fix from Task #1 or the OTA apply changes from
  Task #3.
- Building a queue dashboard with reordering/priority — out of scope, just
  render what's there.

## Steps
1. **Fan out "Build all" on the server.** In the admin build endpoint, when
   `all=true`, instead of creating one `build-all` job with all channels,
   loop over `targetChannels` and call `enqueueBuildJob` once per channel
   with that single channel's steps + per-channel `onComplete`. Return the
   list of created job ids to the client. Drop the `channels=[]` build-all
   job kind entirely (or leave it for back-compat but stop using it).
2. **Per-job cleanup-on-cancel.** Extend `cancelJob` (or add an
   `onCancel` hook on the job object) so cancellation triggers a callback
   that: (a) `rm -rf` the job workspace, (b) `rm -rf` the half-published
   `update-server/public/updates/<channel>/<version>/` dir for that job's
   channel + version, (c) `rm -rf` the matching `releases/<channel>/<version>/`
   under `OTA_PROJECT_ROOT`. Guard each step so a missing dir is not an
   error. Never touch any other version directory.
3. **Render multiple live consoles in the admin UI.** Replace the current
   single-stream console with a list/grid of per-job consoles. Each console
   subscribes to its own `/api/admin/jobs/:id/stream`, shows its own status
   pill (queued / running / success / failed / cancelled), step + substep
   header, and a Cancel button. Reuse the existing `streamJob` rendering
   primitive — just instantiate it N times. When a job ends, keep its console
   visible (collapsed) so the operator can still scroll the log.
4. **Per-job Cancel wiring on the queue card.** The existing queue snapshot
   endpoint already returns per-job state; add Cancel buttons to each row that
   call the existing `/api/admin/jobs/:id/cancel`. Only show the button for
   `queued` and `running` jobs. After cancel, optimistically grey out the row
   until the next snapshot confirms the new state.
5. **Tests.** Add the four cases listed in "Done looks like" to
   `walok/update-server/test-job-runner.js`. Use stub steps (`process.execPath`
   running a tiny inline `-e` script) so tests stay fast and platform-
   independent. Mock `fs.rmSync` for the cleanup-on-cancel test and assert it
   was called with the right paths and never with a path outside
   `releases/<channel>/<version>` or
   `public/updates/<channel>/<version>`. Path-traversal safety is non-
   negotiable here — a buggy channel name must NEVER be able to delete
   anything outside its own version dir.
6. **Code review.** After implementation, run an architect review focused on
   (a) parallel safety of the new per-customer fan-out (do two parallel jobs
   share any state via the workspace junction, env vars, or the publish
   pipeline?), and (b) the cleanup path-traversal guards. Both must be signed
   off before merge.

## Relevant files
- `walok/update-server/job-runner.js:218-296,374-460,486-540`
- `walok/update-server/server.js:600-740,1063-1116`
- `walok/update-server/cleanup.js`
- `walok/update-server/public/admin/admin.js:107,306-440,487-520,708`
- `walok/update-server/public/admin/index.html`
- `walok/update-server/test-job-runner.js`
