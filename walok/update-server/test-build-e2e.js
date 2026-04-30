// End-to-end regression test for Task #15.
//
// What this test proves
// ---------------------
// A successful POST /api/admin/build (or {all:true} fan-out) MUST result in
// the customer card on the admin UI showing a working [download] link and a
// non-empty "Last release" timestamp. Concretely, after a successful build
// the GET /api/admin/customers payload for that channel MUST satisfy:
//   _launcherFileExists === true
//   _serverFileExists   === true
//   _launcherReleased   !== null   // drives "Last release: <date>"
//   _serverReleased     !== null   // (read but not currently rendered)
//
// The original bug (Task #15) was: builds completed successfully, the DB
// recorded the version, but the launcher zip + manifest landed in the
// per-job ephemeral workspace clone (.build-jobs/<jobId>/...) instead of
// the real UPDATES_DIR. finishJob then deleted the workspace, leaving the
// DB pointing at files that didn't exist. Customer card showed
// "[file missing — rebuild]" + "Last release: ---" despite a successful
// build.
//
// Why this complements test-publish-paths.js
// ------------------------------------------
// test-publish-paths.js exercises scripts/publish-update.js in isolation
// (proves the env contract). This test drives the full HTTP flow:
//   POST /api/admin/build -> job runner clones workspace -> runs build
//   step (stub) -> runs publish step (REAL publish-update.js) -> onComplete
//   runs cleanup + DB writes -> finishJob disposes workspace -> client
//   GETs /api/admin/customers and reads the on-disk truth.
// If ANY of those layers regresses (publish path, cleanup keeper logic,
// DB write order, customers endpoint file-existence check), this test
// catches it — even when the unit-level test still passes.
//
// Coverage
// --------
//   * Single-customer build: POST /api/admin/build {channel}
//   * Multi-customer fan-out: POST /api/admin/build {all:true} with 2
//     seeded customers — matches the exact scenario in the original
//     screenshot (BLAST + DENFI both showing missing-file warnings).
//
// Run via:  node walok/update-server/test-build-e2e.js
'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const child_process = require('child_process')

let passed = 0
let failed = 0
function ok(msg) { passed++; console.log('  PASS  ' + msg) }
function fail(msg, err) { failed++; console.log('  FAIL  ' + msg + '\n        ' + (err && err.stack || err)) }

// Per-run randomized sentinel prefix for our test channels.
//
// IMPORTANT: server.js validates customer channels against
//   /^[a-z0-9][a-z0-9-]{0,49}$/
// which forbids underscores and uppercase, so we must build the prefix
// out of [a-z0-9-] only. We use the static prefix "e2e-test-" + 8 random
// hex chars + "-" so the cleanup sweep can match a very specific pattern
// (e2e-test-[0-9a-f]{8}-...) instead of the broad "e2e-*" wildcard the
// architect review flagged as risky against legitimate customer channels.
const RUN_ID = crypto.randomBytes(4).toString('hex')          // e.g. 9f3c1a02
const RUN_PREFIX = 'e2e-test-' + RUN_ID + '-'                 // e.g. e2e-test-9f3c1a02-
// Pattern used by cleanupSharedUpdatesDir() to safely sweep stale dirs
// from prior failed runs without touching anything else. Anchored at the
// start; only matches our well-formed run-prefix shape.
const STALE_RUN_RE = /^e2e-test-[0-9a-f]{8}-/

// ---- temp-dir scaffolding ----
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'test-build-e2e-'))
const PROJ_DIR = path.join(TMP_ROOT, 'proj')
const DATA_DIR = path.join(TMP_ROOT, 'data')
const BIN_DIR = path.join(TMP_ROOT, 'bin')
const SERVER_LOG = path.join(TMP_ROOT, 'server.log')
const REAL_PUBLISH_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'publish-update.js')

