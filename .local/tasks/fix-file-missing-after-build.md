# Fix "[file missing — rebuild]" After Successful Build

## What & Why
After a successful Build (single OR Build All), the customer card in the admin panel shows the version number followed by `[file missing — rebuild]` next to BOTH the launcher and server lines, AND `Last release: ---` — even though the build console clearly logged `=== SUCCESS (exit 0) ===` and `publish-update.js` printed `Launcher OK` / `Server OK`. The download link is therefore hidden and operators are tricked into rebuilding even though the payload is on disk.

The screenshot the user attached (`attached_assets/image_1777544853666.png`) shows both BLAST (channel 2) and DENFI (channel 1) in this state right after a Build All. The build queue is empty and both job consoles report SUCCESS.

This is a real correctness bug, not a UI-refresh issue: `loadCustomers()` is already called when the job-stream EventSource sees a `done` event (`public/admin/admin.js:563`), so the customer list IS re-fetched once the build finishes. The state on screen reflects what the server returned. So either:
1. The post-build DB write (`recordLauncherPublished` / `recordServerPublished`) didn't run or didn't persist (would also explain `Last release: ---`).
2. The file existence check on the server side (`server.js:579-584`) is looking at a different path than where `publish-update.js` actually wrote the payload (most likely a cleanup-vs-publish ordering bug, or path-derivation drift between the two files).
3. `cleanupAfterBuild` is deleting the just-published payload before `recordLauncherPublished` runs.

## Done looks like
- After a clean single-customer build, the customer card shows the new version with a working `[download]` link, and `Last release:` shows a timestamp.
- After a Build All across N customers, EVERY customer card shows the same — no `[file missing — rebuild]` on any of them, no `Last release: ---`.
- A new automated regression test exercises the `/api/admin/build` flow end-to-end (build → publish → DB write → customers endpoint) and asserts that the returned customer object has `_launcherFileExists: true`, `_serverFileExists: true`, and a non-null `launcherPublishedAt` / `serverPublishedAt`.
- All existing tests in `walok/update-server` (`npm test`) still pass.
- `replit.md` updated with a one-line note describing the root cause and the fix.

## Out of scope
- The Build All terminal/UI lag (separate task).
- Replacing the build console with a progress bar (separate task).
- Any changes to the launcher's update-consumption code on the customer side.

## Steps
1. Reproduce the bug in Replit by adding two test customers and running Build All against the OTA server. Capture the exact state of `walok/update-server/public/updates/<channel>/` and `<channel>-server/` on disk, the DB row for each customer, and the JSON returned by `/api/admin/customers`. This pins down which of the three hypotheses is correct.
2. Fix the root cause. Likely candidates: re-order so DB write happens before cleanup; tighten cleanup so it never removes the version it was just told was the new one; or correct the path derivation in the file-existence check. Whatever the fix, it must work for both the `/api/admin/build` path and the `/api/admin/upload` path (both call `cleanupAfterBuild` then `recordLauncherPublished`/`recordServerPublished` — server.js:811-839 and 1186-1209).
3. Add a regression test under `walok/update-server/` that drives the full flow and asserts the customer endpoint reports the file as present. Wire it into the existing `npm test` chain.
4. Run `npm test` to confirm everything still passes. Manually verify in the running OTA workflow that the bug is gone.
5. Have the architect review the diff before marking complete.

## Relevant files
- `walok/update-server/server.js:551-606`
- `walok/update-server/server.js:790-899`
- `walok/update-server/server.js:1170-1217`
- `walok/update-server/cleanup.js`
- `walok/update-server/db.js`
- `walok/scripts/publish-update.js:124-227`
- `walok/update-server/public/admin/admin.js:540-574`
- `walok/update-server/test-build-endpoint.js`
- `walok/update-server/test-cleanup.js`
- `replit.md`
