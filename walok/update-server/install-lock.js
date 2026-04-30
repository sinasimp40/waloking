// Cross-process install lock for the OTA build pre-flight.
//
// Why this exists:
//   /api/admin/build runs `npm install` against PROJECT_ROOT/node_modules
//   before fanning out per-customer build jobs. Inside one Node process
//   that path is already serialised (synchronous spawnSync inside the
//   request handler), but if an operator runs TWO ota-update-server
//   instances against the same PROJECT_ROOT (primary + hot-spare during
//   maintenance, or accidentally during a deploy), both could try to
//   `npm install` the SAME node_modules at the SAME time. npm is not
//   concurrency-safe on a shared install target — you get sporadic
//   EEXIST / ENOENT / partial-write failures and a corrupted tree.
//
// Mechanism:
//   `fs.openSync(<lock>, 'wx')` is atomic create-or-fail at the OS
//   syscall level on every supported platform (POSIX O_EXCL, Windows
//   FILE_FLAG_OVERLAPPED+CREATE_NEW). One process wins; every other
//   gets EEXIST and either waits, reclaims a stale lock, or times out.
//
//   The lockfile contains JSON {pid,host,acquiredAt} purely for
//   forensic logging — diagnostic only, never trusted for correctness.
//
// Stale-lock recovery:
//   If the holder crashed without releasing (kill -9, OOM, power
//   cut), the file lingers forever. We fall back to mtime: if the
//   lockfile is older than `staleAfterMs` we forcibly unlink and
//   retry. A real `npm install` for this project completes in seconds
//   to a couple of minutes worst-case, so the default 10-minute
//   threshold is far above any legitimate hold time and far below the
//   gap that would cause an operator to wait painfully long after a
//   crash.
//
// Sleep:
//   The /api/admin/build request handler is already synchronous (it
//   uses spawnSync), so we use Atomics.wait on a SharedArrayBuffer to
//   sleep without a hot CPU spin.
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const LOCK_FILENAME = '.ota-install.lock'

// Atomics.wait-based synchronous sleep that does NOT hot-spin the CPU.
// Returns when ms have elapsed (or sooner if a signal interrupts the
// underlying futex wait — caller treats as a no-op early wake).
function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4)
  const view = new Int32Array(buf)
  Atomics.wait(view, 0, 0, ms)
}

function readLockMeta(lockPath) {
  try { return fs.readFileSync(lockPath, 'utf-8').slice(0, 500) }
  catch (e) { return '' }
}

function tryUnlink(lockPath) {
  try { fs.unlinkSync(lockPath); return true }
  catch (e) { return false }
}

