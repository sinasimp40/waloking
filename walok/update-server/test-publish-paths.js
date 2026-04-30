// Regression test: publish-update.js MUST honor OTA_UPDATES_DIR.
//
// What this test proves
// ---------------------
// scripts/publish-update.js derives its output dir from __dirname:
//   ROOT = path.join(__dirname, '..')
//   UPDATE_SERVER_PUBLIC = ROOT/update-server/public/updates
//
// When the OTA admin's job runner invokes this script, it does so from
// a TEMPORARY workspace clone at <projectRoot>/.build-jobs/<jobId>/.
// Inside that clone __dirname resolves to .build-jobs/<jobId>/scripts
// and ROOT resolves to .build-jobs/<jobId>/. If the script publishes
// to that location, finishJob deletes the workspace seconds later,
// taking the published artifacts with it. The customer card then shows
// "[file missing — rebuild]" + "Last release: ---" despite a
// successful build (the original Task #15 bug).
//
// To prevent this, server.js sets OTA_UPDATES_DIR=UPDATES_DIR (the
// REAL updates dir on the host) when invoking the publish step. The
// script MUST honor that env var and write there instead of the
// workspace-relative default.
//
// How it proves it
// ----------------
// 1. Build a synthetic workspace clone tree that mirrors the layout the
//    job runner produces: <ws>/scripts/publish-update.js (a copy),
//    <ws>/package.json, <ws>/customers/<ch>.json, and a fake
//    releases/<ch>/<v>/launcher-unpacked/ dir with dummy files.
// 2. PATH-prefix a fake `zip` shim so we don't need real zip installed.
// 3. Spawn `node scripts/publish-update.js <ch>` with cwd=<ws>,
//    BUILD_VERSION=<v>, and OTA_UPDATES_DIR=<REAL_UPDATES>.
// 4. Assert: REAL_UPDATES/<ch>/latest.json AND
//            REAL_UPDATES/<ch>/<v>/launcher-payload.zip both exist.
// 5. Assert: <ws>/update-server/public/updates does NOT exist (or has
//    no <ch>/ entry), proving nothing leaked into the workspace.
// 6. Sanity test: without OTA_UPDATES_DIR, the script falls back to
//    <ws>/update-server/public/updates (legacy behavior preserved
//    for direct CLI usage outside the job runner).
//
// Run via:  node walok/update-server/test-publish-paths.js
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const child_process = require('child_process')

let passed = 0
let failed = 0
function ok(msg) { passed++; console.log('  PASS  ' + msg) }
function fail(msg, err) { failed++; console.log('  FAIL  ' + msg + '\n        ' + (err && err.stack || err)) }

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'test-publish-paths-'))
const REAL_PROJECT = path.resolve(__dirname, '..')
const REAL_PUBLISH_SCRIPT = path.join(REAL_PROJECT, 'scripts', 'publish-update.js')

// ---- helpers ----

function buildWorkspace({ wsRoot, channel, version, brandName }) {
  // Mirror the subset of the project layout that publish-update.js touches:
  //   <ws>/scripts/publish-update.js   (copy of the real script under test)
  //   <ws>/package.json                 (readVersion fallback)
  //   <ws>/customers/<ch>.json          (computeExeName multi-channel branch)
  //   <ws>/releases/<ch>/<v>/launcher-unpacked/dummy.txt  (publish input)
  fs.mkdirSync(path.join(wsRoot, 'scripts'), { recursive: true })
  fs.copyFileSync(REAL_PUBLISH_SCRIPT, path.join(wsRoot, 'scripts', 'publish-update.js'))
  fs.writeFileSync(
    path.join(wsRoot, 'package.json'),
    JSON.stringify({ name: 'fake-walok', version: '0.0.1' }, null, 2),
  )
  fs.mkdirSync(path.join(wsRoot, 'customers'), { recursive: true })
  fs.writeFileSync(
    path.join(wsRoot, 'customers', channel + '.json'),
    JSON.stringify({ channel, brandName }, null, 2),
  )
  const unpacked = path.join(wsRoot, 'releases', channel, version, 'launcher-unpacked')
  fs.mkdirSync(unpacked, { recursive: true })
  fs.writeFileSync(path.join(unpacked, 'launcher.exe'), 'fake exe payload bytes')
  fs.writeFileSync(path.join(unpacked, 'README.txt'), 'fake launcher payload')
}

function writeFakeZipShim(binDir) {
  // The script invokes:  cd "<unpacked>" && zip -r "<outZip>" . -q
  // We don't need a real zip — we just need a file at <outZip> so the
  // size + sha256 reads succeed. The shim parses argv to find the
  // output path (the second positional after -r), creates its parent
  // dir, and writes a stable byte sequence.
  fs.mkdirSync(binDir, { recursive: true })
  const shim = `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const argv = process.argv.slice(2)
let out = null
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-r' && argv[i + 1]) { out = argv[i + 1]; break }
}
if (!out) { process.stderr.write('fake zip: no -r <out> in argv\\n'); process.exit(2) }
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]))
process.exit(0)
`
  const file = path.join(binDir, 'zip')
  fs.writeFileSync(file, shim, { mode: 0o755 })
}

function runPublish({ wsRoot, channel, version, env, binDir }) {
  const fullEnv = Object.assign({}, process.env, env || {}, {
    BUILD_VERSION: version,
    PATH: binDir + path.delimiter + (process.env.PATH || ''),
  })
  const r = child_process.spawnSync(
    process.execPath,
    [path.join('scripts', 'publish-update.js'), channel],
    { cwd: wsRoot, env: fullEnv, encoding: 'utf-8' },
  )
  return r
}

