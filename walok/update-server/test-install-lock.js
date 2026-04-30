#!/usr/bin/env node
// Tests for install-lock.js — the cross-process filesystem lock that
// guards the npm-install pre-flight in /api/admin/build (Task #7).
//
// Acceptance criteria covered:
//   1. Atomicity:  two parallel acquire() calls in separate processes —
//      exactly one wins immediately; the other waits and then acquires
//      after the winner releases.
//   2. Stale recovery: a lockfile whose mtime is older than staleAfterMs
//      is reclaimed (forcibly unlinked) by the next acquire().
//   3. Crash safety: if the critical section throws, the finally-release
//      pattern still removes the lockfile (verified by simulating a
//      throw inside a try/finally that releases).
//   4. Timeout: when a holder never releases and the lock isn't stale,
//      acquire fails with EINSTALLLOCKED carrying the previous owner
//      metadata for forensics.
//   5. Idempotent release: calling release() twice (typical of nested
//      try/finally guards) does not throw.
//
// Run from repo root:   node update-server/test-install-lock.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { spawn } = require('child_process')

const { acquireInstallLock, LOCK_FILENAME } = require('./install-lock')

let failed = 0
function ok(name) { console.log('  PASS  ' + name) }
function fail(name, err) { failed++; console.log('  FAIL  ' + name + ' :: ' + (err && err.stack ? err.stack : err)) }

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'install-lock-test-'))
}

console.log('=== install-lock.js tests ===')