// Build a synthetic project root that mirrors the real walok layout enough
// to drive POST /api/admin/build end-to-end. Specifically:
//   - package.json (so PROJECT_ROOT is recognized)
//   - customers/                       (created lazily by /api/admin/customers)
//   - scripts/build-customer.js        (STUB: writes releases/<ch>/<v>/...)
//   - scripts/publish-update.js        (COPY of the real script under test)
//   - node_modules/.bin/vite,
//     node_modules/.bin/electron-builder (rootDepsInstalled() sentinels —
//     prevents the npm-install pre-flight from running, which we don't need)
//   - server/ omitted so serverDepsInstalled() check is bypassed entirely
function setupSyntheticProject() {
  fs.mkdirSync(PROJ_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(PROJ_DIR, 'package.json'),
    JSON.stringify({ name: 'fake-walok-e2e', version: '1.0.0' }, null, 2),
  )
  fs.mkdirSync(path.join(PROJ_DIR, 'customers'), { recursive: true })

  // .bin sentinels — server.js's rootDepsInstalled() looks for these.
  const binDir = path.join(PROJ_DIR, 'node_modules', '.bin')
  fs.mkdirSync(binDir, { recursive: true })
  for (const name of ['vite', 'electron-builder']) {
    fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }

  // STUB build-customer.js: takes <channel> as argv[2], reads BUILD_VERSION
  // from env, and produces the same on-disk artifacts the real script does
  // (releases/<ch>/<v>/launcher-unpacked/* + server-unpacked/*) so that
  // publish-update.js has something to pack. Runs in <1s.
  fs.mkdirSync(path.join(PROJ_DIR, 'scripts'), { recursive: true })
  const stubBuild = `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const channel = process.argv[2]
const version = process.env.BUILD_VERSION
if (!channel || !version) {
  console.error('stub build-customer: need channel + BUILD_VERSION')
  process.exit(1)
}
const root = process.cwd()
const launcherDir = path.join(root, 'releases', channel, version, 'launcher-unpacked')
const serverDir = path.join(root, 'releases', channel, version, 'server-unpacked')
fs.mkdirSync(launcherDir, { recursive: true })
fs.mkdirSync(serverDir, { recursive: true })
fs.writeFileSync(path.join(launcherDir, channel + '.exe'), 'fake launcher exe ' + version)
fs.writeFileSync(path.join(launcherDir, 'README.txt'), 'fake launcher readme')
fs.writeFileSync(path.join(serverDir, 'server.exe'), 'fake server exe ' + version)
fs.writeFileSync(path.join(serverDir, 'README.txt'), 'fake server readme')
console.log('[stub-build] ' + channel + ' v' + version + ' staged')
process.exit(0)
`
  fs.writeFileSync(path.join(PROJ_DIR, 'scripts', 'build-customer.js'), stubBuild, { mode: 0o755 })

  // REAL publish-update.js — this is the script under test. We copy it (not
  // symlink) so the workspace clone the job runner makes contains the same
  // exact source it would in production.
  fs.copyFileSync(REAL_PUBLISH_SCRIPT, path.join(PROJ_DIR, 'scripts', 'publish-update.js'))

  fs.mkdirSync(DATA_DIR, { recursive: true })
}

