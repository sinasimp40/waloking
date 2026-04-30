// Integration regression test: lock in the parallel-install safety
// guarantee for /api/admin/build.
//
// What this test proves
// ---------------------
// A future refactor must NEVER allow two overlapping POST /api/admin/build
// requests to run `npm install` against the shared PROJECT_ROOT/node_modules
// concurrently. npm is not concurrency-safe on a shared install target;
// overlap can corrupt the tree (EEXIST / partial writes / wrong-version
// resolutions) and the corruption is silent until the next build.
//
// How it proves it
// ----------------
// 1. We spin up an isolated forked instance of server.js with:
//    - OTA_PROJECT_ROOT pointing at a synthetic project (package.json +
//      empty customers/ + no node_modules, so rootDepsInstalled() returns
//      false and the install pre-flight WILL fire)
//    - OTA_DATA_DIR pointing at an empty temp dir (fresh launcher.db; we
//      do not touch the real customer table)
//    - PATH prefixed with a temp bin dir whose ONLY entry is a fake `npm`
//      shim (Node script). The shim records START + END timestamps to a
//      marker log every time it's invoked, sleeps a known interval, then
//      writes the .bin/vite + .bin/electron-builder stubs the server uses
//      to detect "deps installed".
// 2. We POST one customer (so /api/admin/build {all:true} has a target).
// 3. We fire TWO POST /api/admin/build {all:true} concurrently.
// 4. We parse the marker log and assert no two npm-install intervals
//    overlap. (In a healthy implementation only ONE invocation happens at
//    all, because spawnSync blocks the Node event loop while request #1's
//    pre-flight runs, so by the time request #2's handler sees the world,
//    rootDepsInstalled() already returns true.)
// 5. We cancel any leftover jobs and tear the server down.
//
// Run via:  node walok/update-server/test-build-endpoint.js
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const child_process = require('child_process')

let passed = 0
let failed = 0
function ok(msg) { passed++; console.log('  PASS  ' + msg) }
function fail(msg, err) { failed++; console.log('  FAIL  ' + msg + '\n        ' + (err && err.stack || err)) }

// ---- temp-dir scaffolding ----
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'test-build-endpoint-'))
const PROJ_DIR = path.join(TMP_ROOT, 'proj')
const DATA_DIR = path.join(TMP_ROOT, 'data')
const BIN_DIR = path.join(TMP_ROOT, 'bin')
const MARKER = path.join(TMP_ROOT, 'npm-marker.log')
const SERVER_LOG = path.join(TMP_ROOT, 'server.log')

function setupTempProject() {
  fs.mkdirSync(PROJ_DIR, { recursive: true })
  fs.mkdirSync(path.join(PROJ_DIR, 'customers'), { recursive: true })
  fs.writeFileSync(
    path.join(PROJ_DIR, 'package.json'),
    JSON.stringify({ name: 'test-fake-walok', version: '1.0.0' }, null, 2),
  )
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(BIN_DIR, { recursive: true })
}

