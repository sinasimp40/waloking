#!/usr/bin/env node
// Tests for cleanup.js — specifically the per-job onCancel cleanup helper
// (cleanupCancelledJob) introduced for Task #4.
//
// Acceptance criteria covered:
//   1. Removes the launcher payload     <updates>/<channel>/<version>/
//   2. Removes the server payload       <updates>/<channel>-server/<version>/
//   3. Removes the raw build output     <projectRoot>/releases/<channel>/<version>/
//   4. Refuses any input that would let the resolved path escape the
//      expected parent dir (path-traversal). Sibling version dirs MUST
//      survive — only the targeted version is removed.
//   5. Refuses bogus channel/version strings (.., /, \, absolute paths,
//      unicode mix, empty, etc.).
//
// Run from repo root:   node update-server/test-cleanup.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')

const { cleanupCancelledJob } = require('./cleanup')

let failed = 0
function ok(name) { console.log('  PASS  ' + name) }
function fail(name, err) { failed++; console.log('  FAIL  ' + name + ' :: ' + (err && err.stack ? err.stack : err)) }

function makeTempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'))
  const projectRoot = path.join(root, 'project')
  const updatesPublicDir = path.join(root, 'updates')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(updatesPublicDir, { recursive: true })
  return { root, projectRoot, updatesPublicDir }
}

function seedVersion(updatesPublicDir, projectRoot, channel, version, contentLabel) {
  // Launcher payload
  const lDir = path.join(updatesPublicDir, channel, version)
  fs.mkdirSync(lDir, { recursive: true })
  fs.writeFileSync(path.join(lDir, 'payload.bin'), 'launcher-' + contentLabel)
  // Server payload
  const sDir = path.join(updatesPublicDir, channel + '-server', version)
  fs.mkdirSync(sDir, { recursive: true })
  fs.writeFileSync(path.join(sDir, 'payload.bin'), 'server-' + contentLabel)
  // Raw build output
  const rDir = path.join(projectRoot, 'releases', channel, version)
  fs.mkdirSync(rDir, { recursive: true })
  fs.writeFileSync(path.join(rDir, 'launcher.exe'), 'release-' + contentLabel)
  return { lDir, sDir, rDir }
}