// Acquire a cross-process install lock at <projectRoot>/.ota-install.lock.
//
// Options (all optional):
//   maxWaitMs     — give up after this long (default 120000 = 2 min).
//   staleAfterMs  — treat lockfile as stale if mtime older than this
//                   (default 1800000 = 30 min, comfortably above any
//                   realistic npm-install duration on this project).
//                   Set to 0 to disable stale reclaim entirely.
//   pollMs        — wait between EEXIST retries (default 250).
//
// Returns: { release(): void, touch(): void, lockPath: string, acquiredAt: number }.
//   release() is idempotent — safe to call from a finally even if the
//   lock was already released or the file disappeared from underneath.
//   touch() refreshes the lockfile mtime so a long-running holder is
//   not mistaken for a stale crash. The release() path also writes
//   our token, so an "old A's late release" can never delete a newer
//   B's reclaimed lock — see the inline notes below.
//
// Throws on:
//   - EINSTALLLOCKED  — couldn't acquire within maxWaitMs (err.owner
//                       carries the previous holder's metadata).
//   - any other fs error (caller decides — usually 503 the request).
function acquireInstallLock(projectRoot, opts) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('acquireInstallLock: projectRoot is required')
  }
  const o = opts || {}
  const maxWaitMs = Number.isFinite(o.maxWaitMs) ? o.maxWaitMs : 120000
  const staleAfterMs = Number.isFinite(o.staleAfterMs) ? o.staleAfterMs : 1800000
  const pollMs = Number.isFinite(o.pollMs) ? o.pollMs : 250
  const lockPath = path.join(projectRoot, LOCK_FILENAME)

  const start = Date.now()
  while (true) {
    let fd
    try {
      // Atomic create-or-fail. 'wx' = O_WRONLY|O_CREAT|O_EXCL on POSIX,
      // CREATE_NEW on Windows — both fail with EEXIST if the file is
      // already present. This is the only step that needs to be atomic;
      // everything else (writing metadata, releasing) is best-effort.
      fd = fs.openSync(lockPath, 'wx')
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // Lock is held. Decide whether to wait, reclaim as stale, or fail.
      let mtimeMs = null
      try { mtimeMs = fs.statSync(lockPath).mtimeMs }
      catch (e2) {
        if (e2.code === 'ENOENT') {
          // Holder released between our open() and stat() — race, retry now.
          continue
        }
        throw e2
      }
      const heldForMs = Date.now() - mtimeMs
      if (staleAfterMs > 0 && heldForMs > staleAfterMs) {
        // Stale. Reclaim.
        tryUnlink(lockPath)
        continue
      }
      if (Date.now() - start >= maxWaitMs) {
        const err = new Error('install lock at ' + lockPath + ' held by another process; gave up after ' + maxWaitMs + 'ms')
        err.code = 'EINSTALLLOCKED'
        err.owner = readLockMeta(lockPath)
        err.lockPath = lockPath
        throw err
      }
      sleepSync(pollMs)
      continue
    }

    // Got the lock. Mint a unique ownership token and write it into
    // the lockfile alongside diagnostic metadata. The token is what
    // makes release() safe under stale-reclaim:
    //
    //   Without a token, this race is possible:
    //     1. holder A acquires the lock (e.g. very slow npm install)
    //     2. A's install runs longer than staleAfterMs
    //     3. holder B sees the lockfile as stale, unlinks it, acquires
    //        a fresh lock — now B is the legitimate owner
    //     4. A's install finally completes and calls A.release(),
    //        which unconditionally unlinks the lockfile → B's valid
    //        lock is silently deleted, opening the door to a third
    //        concurrent install
    //
    //   With a token, A's release() reads the lockfile, sees B's
    //   token (or, mid-stale-reclaim, sees an empty/partial file
    //   because B has openSync'd but not yet written its token) and
    //   refuses to unlink. The race is closed: ONLY the explicit
    //   ownerToken match permits unlink — anything else (empty,
    //   corrupted, foreign token, ENOENT) is a no-op.
    //
    // Token must be DURABLY present in the file before this function
    // returns. If we can't write+sync the token, fail the acquire and
    // unlink our half-written lockfile so the next caller can try.
    // (Without this, a writeSync failure would leave a tokenless
    // lockfile that could later be misclassified by a token-strict
    // release() on a different process.)
    const ownerToken = crypto.randomBytes(16).toString('hex')
    const meta = JSON.stringify({
      token: ownerToken,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
    })
    try {
      fs.writeSync(fd, meta)
      try { fs.fsyncSync(fd) } catch (e) { /* fsync is best-effort across FS */ }
      fs.closeSync(fd)
    } catch (writeErr) {
      try { fs.closeSync(fd) } catch (e) { /* ignore */ }
      tryUnlink(lockPath)
      const err = new Error('failed to write install-lock token: ' + writeErr.message)
      err.code = 'EINSTALLLOCKWRITE'
      throw err
    }

    let released = false
    return {
      lockPath,
      acquiredAt: Date.now(),
      // Refresh the lockfile mtime so a long-running holder is not
      // mistaken for a stale crash by another process. Best-effort —
      // if the file has been forcibly reclaimed (token mismatch) we
      // intentionally do NOT touch it (would clobber the new owner's
      // mtime). Returns true if our mtime was refreshed, false if we
      // no longer own the lock.
      touch() {
        if (released) return false
        let current = null
        try { current = fs.readFileSync(lockPath, 'utf-8') }
        catch (e) { return false }
        let parsed = null
        try { parsed = JSON.parse(current) } catch (e) { return false }
        if (!parsed || parsed.token !== ownerToken) return false
        const now = Date.now() / 1000
        try { fs.utimesSync(lockPath, now, now); return true }
        catch (e) { return false }
      },
      release() {
        if (released) return
        released = true
        // STRICT token-checked unlink. The ONLY case in which we
        // unlink is when the on-disk lockfile contains our exact
        // ownerToken. Every other case is a no-op:
        //
        //   - ENOENT     → lockfile already gone (force-reclaimed
        //                  earlier as stale by another process); we
        //                  do not own it any more.
        //   - empty/partial read → another process is in the
        //                  microscopic window between openSync('wx')
        //                  and writeSync(token). They are the new
        //                  owner. Deleting the file would re-open the
        //                  full mutual-exclusion race the task exists
        //                  to close. Refuse to unlink.
        //   - JSON parse fail / missing token / token mismatch →
        //                  some other process owns this file (or the
        //                  metadata is corrupted). Not ours to delete.
        //                  Stale recovery (mtime > staleAfterMs in a
        //                  later acquire()) will eventually reclaim
        //                  any genuinely abandoned tokenless file.
        //
        // The cost of this strictness is a possible lockfile leak in
        // the rare write-failure path. That's acceptable: the next
        // acquire() will reclaim it via the stale-mtime path. The
        // benefit is that mutual exclusion is preserved even under
        // the open-before-write reclaim race.
        let current
        try { current = fs.readFileSync(lockPath, 'utf-8') }
        catch (e) { return /* ENOENT or unreadable — not ours */ }
        let parsed
        try { parsed = JSON.parse(current) } catch (e) { return /* not ours */ }
        if (!parsed || parsed.token !== ownerToken) return
        tryUnlink(lockPath)
      },
    }
  }
}

module.exports = { acquireInstallLock, LOCK_FILENAME, _sleepSync: sleepSync }
