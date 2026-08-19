// Cross-process install lock for the OTA build pre-flight.
//
// Prevents two ota-update-server processes against the same
// PROJECT_ROOT from running `npm install` concurrently against the
// shared node_modules (npm is not concurrency-safe on a shared install
// target).
//
// Mechanism:  fs.openSync(path, 'wx') is atomic create-or-fail at the
//             OS level (POSIX O_EXCL, Windows CREATE_NEW). The lockfile
//             carries a 16-byte ownership token so release() can verify
//             we still own the lock before unlinking — this closes the
//             stale-reclaim race where a slow holder's late release
//             would otherwise delete a successor's freshly-acquired
//             lockfile.
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const LOCK_FILENAME = '.ota-install.lock'

// Atomics.wait-based synchronous sleep (no hot-spin).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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
// Options:
//   maxWaitMs     — give up after this long (default 120000 = 2 min).
//   staleAfterMs  — reclaim lockfile if mtime older than this
//                   (default 1800000 = 30 min). Set 0 to disable.
//   pollMs        — wait between EEXIST retries (default 250).
//
// Returns: { release, touch, lockPath, acquiredAt }.
//   release() is idempotent + token-strict (only unlinks on owner match).
//   touch()   refreshes mtime so long-running holders are not reclaimed.
//
// Throws:
//   EINSTALLLOCKED      — couldn't acquire within maxWaitMs (err.owner
//                         carries the previous holder's metadata).
//   EINSTALLLOCKWRITE   — created the lockfile but couldn't write the
//                         ownership token (file is unlinked first).
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
      fd = fs.openSync(lockPath, 'wx')
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let mtimeMs = null
      try { mtimeMs = fs.statSync(lockPath).mtimeMs }
      catch (e2) {
        if (e2.code === 'ENOENT') continue // released between open+stat — retry
        throw e2
      }
      if (staleAfterMs > 0 && (Date.now() - mtimeMs) > staleAfterMs) {
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

    // Token must be durably present before we return — otherwise a
    // tokenless lockfile could trick a token-strict release elsewhere.
    const ownerToken = crypto.randomBytes(16).toString('hex')
    const meta = JSON.stringify({
      token: ownerToken,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
    })
    try {
      fs.writeSync(fd, meta)
      try { fs.fsyncSync(fd) } catch (e) { /* fsync best-effort */ }
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
      // Refresh mtime so long-running holders aren't reclaimed as stale.
      // Returns false if we no longer own the lock (foreign reclaim).
      touch() {
        if (released) return false
        let parsed
        try { parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) }
        catch (e) { return false }
        if (!parsed || parsed.token !== ownerToken) return false
        const now = Date.now() / 1000
        try { fs.utimesSync(lockPath, now, now); return true }
        catch (e) { return false }
      },
      // Strict: only unlink when the on-disk token matches ours. Any
      // other state (ENOENT, empty/partial mid-acquire by a successor,
      // foreign or corrupted token) is a no-op so we cannot delete
      // someone else's lock. Stale-mtime recovery handles any leak.
      release() {
        if (released) return
        released = true
        let current
        try { current = fs.readFileSync(lockPath, 'utf-8') }
        catch (e) { return }
        let parsed
        try { parsed = JSON.parse(current) } catch (e) { return }
        if (!parsed || parsed.token !== ownerToken) return
        tryUnlink(lockPath)
      },
    }
  }
}

// Same contract as acquireInstallLock(), but the EEXIST wait is non-blocking
// (setTimeout-based) so the Node event loop stays free to service other
// requests + SSE flushes while we are blocked on a sibling holder.
//
// CRITICAL for /api/admin/build: the sync flavor uses Atomics.wait, which
// freezes the entire OTA server (admin UI, build SSE streams, every other
// HTTP handler) for the duration of the wait. During a Build All against a
// fresh tree that wait can be 10s+ — long enough for operators to think the
// admin site has hung. The async flavor below polls via setTimeout and
// awaits, so the event loop stays responsive.
async function acquireInstallLockAsync(projectRoot, opts) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('acquireInstallLockAsync: projectRoot is required')
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
      fd = fs.openSync(lockPath, 'wx')
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let mtimeMs = null
      try { mtimeMs = fs.statSync(lockPath).mtimeMs }
      catch (e2) {
        if (e2.code === 'ENOENT') continue
        throw e2
      }
      if (staleAfterMs > 0 && (Date.now() - mtimeMs) > staleAfterMs) {
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
      // Non-blocking wait — yields the event loop to other handlers.
      await new Promise(r => setTimeout(r, pollMs))
      continue
    }

    // Token write is fast (single small file); keep it sync so we never
    // return a half-initialized lock.
    const ownerToken = crypto.randomBytes(16).toString('hex')
    const meta = JSON.stringify({
      token: ownerToken,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
    })
    try {
      fs.writeSync(fd, meta)
      try { fs.fsyncSync(fd) } catch (e) { /* fsync best-effort */ }
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
      touch() {
        if (released) return false
        let parsed
        try { parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) }
        catch (e) { return false }
        if (!parsed || parsed.token !== ownerToken) return false
        const now = Date.now() / 1000
        try { fs.utimesSync(lockPath, now, now); return true }
        catch (e) { return false }
      },
      release() {
        if (released) return
        released = true
        let current
        try { current = fs.readFileSync(lockPath, 'utf-8') }
        catch (e) { return }
        let parsed
        try { parsed = JSON.parse(current) } catch (e) { return }
        if (!parsed || parsed.token !== ownerToken) return
        tryUnlink(lockPath)
      },
    }
  }
}

module.exports = { acquireInstallLock, acquireInstallLockAsync, LOCK_FILENAME, _sleepSync: sleepSync }