// === Test 1: happy path — removes exactly the targeted version ===
function testHappyPath() {
  const t = 'happy path: removes launcher + server + releases for v1.2.3'
  try {
    const { projectRoot, updatesPublicDir } = makeTempDirs()
    const ch = 'good-customer'
    const seeded = seedVersion(updatesPublicDir, projectRoot, ch, '1.2.3', 'target')
    // Sibling version that MUST survive.
    const survivor = seedVersion(updatesPublicDir, projectRoot, ch, '0.0.0', 'survivor')

    const r = cleanupCancelledJob({
      projectRoot, updatesPublicDir, channel: ch, version: '1.2.3',
    })
    assert.strictEqual(r.skipped.length, 0, 'unexpected skipped: ' + JSON.stringify(r.skipped))
    assert.strictEqual(r.removed.length, 3, 'expected 3 removed entries, got ' + JSON.stringify(r.removed))
    assert.strictEqual(fs.existsSync(seeded.lDir), false, 'launcher version dir should be gone')
    assert.strictEqual(fs.existsSync(seeded.sDir), false, 'server version dir should be gone')
    assert.strictEqual(fs.existsSync(seeded.rDir), false, 'releases version dir should be gone')
    // Sibling untouched.
    assert.strictEqual(fs.existsSync(survivor.lDir), true, 'sibling launcher v0.0.0 must SURVIVE')
    assert.strictEqual(fs.existsSync(survivor.sDir), true, 'sibling server v0.0.0 must SURVIVE')
    assert.strictEqual(fs.existsSync(survivor.rDir), true, 'sibling releases v0.0.0 must SURVIVE')
    // The PARENT channel dirs must also survive (they hold the sibling).
    assert.strictEqual(fs.existsSync(path.join(updatesPublicDir, ch)), true, 'channel dir must survive')
    assert.strictEqual(fs.existsSync(path.join(projectRoot, 'releases', ch)), true, 'releases channel dir must survive')
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 2: missing version dir is a silent no-op (never throws) ===
function testMissingDirsNoThrow() {
  const t = 'missing dirs: nothing to remove → no throw, empty removed[]'
  try {
    const { projectRoot, updatesPublicDir } = makeTempDirs()
    // Don't seed anything. Cleanup should still succeed silently.
    const r = cleanupCancelledJob({
      projectRoot, updatesPublicDir, channel: 'never-built', version: '9.9.9',
    })
    assert.strictEqual(r.removed.length, 0)
    assert.strictEqual(r.skipped.length, 0)
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 3: PATH TRAVERSAL — bogus channel/version strings ===
// This is the security-critical test. cleanupCancelledJob must REFUSE to
// touch any path that would escape the expected version dir.
function testPathTraversal() {
  const t = 'path traversal: refuses .., /, \\, absolute, empty inputs'
  try {
    const { projectRoot, updatesPublicDir, root } = makeTempDirs()
    // Pre-seed a SENTINEL outside the legal cleanup roots that MUST
    // survive every malicious call below.
    const sentinelPath = path.join(root, 'SENTINEL.txt')
    fs.writeFileSync(sentinelPath, 'do not delete me')
    // And a sibling version dir that must also survive.
    const survivor = seedVersion(updatesPublicDir, projectRoot, 'real', '1.0.0', 'sentinel-sibling')

    const malicious = [
      { channel: '../etc',       version: '1.0.0' },
      { channel: '..',           version: '1.0.0' },
      { channel: '/etc/passwd',  version: '1.0.0' },
      { channel: 'real/../etc',  version: '1.0.0' },
      { channel: 'real',         version: '../1.0.0' },
      { channel: 'real',         version: '1.0.0/../../../etc' },
      { channel: 'real',         version: '/etc' },
      { channel: 'real',         version: '..' },
      { channel: '',             version: '1.0.0' },
      { channel: 'real',         version: '' },
      { channel: null,           version: '1.0.0' },
      { channel: 'real',         version: null },
      { channel: 'REAL',         version: '1.0.0' },              // uppercase rejected by regex
      { channel: 'real',         version: 'not-a-semver' },
      { channel: 'real\u0000bad',version: '1.0.0' },              // null byte
    ]
    for (const m of malicious) {
      const r = cleanupCancelledJob({
        projectRoot, updatesPublicDir, channel: m.channel, version: m.version,
      })
      assert.strictEqual(r.removed.length, 0,
        'malicious input ' + JSON.stringify(m) + ' was allowed to delete: ' + JSON.stringify(r.removed))
    }
    // Sentinel + sibling must still exist.
    assert.strictEqual(fs.existsSync(sentinelPath), true, 'SENTINEL outside roots was deleted!')
    assert.strictEqual(fs.existsSync(survivor.lDir), true, 'sibling launcher payload deleted')
    assert.strictEqual(fs.existsSync(survivor.sDir), true, 'sibling server payload deleted')
    assert.strictEqual(fs.existsSync(survivor.rDir), true, 'sibling release deleted')
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 4: filesystem-root containment — refuses if updatesPublicDir is "/"
// or projectRoot is "/" so a misconfigured server can't sweep the whole disk
// even given a valid channel/version. ===
function testFsRootRefused() {
  const t = 'fs root: refuses cleanup when containment root is /'
  try {
    // Use legal channel/version, but point updatesPublicDir + projectRoot at
    // the filesystem root. Even if such a directory existed, the helper
    // must refuse.
    const fsRoot = path.parse(process.cwd()).root
    const r = cleanupCancelledJob({
      projectRoot: fsRoot, updatesPublicDir: fsRoot, channel: 'real', version: '1.0.0',
    })
    assert.strictEqual(r.removed.length, 0,
      'fs-root cleanup must remove nothing, got ' + JSON.stringify(r.removed))
    // Every triple should have been refused.
    assert.ok(r.skipped.length > 0, 'expected refusal entries when containment root is fs root')
    for (const sk of r.skipped) {
      assert.ok(/refused/.test(sk.reason),
        'skip reason should be "refused…", was: ' + sk.reason)
    }
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 5: only one of projectRoot / updatesPublicDir provided still works
// (helper is used in places where one or the other is missing). ===
function testPartialInputs() {
  const t = 'partial inputs: missing projectRoot → only updates dirs touched'
  try {
    const { projectRoot, updatesPublicDir } = makeTempDirs()
    const seeded = seedVersion(updatesPublicDir, projectRoot, 'partial', '2.0.0', 'partial')
    const r = cleanupCancelledJob({
      projectRoot: null, updatesPublicDir, channel: 'partial', version: '2.0.0',
    })
    // Should remove launcher + server, NOT releases (we passed projectRoot=null).
    assert.strictEqual(r.removed.length, 2,
      'expected 2 removed entries (launcher + server), got ' + JSON.stringify(r.removed))
    assert.strictEqual(fs.existsSync(seeded.lDir), false)
    assert.strictEqual(fs.existsSync(seeded.sDir), false)
    assert.strictEqual(fs.existsSync(seeded.rDir), true,
      'releases dir should be UNTOUCHED when projectRoot is null')
    ok(t)
  } catch (e) { fail(t, e) }
}

;(async () => {
  console.log('=== cleanup.js tests ===')
  console.log('')
  testHappyPath()
  testMissingDirsNoThrow()
  testPathTraversal()
  testFsRootRefused()
  testPartialInputs()
  console.log('')
  if (failed === 0) {
    console.log('=== ALL TESTS PASSED ===')
    process.exit(0)
  } else {
    console.log('=== ' + failed + ' TEST(S) FAILED ===')
    process.exit(1)
  }
})().catch(e => {
  console.error('TEST RUNNER CRASHED:', e)
  process.exit(2)
})
