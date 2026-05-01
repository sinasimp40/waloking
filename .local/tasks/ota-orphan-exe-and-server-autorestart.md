# OTA orphan-exe cleanup + server.exe auto-restart

## What & Why
Two related OTA bugs the user reported:

**(a) Black/violet screen with garbled text after a rename OTA.**
When a customer's brand changes (e.g. `BLAST` → `BLASTING`), the new payload adds
`BLASTING.exe` to the install dir but `BLAST.exe` is still there too (see the
user's screenshot). The current cleanup-marker mechanism in
`walok/electron/updater.js` only deletes the old exe **if the manifest declares
`exeName` AND the new exe successfully takes over via `STATE.nextExePath`**. If
either of those conditions misses (legacy manifest, locked file, user double-
clicks the old shortcut), the old `BLAST.exe` survives and shows the garbled
"black/violet" screen because the OLD binary loads the NEW `app.asar`.

**(b) `server.exe` OTA stays "pending" forever.**
The user confirmed `server.exe` auto-starts on their machine. The OTA download
+ stage works — the new payload sits in `.ota-pending/` — but nothing ever
restarts the running `server.exe`, so it never applies. There is already a
`/api/internal/quit-for-update` endpoint and `gracefulQuitForUpdate()` function
in `walok/server/electron/`, but **nothing ever calls them.** The user wants
the server to behave exactly like the launcher: when an update is staged,
auto-quit, get auto-restarted by the OS, and the new instance applies the
pending payload on boot.

## Done looks like
- After a rename OTA:
  - The old `.exe` is deleted on the next launch (existing behavior, kept).
  - **NEW:** Orphan-exe scan also removes any other `.exe` in the install dir
    that isn't the currently-running one and isn't part of the just-extracted
    payload. No more "two .exes side by side".
  - **NEW:** If the user double-clicks an orphan old `.exe` BEFORE the
    cleanup sweep runs, the old binary detects the version mismatch (its baked
    `ota-config.json` version is older than the on-disk `app.asar`'s manifest)
    and refuses to load the renderer; instead it spawns the correct new exe and
    exits cleanly. No more black/violet screen, ever.
- After a server-side OTA:
  - `server.exe` finishes downloading + staging, then auto-quits within a few
    seconds via the existing `gracefulQuitForUpdate` path.
  - The OS-level auto-start mechanism the user already has brings it back.
  - The new `server.exe` instance applies the pending payload on init and the
    admin "online" view shows the new server version live, no manual stop
    required.
- Both behaviors are guarded by automated tests in
  `walok/electron/__tests__/` (or equivalent test scaffolding for the updater
  modules) that don't require a real Electron runtime.
- Manual smoke check on Replit (Linux): the updater logic that doesn't depend on
  Electron APIs (zip extract, marker write/sweep, orphan scan, version-mismatch
  detection) runs green via plain `node` test files.

## Out of scope
- Changing how `server.exe` is auto-started on the user's Windows machine
  (assume their existing OS-level mechanism keeps working — confirmed by user).
- Replacing the custom zip extractor with a library — keep the zero-deps approach.
- Update-server-side changes (those are Tasks #2 and #4).
- Re-flowing the launcher↔server install layout (single-folder install stays).

## Steps
1. **Orphan-exe scan inside `applyPendingUpdateOnStartup`.** After successful
   extraction, walk the install dir for `*.exe` files. Anything that's not the
   currently-running exe AND wasn't an entry in the just-extracted payload gets
   added to the existing cleanup marker. The next launch's `sweepCleanupMarker`
   already knows how to delete those safely. Do this in BOTH `walok/electron/`
   and `walok/server/electron/` updaters (same code pattern).
2. **Old-exe self-defense ("never run a stale binary").** At `init()` time in
   each updater, before any window/listen call: read the on-disk
   `ota-config.json` version (or the staged manifest if `.ota-pending` is gone
   but a new exe sits next to us) and compare to the bundled exe version. If the
   currently-running binary is older than what the install dir advertises,
   discover the new exe via the existing `discoverNewExe` helper, spawn it
   detached, and exit. This makes the black/violet screen physically impossible.
3. **Auto-quit `server.exe` after staging an OTA.** In
   `walok/server/electron/updater.js`'s `downloadAndApply` success path, after
   the `READY` marker is written, call `gracefulQuitForUpdate('post-stage
   auto-restart')`. Add a small (5-10 second) delay so any in-flight HTTP
   responses can flush. Reuse the existing function — do not duplicate the quit
   logic.
4. **Belt-and-braces relauncher (Windows-only).** Just before the graceful quit
   in step 3, write a tiny detached `cmd.exe` helper that waits ~5 seconds and
   re-launches `server.exe`. This is a fallback for the rare case where the OS
   auto-start mechanism fails or is misconfigured — it costs nothing and
   guarantees the server comes back. No-op on non-Windows.
5. **Tests.** Add unit tests covering: (a) orphan scan correctly identifies
   extra `.exe` files, (b) marker is written with the right list, (c) sweep
   skips the running exe, (d) version-mismatch self-defense triggers spawn-and-
   exit path. Mock `fs` / `spawn` / `app` so the tests run on Linux without
   Electron. Wire them into a runnable `node walok/electron/test-updater.js`
   entrypoint matching the style of the existing
   `walok/update-server/test-job-runner.js`.
6. **Code review.** After implementation, run an architect review focused on
   "could the self-defense step ever spawn the wrong exe?" and "could the
   auto-quit ever fire while a real client is mid-request?" — both are user-
   visible failure modes that must be ruled out before merge.

## Relevant files
- `walok/electron/updater.js:223-292,416-580,602-661`
- `walok/server/electron/updater.js:219-304,446-603,625-676,739-753`
- `walok/server/electron/api.js:67-92`
- `walok/electron/main.js`
- `walok/scripts/publish-update.js:25-148`