// Fake `npm` shim. Records START/END events with PID + ISO timestamp +
// argv to MARKER, sleeps SHIM_DELAY_MS to widen the concurrency window
// (so an accidentally-parallel pair is easy to detect), then writes the
// .bin/vite and .bin/electron-builder stubs that rootDepsInstalled()
// looks for. The shim is a Node script (portable across Linux/Windows
// without bash). The server invokes us as `npm install --no-audit --no-fund`
// from cwd=<PROJECT_ROOT> or cwd=<PROJECT_ROOT>/server.
const SHIM_DELAY_MS = 600
function writeFakeNpmShim() {
  const shim = `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const MARKER = ${JSON.stringify(MARKER)}
const DELAY = ${SHIM_DELAY_MS}
const cwd = process.cwd()
const pid = process.pid
const argv = process.argv.slice(2).join(' ')
function stamp(kind) {
  fs.appendFileSync(MARKER, kind + ' ' + pid + ' ' + new Date().toISOString() + ' cwd=' + cwd + ' argv="' + argv + '"\\n')
}
stamp('START')
// Busy-wait sleep to model real npm's CPU-bound install. setTimeout would
// yield the event loop, but the host server uses spawnSync so what matters
// is wall-clock duration of the child process.
const end = Date.now() + DELAY
while (Date.now() < end) { /* busy */ }
// Drop the .bin shims the server uses as its "deps installed" sentinel.
const binDir = path.join(cwd, 'node_modules', '.bin')
fs.mkdirSync(binDir, { recursive: true })
for (const name of ['vite', 'electron-builder']) {
  const file = path.join(binDir, name)
  if (!fs.existsSync(file)) fs.writeFileSync(file, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 })
}
stamp('END')
process.exit(0)
`
  const npmShim = path.join(BIN_DIR, 'npm')
  fs.writeFileSync(npmShim, shim, { mode: 0o755 })
  // Windows-friendly alias: npm.cmd just spawns node on the same shim.
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(BIN_DIR, 'npm.cmd'),
      '@echo off\r\nnode "' + npmShim + '" %*\r\n',
    )
  }
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
        // Capture the auth cookie from /api/admin/login.
        const sc = res.headers['set-cookie']
        if (sc && sc.length) {
          cookieHeader = sc.map(c => c.split(';')[0]).join('; ')
        }
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
    SERVER_PORT = 14231 + Math.floor(Math.random() * 1000)
    const env = Object.assign({}, process.env, {
      OTA_PORT: String(SERVER_PORT),
      OTA_HOST: '127.0.0.1',
      OTA_ADMIN_PASSWORD: 'test-password-12345',
      OTA_PROJECT_ROOT: PROJ_DIR,
      OTA_DATA_DIR: DATA_DIR,
      // Enables /api/admin/__test_inline_job (gated test-only hook used by
      // the SSE coalescing assertion below). Mounting only when this env
      // var is set keeps it absent from production servers.
      OTA_TEST_MODE: '1',
      // PATH-prefix with our shim dir so the server's `npm install` resolves
      // to our fake. NPM_CMD on the server is plain 'npm' (or npm.cmd on
      // Windows) so a PATH prefix is sufficient.
      PATH: BIN_DIR + path.delimiter + (process.env.PATH || ''),
    })
    const logFd = fs.openSync(SERVER_LOG, 'w')
    serverChild = child_process.spawn(
      process.execPath,
      [path.join(__dirname, 'server.js')],
      { env, cwd: __dirname, stdio: ['ignore', logFd, logFd] },
    )
    serverChild.on('exit', (code, sig) => {
      // Surface unexpected exits during the test window as a rejection.
      if (!serverChild._expectedExit) {
        reject(new Error('server exited unexpectedly: code=' + code + ' sig=' + sig + '; see ' + SERVER_LOG))
      }
    })
    // Poll /api/admin/status until it responds.
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

// ---- assertions ----
function parseMarker() {
  if (!fs.existsSync(MARKER)) return []
  const lines = fs.readFileSync(MARKER, 'utf-8').split('\n').filter(Boolean)
  const events = []
  for (const ln of lines) {
    const m = ln.match(/^(START|END) (\d+) (\S+) cwd=(\S+) argv="(.*)"$/)
    if (!m) continue
    events.push({ kind: m[1], pid: +m[2], t: Date.parse(m[3]), cwd: m[4], argv: m[5] })
  }
  return events
}

function pairIntervals(events) {
  // Pair START with END by PID; assume PIDs don't recycle within the test
  // window (very safe — child process lifetimes here are < 1s and OS PID
  // recycling is far wider than that).
  const open = new Map()
  const intervals = []
  for (const e of events) {
    if (e.kind === 'START') open.set(e.pid, e)
    else {
      const start = open.get(e.pid)
      if (start) {
        intervals.push({ pid: e.pid, start: start.t, end: e.t, cwd: e.cwd })
        open.delete(e.pid)
      }
    }
  }
  return intervals
}

function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end
}