// Fake `zip` shim. Same trick as test-publish-paths.js — Replit doesn't
// have zip installed, and the real publish-update.js shells out to
//   cd "<unpacked>" && zip -r "<outZipPath>" . -q
// so we PATH-prefix a Node script that just writes a tiny valid empty-zip
// EOCD record at the requested output path.
function writeFakeZipShim() {
  fs.mkdirSync(BIN_DIR, { recursive: true })
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
// Minimal empty-zip EOCD — 22 bytes, not a real archive but enough for
// existsSync + statSync.size > 0 + sha256 to all succeed.
fs.writeFileSync(out, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]))
process.exit(0)
`
  fs.writeFileSync(path.join(BIN_DIR, 'zip'), shim, { mode: 0o755 })
}

// ---- HTTP helpers ----
let SERVER_PORT = 0
let cookieHeader = ''

function httpReq(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const opts = {
      host: '127.0.0.1', port: SERVER_PORT, path: urlPath, method,
      headers: { 'Content-Type': 'application/json' },
    }
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data)
    if (cookieHeader) opts.headers['Cookie'] = cookieHeader
    const req = http.request(opts, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        let json = null
        try { json = JSON.parse(text) } catch (e) {}
        const sc = res.headers['set-cookie']
        if (sc && sc.length) cookieHeader = sc.map(c => c.split(';')[0]).join('; ')
        resolve({ status: res.statusCode, body: json, raw: text })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// ---- server lifecycle ----
let serverChild = null

function startServer() {
  return new Promise((resolve, reject) => {
    SERVER_PORT = 15231 + Math.floor(Math.random() * 1000)
    const env = Object.assign({}, process.env, {
      OTA_PORT: String(SERVER_PORT),
      OTA_HOST: '127.0.0.1',
      OTA_ADMIN_PASSWORD: 'e2e-test-password-12345',
      OTA_PROJECT_ROOT: PROJ_DIR,
      OTA_DATA_DIR: DATA_DIR,
      // PATH-prefix our fake zip so publish-update.js's `zip -r` resolves
      // to it (Replit doesn't ship zip).
      PATH: BIN_DIR + path.delimiter + (process.env.PATH || ''),
    })
    const logFd = fs.openSync(SERVER_LOG, 'w')
    serverChild = child_process.spawn(
      process.execPath,
      [path.join(__dirname, 'server.js')],
      { env, cwd: __dirname, stdio: ['ignore', logFd, logFd] },
    )
    serverChild.on('exit', (code, sig) => {
      if (!serverChild._expectedExit) {
        reject(new Error('server exited unexpectedly: code=' + code + ' sig=' + sig + '; see ' + SERVER_LOG))
      }
    })
    const deadline = Date.now() + 8000
    const tick = () => {
      httpReq('GET', '/api/admin/status').then(r => {
        if (r.status === 200) resolve()
        else if (Date.now() > deadline) reject(new Error('server status never became 200, last=' + r.status))
        else setTimeout(tick, 100)
      }).catch(() => {
        if (Date.now() > deadline) reject(new Error('server never accepted connections'))
        else setTimeout(tick, 100)
      })
    }
    setTimeout(tick, 200)
  })
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverChild) return resolve()
    serverChild._expectedExit = true
    serverChild.once('exit', () => resolve())
    try { serverChild.kill('SIGTERM') } catch (e) {}
    setTimeout(() => { try { serverChild.kill('SIGKILL') } catch (e) {} }, 1500)
  })
}

// Poll /api/admin/jobs/:id until status reaches a terminal state, with a
// generous timeout so a slow CI box doesn't false-fail this test.
async function waitForJob(jobId, timeoutMs) {
  // /api/admin/jobs/:id returns the job fields at the top level (not
  // wrapped under .job): {id, status, exitCode, output, ...}
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await httpReq('GET', '/api/admin/jobs/' + jobId)
    if (r.status === 200 && r.body) {
      const s = r.body.status
      if (s === 'success' || s === 'failed' || s === 'cancelled') return r.body
    }
    await new Promise(res => setTimeout(res, 200))
  }
  throw new Error('job ' + jobId + ' did not finish within ' + timeoutMs + 'ms')
}

async function getCustomers() {
  // /api/admin/customers returns:
  //   { customers: [...], version, serverVersion, deps, requestIsRemote }
  const r = await httpReq('GET', '/api/admin/customers')
  assert.strictEqual(r.status, 200, '/api/admin/customers HTTP status (got ' + r.status + ')')
  assert.ok(r.body && Array.isArray(r.body.customers),
    'customers payload should have a .customers array (got: ' + JSON.stringify(r.body).slice(0, 300) + ')')
  return r.body.customers
}

function customerByChannel(list, ch) {
  const c = list.find(x => x.channel === ch)
  if (!c) throw new Error('no customer with channel=' + ch + ' in: ' + JSON.stringify(list.map(x => x.channel)))
  return c
}

// Build console tail — surfaced when a job fails, so the failure message
// the test prints actually tells you WHAT broke (not just "exit -1").
async function jobConsoleTail(jobId) {
  try {
    const r = await httpReq('GET', '/api/admin/jobs/' + jobId)
    if (r.status === 200 && r.body && typeof r.body.output === 'string') {
      return r.body.output.split('\n').slice(-40).join('\n        ')
    }
  } catch (e) {}
  return '(could not fetch job output)'
}

// ---- test 1: single-customer build → customer card shows working links ----

async function testSingleCustomerBuild() {
  console.log('\n  --- single-customer build ---')
  const channel = RUN_PREFIX + 'single'
  // Login (cookie persists across helper calls for the rest of the run)
  let r = await httpReq('POST', '/api/admin/login', { password: 'e2e-test-password-12345' })
  assert.strictEqual(r.status, 200, 'login HTTP status (got ' + r.status + ')')
  ok('login succeeds')

  // Seed one customer
  r = await httpReq('POST', '/api/admin/customers', {
    channel, brandName: 'E2E SINGLE', subtitle: 'sub',
    updateServer: 'http://10.0.0.1:4231',
  })
  assert.strictEqual(r.status, 200, 'create customer (got ' + r.status + ' body=' + r.raw + ')')
  ok('seed: created customer "' + channel + '"')

  // Trigger the build
  r = await httpReq('POST', '/api/admin/build', { channel })
  assert.strictEqual(r.status, 200, 'build POST (got ' + r.status + ' body=' + r.raw + ')')
  assert.ok(Array.isArray(r.body.jobs) && r.body.jobs.length === 1, 'build returns 1 job')
  // Single-channel response includes a top-level jobId for back-compat;
  // jobs[].jobId works in both single and fan-out shapes.
  const jobId = r.body.jobId || r.body.jobs[0].jobId
  assert.ok(jobId, 'build response must include a jobId (got body=' + r.raw + ')')
  ok('build job enqueued (jobId=' + jobId + ')')

  // Wait for it to finish
  const job = await waitForJob(jobId, 30000)
  if (job.status !== 'success') {
    fail('job reached terminal state', new Error(
      'expected status=success, got status=' + job.status + ' exit=' + job.exitCode +
      ' failedStep=' + job.failedStep + '\n        last lines:\n        ' + (await jobConsoleTail(jobId))))
    return
  }
  ok('build job reached status=success (exit=' + job.exitCode + ')')

  // THE CORE ASSERTION: /api/admin/customers reflects the just-built state.
  const customers = await getCustomers()
  const c = customerByChannel(customers, channel)

  try {
    assert.strictEqual(c._launcherFileExists, true,
      '_launcherFileExists must be true after a successful build (was: ' + JSON.stringify(c._launcherFileExists) +
      ', launcherVersion=' + c._launcherVersion + ')')
    ok('customer card: _launcherFileExists === true (no "[file missing — rebuild]" warning)')
  } catch (e) { fail('launcher file existence', e) }

  try {
    assert.strictEqual(c._serverFileExists, true,
      '_serverFileExists must be true after a successful build (was: ' + JSON.stringify(c._serverFileExists) +
      ', serverVersion=' + c._serverVersion + ')')
    ok('customer card: _serverFileExists === true (no "[file missing — rebuild]" warning)')
  } catch (e) { fail('server file existence', e) }

  try {
    assert.ok(c._launcherReleased,
      '_launcherReleased must be a non-empty timestamp after a successful build (was: ' + JSON.stringify(c._launcherReleased) + '). ' +
      'This is the field that drives "Last release: <date>" on the card; the original bug showed "Last release: ---" because the manifest with releasedAt never got written to the real updates dir.')
    ok('customer card: _launcherReleased is set ("Last release" will show a real date)')
  } catch (e) { fail('launcher released timestamp', e) }

  try {
    assert.ok(c._launcherVersion, '_launcherVersion should be set after a build')
    assert.ok(c._serverVersion, '_serverVersion should be set after a build')
    ok('customer card: both versions populated (launcher=' + c._launcherVersion + ', server=' + c._serverVersion + ')')
  } catch (e) { fail('versions populated', e) }

  // DB-backed publish timestamps. These come from the customers table
  // (launcher_published_at / server_published_at) via dbApi.listCustomers
  // and are spread into the response by /api/admin/customers. They're a
  // distinct signal from _launcherReleased (which is read off the on-disk
  // manifest) — guarding both prevents a future regression where the
  // build succeeds but the DB write step is skipped or reordered.
  try {
    assert.ok(c.launcherPublishedAt,
      'launcherPublishedAt (DB column) must be populated after a successful build (was: ' +
      JSON.stringify(c.launcherPublishedAt) + ')')
    assert.ok(c.serverPublishedAt,
      'serverPublishedAt (DB column) must be populated after a successful build (was: ' +
      JSON.stringify(c.serverPublishedAt) + ')')
    ok('customer row: DB publish timestamps populated (launcherPublishedAt + serverPublishedAt)')
  } catch (e) { fail('DB publish timestamps', e) }
}

// ---- test 2: build all → both customers show working links ----
//
// This matches the exact scenario from the screenshot in the original bug
// report: BUILD ALL fan-out across two customers, both shown with
// "[file missing — rebuild]" + "Last release: ---" after a successful run.

async function testBuildAllTwoCustomers() {
  console.log('\n  --- build all (two customers) ---')
  const channels = [RUN_PREFIX + 'blast', RUN_PREFIX + 'denfi']

  for (const ch of channels) {
    const r = await httpReq('POST', '/api/admin/customers', {
      channel: ch, brandName: ch.toUpperCase(), subtitle: 'sub',
      updateServer: 'http://10.0.0.1:4231',
    })
    assert.strictEqual(r.status, 200, 'create ' + ch + ' (got ' + r.status + ' body=' + r.raw + ')')
  }
  ok('seed: created 2 customers (' + channels.join(', ') + ')')

  const r = await httpReq('POST', '/api/admin/build', { all: true })
  assert.strictEqual(r.status, 200, 'build all POST (got ' + r.status + ' body=' + r.raw + ')')
  // Note: `all:true` builds ALL customers (including the {RUN_PREFIX}single
  // from test 1), so we assert at-least-2 rather than exactly-2.
  assert.ok(Array.isArray(r.body.jobs) && r.body.jobs.length >= 2,
    'build all returns at least 2 jobs (got ' + (r.body.jobs && r.body.jobs.length) + ')')
  // Each summary in r.body.jobs has shape {jobId, channel, version, status, queuePosition}.
  // Filter to the two channels we care about for THIS test (so a leftover
  // {RUN_PREFIX}single job from test 1 doesn't muddle the wait list).
  const jobIds = r.body.jobs.filter(j => channels.includes(j.channel)).map(j => j.jobId)
  const idsToWait = jobIds.length === 2 ? jobIds : r.body.jobs.map(j => j.jobId)
  assert.ok(idsToWait.every(Boolean), 'every enqueued job must carry a jobId (got body=' + r.raw + ')')
  ok('build all: enqueued ' + r.body.jobs.length + ' job(s), waiting for ' + idsToWait.length)

  const finalStates = []
  for (const id of idsToWait) {
    const j = await waitForJob(id, 30000)
    finalStates.push(j)
  }
  const failedJobs = finalStates.filter(j => j.status !== 'success')
  if (failedJobs.length > 0) {
    const tails = []
    for (const j of failedJobs) tails.push('job ' + j.id + ' (status=' + j.status + '):\n        ' + (await jobConsoleTail(j.id)))
    fail('all jobs reach success', new Error('failed jobs:\n        ' + tails.join('\n\n        ')))
    return
  }
  ok('all build jobs reached status=success')

  // Now assert the customer cards for the two test channels reflect reality.
  const customers = await getCustomers()
  for (const ch of channels) {
    const c = customerByChannel(customers, ch)
    try {
      assert.strictEqual(c._launcherFileExists, true, ch + '._launcherFileExists must be true (was ' + JSON.stringify(c._launcherFileExists) + ')')
      assert.strictEqual(c._serverFileExists, true, ch + '._serverFileExists must be true (was ' + JSON.stringify(c._serverFileExists) + ')')
      assert.ok(c._launcherReleased, ch + '._launcherReleased must be set (was ' + JSON.stringify(c._launcherReleased) + ')')
      // DB-backed publish timestamps (see single-customer test for rationale).
      assert.ok(c.launcherPublishedAt, ch + '.launcherPublishedAt (DB) must be set (was ' + JSON.stringify(c.launcherPublishedAt) + ')')
      assert.ok(c.serverPublishedAt, ch + '.serverPublishedAt (DB) must be set (was ' + JSON.stringify(c.serverPublishedAt) + ')')
      ok(ch + ': card shows real download links + last-release timestamp + DB publish timestamps')
    } catch (e) { fail(ch + ': customer card after build all', e) }
  }
}

// ---- run ----

// IMPORTANT: server.js derives UPDATES_DIR from its own __dirname
// (walok/update-server/public/updates), NOT from any env var. Even though
// our spawned test server uses an isolated PROJECT_ROOT + DATA_DIR, all
// publishes still land in the SHARED real updates dir on disk. That's
// exactly what we want to test (the bug was that publishes went to the
// wrong dir), but it means we leave behind channel folders we have to
// sweep so they don't accumulate across runs or pollute the dev
// workflow's view.
//
// Cleanup is scoped to STALE_RUN_RE (e2e-test-[0-9a-f]{8}-...) so we
// only delete dirs whose name matches our exact randomized run-prefix
// shape. This addresses the architect review's concern that a broad
// "e2e-*" prefix could collide with a legitimate customer channel that
// happens to start with the same string.
const REAL_UPDATES_DIR = path.resolve(__dirname, 'public', 'updates')
function cleanupSharedUpdatesDir() {
  if (!fs.existsSync(REAL_UPDATES_DIR)) return
  for (const ent of fs.readdirSync(REAL_UPDATES_DIR)) {
    if (STALE_RUN_RE.test(ent)) {
      try { fs.rmSync(path.join(REAL_UPDATES_DIR, ent), { recursive: true, force: true }) } catch (_) {}
    }
  }
}

async function run() {
  console.log('=== test-build-e2e.js: end-to-end /api/admin/build → /api/admin/customers ===')
  console.log('  tmp dir: ' + TMP_ROOT)

  // Belt-and-suspenders: sweep any leftover e2e-test-<runid>- dirs from a
  // prior failed run BEFORE we start, so a stale "[file missing — rebuild]"
  // state from last time can't masquerade as a fresh successful build now.
  cleanupSharedUpdatesDir()

  setupSyntheticProject()
  writeFakeZipShim()

  try {
    await startServer()
  } catch (e) {
    fail('startServer', e)
    cleanupSharedUpdatesDir()
    return
  }

  try { await testSingleCustomerBuild() } catch (e) { fail('testSingleCustomerBuild threw', e) }
  try { await testBuildAllTwoCustomers() } catch (e) { fail('testBuildAllTwoCustomers threw', e) }

  await stopServer()
  cleanupSharedUpdatesDir()
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch (_) {}

  console.log('')
  if (failed === 0) {
    console.log('=== ALL TESTS PASSED (' + passed + ') ===')
    process.exit(0)
  } else {
    console.log('=== ' + failed + ' TEST(S) FAILED ===')
    console.log('=== ' + passed + ' passed ===')
    console.log('=== server log: ' + SERVER_LOG + ' ===')
    process.exit(1)
  }
}

process.on('unhandledRejection', async (e) => {
  console.error('unhandledRejection:', e && e.stack || e)
  await stopServer().catch(() => {})
  cleanupSharedUpdatesDir()
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch (_) {}
  process.exit(1)
})

run().catch(async (e) => {
  fail('run()', e)
  await stopServer().catch(() => {})
  cleanupSharedUpdatesDir()
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch (_) {}
  process.exit(1)
})
