# Replace Build Console With Real-Time Progress Bar

## What & Why
Each running build currently renders a full scrollback log card in the admin panel. The console doesn't auto-clear (the only way to remove finished cards is the manual "CLEAR FINISHED" button), and during a long build there is no at-a-glance answer to "how far along is this build?". The operator has to read the log to figure out which step is running.

The user wants the default view to be a real-time progress bar per running build — something like `[████████░░░░] 64% — Packing server payload` — instead of the verbose console. The full console should still be available (e.g. behind a "Show log" toggle) so operators can debug failures, but the primary affordance becomes the progress bar.

This requires three coordinated pieces:
1. A definition of build "phases" with known relative weights (e.g. install deps 5%, build launcher 35%, build server 35%, pack zips 20%, publish 5%). The OTA server already drives builds as discrete steps via the job runner — those steps are the natural phase boundaries.
2. A structured progress event on the existing per-job SSE stream alongside (or instead of) the current line-by-line log events.
3. A new admin UI card that renders the progress bar, the current phase label, an elapsed-time counter, and a collapsible log section (collapsed by default).

## Done looks like
- Each running build is shown as a single compact card with a labelled progress bar that advances smoothly as the job moves through its phases (no jumps from 0% straight to 100%).
- The current phase name is shown above the bar (e.g. `Packing launcher payload`) and an elapsed-time counter ticks once per second.
- Failed builds turn the bar red and surface the failing phase clearly. Cancelled builds stop the bar at its last position with a muted style.
- The full log is still reachable via a toggle on the card and behaves identically to today (live tail, color-coded lines, scroll-to-bottom).
- Finished cards still respect the existing CLEAR FINISHED button, and they still survive a page refresh as designed in Task #10.
- Visual changes screenshotted and reviewed against the existing dark-on-orange admin aesthetic. Architect signs off.

## Out of scope
- Backend rework of how builds are scheduled or run (Task #2 here is purely additive on the SSE pipe).
- Fixing the "[file missing — rebuild]" correctness bug (separate task).
- Fixing the Build All lag (separate task — but reducing the SSE log line volume in that fix would be a natural complement).

## Steps
1. Define the phase model. List the discrete steps the job runner emits today (in `server.js` `enqueueOneCustomerJob`) and assign each a stable name + weight. Store the model where both `server.js` and the admin UI can see it.
2. Extend the per-job SSE stream to emit a structured `phase` event (`{ phase: 'pack-server', weight: 0.2, startedAt }`) at each step boundary, in addition to the existing per-line log events. Be careful to keep backward compatibility — the existing `loadCustomers()` flow on `done` must still work.
3. Build the new admin card with the bar, phase label, elapsed counter, and collapsible log. Use only CSS (no new framework) to match the existing handwritten style.
4. Test the UI under all 4 build outcomes: success, failure mid-phase, cancellation, and Build All with 2+ concurrent jobs (the cards should sit side by side and update independently).
5. Update `replit.md` with the new event shape and the phase weights.

## Relevant files
- `walok/update-server/server.js:790-900`
- `walok/update-server/server.js:1230-1280`
- `walok/update-server/job-runner.js`
- `walok/update-server/public/admin/admin.js:480-620`
- `walok/update-server/public/admin/admin.css`
- `walok/update-server/public/admin/index.html`
- `replit.md`