// ---- the test ----
async function run() {
  console.log('=== test-build-endpoint.js: parallel-install safety regression ===')
  console.log('  tmp dir: ' + TMP_ROOT)

  setupTempProject()
  writeFakeNpmShim()

  try {
    await startServer()
  } catch (e) {
    fail('startServer', e)
    return
  }

  // --- Login ---
  try {
    const r = await httpReq('POST', '/api/admin/login', { password: 'test-password-12345' })
    assert.strictEqual(r.status, 200, 'login HTTP status (got ' + r.status + ' body=' + r.raw + ')')
    assert.ok(r.body && r.body.ok, 'login should return ok:true')
    ok('login succeeds with env-supplied password')
  } catch (e) { fail('login', e) }

  // --- Create one customer so /api/admin/build {all:true} has a target ---
  try {
    const r = await httpReq('POST', '/api/admin/customers', {
      channel: 'parallel-install-test',
      brandName: 'PARALLEL TEST',
      subtitle: 'sub',
      updateServer: 'http://10.0.0.1:4231',
    })
    assert.strictEqual(r.status, 200, 'create customer HTTP status (got ' + r.status + ' body=' + r.raw + ')')
    ok('seed: created one customer in fresh DB')
  } catch (e) { fail('create customer', e) }

  // --- Fire two overlapping build requests ---
  try {
    const t0 = Date.now()
    const [r1, r2] = await Promise.all([
      httpReq('POST', '/api/admin/build', { all: true }),
      httpReq('POST', '/api/admin/build', { all: true }),
    ])
    const elapsed = Date.now() - t0
    // Both should succeed (200) — the install pre-flight runs to completion
    // for the first request, and the second arrives to find deps already
    // installed (or, on a slow pre-flight, waits for it to finish). Either
    // way both end up returning a fan-out job list.
    assert.strictEqual(r1.status, 200, 'build #1 HTTP status (got ' + r1.status + ' body=' + r1.raw + ')')
    assert.strictEqual(r2.status, 200, 'build #2 HTTP status (got ' + r2.status + ' body=' + r2.raw + ')')
    assert.ok(Array.isArray(r1.body.jobs) && r1.body.jobs.length >= 1, 'build #1 returns jobs[]')
    assert.ok(Array.isArray(r2.body.jobs) && r2.body.jobs.length >= 1, 'build #2 returns jobs[]')
    ok('both overlapping build requests returned 200 with jobs[] (elapsed=' + elapsed + 'ms)')
  } catch (e) { fail('overlapping build requests', e) }

  // --- THE CORE ASSERTION: exactly ONE npm install ran across both requests ---
  // For two overlapping POST /api/admin/build calls against a fresh tree,
  // a healthy implementation must run npm install EXACTLY ONCE: the
  // install lock holds while request #1's pre-flight runs, and by the
  // time request #2's handler acquires the lock + rechecks, the .bin
  // sentinels exist and rootDepsInstalled() returns true. Anything other
  // than 1 is the regression we are guarding against (2 = parallel
  // installs racing node_modules; 0 = pre-flight bypassed entirely).
  // Originally serialized via spawnSync; Task #16 switched to async
  // spawn + async lock acquire so the event loop stays responsive — the
  // serialization guarantee is now load-bearing on the post-acquire
  // recheck, which the next test below also exercises.
  let observedEvents = []
  let observedIntervals = []
  try {
    observedEvents = parseMarker()
    observedIntervals = pairIntervals(observedEvents)
    const renderEvents = () =>
      '\n        marker events:\n          ' +
      observedEvents.map(e => e.kind + ' pid=' + e.pid + ' t=' + new Date(e.t).toISOString() + ' cwd=' + e.cwd).join('\n          ')
    assert.strictEqual(
      observedIntervals.length, 1,
      'expected EXACTLY 1 npm-install invocation across both overlapping requests, got ' + observedIntervals.length +
      ' — this is the regression we are guarding against' + renderEvents(),
    )
    ok('exactly 1 npm-install invocation observed across both overlapping requests (install lock + post-acquire recheck serialize them)')
  } catch (e) { fail('parallel-install safety: exactly-one invocation', e) }

  // --- Defense-in-depth: even if a future refactor relaxes the
  //     "exactly 1" guarantee (e.g. switches to async install with a
  //     proper lock), the intervals must still never overlap. ---
  try {
    for (let i = 0; i < observedIntervals.length; i++) {
      for (let j = i + 1; j < observedIntervals.length; j++) {
        const a = observedIntervals[i], b = observedIntervals[j]
        assert.ok(!intervalsOverlap(a, b),
          'npm install ran CONCURRENTLY: pid=' + a.pid + ' [' + a.start + '..' + a.end + '] cwd=' + a.cwd +
          ' overlaps pid=' + b.pid + ' [' + b.start + '..' + b.end + '] cwd=' + b.cwd)
      }
    }
    ok('defense-in-depth: no install intervals overlap (' + observedIntervals.length + ' invocation(s) checked)')
  } catch (e) { fail('parallel-install safety: non-overlap', e) }

  // --- Cancel any jobs the requests enqueued so they don't run their
  //     (broken — no real build-customer.js in temp project root) steps. ---
  try {
    const r = await httpReq('GET', '/api/admin/jobs')
    if (r.status === 200 && r.body && r.body.jobs) {
      for (const j of r.body.jobs) {
        if (j.status === 'running' || j.status === 'queued') {
          await httpReq('POST', '/api/admin/jobs/' + j.id + '/cancel')
        }
      }
    }
  } catch (e) { /* best-effort cleanup */ }

  // --- Task #16: install pre-flight must NOT block the event loop ---
  // Reset the project's deps sentinels so the next build request
  // re-enters the install pre-flight (which calls our 600ms busy-wait
  // shim). Then fire a build request AND an unrelated /api/admin/status
  // probe in parallel: the probe must come back well before the build
  // response, proving the handler yielded the event loop while the shim
  // was busy. With the old spawnSync-based pre-flight the probe would
  // queue behind the install and finish strictly AFTER the build.
  try {
    // Wipe .bin/* sentinels so rootDepsInstalled() flips back to false
    // and the next /api/admin/build re-runs the install pre-flight.
    const binDir = path.join(PROJ_DIR, 'node_modules', '.bin')
    if (fs.existsSync(binDir)) {
      for (const f of fs.readdirSync(binDir)) {
        try { fs.unlinkSync(path.join(binDir, f)) } catch (_) {}
      }
    }
    // Truncate the marker so we only see this round's events.
    try { fs.writeFileSync(MARKER, '') } catch (_) {}

    const tBuildStart = Date.now()
    const buildPromise = httpReq('POST', '/api/admin/build', { all: true })
    // Stagger the probe by ~100ms so it lands AFTER the build handler is
    // already inside its async install await — that is the moment we
    // need to prove the event loop is still free.
    const probePromise = new Promise(r => setTimeout(r, 100))
      .then(() => httpReq('GET', '/api/admin/status').then(res => ({ res, t: Date.now() })))
    const [buildRes, probe] = await Promise.all([
      buildPromise.then(res => ({ res, t: Date.now() })),
      probePromise,
    ])
    const buildElapsed = buildRes.t - tBuildStart
    const probeElapsed = probe.t - tBuildStart
    assert.strictEqual(buildRes.res.status, 200, 'build #3 HTTP status (got ' + buildRes.res.status + ')')
    assert.strictEqual(probe.res.status, 200, 'probe HTTP status (got ' + probe.res.status + ')')
    assert.ok(buildElapsed >= 500,
      'build response should take >= ~500ms (the 600ms shim) to prove install actually ran, got ' + buildElapsed + 'ms')
    // The smoking-gun assertion: the unrelated probe came back BEFORE
    // the build did. If spawnSync were still in use, the probe would
    // queue behind the install and finish at >= buildElapsed.
    assert.ok(probe.t < buildRes.t,
      'probe finished AFTER build — install pre-flight blocked the event loop (probe=' + probeElapsed + 'ms, build=' + buildElapsed + 'ms)')
    assert.ok(probeElapsed < 400,
      'probe should respond promptly (< 400ms) while install runs in background, got ' + probeElapsed + 'ms — install is blocking the event loop')
    ok('event loop stays responsive during install pre-flight (probe=' + probeElapsed + 'ms vs build=' + buildElapsed + 'ms)')

    // Cancel any jobs this round enqueued so we don't leave them running.
    try {
      const j = await httpReq('GET', '/api/admin/jobs')
      if (j.status === 200 && j.body && j.body.jobs) {
        for (const jb of j.body.jobs) {
          if (jb.status === 'running' || jb.status === 'queued') {
            await httpReq('POST', '/api/admin/jobs/' + jb.id + '/cancel')
          }
        }
      }
    } catch (e) { /* best-effort */ }
  } catch (e) { fail('event-loop responsiveness during install pre-flight', e) }

  // --- Task #16: SSE stream coalesces high-rate output into batched writes ---
  // The /api/admin/jobs/:id/stream handler buffers entries and flushes at
  // ~OTA_SSE_COALESCE_MS (default 33ms) intervals into ONE res.write per
  // flush. This test enqueues an inline job that produces a burst of log
  // lines, opens an SSE stream, and counts how many distinct TCP chunks
  // we receive. Without coalescing one chunk per line is typical
  // (=== nlines events). With coalescing we expect << nlines chunks.
  try {
    const enqueueRes = await httpReq('POST', '/api/admin/__test_inline_job', {
      lines: 200, label: 'sse-coalesce-test',
    })
    assert.strictEqual(enqueueRes.status, 200, 'inline-job enqueue HTTP status')
    const jobId = enqueueRes.body && enqueueRes.body.jobId
    assert.ok(jobId, 'inline-job enqueue should return jobId')

    // Read the SSE stream raw and count discrete data chunks delivered to
    // the socket (proxy for res.write calls).
    const chunkCount = await new Promise((resolve, reject) => {
      const opts = {
        host: '127.0.0.1', port: SERVER_PORT,
        path: '/api/admin/jobs/' + jobId + '/stream',
        method: 'GET',
        headers: { 'Accept': 'text/event-stream', 'Cookie': cookieHeader },
      }
      const req = http.request(opts, (res) => {
        if (res.statusCode !== 200) return reject(new Error('SSE status ' + res.statusCode))
        let chunks = 0
        let endSeen = false
        let buf = ''
        res.on('data', d => {
          chunks++
          buf += d.toString()
          if (buf.includes('"end":true')) endSeen = true
        })
        res.on('end', () => resolve({ chunks, endSeen, buf }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
      setTimeout(() => reject(new Error('SSE stream timeout')), 10000)
    })
    // Count actual log entries in the buffer to verify nothing was lost.
    const lineMatches = (chunkCount.buf.match(/"line":/g) || []).length
    assert.ok(chunkCount.endSeen, 'SSE stream should end with {end:true}')
    assert.ok(lineMatches >= 200,
      'SSE replay+stream should deliver all 200 lines, got ' + lineMatches)
    // The smoking-gun assertion: we got far fewer TCP chunks than lines.
    // Typical observed: 2-5 chunks for 200 lines (1 replay + a few flushes).
    // We give a generous ceiling (50 chunks) so this isn't flaky on slow
    // CI but still catches a regression to per-line writes (=200+ chunks).
    assert.ok(chunkCount.chunks <= 50,
      'SSE stream should coalesce ~200 lines into <=50 TCP chunks (got ' + chunkCount.chunks + ' — coalescing regressed)')
    ok('SSE stream coalesces ' + lineMatches + ' lines into ' + chunkCount.chunks + ' TCP chunks')
  } catch (e) { fail('SSE coalescing', e) }

  await stopServer()

  // --- Cleanup tmp dir ---
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch (e) {}

  console.log('')
  if (failed === 0) {
    console.log('=== ALL TESTS PASSED ===')
    process.exit(0)
  } else {
    console.log('=== ' + failed + ' TEST(S) FAILED ===')
    console.log('=== ' + passed + ' passed ===')
    process.exit(1)
  }
}

// Catch-all so an unhandled rejection doesn't leave the server child
// orphaned and the temp dir un-cleaned.
process.on('unhandledRejection', async (e) => {
  console.error('unhandledRejection:', e && e.stack || e)
  await stopServer().catch(() => {})
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch (_) {}
  process.exit(1)
})

run().catch(async (e) => {
  fail('run()', e)
  await stopServer().catch(() => {})
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch (_) {}
  process.exit(1)
})