// ---- test 1: with OTA_UPDATES_DIR set, output goes to the real dir ----

function testHonorsOtaUpdatesDir() {
  const wsRoot = path.join(TMP_ROOT, 'ws-with-env')
  const realUpdates = path.join(TMP_ROOT, 'real-updates')
  const binDir = path.join(TMP_ROOT, 'bin-with-env')
  const channel = 'demo'
  const version = '1.2.3'

  buildWorkspace({ wsRoot, channel, version, brandName: 'DEMO BRAND' })
  writeFakeZipShim(binDir)

  const r = runPublish({
    wsRoot, channel, version, binDir,
    env: { OTA_UPDATES_DIR: realUpdates },
  })

  if (r.status !== 0) {
    fail('OTA_UPDATES_DIR honored: publish-update.js exit code',
      new Error('exit=' + r.status + '\n  stdout:\n' + r.stdout + '\n  stderr:\n' + r.stderr))
    return
  }
  ok('publish-update.js exits 0 when OTA_UPDATES_DIR is set')

  const realManifest = path.join(realUpdates, channel, 'latest.json')
  const realZip = path.join(realUpdates, channel, version, 'launcher-payload.zip')
  try {
    assert.ok(fs.existsSync(realManifest), 'expected manifest at REAL ' + realManifest)
    ok('manifest landed in OTA_UPDATES_DIR (the REAL updates dir)')
  } catch (e) { fail('manifest in REAL updates', e) }

  try {
    assert.ok(fs.existsSync(realZip), 'expected launcher-payload.zip at REAL ' + realZip)
    ok('launcher-payload.zip landed in OTA_UPDATES_DIR (the REAL updates dir)')
  } catch (e) { fail('zip in REAL updates', e) }

  // Manifest content sanity: version + releasedAt + exeName from customer JSON
  try {
    const m = JSON.parse(fs.readFileSync(realManifest, 'utf-8'))
    assert.strictEqual(m.version, version, 'manifest.version')
    assert.ok(m.releasedAt, 'manifest.releasedAt set (cures "Last release: ---")')
    assert.ok(m.launcher && m.launcher.url && m.launcher.sha256, 'manifest.launcher populated')
    ok('manifest includes version + releasedAt + launcher{url,sha256}')
  } catch (e) { fail('manifest content', e) }

  // CRITICAL: nothing should have leaked into the workspace's update-server dir.
  // The bug we are guarding against published HERE and let finishJob wipe it.
  const wsLeak = path.join(wsRoot, 'update-server', 'public', 'updates', channel)
  try {
    assert.ok(!fs.existsSync(wsLeak),
      'workspace LEAK: publish wrote to ' + wsLeak + ' (it should have gone to OTA_UPDATES_DIR only). ' +
      'This is exactly the Task #15 regression: the workspace gets wiped seconds later, ' +
      'leaving the customer card with "[file missing — rebuild]" + "Last release: ---".')
    ok('no workspace leak: nothing published to <ws>/update-server/public/updates/' + channel)
  } catch (e) { fail('workspace leak guard', e) }
}

// ---- test 2: without OTA_UPDATES_DIR, falls back to workspace path ----
//
// This protects direct CLI usage from outside the job runner (e.g. an
// operator running `node scripts/publish-update.js <ch>` by hand from
// the real project root). We don't want to break that workflow while
// fixing the job-runner one.

function testFallbackWhenEnvUnset() {
  const wsRoot = path.join(TMP_ROOT, 'ws-no-env')
  const binDir = path.join(TMP_ROOT, 'bin-no-env')
  const channel = 'fallback'
  const version = '0.9.0'

  buildWorkspace({ wsRoot, channel, version, brandName: 'FALLBACK BRAND' })
  writeFakeZipShim(binDir)

  const r = runPublish({ wsRoot, channel, version, binDir, env: {} })
  if (r.status !== 0) {
    fail('fallback path: publish-update.js exit code',
      new Error('exit=' + r.status + '\n  stdout:\n' + r.stdout + '\n  stderr:\n' + r.stderr))
    return
  }
  ok('publish-update.js exits 0 with default (workspace-relative) path')

  const wsManifest = path.join(wsRoot, 'update-server', 'public', 'updates', channel, 'latest.json')
  try {
    assert.ok(fs.existsSync(wsManifest),
      'fallback: expected manifest at workspace path ' + wsManifest)
    ok('fallback: manifest written to <ws>/update-server/public/updates (legacy behavior preserved)')
  } catch (e) { fail('fallback manifest', e) }
}

// ---- run ----

console.log('=== test-publish-paths.js: publish-update.js OTA_UPDATES_DIR contract ===')
console.log('  tmp dir: ' + TMP_ROOT)

try { testHonorsOtaUpdatesDir() } catch (e) { fail('testHonorsOtaUpdatesDir threw', e) }
try { testFallbackWhenEnvUnset() } catch (e) { fail('testFallbackWhenEnvUnset threw', e) }

try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch (_) {}

console.log('')
if (failed === 0) {
  console.log('=== ALL TESTS PASSED (' + passed + ') ===')
  process.exit(0)
} else {
  console.log('=== ' + failed + ' TEST(S) FAILED ===')
  console.log('=== ' + passed + ' passed ===')
  process.exit(1)
}