// --- Test 1: basic acquire + release round-trip ---
;(function test_basic() {
  const root = makeTempRoot()
  const lockPath = path.join(root, LOCK_FILENAME)
  try {
    assert.strictEqual(fs.existsSync(lockPath), false, 'no lockfile pre-acquire')
    const lock = acquireInstallLock(root, { maxWaitMs: 1000 })
    assert.strictEqual(fs.existsSync(lockPath), true, 'lockfile present after acquire')
    const meta = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
    assert.strictEqual(meta.pid, process.pid, 'metadata has our pid')
    assert.ok(meta.host, 'metadata has hostname')
    assert.ok(meta.acquiredAt, 'metadata has acquiredAt timestamp')
    lock.release()
    assert.strictEqual(fs.existsSync(lockPath), false, 'lockfile gone after release')
    ok('basic: acquire writes metadata, release removes lockfile')
  } catch (e) { fail('basic', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// --- Test 2: idempotent release ---
;(function test_idempotent_release() {
  const root = makeTempRoot()
  try {
    const lock = acquireInstallLock(root)
    lock.release()
    lock.release() // must not throw
    lock.release() // still must not throw
    ok('release(): idempotent (safe to call multiple times in finally chains)')
  } catch (e) { fail('idempotent release', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// --- Test 3: timeout when lock never released ---
;(function test_timeout() {
  const root = makeTempRoot()
  try {
    const holder = acquireInstallLock(root)
    const t0 = Date.now()
    let caught = null
    try {
      acquireInstallLock(root, { maxWaitMs: 400, pollMs: 50, staleAfterMs: 0 })
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - t0
    assert.ok(caught, 'second acquire threw')
    assert.strictEqual(caught.code, 'EINSTALLLOCKED', 'error code is EINSTALLLOCKED')
    assert.ok(caught.owner && caught.owner.includes(String(process.pid)), 'owner metadata identifies the holder')
    assert.ok(elapsed >= 400 && elapsed < 1500, 'waited at least maxWaitMs (' + elapsed + 'ms)')
    holder.release()
    ok('timeout: throws EINSTALLLOCKED with owner metadata after maxWaitMs')
  } catch (e) { fail('timeout', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// --- Test 4: stale-lock reclaim ---
;(function test_stale_reclaim() {
  const root = makeTempRoot()
  try {
    // Create a "leftover" lockfile by hand (simulating a holder that
    // crashed without releasing) and backdate its mtime far enough that
    // staleAfterMs treats it as abandoned.
    const lockPath = path.join(root, LOCK_FILENAME)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, host: 'ghost', acquiredAt: 'long ago' }))
    const old = (Date.now() - 60 * 60 * 1000) / 1000 // 1 hour ago, in seconds
    fs.utimesSync(lockPath, old, old)

    const lock = acquireInstallLock(root, { maxWaitMs: 500, staleAfterMs: 1000, pollMs: 50 })
    // The reclaim path unlinks the stale file then atomically opens our
    // own — so the file should now contain OUR metadata, not the ghost's.
    const meta = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
    assert.strictEqual(meta.pid, process.pid, 'reclaimed lock now holds our pid')
    assert.notStrictEqual(meta.host, 'ghost', 'ghost metadata replaced')
    lock.release()
    ok('stale-lock: reclaimed when mtime older than staleAfterMs')
  } catch (e) { fail('stale-lock reclaim', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// --- Test 5: finally-release on simulated crash ---
;(function test_crash_safety() {
  const root = makeTempRoot()
  try {
    const lock = acquireInstallLock(root)
    let threw = false
    try {
      try {
        throw new Error('simulated install crash')
      } finally {
        lock.release()
      }
    } catch (e) { threw = true }
    assert.strictEqual(threw, true, 'caller observed the simulated crash')
    assert.strictEqual(fs.existsSync(path.join(root, LOCK_FILENAME)), false, 'lockfile cleaned up by finally')
    // And a follow-up acquire works immediately (no contention).
    const next = acquireInstallLock(root, { maxWaitMs: 500 })
    next.release()
    ok('crash-safety: finally-release leaves the lock acquirable for the next caller')
  } catch (e) { fail('crash-safety', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// --- Test 6: stale-reclaim release safety (the architect-flagged
// edge case). If holder A's install runs longer than staleAfterMs,
// holder B will reclaim the stale lockfile and acquire a fresh lock.
// When A finally calls release(), it MUST NOT delete B's lock — the
// token-ownership check protects against that. ---
;(function test_release_after_stale_reclaim() {
  const root = makeTempRoot()
  const lockPath = path.join(root, LOCK_FILENAME)
  try {
    // Simulate "A is a slow holder": acquire normally, then backdate
    // the lockfile mtime so a follow-up acquire treats it as stale.
    const lockA = acquireInstallLock(root)
    const long = (Date.now() - 60 * 60 * 1000) / 1000 // 1h ago
    fs.utimesSync(lockPath, long, long)

    // Holder B comes along, sees stale, reclaims. Now B owns a FRESH
    // lockfile with B's token.
    const lockB = acquireInstallLock(root, { staleAfterMs: 1000, maxWaitMs: 500, pollMs: 25 })
    const bMeta = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
    assert.ok(bMeta.token, 'B has a token')

    // A's install eventually completes and A.release() runs. Without
    // token check, this would unlink B's lockfile — corrupting the
    // mutual-exclusion invariant. With token check, A sees the token
    // mismatch and refuses.
    lockA.release()
    assert.strictEqual(fs.existsSync(lockPath), true, "A.release() must NOT delete B's lockfile")
    const stillB = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
    assert.strictEqual(stillB.token, bMeta.token, "B's token still in the lockfile after A's late release()")

    // B can release normally.
    lockB.release()
    assert.strictEqual(fs.existsSync(lockPath), false, 'B can release its own lock')
    ok('release-after-stale-reclaim: token check prevents A from deleting B\'s lock')
  } catch (e) { fail('release-after-stale-reclaim', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// --- Test 7: cross-PROCESS contention (the actual scenario the lock
// exists for: two OTA server instances racing). Spawns two short Node
// child processes that BOTH try to acquire and hold for ~400ms. One
// wins immediately; the other waits then acquires after the first
// releases. Verifies their hold-windows DO NOT overlap. ---
;(function test_cross_process() {
  const root = makeTempRoot()
  const lockPath = path.join(root, LOCK_FILENAME)
  // Write the helper into OS tmpdir (NOT the repo) so a crashed test
  // run can never leave _install-lock-child.js sitting next to the
  // production sources.
  const childScript = path.join(root, '_install-lock-child.js')
  // Tiny child program emitting JSON markers we can timestamp + match.
  // The hold-window uses Atomics.wait (cross-platform sync sleep) rather
  // than the `sleep` shell command — the production operator runs this
  // on Windows where `sleep` doesn't exist in cmd.exe / PowerShell.
  fs.writeFileSync(childScript, `
    const { acquireInstallLock } = require(${JSON.stringify(path.join(__dirname, 'install-lock.js'))})
    const root = process.argv[2]
    const id = process.argv[3]
    const holdMs = parseInt(process.argv[4], 10)
    function emit(ev) { process.stdout.write(JSON.stringify({ id, ev, t: Date.now() }) + '\\n') }
    function sleepSync(ms) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    }
    emit('start')
    const lock = acquireInstallLock(root, { maxWaitMs: 30000, pollMs: 25 })
    emit('acquired')
    sleepSync(holdMs)
    emit('releasing')
    lock.release()
    emit('done')
  `)

  function spawnChild(id, holdMs) {
    return new Promise((resolve, reject) => {
      const ch = spawn(process.execPath, [childScript, root, id, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      ch.stdout.on('data', d => { out += d })
      let err = ''
      ch.stderr.on('data', d => { err += d })
      ch.on('exit', (code) => {
        if (code !== 0) return reject(new Error('child ' + id + ' exit ' + code + ' stderr=' + err))
        const events = out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
        resolve(events)
      })
    })
  }

  Promise.all([spawnChild('A', 400), spawnChild('B', 400)]).then((results) => {
    try {
      const allEvents = results.flat().sort((a, b) => a.t - b.t)
      const intervals = []
      for (const id of ['A', 'B']) {
        const ev = results.find(r => r[0].id === id)
        const acq = ev.find(x => x.ev === 'acquired')
        const rel = ev.find(x => x.ev === 'releasing')
        assert.ok(acq && rel, 'child ' + id + ' acquired and released')
        intervals.push({ id, start: acq.t, end: rel.t })
      }
      intervals.sort((a, b) => a.start - b.start)
      const [first, second] = intervals
      // The crucial invariant: second child must have acquired AFTER the
      // first child released. Allow a tiny 50ms grace for clock granularity.
      assert.ok(
        second.start >= first.end - 50,
        'no overlap: A=[' + first.start + '..' + first.end + '] B=[' + second.start + '..' + second.end + ']',
      )
      assert.strictEqual(fs.existsSync(lockPath), false, 'lockfile cleaned after both children done')
      ok('cross-process: two child processes serialise on the same lockfile (no overlap)')
    } catch (e) { fail('cross-process', e) }
    fs.rmSync(root, { recursive: true, force: true })
    finalize()
  }).catch((e) => {
    fail('cross-process', e)
    fs.rmSync(root, { recursive: true, force: true })
    finalize()
  })
})()

function finalize() {
  if (failed > 0) {
    console.log('=== ' + failed + ' TEST(S) FAILED ===')
    process.exit(1)
  } else {
    console.log('=== ALL TESTS PASSED ===')
    process.exit(0)
  }
}
