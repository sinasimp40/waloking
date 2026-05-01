#!/usr/bin/env node
// Tests for install-lock.js — the cross-process filesystem lock that
// guards the npm-install pre-flight in /api/admin/build (Task #7).
//
// Run from repo root:  node update-server/test-install-lock.js

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

// 1. Basic acquire writes metadata; release removes lockfile.
;(function test_basic() {
  const root = makeTempRoot()
  const lockPath = path.join(root, LOCK_FILENAME)
  try {
    assert.strictEqual(fs.existsSync(lockPath), false)
    const lock = acquireInstallLock(root, { maxWaitMs: 1000 })
    assert.strictEqual(fs.existsSync(lockPath), true)
    const meta = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
    assert.strictEqual(meta.pid, process.pid)
    assert.ok(meta.token && meta.host && meta.acquiredAt)
    lock.release()
    assert.strictEqual(fs.existsSync(lockPath), false)
    ok('basic: acquire writes metadata, release removes lockfile')
  } catch (e) { fail('basic', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// 2. release() is idempotent.
;(function test_idempotent_release() {
  const root = makeTempRoot()
  try {
    const lock = acquireInstallLock(root)
    lock.release()
    lock.release()
    lock.release()
    ok('release(): idempotent')
  } catch (e) { fail('idempotent release', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// 3. Timeout when lock never released.
;(function test_timeout() {
  const root = makeTempRoot()
  try {
    const holder = acquireInstallLock(root)
    const t0 = Date.now()
    let caught = null
    try {
      acquireInstallLock(root, { maxWaitMs: 400, pollMs: 50, staleAfterMs: 0 })
    } catch (e) { caught = e }
    const elapsed = Date.now() - t0
    assert.ok(caught)
    assert.strictEqual(caught.code, 'EINSTALLLOCKED')
    assert.ok(caught.owner && caught.owner.includes(String(process.pid)))
    assert.ok(elapsed >= 400 && elapsed < 1500, 'waited ~maxWaitMs (' + elapsed + 'ms)')
    holder.release()
    ok('timeout: throws EINSTALLLOCKED with owner metadata after maxWaitMs')
  } catch (e) { fail('timeout', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// 4. Stale-lock reclaim by mtime.
;(function test_stale_reclaim() {
  const root = makeTempRoot()
  try {
    const lockPath = path.join(root, LOCK_FILENAME)
    fs.writeFileSync(lockPath, JSON.stringify({ token: 'ghost', pid: 999999, host: 'ghost', acquiredAt: '' }))
    const old = (Date.now() - 60 * 60 * 1000) / 1000
    fs.utimesSync(lockPath, old, old)
    const lock = acquireInstallLock(root, { maxWaitMs: 500, staleAfterMs: 1000, pollMs: 50 })
    const meta = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
    assert.strictEqual(meta.pid, process.pid)
    assert.notStrictEqual(meta.token, 'ghost')
    lock.release()
    ok('stale-lock: reclaimed when mtime older than staleAfterMs')
  } catch (e) { fail('stale-lock reclaim', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// 5. finally-release still cleans up after a thrown crash.
;(function test_crash_safety() {
  const root = makeTempRoot()
  try {
    const lock = acquireInstallLock(root)
    let threw = false
    try {
      try { throw new Error('simulated install crash') }
      finally { lock.release() }
    } catch (e) { threw = true }
    assert.strictEqual(threw, true)
    assert.strictEqual(fs.existsSync(path.join(root, LOCK_FILENAME)), false)
    const next = acquireInstallLock(root, { maxWaitMs: 500 })
    next.release()
    ok('crash-safety: finally-release leaves the lock acquirable')
  } catch (e) { fail('crash-safety', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// 6. touch() refreshes owner mtime; refuses to clobber a foreign reclaimer.
;(function test_touch() {
  const root = makeTempRoot()
  const lockPath = path.join(root, LOCK_FILENAME)
  try {
    const lock = acquireInstallLock(root)
    const long = (Date.now() - 60 * 60 * 1000) / 1000
    fs.utimesSync(lockPath, long, long)
    const before = fs.statSync(lockPath).mtimeMs
    assert.strictEqual(lock.touch(), true)
    assert.ok(fs.statSync(lockPath).mtimeMs > before + 1000)

    fs.utimesSync(lockPath, long, long)
    const lock2 = acquireInstallLock(root, { staleAfterMs: 1000, maxWaitMs: 500, pollMs: 25 })
    const m2 = fs.statSync(lockPath).mtimeMs
    assert.strictEqual(lock.touch(), false, 'foreign reclaim → touch returns false')
    assert.strictEqual(fs.statSync(lockPath).mtimeMs, m2, 'mtime not clobbered')
    lock2.release()
    lock.release()
    ok('touch(): refreshes mtime for owner; refuses to clobber foreign reclaimer')
  } catch (e) { fail('touch', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// 7. release-after-stale-reclaim: A.release() must not delete B's lock.
;(function test_release_after_stale_reclaim() {
  const root = makeTempRoot()
  const lockPath = path.join(root, LOCK_FILENAME)
  try {
    const lockA = acquireInstallLock(root)
    const long = (Date.now() - 60 * 60 * 1000) / 1000
    fs.utimesSync(lockPath, long, long)
    const lockB = acquireInstallLock(root, { staleAfterMs: 1000, maxWaitMs: 500, pollMs: 25 })
    const bToken = JSON.parse(fs.readFileSync(lockPath, 'utf-8')).token
    lockA.release()
    assert.strictEqual(fs.existsSync(lockPath), true, "A.release() must NOT delete B's lock")
    assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).token, bToken)
    lockB.release()
    assert.strictEqual(fs.existsSync(lockPath), false)
    ok('release-after-stale-reclaim: token check prevents A from deleting B\'s lock')
  } catch (e) { fail('release-after-stale-reclaim', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// 8. Open-before-write race: A's release() must not delete an empty
//    lockfile mid-acquired by B.
;(function test_release_during_partial_write() {
  const root = makeTempRoot()
  const lockPath = path.join(root, LOCK_FILENAME)
  try {
    const lockA = acquireInstallLock(root)
    fs.unlinkSync(lockPath)
    const fdB = fs.openSync(lockPath, 'wx') // B mid-acquire, no token yet
    assert.strictEqual(fs.readFileSync(lockPath, 'utf-8'), '')
    lockA.release()
    assert.strictEqual(fs.existsSync(lockPath), true, "A.release() must NOT delete B's mid-acquire lockfile")
    assert.strictEqual(fs.readFileSync(lockPath, 'utf-8'), '')
    fs.closeSync(fdB)
    fs.unlinkSync(lockPath)
    ok('release-during-partial-write: A refuses to unlink an empty/partial lockfile')
  } catch (e) { fail('release-during-partial-write', e) } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})()

// 9. Cross-PROCESS contention: two child Node processes must serialise
//    on the same lockfile (no overlapping hold windows).
;(function test_cross_process() {
  const root = makeTempRoot()
  const lockPath = path.join(root, LOCK_FILENAME)
  // Helper script lives in the temp dir so a crashed test can never
  // leave it sitting next to the production sources.
  const childScript = path.join(root, '_install-lock-child.js')
  // Atomics.wait sleep — cross-platform; operator runs on Windows.
  fs.writeFileSync(childScript, `
    const { acquireInstallLock } = require(${JSON.stringify(path.join(__dirname, 'install-lock.js'))})
    const [root, id, holdMs] = [process.argv[2], process.argv[3], parseInt(process.argv[4], 10)]
    function emit(ev) { process.stdout.write(JSON.stringify({ id, ev, t: Date.now() }) + '\\n') }
    function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
    emit('start')
    const lock = acquireInstallLock(root, { maxWaitMs: 30000, pollMs: 25 })
    emit('acquired'); sleepSync(holdMs); emit('releasing'); lock.release(); emit('done')
  `)

  function spawnChild(id, holdMs) {
    return new Promise((resolve, reject) => {
      const ch = spawn(process.execPath, [childScript, root, id, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', err = ''
      ch.stdout.on('data', d => { out += d })
      ch.stderr.on('data', d => { err += d })
      ch.on('exit', (code) => {
        if (code !== 0) return reject(new Error('child ' + id + ' exit ' + code + ' stderr=' + err))
        resolve(out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
      })
    })
  }

  Promise.all([spawnChild('A', 400), spawnChild('B', 400)]).then((results) => {
    try {
      const intervals = results.map((ev) => ({
        id: ev[0].id,
        start: ev.find(x => x.ev === 'acquired').t,
        end: ev.find(x => x.ev === 'releasing').t,
      })).sort((a, b) => a.start - b.start)
      const [first, second] = intervals
      assert.ok(
        second.start >= first.end - 50,
        'no overlap: A=[' + first.start + '..' + first.end + '] B=[' + second.start + '..' + second.end + ']',
      )
      assert.strictEqual(fs.existsSync(lockPath), false)
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
