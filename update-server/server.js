// =====================================================================
// SELF-HEALING DEPENDENCY PREFLIGHT
// =====================================================================
// Operators sometimes unzip a fresh copy of update-server/ on a Windows RDP
// box and run `node server.js` directly without first running `npm install`.
// That used to crash with `Error: Cannot find module 'express'` and a
// 30-line stack trace. The preflight below detects that failure mode and
// auto-installs deps once, then re-execs the server. It costs ~0 ms on
// normal startups (the require succeeds immediately and we fall through).
//
// We deliberately gate the auto-install on (a) node_modules/ being missing
// AND (b) a package.json sitting next to server.js — that way a developer
// who has intentionally deleted node_modules to debug something doesn't
// get a surprise install, and we never run npm install in some unrelated
// directory that happens to have the script symlinked.
;(function preflight() {
  const _path = require('path')
  const _fs = require('fs')
  const here = __dirname
  const nodeModulesDir = _path.join(here, 'node_modules')
  const pkgJson = _path.join(here, 'package.json')
  // Guard 1: only act if package.json is present (i.e. we're sitting in
  // the actual update-server folder, not some weird relocation).
  if (!_fs.existsSync(pkgJson)) return
  // Guard 2: skip the whole preflight if node_modules already has express
  // resolvable. Cheap: try a require.resolve first.
  try { require.resolve('express'); return } catch (_) { /* fall through */ }
  console.log('')
  console.log('============================================================')
  console.log(' OTA SERVER — first-run dependency install')
  console.log('============================================================')
  console.log(' node_modules/ is missing or incomplete (express not found).')
  console.log(' Running `npm install` once to fix this. This usually takes')
  console.log(' 30-90 seconds depending on your internet connection.')
  console.log('')
  if (_fs.existsSync(nodeModulesDir)) {
    console.log(' (Existing node_modules/ found but express is missing — npm')
    console.log('  install will repair it.)')
  }
  console.log('------------------------------------------------------------')
  const _cp = require('child_process')
  // npm.cmd on Windows, npm elsewhere. shell:true on Windows is required so
  // .cmd resolution works; on POSIX shell:false is fine and safer.
  const isWin = process.platform === 'win32'
  const npmCmd = isWin ? 'npm.cmd' : 'npm'
  const r = _cp.spawnSync(npmCmd, ['install', '--no-audit', '--no-fund'], {
    cwd: here,
    stdio: 'inherit',
    shell: isWin,
  })
  if (r.status !== 0) {
    console.error('')
    console.error('============================================================')
    console.error(' [ERROR] npm install failed (exit code ' + r.status + ').')
    console.error('============================================================')
    console.error(' Please open a terminal in this folder and run manually:')
    console.error('   cd ' + here)
    console.error('   npm install')
    console.error(' Then re-run:')
    console.error('   node server.js')
    console.error(' If npm itself is missing, install Node.js LTS from')
    console.error(' https://nodejs.org/ (which bundles npm) and try again.')
    console.error('============================================================')
    process.exit(1)
  }
  console.log('------------------------------------------------------------')
  console.log(' [OK] Dependencies installed. Starting OTA server…')
  console.log('============================================================')
  console.log('')
  // Fall through to the normal require() chain below — express is now
  // installed, so the requires that previously failed will now succeed.
  // We deliberately don't re-exec the process: Node's require() looks at
  // node_modules/ on disk for each call, so the next `require('express')`
  // will find the freshly installed module without restart.
})()

const express = require('express')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
const cookieParser = require('cookie-parser')
const multer = require('multer')

const dbApi = require('./db')
const live = require('./live')
const { cleanupAfterBuild, cleanupCancelledJob } = require('./cleanup')
const jobRunner = require('./job-runner')
const sourceBuild = require('./source-build')
const { acquireInstallLock, acquireInstallLockAsync } = require('./install-lock')

const PORT = parseInt(process.env.OTA_PORT || '4231', 10)
const HOST = process.env.OTA_HOST || '0.0.0.0'

const PUBLIC_DIR = path.join(__dirname, 'public')
const UPDATES_DIR = path.join(PUBLIC_DIR, 'updates')
const ADMIN_DIR = path.join(PUBLIC_DIR, 'admin')

if (!fs.existsSync(UPDATES_DIR)) fs.mkdirSync(UPDATES_DIR, { recursive: true })

// Read this from package.json so we can show "Server v1.x.y" in the admin
// topbar and the launcher (matching what the user runs locally).
const SERVER_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version }
  catch (e) { return null }
})()

// Build stamp computed at boot. Lets the operator confirm in the admin UI
// which copy of update-server/ is actually running, so questions like "is the
// SSE crash fix really deployed?" can be answered without reading stack
// traces. The contentHash is a sha256 of the server's core source files
// (truncated to 7 hex chars) — same idea as a git short rev, but works on
// Windows machines that never installed git.
const BUILD_STAMP = (() => {
  const sourceFiles = [
    path.join(__dirname, 'server.js'),
    path.join(__dirname, 'job-runner.js'),
    path.join(__dirname, 'live.js'),
    path.join(__dirname, 'cleanup.js'),
    path.join(__dirname, 'db.js'),
    path.join(__dirname, 'package.json'),
  ]
  const hash = crypto.createHash('sha256')
  let newestMtime = 0
  for (const f of sourceFiles) {
    try {
      const buf = fs.readFileSync(f)
      // Mix the basename + a NUL delimiter into the hash before the bytes.
      // This way, content moved between files (or a file becoming empty)
      // produces a different digest, not the same one.
      hash.update(path.basename(f) + '\0')
      hash.update(buf)
      hash.update('\0')
      const m = fs.statSync(f).mtimeMs
      if (m > newestMtime) newestMtime = m
    } catch (_) { /* file missing — ignored, hash still distinguishes builds */ }
  }
  const builtAt = newestMtime > 0 ? new Date(newestMtime).toISOString() : null
  return {
    version: SERVER_VERSION,
    builtAt,
    contentHash: hash.digest('hex').slice(0, 7),
    node: process.version,
    bootedAt: new Date().toISOString(),
  }
})()

const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,49}$/
const VERSION_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/
function isValidChannel(c) { return typeof c === 'string' && CHANNEL_RE.test(c) }
function isValidVersion(v) { return typeof v === 'string' && VERSION_RE.test(v) }

// Admin password is set manually via the OTA_ADMIN_PASSWORD environment
// variable. There is no auto-generation and no .admin-password file — the
// operator is expected to set this in .env (or in the start.bat / .replit
// command line) the same way they would set DB_PASSWORD or any other secret.
function resolveAdminPassword() {
  const v = process.env.OTA_ADMIN_PASSWORD
  if (!v || typeof v !== 'string' || v.length < 1) {
    console.error('')
    console.error('============================================')
    console.error('  FATAL: OTA_ADMIN_PASSWORD is not set.')
    console.error('============================================')
    console.error('  Set it in .env or on the start.bat command line:')
    console.error('    set OTA_ADMIN_PASSWORD=your-password-here')
    console.error('    node server.js')
    console.error('  (Use at least 8 characters in production.)')
    console.error('============================================')
    process.exit(1)
  }
  if (v.length < 8) {
    console.warn('[server] WARNING: OTA_ADMIN_PASSWORD is shorter than 8 characters — please use a stronger password.')
  }
  return v
}
const ADMIN_PASSWORD = resolveAdminPassword()

function findProjectRoot() {
  // As of May 2026, update-server/ lives at the REPO ROOT, sibling of walok/
  // (rather than inside walok/) so that "zip walok/" produces a clean,
  // unambiguous launcher source bundle. The old in-walok layout is still
  // supported by the `__dirname + '..'` candidate so a user on the RDP who
  // hasn't migrated yet keeps working.
  const candidates = [
    process.env.OTA_PROJECT_ROOT,
    path.join(__dirname, '..', 'walok'),  // NEW layout: ../walok
    path.join(__dirname, '..'),            // LEGACY layout: walok was parent of update-server
    path.join(__dirname, '..', '..'),
    process.cwd(),
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      const pkgPath = path.join(c, 'package.json')
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        if (pkg.name === 'nextreme-gaming-hub' || fs.existsSync(path.join(c, 'customers'))) {
          return path.resolve(c)
        }
      }
    } catch (e) {}
  }
  return null
}

const PROJECT_ROOT = findProjectRoot()
const CUSTOMERS_DIR = PROJECT_ROOT ? path.join(PROJECT_ROOT, 'customers') : null
const BRANDING_DIR = PROJECT_ROOT ? path.join(PROJECT_ROOT, 'branding') : null

console.log('[server] PROJECT_ROOT=' + (PROJECT_ROOT || 'NOT FOUND - admin builds will be disabled'))
console.log('[server] SERVER_VERSION=v' + (SERVER_VERSION || '?'))

// One-shot migration of customers/*.json -> SQLite, then keep customers/*.json
// in sync as a mirror so the existing build scripts can still read JSON files
// without knowing about the DB.
if (CUSTOMERS_DIR) {
  const m = dbApi.migrateFromJson(CUSTOMERS_DIR)
  if (m.migrated > 0) console.log('[db] migrated ' + m.migrated + ' customer(s) from JSON -> SQLite (skipped ' + m.skipped + ')')
  else if (m.alreadyDone) console.log('[db] customers already migrated; ' + dbApi.listCustomers().length + ' in DB')
  // Backfill MUST run BEFORE syncJsonMirror so the mirror writes the rewritten
  // per-channel logo paths back to customers/*.json. Without this, every
  // multi-customer install that pre-dates the rewriteLegacyLogoPath helper
  // would silently keep shipping the build-all logo-leakage bug forever.
  const b = dbApi.backfillLogoPaths(BRANDING_DIR)
  if (b.rewritten > 0) console.log('[db] backfilled ' + b.rewritten + ' customer logo path(s) from shared branding/logo.* to per-channel filenames')
  if (b.failures && b.failures.length > 0) {
    // Don't crash — broken file copies are recoverable on the next start
    // (meta flag wasn't set), but the operator must SEE this so they can
    // diagnose disk permission / missing-file issues.
    console.log('[db] WARN: backfillLogoPaths deferred due to ' + b.failures.length + ' failure(s):')
    for (const f of b.failures) console.log('[db]   - ' + f)
  }
  dbApi.syncJsonMirror(CUSTOMERS_DIR)

  // Pre-flight: warn (don't fail) when a customer's configured logo file is
  // missing on disk. The build will throw a clear error when that customer
  // is built, but surfacing it at boot lets the operator fix it before they
  // hit BUILD-ALL and watch one customer fail mid-batch.
  for (const c of dbApi.listCustomers()) {
    if (!c.logo) continue
    const abs = path.isAbsolute(c.logo) ? c.logo : path.join(__dirname, '..', c.logo)
    if (!fs.existsSync(abs)) {
      console.log('[db] WARN: customer "' + c.channel + '" logo missing on disk: ' + c.logo + ' — build for this customer will fail until you upload a logo')
    }
  }
}

const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// Async `npm install` wrapper used by the build pre-flight. Returns a
// Promise that resolves on exit code 0 and rejects with a descriptive
// Error on any other outcome. Critically, this does NOT block the event
// loop while npm runs, so the admin panel + every other route stay
// responsive during a fresh-tree first build (Task #16). Output is
// captured (not streamed) because the install pre-flight runs OUTSIDE
// any job and has no SSE listener — surfacing the tail of stderr in the
// rejection error gives the operator something to diagnose.
function runNpmInstallAsync(cwd, label) {
  const { spawn } = require('child_process')
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(NPM_CMD, ['install', '--no-audit', '--no-fund'], {
        cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      reject(new Error('npm install spawn failed for ' + label + ' deps: ' + e.message))
      return
    }
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', e => reject(new Error('npm install error for ' + label + ' deps: ' + e.message)))
    child.on('exit', (code) => {
      if (code === 0) return resolve()
      reject(new Error('npm install failed for ' + label + ' deps (exit ' + code + '): ' + (stderr || stdout).slice(0, 800)))
    })
  })
}

function hasNpmBin(rootDir, name) {
  const binDir = path.join(rootDir, 'node_modules', '.bin')
  if (!fs.existsSync(binDir)) return false
  const candidates = [name, name + '.cmd', name + '.ps1']
  for (const c of candidates) {
    if (fs.existsSync(path.join(binDir, c))) return true
  }
  return false
}
function rootDepsInstalled() {
  if (!PROJECT_ROOT) return false
  return hasNpmBin(PROJECT_ROOT, 'vite') && hasNpmBin(PROJECT_ROOT, 'electron-builder')
}
function serverDepsInstalled() {
  if (!PROJECT_ROOT) return false
  const serverDir = path.join(PROJECT_ROOT, 'server')
  if (!fs.existsSync(serverDir)) return false
  return hasNpmBin(serverDir, 'electron-builder')
}
function depsStatus() {
  return {
    root: rootDepsInstalled(),
    server: serverDepsInstalled(),
    serverDirExists: PROJECT_ROOT ? fs.existsSync(path.join(PROJECT_ROOT, 'server')) : false,
  }
}

const PLACEHOLDER_URL_RE = /YOUR[-_.]?(RDP|SERVER|IP|HOST)|change[-_]?me|example\.com|placeholder|configure[-_]?your/i
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

function normalizeIp(ip) {
  if (!ip) return ''
  return String(ip).replace(/^::ffff:/, '').toLowerCase()
}
function isLoopbackIp(ip) {
  const v = normalizeIp(ip)
  return v === '127.0.0.1' || v === '::1' || v === 'localhost' || v.startsWith('127.')
}
function classifyUpdateServerUrl(url, requestIp) {
  if (!url || typeof url !== 'string') return 'placeholder'
  if (PLACEHOLDER_URL_RE.test(url)) return 'placeholder'
  let host
  try {
    const u = new URL(url)
    host = (u.hostname || '').toLowerCase()
    if (!host) return 'placeholder'
  } catch (e) { return 'placeholder' }
  if (LOOPBACK_HOSTS.has(host) && requestIp && !isLoopbackIp(requestIp)) {
    return 'loopback-when-remote'
  }
  return ''
}

const SESSION_SECRET = crypto.randomBytes(32).toString('hex')
function signToken(value) {
  const h = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex')
  return value + '.' + h
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false
  const idx = token.lastIndexOf('.')
  if (idx < 0) return false
  const value = token.slice(0, idx)
  const sig = token.slice(idx + 1)
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex')
  if (sig.length !== expected.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false
  try {
    const data = JSON.parse(Buffer.from(value, 'base64').toString('utf-8'))
    if (Date.now() > data.exp) return false
    return data
  } catch (e) { return false }
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.ota_admin || (req.headers.authorization || '').replace(/^Bearer /, '')
  const payload = verifyToken(token)
  if (!payload) return res.status(401).json({ error: 'unauthorized' })
  req.admin = payload
  next()
}

function getChannelInfo(channel) {
  const manifestPath = path.join(UPDATES_DIR, channel, 'latest.json')
  if (!fs.existsSync(manifestPath)) return null
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) }
  catch (e) { return null }
}

function getProjectVersion() {
  if (!PROJECT_ROOT) return null
  try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8')).version }
  catch (e) { return null }
}

// Per-customer build version policy:
//   The version is taken VERBATIM from the global "Set Version" field
//   (persisted in walok/package.json) — operators control bumping explicitly.
//   No auto-increment.
//
// Why no auto-bump:
//   The previous strategy auto-incremented the patch from each customer's
//   prior published version on every build. That removed operator control —
//   click Build twice without touching anything and the version silently
//   walked from 1.0.0 -> 1.0.1 -> 1.0.2, surprising operators who expected
//   "still 1.0.0 because I didn't change anything".
//
// Same-version re-publish:
//   The DB already tracks idempotent re-publishes via the rebump counter
//   (db.js _recordLauncherTx / _recordServerTx) — when the new version
//   equals the prior version, launcher_rebuild_count++ and the admin UI
//   shows "Rebump xN". Clients won't pull the rebuild because the OTA
//   manifest version is unchanged; that's the correct semantic for "I'm
//   reshipping the same release".
//
// To actually ship an update to clients:
//   The operator updates the global "Set Version" field to a higher version
//   (e.g. 1.0.0 -> 1.0.1) before clicking Build. POST /api/admin/version
//   writes the new value to walok/package.json + walok/server/package.json,
//   and subsequent builds pick it up here.
function computeNextVersion(_channel) {
  return getProjectVersion() || '1.0.0'
}

// NOTE: The legacy in-file BUILD_LOCKS + JOBS + runChain implementation has
// been replaced by ./job-runner.js, which provides:
//   * a 2-slot worker queue (was: single per-channel atomic lock)
//   * real CANCEL that kills the spawned child process tree (was: stub)
//   * per-job isolated workspace + dist-electron-<jobId>/ output dirs
//     (eliminates the EPERM-on-dist-electron crashes the field reported when
//     a previous build's leftover handles blocked the next build's wipe)
//   * EPERM-tolerant cleanup with retry/backoff on Windows AV/Explorer locks
// Helpers below adapt the old "jobAppend" signature so the bulk-upload route
// (which still drives a job inline) keeps working.
const jobAppend = jobRunner.jobAppend
const jobEmitPhase = jobRunner.jobEmitPhase

// Set of SSE listeners on /api/admin/jobs/stream that get a fresh snapshot
// whenever the worker pool's ACTIVE or QUEUE changes. Wired into job-runner
// via setOnSlotChange below.
const jobRunnerOnSlotListeners = new Set()
jobRunner.setOnSlotChange(() => {
  for (const send of jobRunnerOnSlotListeners) {
    try { send() } catch (_) {}
  }
})

const app = express()
app.set('trust proxy', 'loopback')
app.use(cookieParser())
app.use(express.json({ limit: '2mb' }))

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.set('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.get('/', (req, res) => {
  const channels = fs.existsSync(UPDATES_DIR)
    ? fs.readdirSync(UPDATES_DIR).filter(d => fs.statSync(path.join(UPDATES_DIR, d)).isDirectory())
    : []
  res.type('html').send(
`<!DOCTYPE html>
<html><head><title>OTA Update Server</title>
<style>
body{font-family:'Segoe UI',sans-serif;background:#0a0806;color:#ff6a00;padding:40px;max-width:900px;margin:0 auto}
h1{font-family:'Courier New',monospace;letter-spacing:2px;border-bottom:1px solid #ff6a00;padding-bottom:10px}
h2{color:#ffaa66;margin-top:30px}
code{background:#1a1410;padding:3px 8px;border-radius:3px;color:#fff}
.channel{background:#1a1410;padding:15px;margin:10px 0;border-left:3px solid #ff6a00;border-radius:4px}
.channel a{color:#ffaa66;text-decoration:none}
.channel a:hover{color:#fff}
.muted{color:#666;font-size:13px}
.adminbtn{display:inline-block;background:linear-gradient(135deg,#ff6a00,#ff8c30);color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:800;letter-spacing:2px;margin-top:14px;text-transform:uppercase;box-shadow:0 0 20px rgba(255,106,0,.5)}
.adminbtn:hover{background:linear-gradient(135deg,#ff8c30,#ffb070)}
.ver{color:#777;font-size:11px;letter-spacing:2px}
</style></head><body>
<h1>OTA UPDATE SERVER <span class="ver">v${SERVER_VERSION || '?'}</span></h1>
<p>Status: <strong style="color:#0f0">RUNNING</strong> on port ${PORT}</p>
<p class="muted">Listening on ${HOST}:${PORT} — clients should connect using your machine's IP address (or RDP public IP).</p>
<a href="/admin/" class="adminbtn">&gt;&gt; OPEN ADMIN PANEL</a>

<h2>Available Channels (${channels.length})</h2>
${channels.length === 0
  ? '<p class="muted">No channels yet. Open the admin panel and click BUILD on a customer to populate.</p>'
  : channels.map(c => `<div class="channel"><strong>${c}</strong><br><a href="/updates/${c}/latest.json">/updates/${c}/latest.json</a></div>`).join('')
}

<h2>Endpoints</h2>
<ul>
  <li><code>GET /updates/&lt;channel&gt;/latest.json</code> — manifest with latest version + payload URL</li>
  <li><code>GET /updates/&lt;channel&gt;/&lt;version&gt;/launcher-payload.zip</code> — payload</li>
  <li><code>GET /api/live/&lt;channel&gt;/&lt;role&gt;/&lt;instance&gt;</code> — SSE live push channel for clients</li>
  <li><code>GET /health</code> — health check</li>
  <li><code>GET /admin/</code> — admin panel (login required)</li>
</ul>
</body></html>`)
})

app.get('/health', (req, res) => res.json({
  status: 'ok',
  port: PORT,
  time: new Date().toISOString(),
  projectRoot: PROJECT_ROOT,
  buildsAvailable: !!PROJECT_ROOT,
  serverVersion: SERVER_VERSION,
}))

// Per-customer "receive OTA updates" gate. Mounted BEFORE the /updates static
// mount so when an admin disables a customer the latest.json fetch returns 404
// (launcher's checkForUpdate already treats !=200 as "no update"). Both the
// launcher channel (`<ch>/latest.json`) and the server-side channel
// (`<ch>-server/latest.json`) are gated by the SAME customer row — disabling
// a customer cuts off both halves at once. Requests for any other path under
// /updates (e.g. payload zips) fall through to the static handler unchanged
// so an in-progress download already begun by an enabled-then-disabled client
// is not interrupted mid-stream.
app.get('/updates/:channelOrServer/latest.json', (req, res, next) => {
  const param = req.params.channelOrServer
  // Resolve `param` to a customer row. There are two channel shapes that hit
  // this gate:
  //   1. `<ch>/latest.json`         — launcher manifest for customer `<ch>`.
  //   2. `<ch>-server/latest.json`  — server manifest for customer `<ch>`.
  // Naively stripping `-server` is unsafe: a real customer whose channel
  // genuinely ENDS in `-server` (e.g. someone names their cafe
  // "old-server") would have its launcher manifest mistakenly mapped to
  // a different (or nonexistent) customer, defeating the gate. So we try
  // an EXACT lookup first, and only fall back to the suffix-stripped
  // lookup when the literal channel doesn't exist as a customer.
  let customer = null
  let dbFailed = false
  try {
    customer = dbApi.getCustomer(param)
    if (!customer && param.endsWith('-server')) {
      const base = param.slice(0, -'-server'.length)
      customer = dbApi.getCustomer(base)
    }
  } catch (e) {
    // DB read failed unexpectedly. For a kill-switch we fail CLOSED — better
    // to serve a temporary 503 than to silently leak an update to a customer
    // who is supposed to be disabled. The launcher already treats !=200 as
    // "no update available", so this is a safe stall.
    dbFailed = true
    console.warn('[ota-gate] customer lookup failed for', param, e && e.message)
  }
  if (dbFailed) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    return res.status(503).json({ error: 'temporary lookup failure, retry later' })
  }
  if (customer && customer.updatesEnabled === false) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    return res.status(404).json({ error: 'updates disabled for this customer' })
  }
  return next()
})

app.use('/updates', express.static(UPDATES_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.json')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.set('Content-Type', 'application/json')
    } else if (filePath.endsWith('.zip')) {
      res.set('Cache-Control', 'public, max-age=86400')
    }
  }
}))

// ============ LIVE PUSH (clients) ============

// SSE stream for installed launchers / server.exe processes. They open this
// once at start-up and keep it open; the server pushes {type:'update'}
// immediately when an admin publishes a new build for their channel.
app.get('/api/live/:channel/:role/:instance', (req, res) => {
  const { channel, role, instance } = req.params
  if (!isValidChannel(channel)) return res.status(400).end()
  if (role !== 'launcher' && role !== 'server') return res.status(400).end()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(instance)) return res.status(400).end()
  // Reject unknown channels to stop spoofed presence / registry-churn from
  // any client that can guess the URL shape. The registry stays clean.
  if (!dbApi.getCustomer(channel)) return res.status(404).end()
  const version = typeof req.query.v === 'string' && req.query.v.length <= 32 ? req.query.v : null
  const ip = normalizeIp(req.ip || req.connection?.remoteAddress)
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 256)

  res.set('Content-Type', 'text/event-stream')
  res.set('Cache-Control', 'no-cache')
  res.set('Connection', 'keep-alive')
  res.set('X-Accel-Buffering', 'no')
  res.flushHeaders()
  // Same defense as the admin SSE routes — async write-after-end (or any
  // other late stream error) on the launcher live-push channel must NEVER
  // crash the whole update-server process. live.broadcast() try/catches the
  // synchronous write but cannot catch the async 'error' event the stream
  // emits when the socket is half-closed mid-broadcast.
  res.on('error', () => {})

  const send = (payload) => {
    try { res.write('data: ' + JSON.stringify(payload) + '\n\n') }
    catch (e) {}
  }
  const close = () => { try { res.end() } catch (e) {} }

  // Confirm registration to the client and replay current published version
  // so a client that just came online doesn't miss an update that landed
  // while it was offline.
  const channelInfo = getChannelInfo(role === 'server' ? channel + '-server' : channel)
  send({
    type: 'hello',
    channel, role, instance,
    serverVersion: SERVER_VERSION,
    publishedVersion: channelInfo ? channelInfo.version : null,
  })

  live.addClient({ channel, role, instance, version, ip, userAgent, send, close })

  const heartbeatTimer = setInterval(() => {
    try {
      res.write(': ping\n\n')
      live.touchClient(channel, role, instance)
    } catch (e) {}
  }, live.HEARTBEAT_MS)

  req.on('close', () => {
    clearInterval(heartbeatTimer)
    live.removeClient(channel, role, instance)
  })
})

// HTTP-based heartbeat fallback for clients whose SSE connection is blocked
// by a corporate proxy / aggressive NAT — they can fall back to plain POST
// every 60s and still appear "online" in the admin.
app.post('/api/live/:channel/:role/:instance/heartbeat', (req, res) => {
  const { channel, role, instance } = req.params
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  if (role !== 'launcher' && role !== 'server') return res.status(400).json({ error: 'invalid role' })
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(instance)) return res.status(400).json({ error: 'invalid instance' })
  if (!dbApi.getCustomer(channel)) return res.status(404).json({ error: 'unknown channel' })
  const version = req.body && typeof req.body.version === 'string' ? req.body.version : null
  const ok = live.touchClient(channel, role, instance, { version })
  if (!ok) {
    // Client wasn't in registry — auto-register a "ghost" entry that has no
    // SSE socket so the admin still sees them as online.
    const ip = normalizeIp(req.ip || req.connection?.remoteAddress)
    live.addClient({
      channel, role, instance, version, ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 256),
      send: () => {}, close: () => {},
    })
  }
  res.json({ ok: true, registered: !ok })
})

// ============ ADMIN ROUTES ============

app.use('/admin', express.static(ADMIN_DIR, { index: 'index.html', redirect: true }))

const LOGIN_FAILS = new Map()
function loginThrottle(ip) {
  const now = Date.now()
  const rec = LOGIN_FAILS.get(ip) || { count: 0, lockedUntil: 0 }
  if (rec.lockedUntil && now < rec.lockedUntil) return rec.lockedUntil - now
  if (rec.lockedUntil && now >= rec.lockedUntil) { rec.count = 0; rec.lockedUntil = 0 }
  return 0
}
function loginFail(ip) {
  const rec = LOGIN_FAILS.get(ip) || { count: 0, lockedUntil: 0 }
  rec.count++
  if (rec.count >= 5) { rec.lockedUntil = Date.now() + 5 * 60 * 1000; rec.count = 0 }
  LOGIN_FAILS.set(ip, rec)
}
function loginOk(ip) { LOGIN_FAILS.delete(ip) }

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown'
  const wait = loginThrottle(ip)
  if (wait > 0) return res.status(429).json({ error: 'too many failed attempts, locked for ' + Math.ceil(wait/1000) + 's' })
  const { password } = req.body || {}
  if (typeof password !== 'string') return res.status(400).json({ error: 'password required' })
  const expected = Buffer.from(ADMIN_PASSWORD)
  const got = Buffer.from(password)
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    loginFail(ip)
    return res.status(401).json({ error: 'invalid password' })
  }
  loginOk(ip)
  const exp = Date.now() + 1000 * 60 * 60 * 12
  const value = Buffer.from(JSON.stringify({ exp })).toString('base64')
  const token = signToken(value)
  res.cookie('ota_admin', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 })
  res.json({ ok: true, expiresAt: exp })
})

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('ota_admin')
  res.json({ ok: true })
})

app.get('/api/admin/status', (req, res) => {
  const token = req.cookies?.ota_admin || (req.headers.authorization || '').replace(/^Bearer /, '')
  const payload = verifyToken(token)
  res.json({
    authenticated: !!payload,
    projectRoot: PROJECT_ROOT,
    buildsAvailable: !!PROJECT_ROOT,
    version: getProjectVersion(),
    serverVersion: SERVER_VERSION,
    deps: depsStatus(),
    // Mirrored so the admin UI gets the build stamp on its first request
    // (no second round-trip needed).
    buildStamp: BUILD_STAMP,
  })
})

// Read-only build identifier for the running update-server process. Lets the
// operator confirm which copy of update-server/ is actually running, so
// "is the SSE crash fix really deployed?" can be answered in seconds.
//
// Note: this GET coexists with the POST /api/admin/version handler defined
// later in this file (which bumps the PROJECT version, a different concept).
// Express dispatches by method, so both can share the path. If you find this
// confusing while reading the code, an equivalent alias is exposed at
// GET /api/admin/build-info — same payload, same auth.
function sendBuildStamp(req, res) {
  res.json(BUILD_STAMP)
}
app.get('/api/admin/version', requireAdmin, sendBuildStamp)
app.get('/api/admin/build-info', requireAdmin, sendBuildStamp)

app.get('/api/admin/customers', requireAdmin, (req, res) => {
  if (!PROJECT_ROOT) return res.status(503).json({ error: 'project root not found — cannot manage customers' })
  const reqIp = req.ip || req.connection?.remoteAddress || ''
  const onlineSnapshot = live.snapshot()
  const customers = dbApi.listCustomers().map(c => {
    const launcherInfo = getChannelInfo(c.channel)
    const serverInfo = getChannelInfo(c.channel + '-server')
    // Authoritative source for "what the operator can download" is a 2-step
    // resolution: prefer the on-disk manifest version (always matches the
    // payload zip we published), fall back to the DB-recorded version if
    // the manifest read failed for any reason (e.g. publish-update.js
    // exited mid-write, manifest got hand-edited, fs glitch). Without the
    // DB fallback the UI silently hides the download link even though the
    // build was recorded as successful.
    const launcherVersion = launcherInfo?.version || c.launcherVersion || null
    const serverVersion = serverInfo?.version || c.serverVersion || null
    // Verify the actual payload zip exists on disk. The manifest can claim
    // a version but the zip file itself may be missing (interrupted publish,
    // overzealous cleanup, manual deletion). Without this check the UI
    // shows a [download] link that 404s when clicked — confusing the user.
    //
    // Defense-in-depth: validate channel + version against the same regexes
    // the upload routes use BEFORE building a filesystem path. The values
    // come from a JSON manifest we wrote and a DB column we wrote, so they
    // should already be safe — but a corrupted manifest or a future code
    // path that bypasses the regex could otherwise sneak ".." into a
    // path.join. Cheap to add, eliminates an entire class of bugs.
    const safeForPath = (v) => typeof v === 'string' && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v)
    const launcherFileExists = launcherVersion && safeForPath(launcherVersion)
      ? fs.existsSync(path.join(UPDATES_DIR, c.channel, launcherVersion, 'launcher-payload.zip'))
      : false
    const serverFileExists = serverVersion && safeForPath(serverVersion)
      ? fs.existsSync(path.join(UPDATES_DIR, c.channel + '-server', serverVersion, 'server-payload.zip'))
      : false
    const cls = classifyUpdateServerUrl(c.updateServer, reqIp)
    const online = onlineSnapshot[c.channel] || { launchers: [], servers: [], total: 0 }
    return {
      ...c,
      _launcherVersion: launcherVersion,
      _serverVersion: serverVersion,
      _launcherReleased: launcherInfo?.releasedAt || null,
      _serverReleased: serverInfo?.releasedAt || null,
      _launcherFileExists: launcherFileExists,
      _serverFileExists: serverFileExists,
      // Rebump indicators — non-zero means the operator has reshipped the
      // current version that many times via Build From Uploaded Source.
      // The UI shows a small pill next to the version with the latest
      // rebump timestamp so the operator can confirm "did my re-upload
      // actually go out?".
      _launcherRebumpCount: c.launcherRebuildCount || 0,
      _launcherRebumpAt: c.launcherRebuiltAt || null,
      _serverRebumpCount: c.serverRebuildCount || 0,
      _serverRebumpAt: c.serverRebuiltAt || null,
      _placeholderUrl: cls !== '',
      _urlIssue: cls || null,
      _online: online,
    }
  })
  res.json({
    customers,
    version: getProjectVersion(),
    serverVersion: SERVER_VERSION,
    deps: depsStatus(),
    requestIsRemote: reqIp ? !isLoopbackIp(reqIp) : false,
  })
})

app.post('/api/admin/customers', requireAdmin, (req, res) => {
  if (!CUSTOMERS_DIR) return res.status(503).json({ error: 'project root not found' })
  const { channel, brandName, subtitle, updateServer, logo } = req.body || {}
  if (!channel || !brandName || !subtitle || !updateServer) {
    return res.status(400).json({ error: 'channel, brandName, subtitle, updateServer required' })
  }
  if (!isValidChannel(channel)) {
    return res.status(400).json({ error: 'channel must be lowercase letters, numbers, dashes only (1-50 chars)' })
  }
  const stored = dbApi.upsertCustomer({ channel, brandName, subtitle, updateServer, logo: logo || null })
  dbApi.syncJsonMirror(CUSTOMERS_DIR, channel)
  res.json({ ok: true, customer: stored })
})

// Toggle the per-customer "receive OTA updates" master switch. Single-field
// PATCH-style endpoint (modeled as POST since the rest of this API is POST).
// Body: { enabled: boolean }. Returns the updated customer row, or 404 when
// the channel doesn't exist. Disabling causes /updates/<ch>/latest.json (and
// the matching `-server` variant) to return 404, which the launcher treats
// as "no update available" — no client-side change required.
app.post('/api/admin/customers/:channel/updates-enabled', requireAdmin, (req, res) => {
  const channel = req.params.channel
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  const enabled = !!(req.body && req.body.enabled)
  const updated = dbApi.setUpdatesEnabled(channel, enabled)
  if (!updated) return res.status(404).json({ error: 'customer not found' })
  res.json({ ok: true, customer: updated })
})

// ----- Netflix cookies (per-customer) ---------------------------------------
// The operator pastes cookies exported from a logged-in browser session
// (Chrome extension "Get cookies.txt LOCALLY" → Export As JSON) and the
// launcher fetches them on Netflix-tile click to pre-populate its
// ephemeral popup session — so the cafe customer lands directly on the
// "Who's Watching?" screen without typing a password.
//
// Threat model — be honest with the operator about it:
//   • The /updates/<channel>/netflix-cookies.json endpoint is PUBLIC, gated
//     only by knowing the channel name. Channel names live inside every
//     shipped launcher binary (ota-config.json) — anyone who can run the
//     launcher can read the channel and curl this endpoint. This is the
//     same threat model as the existing /updates/<channel>/latest.json.
//   • A leaked Netflix session cookie = full account takeover until the
//     account holder forces a sign-out from netflix.com → Account →
//     "Sign out of all devices". The OTA admin should treat this as a
//     "share my Netflix login with every cafe customer who has the
//     launcher" decision, NOT a "cafe customers individually log in"
//     decision.
//   • Cookies expire — Netflix's NetflixId session typically lasts ~1
//     year, but a forced sign-out invalidates it instantly. When a cookie
//     stops working, every launcher in the channel breaks at once until
//     the operator re-pastes a fresh export.

app.get('/api/admin/customers/:channel/netflix-cookies', requireAdmin, (req, res) => {
  const channel = req.params.channel
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  if (!dbApi.getCustomer(channel)) return res.status(404).json({ error: 'customer not found' })
  const cookies = dbApi.getNetflixCookies(channel)
  res.json({ ok: true, cookies: cookies || [], hasCookies: !!cookies })
})

// Cookies that Netflix marks as HttpOnly in the browser. When the operator
// pastes the raw "document.cookie" string format (which strips attributes
// and only gives us name=value pairs), we restore HttpOnly on these so
// Electron sets them with the same flag Netflix expects. Other cookies
// stay non-HttpOnly so Netflix's frontend JS can still read them.
const NETFLIX_HTTPONLY_COOKIES = new Set(['NetflixId', 'SecureNetflixId'])

// Parse a browser "Cookie:" header style string into Electron-compatible
// cookie objects. Input looks like: "name1=value1; name2=value2; ..."
// This is what you get from Chrome DevTools → Application → Cookies →
// "Copy as cURL" / right-click "Copy value", or from running
// `document.cookie` in the JS console while logged into Netflix.
function parseCookieHeaderString(str, domain = '.netflix.com') {
  const oneYearFromNow = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365
  return str
    .split(/;\s*/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=')
      if (eq < 1) return null
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!name) return null
      return {
        domain,
        name,
        value,
        path: '/',
        secure: true,
        httpOnly: NETFLIX_HTTPONLY_COOKIES.has(name),
        expirationDate: oneYearFromNow,
      }
    })
    .filter(Boolean)
}

app.post('/api/admin/customers/:channel/netflix-cookies', requireAdmin, (req, res) => {
  const channel = req.params.channel
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  // Body shape: { cookiesJson: "<raw JSON string OR raw cookie-header string>" }
  // OR { cookies: <array> } OR { clear: true } to wipe.
  // Accepts THREE input formats for cookiesJson — auto-detected:
  //   1. JSON array (from "Get cookies.txt LOCALLY" extension → Export as JSON)
  //   2. JSON object (rare; rejected so user gets a clear error)
  //   3. Raw cookie-header string "name=value; name2=value2; ..."
  //      (from Chrome DevTools console: document.cookie)
  let cookiesJson = null
  if (req.body && req.body.clear) {
    cookiesJson = null
  } else if (req.body && Array.isArray(req.body.cookies)) {
    cookiesJson = JSON.stringify(req.body.cookies)
  } else if (req.body && typeof req.body.cookiesJson === 'string') {
    const trimmed = req.body.cookiesJson.trim()
    if (!trimmed) {
      return res.status(400).json({ error: 'cookiesJson is empty' })
    }
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      // JSON path
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON: ' + e.message })
      }
      if (!Array.isArray(parsed)) {
        return res.status(400).json({ error: 'Cookies must be a JSON array' })
      }
      cookiesJson = JSON.stringify(parsed)
    } else if (trimmed.includes('=')) {
      // Cookie-header string path — auto-convert to Electron cookie objects.
      const converted = parseCookieHeaderString(trimmed)
      if (converted.length === 0) {
        return res.status(400).json({ error: 'Could not parse any name=value pairs from input. Expected JSON array OR "name=value; name2=value2; ..." string.' })
      }
      cookiesJson = JSON.stringify(converted)
    } else {
      return res.status(400).json({ error: 'Unrecognized format. Paste a JSON array OR a "name=value; name2=value2; ..." cookie string.' })
    }
  } else {
    return res.status(400).json({ error: 'expected cookiesJson string, cookies array, or clear:true' })
  }
  const result = dbApi.setNetflixCookies(channel, cookiesJson)
  if (!result.ok) return res.status(400).json({ error: result.error })
  res.json({ ok: true, count: result.count })
})

// PUBLIC — launcher fetches at click time. See threat-model note above.
app.get('/updates/:channel/netflix-cookies.json', (req, res) => {
  const channel = req.params.channel
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  if (!dbApi.getCustomer(channel)) return res.status(404).json({ error: 'channel not found' })
  const cookies = dbApi.getNetflixCookies(channel)
  if (!cookies) return res.status(404).json({ error: 'no cookies configured' })
  res.setHeader('Cache-Control', 'no-store')
  res.json({ cookies })
})

app.delete('/api/admin/customers/:channel', requireAdmin, (req, res) => {
  if (!CUSTOMERS_DIR) return res.status(503).json({ error: 'project root not found' })
  const channel = req.params.channel
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  if (!dbApi.getCustomer(channel)) return res.status(404).json({ error: 'not found' })
  dbApi.deleteCustomer(channel)
  dbApi.syncJsonMirror(CUSTOMERS_DIR, channel)
  // Sweep on-disk artifacts for this channel so a future BUILD ALL doesn't
  // try to publish a stale folder. Covers:
  //   - update-server/public/updates/<channel>/        (launcher manifests + payloads)
  //   - update-server/public/updates/<channel>-server/ (server manifests + payloads)
  //   - releases/<channel>/                            (electron-builder output, used by publish-update --all)
  const sweepDirs = [
    path.join(UPDATES_DIR, channel),
    path.join(UPDATES_DIR, channel + '-server'),
  ]
  if (PROJECT_ROOT) sweepDirs.push(path.join(PROJECT_ROOT, 'releases', channel))
  for (const d of sweepDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) {}
  }
  res.json({ ok: true })
})

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!BRANDING_DIR) return cb(new Error('project root not found'))
      if (!fs.existsSync(BRANDING_DIR)) fs.mkdirSync(BRANDING_DIR, { recursive: true })
      cb(null, BRANDING_DIR)
    },
    filename: (req, file, cb) => {
      const channel = req.params.channel
      if (!isValidChannel(channel)) return cb(new Error('invalid channel'))
      const ext = path.extname(file.originalname).toLowerCase()
      const allowedExt = ['.png', '.jpg', '.jpeg', '.webp', '.bmp']
      const safeExt = allowedExt.includes(ext) ? ext : '.png'
      cb(null, channel + '-logo' + safeExt)
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'].includes(file.mimetype)
    cb(ok ? null : new Error('Only PNG/JPG/WEBP/BMP allowed'), ok)
  },
})

app.post('/api/admin/customers/:channel/logo', requireAdmin, (req, res) => {
  if (!isValidChannel(req.params.channel)) return res.status(400).json({ error: 'invalid channel' })
  upload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'no file' })
    const channel = req.params.channel
    const c = dbApi.getCustomer(channel)
    if (c) {
      const logo = path.posix.join('branding', req.file.filename)
      dbApi.upsertCustomer({ ...c, logo })
      dbApi.syncJsonMirror(CUSTOMERS_DIR, channel)
    }
    res.json({ ok: true, logo: 'branding/' + req.file.filename })
  })
})

// Serve the customer's uploaded logo to the admin UI so the customer card
// can render the real brand mark inside the avatar tile (instead of just
// the brand initial). Auth-gated — branding files are not part of the
// public update payload, so we never expose them via express.static.
//
// Returns 404 (not 4xx + JSON) when missing so an <img onerror> can swap
// to the letter-fallback without firing console errors as JSON parses.
app.get('/api/admin/customers/:channel/logo', requireAdmin, (req, res) => {
  if (!isValidChannel(req.params.channel)) return res.status(400).end()
  if (!PROJECT_ROOT) return res.status(503).end()
  const c = dbApi.getCustomer(req.params.channel)
  if (!c || !c.logo) return res.status(404).end()
  // c.logo is stored as a relative POSIX path like "branding/<channel>-logo.png".
  // Resolve against PROJECT_ROOT and then verify the resolved path is STILL
  // inside BRANDING_DIR — defends against a maliciously-crafted DB row with
  // "../" or absolute paths sneaking outside the branding directory.
  const abs = path.isAbsolute(c.logo) ? c.logo : path.resolve(PROJECT_ROOT, c.logo)
  if (!BRANDING_DIR || !abs.startsWith(BRANDING_DIR + path.sep)) {
    return res.status(404).end()
  }
  if (!fs.existsSync(abs)) return res.status(404).end()
  // Use revalidation (not max-age) so a re-upload of a logo with the same
  // filename — which is the common case for "<channel>-logo.png" — is
  // picked up by the browser immediately. express.sendFile sets ETag +
  // Last-Modified automatically, so the conditional GET that follows is
  // a tiny 304 round-trip and not a full re-download.
  res.setHeader('Cache-Control', 'private, no-cache, must-revalidate')
  res.sendFile(abs)
})

app.post('/api/admin/version', requireAdmin, (req, res) => {
  if (!PROJECT_ROOT) return res.status(503).json({ error: 'project root not found' })
  const { version } = req.body || {}
  if (!isValidVersion(version)) return res.status(400).json({ error: 'invalid version (expected x.y.z)' })
  for (const rel of ['package.json', 'server/package.json']) {
    const p = path.join(PROJECT_ROOT, rel)
    if (fs.existsSync(p)) {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'))
      pkg.version = version
      fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
    }
  }
  res.json({ ok: true, version })
})

// ============ SINGLE BUILD ROUTE ============
// Always: build → publish → cleanup → live push.
// No more separate BUILD-only or PUBLISH-only flows in the admin UI.
app.post('/api/admin/build', requireAdmin, async (req, res) => {
  if (!PROJECT_ROOT) return res.status(503).json({ error: 'project root not found — cannot run builds' })
  // Mutex with /api/admin/update-source: refuse to enqueue while a master
  // source replacement is in flight, otherwise the new job could dequeue
  // and start reading the source dir mid-rename.
  if (_sourceUpdateInFlight) {
    return res.status(409).json({
      error: 'master source is being replaced right now — wait for the upload to finish, then try again',
    })
  }
  // Refuse if the live source on disk is in a partial / mixed state from a
  // prior overlay-fallback that died midway. The operator MUST successfully
  // re-upload that role's source before any further build, otherwise we'd
  // ship a half-applied tree to customers.
  const partialKinds = []
  try {
    if (dbApi.getSourcePartial('launcher')) partialKinds.push('launcher')
    if (dbApi.getSourcePartial('server')) partialKinds.push('server')
  } catch (_) {}
  if (partialKinds.length > 0) {
    return res.status(409).json({
      error: 'source tree is in a partial / mixed state from a previous failed upload (' + partialKinds.join(', ') + ') — re-upload that source via the Update Source Files panel before building',
      partialKinds,
    })
  }
  const { channel, all, version, dryRun, roles } = req.body || {}
  if (!all && !isValidChannel(channel)) return res.status(400).json({ error: 'channel required (or pass all:true)' })
  if (version && !isValidVersion(version)) return res.status(400).json({ error: 'invalid version (expected x.y.z)' })

  // roles: optional ['launcher'] | ['server']. undefined / null / [] / both
  // present = full build (default). Plumbed to the build-customer.js child
  // process as BUILD_ROLE which controls which electron-builder substeps
  // run; publish-update.js then auto-skips the role whose <role>-unpacked/
  // doesn't exist, so a launcher-only build correctly leaves the customer's
  // server payload untouched (and vice versa).
  let roleFilter = null
  if (Array.isArray(roles) && roles.length > 0) {
    const valid = ['launcher', 'server']
    const filtered = roles.filter(r => valid.includes(r))
    if (filtered.length === 0) {
      return res.status(400).json({ error: 'roles must contain "launcher" and/or "server"' })
    }
    // Single-role filter only makes sense when exactly one is selected; when
    // both are listed treat it as "no filter" (= both, the default).
    if (filtered.length === 1) roleFilter = filtered[0]
  }

  const reqIp = req.ip || req.connection?.remoteAddress || ''
  const targetChannels = all ? dbApi.listCustomers().map(c => c.channel) : [channel]
  if (targetChannels.length === 0) {
    return res.status(400).json({ error: 'no customers configured — add one before building' })
  }

  // Resolve per-customer build version BEFORE spawning anything:
  //   - explicit `version` from request: used for ALL target channels (admin
  //     override, e.g. emergency major bump from a one-off API call).
  //   - otherwise: every customer ships at the global project version (the
  //     value last written by /api/admin/version aka "Set Version"). No
  //     auto-bump — see computeNextVersion() above for the rationale.
  // perChannelVersion is captured by both the per-channel build steps AND
  // the post-build cleanup/push callback, so they always agree on what was
  // just shipped.
  const perChannelVersion = {}
  for (const ch of targetChannels) {
    perChannelVersion[ch] = version || computeNextVersion(ch)
  }

  // Dry-run: resolve next version per channel and return immediately, no
  // lock + no spawn + no source mutation. Used by the admin UI to preview
  // "next BUILD will ship as v1.0.X" badges, and by automated tests to
  // assert auto-bump correctness without invoking electron-builder.
  if (dryRun) {
    return res.json({ dryRun: true, perChannelVersion })
  }

  // === SKIP-SAME-VERSION: only when all=true (Build All Customers) ===
  // Build All is a "ship anything that needs shipping" sweep — if a customer
  // has already published the resolved target version for the requested
  // role(s), rebuilding would just churn out an identical payload. Skip them
  // and report the skip in the response so the UI can show the operator
  // exactly which customers were no-ops.
  //
  // Per-customer / per-role buttons (single `channel` in the request) are
  // explicit operator intent — typically a "rebump" to re-ship the same
  // version after a config / branding tweak. Those are NEVER skipped, even
  // when the version matches what's already on disk; the operator can see the
  // version field on the card and clicked Build deliberately.
  //
  // Edge cases:
  //   - Brand-new customer (launcherVersion=null): null !== "1.0.4" so it
  //     gets built. First-time builds always run.
  //   - Half-shipped customer (launcher=1.0.4, server=null) with a FULL build
  //     request: BOTH roles must match the target to skip, so the partial
  //     gets built to catch the missing role up.
  //   - Build All + roleFilter='launcher': only checks launcherVersion. A
  //     customer whose launcher matches but whose server is stale won't have
  //     its server rebuilt (correctly — operator only asked for launchers).
  const skippedChannels = []
  let workingChannels = targetChannels
  if (all) {
    workingChannels = []
    for (const ch of targetChannels) {
      const cust = dbApi.getCustomer(ch)
      const v = perChannelVersion[ch]
      const lv = cust ? (cust.launcherVersion || null) : null
      const sv = cust ? (cust.serverVersion || null)   : null
      let alreadyAtVersion
      if (roleFilter === 'launcher')      alreadyAtVersion = lv === v
      else if (roleFilter === 'server')   alreadyAtVersion = sv === v
      else                                alreadyAtVersion = lv === v && sv === v
      if (alreadyAtVersion) {
        skippedChannels.push({
          channel: ch,
          version: v,
          role: roleFilter || 'both',
          reason: 'already on v' + v,
        })
      } else {
        workingChannels.push(ch)
      }
    }
    // All customers were already on the target version — nothing to enqueue.
    // Return a successful response (NOT an error) with the skip details so
    // the UI can show "all N customers already on v1.0.4" instead of looking
    // like the build silently failed.
    if (workingChannels.length === 0) {
      return res.json({
        jobs: [],
        jobIds: [],
        skipped: skippedChannels,
        allSkipped: true,
        version: perChannelVersion[targetChannels[0]] || null,
      })
    }
  }

  // Per-customer fan-out: each customer gets ITS OWN job, scoped to a single
  // channel. The job-runner's 2-slot worker pool then runs up to MAX_CONCURRENT
  // of these in parallel; channel-conflict avoidance (channels=[ch] declared on
  // every job) ensures two independent customers can build simultaneously
  // while a duplicate-channel resubmission would still serialize.
  //
  // Each job's onCancel fires cleanupCancelledJob to sweep any half-published
  // payload + raw build output for THAT channel only — siblings are
  // unaffected.
  const serverDir = path.join(PROJECT_ROOT, 'server')

  // CRITICAL: when fanning out N parallel build jobs, all N junction the SAME
  // PROJECT_ROOT/node_modules into their workspace. Putting `npm install` in
  // every per-job step list would let two concurrent jobs run npm install
  // against that one shared node_modules at the same time — npm is NOT
  // concurrency-safe on a shared install target and you get nondeterministic
  // EEXIST / partial-write failures. Solution: do the install ONCE here in
  // the request handler before any job is enqueued. On the typical operator
  // machine deps are already populated (rootDepsInstalled()===true) so this
  // is a noop; on a truly fresh tree we block this one request, but the
  // event loop stays free (see below) so other admin requests + SSE flushes
  // continue to work.
  //
  // Cross-process filesystem lock so two OTA server instances against
  // the same PROJECT_ROOT can't run `npm install` concurrently against
  // shared node_modules. Acquired only when an install is actually
  // needed; rechecked after acquire in case a sibling just finished.
  //
  // Task #16 fix: async lock acquire + async spawn. The previous
  // implementation used Atomics.wait + spawnSync which froze the entire
  // OTA server (admin UI, build SSE streams, every other handler) until
  // npm install returned. With two concurrent build requests (e.g. the
  // operator double-clicked BUILD ALL on a fresh tree) the freeze stacked
  // and the panel felt hung. acquireInstallLockAsync polls via setTimeout
  // and the spawn awaits 'exit' — both yield the event loop.
  if (!rootDepsInstalled() || (fs.existsSync(serverDir) && !serverDepsInstalled())) {
    let lock
    try {
      lock = await acquireInstallLockAsync(PROJECT_ROOT, { maxWaitMs: 120000 })
    } catch (e) {
      if (e.code === 'EINSTALLLOCKED') {
        return res.status(503).json({
          error: 'another OTA server instance is currently installing dependencies in this project root. Try again in a moment. Lock owner: ' + (e.owner || 'unknown'),
        })
      }
      return res.status(503).json({ error: 'failed to acquire install lock: ' + e.message })
    }
    try {
      // RECHECK after acquiring the lock — a sibling request that arrived
      // ~ms before us may have just finished installing while we were
      // polling. Without this recheck we would re-run npm install on a
      // fully-populated tree (slow + noisy + makes the
      // test-build-endpoint.js "exactly 1 invocation" assertion flaky).
      const installSteps = []
      if (!rootDepsInstalled()) installSteps.push({ cwd: PROJECT_ROOT, label: 'root' })
      if (fs.existsSync(serverDir) && !serverDepsInstalled()) installSteps.push({ cwd: serverDir, label: 'server' })
      for (const s of installSteps) {
        lock.touch() // keep mtime fresh across a multi-step install
        try {
          await runNpmInstallAsync(s.cwd, s.label)
        } catch (e) {
          return res.status(503).json({ error: e.message })
        }
      }
    } finally {
      lock.release()
    }
  }

  function enqueueOneCustomerJob(ch) {
    const v = perChannelVersion[ch]
    const steps = []
    // When the operator clicked the per-customer "Launcher" or "Server"
    // button, roleFilter is set and we tag the step label + child env so
    // the build-customer.js script knows to skip the other role's
    // electron-builder substep. Tag flows up to the BUILD CONSOLE header
    // ("Build customer FOO v1.2.3 [LAUNCHER ONLY]") so the operator can
    // tell at a glance that this isn't a full build.
    const roleTag = roleFilter ? ' [' + roleFilter.toUpperCase() + ' ONLY]' : ''
    const stepEnv = { BUILD_VERSION: v }
    if (roleFilter) stepEnv.BUILD_ROLE = roleFilter
    steps.push({
      label: 'Build customer "' + ch + '" v' + v + roleTag,
      cmd: process.execPath, args: ['scripts/build-customer.js', ch],
      cwd: '.',
      env: stepEnv,
      // No `phase` here — build-customer.js prints [SUBSTEP_BEGIN] markers
      // for each of its 5 inner phases (rebrand → vite → pack-launcher →
      // pack-server → collect), and the job-runner translates those into
      // jobEmitPhase calls so the bar advances 5 times during this single
      // step instead of jumping from `workspace` straight to `publish`.
    })
    steps.push({
      label: 'Ship "' + ch + '" v' + v + roleTag + ' to update server',
      cmd: process.execPath, args: ['scripts/publish-update.js', ch],
      cwd: '.',
      // BUILD_ROLE plumbed through for log-clarity only — publish-update.js
      // already auto-skips a role whose <role>-unpacked/ doesn't exist on
      // disk, so the actual filtering happens implicitly.
      env: roleFilter
        ? { BUILD_VERSION: v, OTA_UPDATES_DIR: UPDATES_DIR, BUILD_ROLE: roleFilter }
        : { BUILD_VERSION: v, OTA_UPDATES_DIR: UPDATES_DIR },
      phase: 'publish', // single-process step — emit at step entry.
    })

    const job = jobRunner.enqueueBuildJob({
      label: 'build-' + ch,
      channels: [ch],
      projectRoot: PROJECT_ROOT,
      steps,
      onComplete: (exitCode, j) => {
        if (exitCode !== 0) return
        try {
          const summary = cleanupAfterBuild({
            projectRoot: PROJECT_ROOT,
            updatesPublicDir: UPDATES_DIR,
            channels: [ch],
            version: v,
          })
          for (const s of summary) {
            const removed = [
              ...(s.releases.removed || []).map(x => 'releases/' + x),
              ...(s.published.removed || []).map(x => 'updates/' + x),
              ...(s.publishedServer.removed || []).map(x => 'updates-server/' + x),
            ]
            if (removed.length > 0) {
              jobAppend(j, '[cleanup] ' + s.channel + ' — removed: ' + removed.join(', '))
            }
          }
        } catch (e) {
          jobAppend(j, '[cleanup] WARN: ' + ch + ': ' + e.message)
        }
        // ROLE-AWARE BOOKKEEPING. When the operator clicked the per-customer
        // "Launcher" or "Server" button (roleFilter set), we must only
        // record + push the role we actually built — recording the
        // untouched role would (a) bump its rebump counter against the
        // wrong manifest and (b) push a stale "update available" to clients
        // that don't have a new payload waiting. roleFilter === null means
        // a full build (both roles).
        const didLauncher = roleFilter === null || roleFilter === 'launcher'
        const didServer   = roleFilter === null || roleFilter === 'server'
        try {
          if (didLauncher) dbApi.recordLauncherPublished(ch, v)
          if (didServer)   dbApi.recordServerPublished(ch, v)
          dbApi.recordBuild(ch)
        } catch (e) {
          jobAppend(j, '[db] WARN: failed to record version for ' + ch + ': ' + e.message)
        }
        const launcherCount = didLauncher
          ? live.broadcast(ch, { type: 'update', version: v, role: 'launcher' })
          : 0
        const serverCount = didServer
          ? live.broadcast(ch, { type: 'update', version: v, role: 'server' })
          : 0
        const roleLabel = roleFilter ? ' [' + roleFilter + ' only]' : ''
        jobAppend(j, '[live-push] ' + ch + ' v' + v + roleLabel + ' -> ' + (launcherCount + serverCount) + ' online client(s)')
      },
      onCancel: (j) => {
        // CRITICAL: only sweep filesystem state if THIS job actually ran a
        // build step. If j.startedAt is null we cancelled while still queued —
        // the job never produced anything, but a SIBLING job for the same
        // (channel, version) might be actively writing into those exact
        // dirs (e.g. operator double-submitted "build all" while a previous
        // run is still in-flight, channel-conflict serializes the second
        // pass; cancelling the queued one must NOT delete the running one's
        // output). The hook still fires for traceability — just skips rm.
        if (j.startedAt === null) {
          jobAppend(j, '[cancel-cleanup] queued-cancel: skipping filesystem sweep (job never started — sibling job for same channel may still be writing)')
          return
        }
        // Sweep this ONE channel's half-published payload + raw build output.
        // Strict path-containment is enforced inside cleanupCancelledJob;
        // siblings (other customers' jobs) are not touched even if they
        // share PROJECT_ROOT and UPDATES_DIR.
        try {
          const result = cleanupCancelledJob({
            projectRoot: PROJECT_ROOT,
            updatesPublicDir: UPDATES_DIR,
            channel: ch,
            version: v,
          })
          if (result.removed.length > 0) {
            jobAppend(j, '[cancel-cleanup] removed: ' + result.removed.join(', '))
          } else {
            jobAppend(j, '[cancel-cleanup] nothing to remove (no half-published files for ' + ch + ' v' + v + ')')
          }
          for (const sk of result.skipped) {
            jobAppend(j, '[cancel-cleanup] SKIPPED ' + sk.path + ': ' + sk.reason)
          }
        } catch (e) {
          jobAppend(j, '[cancel-cleanup] WARN: ' + e.message)
        }
      },
    })

    // Pre-pend per-job header lines so the SSE stream sees them as soon as
    // it connects (they live on the job's output buffer, not stdout of any
    // child process).
    jobAppend(job, '== Customer "' + ch + '" -> v' + v)
    const c = dbApi.getCustomer(ch)
    if (c) {
      const cls = classifyUpdateServerUrl(c.updateServer, reqIp)
      if (cls === 'placeholder') {
        jobAppend(job, '!! WARNING: customer "' + ch + '" still has a PLACEHOLDER updateServer (' + c.updateServer + ').')
        jobAppend(job, '!! The launcher built from this config will NOT receive OTA updates until you set the URL to your real RDP IP.')
      } else if (cls === 'loopback-when-remote') {
        jobAppend(job, '!! WARNING: customer "' + ch + '" has updateServer = ' + c.updateServer + ' (loopback address).')
        jobAppend(job, '!! You are accessing this admin panel REMOTELY — installed launchers will dial THEIR own loopback, not this server, and never receive updates.')
      }
    }
    jobAppend(job, '')
    return job
  }

  const jobs = workingChannels.map(enqueueOneCustomerJob)
  const queueState = jobRunner.getQueueState()
  const jobSummaries = jobs.map(job => ({
    jobId: job.id,
    channel: job.channels[0],
    version: perChannelVersion[job.channels[0]],
    status: job.status,
    queuePosition: job.status === 'queued' ? queueState.queued.indexOf(job.id) + 1 : null,
  }))

  // Response shape:
  //   - all=true  -> {jobs: [...], jobIds: [...], skipped: [...]} (new fan-out shape)
  //   - single ch -> {jobId, status, queuePosition} for back-compat with any
  //     scripted callers, plus jobs/jobIds for new callers.
  // `skipped` is always present on Build All responses (empty array if
  // nothing was skipped) so the UI can rely on its existence; absent on
  // single-channel responses since per-customer builds never skip.
  const body = {
    jobs: jobSummaries,
    jobIds: jobSummaries.map(s => s.jobId),
  }
  if (all) body.skipped = skippedChannels
  if (!all && jobs.length === 1) {
    body.jobId = jobs[0].id
    body.status = jobs[0].status
    body.queuePosition = jobSummaries[0].queuePosition
  }
  res.json(body)
})

// ============ UPDATE SOURCE FILES (master source replacement) ============
// One-shot endpoint: operator uploads a .zip of the launcher source (replaces
// walok/src/) OR the server source (replaces walok/server/). The next time
// the operator clicks "Build All Customers" (or any per-customer Build /
// Launcher / Server button), the build pipeline reads from the freshly
// replaced master source — there is NO per-build source upload anymore.
//
// This replaces the old "Build From Uploaded Source" + per-customer
// "Upload Update" flows, both of which uploaded a payload PER BUILD. The new
// model is: master source on disk is the source of truth, the operator
// updates it explicitly when needed, and builds reuse it.
//
// Safety:
//   - 500 MB upload cap (multer). Source trees fit comfortably; rejecting
//     larger uploads protects the OTA host's RAM (multer.memoryStorage
//     buffers the entire upload before we touch disk).
//   - Refuses with 409 if any build job is currently RUNNING — replacing
//     master source mid-build would corrupt the in-progress copy.
//   - Atomic replace via tmp + rename + async-rmrf-trash. Concurrent reads
//     (an in-flight build that started before this request) always see
//     either the old or the new tree, never a half-extracted state.
//   - Strict zip validation: PK magic, zip-slip refusal, per-entry +
//     total-size caps (reuses primitives from source-build.js).
//   - Validates extracted shape: launcher must contain package.json (and
//     either electron/main.js or main.js); server must contain package.json
//     and electron/main.js. Hard-fail before the rename, so a bad upload
//     doesn't take down the master source.
//
// Per-zip upload cap. Source trees fit easily under 500 MB even with images
// and prebuilt binaries; if you legitimately need more, raise this and the
// host's RAM headroom together.
const uploadSource = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
})

function _hasActiveBuildJob() {
  // job-runner exposes listJobs() returning every known job (queued +
  // running + finished). Treat 'running' AND 'cancelling' as blocking
  // for a master-source swap — both can still have a child build process
  // alive that's reading walok/src or walok/server. 'queued' is OK since
  // those jobs haven't read anything yet, and the build endpoint's own
  // 409 against `_sourceUpdateInFlight` prevents new ones from queuing
  // while we're swapping.
  try {
    const jobs = jobRunner.listJobs()
    return jobs.some(j => j.status === 'running' || j.status === 'cancelling')
  } catch (_) { return false }
}

// Mutex flag: TRUE while /api/admin/update-source is between its initial
// 409 gate and its final rename/cleanup. Cleared in `finally`. The build
// endpoint refuses 409 while this is set, closing the TOCTOU window where
// a build could enqueue + start running mid-extract and then read a
// half-swapped source tree. Set/cleared synchronously to avoid races
// between concurrent /api/admin/update-source requests too.
let _sourceUpdateInFlight = false

function _validateExtractedSourceShape(rootDir, kind) {
  // The launcher zip = the CONTENTS of walok/src/ (App.jsx, main.jsx,
  // index.css, components/, store/, ...). It does NOT contain a top-level
  // package.json or electron/ — those live one level up in walok/. Reject
  // an obviously-wrong "full repo" upload (which would clobber walok/src
  // with a totally different tree shape).
  // The server zip = the CONTENTS of walok/server/ (electron/, src/,
  // package.json, package-lock.json) — package.json + electron/main.js
  // ARE expected here.
  if (kind === 'launcher') {
    const required = ['main.jsx', 'App.jsx']
    const missing = required.filter(f => !fs.existsSync(path.join(rootDir, f)))
    if (missing.length > 0) {
      throw new Error('launcher zip is missing ' + missing.join(' + ') + ' — expected the CONTENTS of walok/src/ (App.jsx, main.jsx, index.css, components/, store/), not a full project')
    }
    // Belt-and-suspenders: a top-level electron/ directory means the
    // operator zipped walok/ instead of walok/src/. Catch that too.
    if (fs.existsSync(path.join(rootDir, 'electron'))) {
      throw new Error('launcher zip contains a top-level electron/ directory — looks like you zipped walok/ instead of walok/src/. Re-zip with the CONTENTS of walok/src/ at the top level.')
    }
  } else if (kind === 'server') {
    if (!fs.existsSync(path.join(rootDir, 'package.json'))) {
      throw new Error('server zip is missing top-level package.json — expected the CONTENTS of walok/server/')
    }
    if (!fs.existsSync(path.join(rootDir, 'electron', 'main.js'))) {
      throw new Error('server zip is missing electron/main.js — expected the CONTENTS of walok/server/')
    }
  }
}

// Windows-friendly rename with retry. On Linux/macOS rename is atomic and
// pretty much always succeeds, but on Windows ANY open handle inside the
// directory (Explorer window viewing it, editor with a file open, antivirus
// scan in progress, vite dev server, ...) causes EPERM/EBUSY. Most of those
// transient locks resolve within 1-2 seconds, so retry with backoff before
// giving up. Total wait at default settings: ~3 seconds across 5 attempts.
async function _renameWithRetry(src, dst, label) {
  const codes = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])
  const delays = [100, 200, 400, 800, 1600] // ms
  let lastErr = null
  for (let i = 0; i <= delays.length; i++) {
    try {
      fs.renameSync(src, dst)
      if (i > 0) console.log('[update-source] ' + label + ' rename succeeded on attempt ' + (i + 1))
      return
    } catch (e) {
      lastErr = e
      if (!codes.has(e.code) || i === delays.length) break
      console.log('[update-source] ' + label + ' rename ' + e.code + ', retrying in ' + delays[i] + 'ms (attempt ' + (i + 2) + '/' + (delays.length + 1) + ')')
      await new Promise(r => setTimeout(r, delays[i]))
    }
  }
  throw lastErr
}

// Per-file copy with retry (Windows files inside a locked-but-not-itself-
// locked dir can still EBUSY transiently — e.g. Defender mid-scan).
async function _copyFileWithRetry(src, dst) {
  const codes = new Set(['EPERM', 'EBUSY', 'EACCES'])
  const delays = [50, 150, 400, 1000]
  let lastErr = null
  for (let i = 0; i <= delays.length; i++) {
    try {
      await fs.promises.copyFile(src, dst)
      return
    } catch (e) {
      lastErr = e
      if (!codes.has(e.code) || i === delays.length) break
      await new Promise(r => setTimeout(r, delays[i]))
    }
  }
  throw lastErr
}

// FALLBACK strategy when atomic rename can't get the parent dir lock
// (persistent OneDrive sync handle, Defender always-on scan on Desktop,
// etc.). Walks the new-source tree and overlays it onto the live tree
// FILE-BY-FILE — never renames or removes the live directory itself, so
// it works even when the live dir is held by an external process. After
// the overlay, walks the live tree and deletes any file that wasn't in
// the new source (so deletions in the new tree propagate). Less atomic
// than rename — there's a brief window where the live tree is a mix of
// old and new files — but the build endpoint's `_sourceUpdateInFlight`
// mutex prevents a build from reading during this window, so the loss
// of atomicity doesn't matter in practice.
async function _overlayDirFallback(srcDir, destDir) {
  // Phase 1: collect every file path in srcDir (relative to srcDir).
  const srcFiles = new Set()
  async function walk(dir, rel) {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const ent of ents) {
      const r = rel ? rel + path.sep + ent.name : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(abs, r)
      } else if (ent.isFile()) {
        srcFiles.add(r)
      }
    }
  }
  await walk(srcDir, '')
  // Phase 2: copy every srcDir file to destDir, mkdir-p as needed.
  for (const rel of srcFiles) {
    const from = path.join(srcDir, rel)
    const to = path.join(destDir, rel)
    await fs.promises.mkdir(path.dirname(to), { recursive: true })
    await _copyFileWithRetry(from, to)
  }
  // Phase 3: walk destDir, remove anything not in srcFiles.
  async function prune(dir, rel) {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const ent of ents) {
      const r = rel ? rel + path.sep + ent.name : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await prune(abs, r)
        // Remove the dir itself if it ended up empty (fully deleted in new tree).
        try {
          const remain = await fs.promises.readdir(abs)
          if (remain.length === 0) await fs.promises.rmdir(abs)
        } catch (_) {}
      } else if (ent.isFile() && !srcFiles.has(r)) {
        try { await fs.promises.unlink(abs) } catch (_) {}
      }
    }
  }
  await prune(destDir, '')
}

// Try the atomic rename swap first. If it fails because the live dir
// itself is locked (EPERM/EBUSY), fall back to file-by-file overlay so
// the operator isn't stuck. Returns { strategy: 'rename'|'overlay',
// partial: boolean }. `partial` is set when the overlay died midway
// and the live tree is in a mixed state — the caller MUST persist
// that flag so future builds refuse until the operator re-uploads.
// `markPartialFn` is an optional callback (kind → void) invoked the
// moment we know we're past the point of no return on the overlay
// path (i.e. at least one new file has been copied into the live
// tree). It MUST be synchronous + best-effort — we don't await it
// because we want the partial marker on disk before any further
// failure point.
async function _swapDirSafely(tmpDir, targetDir, trashDir, markPartialFn) {
  const liveExists = fs.existsSync(targetDir)
  if (!liveExists) {
    await _renameWithRetry(tmpDir, targetDir, 'tmp→live (fresh)')
    return { strategy: 'rename', partial: false }
  }
  // Try the clean atomic path first.
  let liveMovedToTrash = false
  try {
    await _renameWithRetry(targetDir, trashDir, 'live→trash')
    liveMovedToTrash = true
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'ENOTEMPTY') {
      console.log('[update-source] atomic rename blocked (' + e.code + '), falling back to file-by-file overlay')
      // Mark partial BEFORE the first copy lands. If the overlay later
      // succeeds we'll clear the marker; if it crashes between here and
      // the success line, the marker stays set so builds refuse.
      try { if (markPartialFn) markPartialFn() } catch (_) {}
      try {
        await _overlayDirFallback(tmpDir, targetDir)
        // Best-effort cleanup of tmp; the overlay copied everything we needed.
        try { await fs.promises.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
        return { strategy: 'overlay', partial: false }
      } catch (overlayErr) {
        const hint = ' — atomic rename was blocked AND the file-by-file fallback also failed PARTWAY through, so the live source tree is now in a MIXED state (some new files, some old). Builds will be refused until you re-upload successfully. On Windows the likely culprits are: (1) the project is on Desktop / OneDrive — move it to e.g. C:\\walok\\ to escape persistent sync handles, (2) a code editor (VSCode/Notepad++) has files in walok\\src open — close it, (3) Windows Defender real-time scan is holding a handle — add the project folder to Defender exclusions, (4) a launcher .exe or vite dev process is running against this source — stop it.'
        const err = new Error('overlay fallback failed (' + overlayErr.code + '): ' + overlayErr.message + hint)
        err.code = overlayErr.code
        err._partial = true
        throw err
      }
    }
    // Other error codes (e.g. ENOENT, ENOSPC) → bubble unchanged. Live
    // dir was never moved, so no rollback needed.
    throw e
  }
  // live→trash succeeded; now move tmp→live. If THIS step fails the live
  // dir is currently nowhere — we MUST roll back trash→live or the OTA
  // server is left with no source on disk and nothing to build from.
  try {
    await _renameWithRetry(tmpDir, targetDir, 'tmp→live')
  } catch (renameErr) {
    // Rollback. Use plain renameSync (no retry loop) so a rollback
    // failure surfaces fast — there's nothing better we can do.
    try {
      fs.renameSync(trashDir, targetDir)
      console.log('[update-source] tmp→live failed, rolled back trash→live successfully')
    } catch (rollbackErr) {
      console.error('[update-source] CRITICAL: tmp→live failed AND trash→live rollback failed. Live source dir: ' + targetDir + ' / trash: ' + trashDir + ' / rollbackErr: ' + rollbackErr.message)
      const e = new Error('atomic swap failed AND rollback failed — live source dir is now empty: ' + renameErr.message + ' / rollback: ' + rollbackErr.message)
      e.code = renameErr.code
      throw e
    }
    throw new Error('atomic swap failed (rolled back to old source): ' + renameErr.message)
  }
  _scheduleTrashRemoval(trashDir)
  return { strategy: 'rename', partial: false }
}

// rmrf the trash dir without blocking the response. We don't care if it
// fails — the worst case is leftover .trash-* dirs which the operator can
// clean up manually. Logged but never thrown.
function _scheduleTrashRemoval(trashDir) {
  setImmediate(() => {
    fs.promises.rm(trashDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
      .catch(e => console.log('[update-source] WARN: failed to rm trash dir ' + trashDir + ': ' + e.message))
  })
}

app.post('/api/admin/update-source',
  requireAdmin,
  (req, res, next) => {
    uploadSource.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message })
      next()
    })
  },
  async (req, res) => {
    if (!PROJECT_ROOT) return res.status(503).json({ error: 'project root not found' })
    const kind = (req.body && req.body.kind) || ''
    if (kind !== 'launcher' && kind !== 'server') {
      return res.status(400).json({ error: 'kind must be "launcher" or "server"' })
    }
    const file = req.file
    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ error: 'no file uploaded (use field name "file")' })
    }
    if (!sourceBuild._internal.looksLikeZip(file.buffer)) {
      return res.status(400).json({ error: 'uploaded file is not a valid zip (PK magic missing)' })
    }
    // ATOMIC GATE: read both pre-conditions and SET the in-flight flag in
    // the same synchronous block so two concurrent update-source requests
    // can't both pass the check. Once set, every other code path that
    // might race with the swap (the build endpoint, a sibling
    // update-source) sees the flag and 409s.
    if (_sourceUpdateInFlight) {
      return res.status(409).json({
        error: 'another source replacement is already in progress — wait for it to finish',
      })
    }
    if (_hasActiveBuildJob()) {
      return res.status(409).json({
        error: 'a build is currently running — wait for it to finish (or cancel it) before replacing master source',
      })
    }
    _sourceUpdateInFlight = true
    // Pause job-runner dispatch so a queued job can't autonomously start
    // mid-swap (drainQueue is fired from job cleanup tails). Resumed in
    // finally below.
    jobRunner.pauseDispatch()

    const targetDirName = kind === 'launcher' ? 'src' : 'server'
    const targetDir = path.join(PROJECT_ROOT, targetDirName)
    const stamp = Date.now() + '-' + crypto.randomBytes(3).toString('hex')
    const tmpDir = path.join(PROJECT_ROOT, targetDirName + '.tmp-' + stamp)
    const trashDir = path.join(PROJECT_ROOT, targetDirName + '.trash-' + stamp)

    try {
      let extractStats = null
      try {
        // Step 1: extract into a sibling tmp dir so the rest of the system
        // never sees a half-extracted state (the rename below is atomic on a
        // single filesystem).
        fs.mkdirSync(tmpDir, { recursive: true })
        extractStats = await sourceBuild._internal.extractZipBuffer(file.buffer, tmpDir)
        // Strip a single common top-level dir (GitHub-style zips wrap
        // everything in <repo>-<sha>/).
        await sourceBuild._internal.maybeStripCommonRoot(tmpDir)
        // Step 2: validate the extracted shape BEFORE the destructive rename.
        // If this throws, only the tmp dir is cleaned up; the live source is
        // untouched.
        _validateExtractedSourceShape(tmpDir, kind)
      } catch (e) {
        try { await fs.promises.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
        return res.status(400).json({ error: 'extract/validate failed: ' + e.message })
      }

      // Step 2.5: re-check that no build sneaked into 'running' during the
      // (potentially slow) extract + validate phase. The build endpoint
      // already 409s while `_sourceUpdateInFlight` is true, so the only
      // way to land here is a job that was 'queued' before we set the flag
      // and has since dequeued + started. Better to abort + ask the
      // operator to retry than swap underneath a live build.
      if (_hasActiveBuildJob()) {
        try { await fs.promises.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
        return res.status(409).json({
          error: 'a build started during upload — cancel it (or wait) and retry',
        })
      }

      // Step 3: atomic swap. If the live targetDir doesn't exist yet, just
      // rename tmp into place. Otherwise: rename live → trash, rename tmp →
      // live, schedule trash for async rmrf. If the second rename fails (e.g.
      // because Windows still has a file handle on the trash), roll back by
      // renaming trash back to live and bubble the error.
      let swapStrategy = null
      try {
        // _swapDirSafely tries atomic rename first, then falls back to a
        // file-by-file overlay if the live directory itself is locked.
        // Either way, the live tree ends up containing exactly the new
        // source after this returns. The markPartialFn callback is fired
        // BEFORE the first overlay copy lands, so if the overlay crashes
        // midway the partial flag is already persisted and future builds
        // will refuse with 409 until the operator successfully re-uploads.
        const swapResult = await _swapDirSafely(tmpDir, targetDir, trashDir, () => {
          try { dbApi.setSourcePartial(kind, true) } catch (_) {}
        })
        swapStrategy = swapResult.strategy
      } catch (e) {
        try { await fs.promises.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
        // If the error is a partial-state failure the partial flag is
        // already set inside _swapDirSafely's overlay branch — surface it
        // to the operator so the UI can show a clear "this role is locked
        // until re-upload" warning.
        const partial = !!e._partial
        return res.status(500).json({
          error: 'failed to install new source: ' + e.message,
          partial,
        })
      }
      // Successful swap clears any prior partial flag for this kind.
      try { dbApi.setSourcePartial(kind, false) } catch (_) {}

      // Step 4: record the swap timestamp so the admin UI can show
      // "Last updated: 2 minutes ago" on the panel.
      const ts = Date.now()
      try { dbApi.setSourceUpdatedAt(kind, ts) } catch (e) {
        console.log('[update-source] WARN: failed to record updated-at: ' + e.message)
      }

      res.json({
        ok: true,
        kind,
        updatedAt: ts,
        entryCount: extractStats.entryCount,
        totalUncompressed: extractStats.totalUncompressed,
        uploadBytes: file.buffer.length,
        // 'rename' = clean atomic swap; 'overlay' = file-by-file fallback
        // (typically because the live dir is held by OneDrive / Defender
        // on Windows). Surfaced so the operator knows whether to consider
        // moving the project off Desktop.
        swapStrategy,
      })
    } finally {
      _sourceUpdateInFlight = false
      try { jobRunner.resumeDispatch() } catch (_) {}
    }
  }
)

// ============ UNIFIED PROJECT-SOURCE UPLOAD (May 2026) ============
//
// PROBLEM: the per-kind /api/admin/update-source endpoint above only
// replaces walok/src/ (launcher) OR walok/server/ (server). It has NO
// way to ship changes to walok/electron/, walok/scripts/, walok/public/,
// walok/package.json, etc. — which is why a fix in walok/electron/main.js
// could never reach customers. Operators were also confused by having
// two separate uploads + having to remember which subdir went where.
//
// SOLUTION: this endpoint accepts ONE zip whose root is the CONTENTS of
// walok/ (so the zip contains src/, server/, electron/, scripts/,
// public/, package.json, vite.config.js, build.bat, etc. at the top
// level). It replaces every "code" subdir + top-level file from the zip
// in one atomic-ish operation, while preserving operator-managed state
// (customers/, branding/<channel>-logo.png, releases/, node_modules/,
// dist/, .build-jobs/).
//
// After a successful upload, BOTH launcher and server baselines are
// updated together — so a subsequent "Build All" produces both .exes
// from a known-consistent source tree.
//
// Subdirs that are FULLY REPLACED (atomic swap each, via the same
// _swapDirSafely used by /api/admin/update-source). Anything inside
// these dirs that's NOT in the zip is deleted.
const _PROJECT_REPLACE_DIRS = [
  'src',       // React launcher source — feeds the launcher .exe
  'server',    // Companion local server — feeds the server .exe
  'electron',  // Electron main process for the launcher (single-instance lock lives here)
  'scripts',   // build-customer.js / build-all.js / publish-update.js
  'public',    // Static assets bundled into the launcher
  'docs',      // Operator-facing docs shipped with the project
]

// Top-level files in walok/ that are FULLY REPLACED if present in the
// zip. Files NOT in this list are left alone (so an unexpected file in
// the upload won't accidentally clobber operator state).
const _PROJECT_REPLACE_FILES = [
  'package.json',
  'package-lock.json',
  'index.html',
  'vite.config.js',
  'vite-igdb-plugin.js',
  'tailwind.config.js',
  'postcss.config.js',
  'build.bat',
  'build-all.bat',
  'build-customer.bat',
  'publish-update.bat',
  '.gitignore',
  'replit.md',
  'UPDATING.md',
]

// Subdirs we OVERLAY (copy new files in, but NEVER delete files that
// aren't in the zip). Used for branding/ because per-customer logos
// (e.g. branding/example-cafe-logo.png) are uploaded by the operator
// through the admin UI, NOT shipped in the source zip — a full replace
// would silently delete them.
const _PROJECT_OVERLAY_DIRS = [
  'branding',
]

// Subdirs we NEVER touch — operator-managed runtime state. Listed here
// for documentation; nothing in this endpoint reads or writes them.
//   customers/      per-customer JSON configs (admin UI managed)
//   node_modules/   npm install output
//   releases/       build outputs
//   dist/           vite build output
//   .build-jobs/    job-runner runtime state
//   .canvas/        Replit canvas metadata
//   .github/        CI configs

function _validateProjectZipShape(rootDir) {
  // The zip must contain enough of walok/ to actually build both kinds.
  // If any of these markers is missing the upload is almost certainly
  // wrong (e.g. operator zipped walok/src/ instead of walok/) — fail
  // BEFORE the destructive swap.
  //
  // We also require ALL required managed dirs to be present as
  // directories, so we never silently skip half the project (which
  // would leave a mixed old/new tree). Optional dirs ('docs') may be
  // missing without rejecting; they'll just appear in skippedDirs.
  const requiredDirs = ['src', 'server', 'electron', 'scripts', 'public']
  const markers = [
    ['src', 'main.jsx'],
    ['src', 'App.jsx'],
    ['server', 'package.json'],
    ['server', 'electron', 'main.js'],
    ['package.json'],
    ['electron', 'main.js'],
  ]
  const missing = []
  for (const parts of markers) {
    if (!fs.existsSync(path.join(rootDir, ...parts))) missing.push(parts.join('/'))
  }
  for (const d of requiredDirs) {
    const p = path.join(rootDir, d)
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      missing.push(d + '/ (directory)')
    }
  }
  if (missing.length > 0) {
    throw new Error(
      'project zip is missing required entries: ' + missing.join(', ') +
      ' — expected the CONTENTS of walok/ at the top level (so the zip should contain src/, server/, electron/, scripts/, public/, package.json, etc.). Did you zip walok/src/ instead of walok/?',
    )
  }
}

// Overlay copy: walks srcDir, copies every file into destDir (mkdir-p
// as needed). Files in destDir that aren't in srcDir are LEFT ALONE.
// Returns { copied: number, skipped: number }.
async function _overlayDirNoDelete(srcDir, destDir) {
  let copied = 0
  if (!fs.existsSync(srcDir)) return { copied }
  await fs.promises.mkdir(destDir, { recursive: true })
  async function walk(dir, rel) {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const ent of ents) {
      const r = rel ? rel + path.sep + ent.name : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await fs.promises.mkdir(path.join(destDir, r), { recursive: true })
        await walk(abs, r)
      } else if (ent.isFile()) {
        await _copyFileWithRetry(abs, path.join(destDir, r))
        copied++
      }
    }
  }
  await walk(srcDir, '')
  return { copied }
}

app.post('/api/admin/update-source-project',
  requireAdmin,
  (req, res, next) => {
    uploadSource.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message })
      next()
    })
  },
  async (req, res) => {
    if (!PROJECT_ROOT) return res.status(503).json({ error: 'project root not found' })
    const file = req.file
    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ error: 'no file uploaded (use field name "file")' })
    }
    if (!sourceBuild._internal.looksLikeZip(file.buffer)) {
      return res.status(400).json({ error: 'uploaded file is not a valid zip (PK magic missing)' })
    }
    // Same atomic gate + mutex as /api/admin/update-source. We hold the
    // mutex through the entire multi-dir swap so a build can't read a
    // half-replaced tree (e.g. new src/ but old electron/).
    if (_sourceUpdateInFlight) {
      return res.status(409).json({
        error: 'another source replacement is already in progress — wait for it to finish',
      })
    }
    if (_hasActiveBuildJob()) {
      return res.status(409).json({
        error: 'a build is currently running — wait for it to finish (or cancel it) before replacing project source',
      })
    }
    _sourceUpdateInFlight = true
    // Pause the job-runner dispatcher BEFORE we touch the queue check, so
    // any queued job is frozen in 'queued' until we resume in finally.
    // Without this, a queued job could autonomously dequeue between
    // phases (drainQueue is called from finishJob's cleanup tail) and
    // start running against a half-replaced source tree.
    jobRunner.pauseDispatch()

    const stamp = Date.now() + '-' + crypto.randomBytes(3).toString('hex')
    // Single tmp dir holds the entire extracted walok zip. Each replaced
    // subdir is atomic-swapped from <tmpRoot>/<subdir> into PROJECT_ROOT.
    const tmpRoot = path.join(PROJECT_ROOT, '.upload-project-' + stamp)

    try {
      let extractStats = null
      try {
        fs.mkdirSync(tmpRoot, { recursive: true })
        extractStats = await sourceBuild._internal.extractZipBuffer(file.buffer, tmpRoot)
        await sourceBuild._internal.maybeStripCommonRoot(tmpRoot)
        _validateProjectZipShape(tmpRoot)
      } catch (e) {
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) } catch (_) {}
        return res.status(400).json({ error: 'extract/validate failed: ' + e.message })
      }

      // Re-check no build snuck into 'running' during the (slow) extract.
      if (_hasActiveBuildJob()) {
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) } catch (_) {}
        return res.status(409).json({
          error: 'a build started during upload — cancel it (or wait) and retry',
        })
      }

      // Mark BOTH baselines partial BEFORE the first destructive write.
      // If the swap crashes midway, builds will refuse for both kinds
      // until the operator successfully re-uploads. Cleared on success.
      try { dbApi.setSourcePartial('launcher', true) } catch (_) {}
      try { dbApi.setSourcePartial('server', true) } catch (_) {}

      const replacedDirs = []
      const skippedDirs = []
      const replacedFiles = []
      const overlaidDirs = {}
      const swapStrategies = {}

      // Phase 1: replace each managed subdir present in the zip.
      for (const sub of _PROJECT_REPLACE_DIRS) {
        const srcDir = path.join(tmpRoot, sub)
        if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
          skippedDirs.push(sub)
          continue
        }
        const targetDir = path.join(PROJECT_ROOT, sub)
        const trashDir = path.join(PROJECT_ROOT, sub + '.trash-' + stamp)
        // Move srcDir from tmpRoot into PROJECT_ROOT as a sibling tmp,
        // because _swapDirSafely expects (tmpDir, targetDir, trashDir)
        // where tmpDir is a sibling of targetDir on the same filesystem.
        const tmpAdjacent = path.join(PROJECT_ROOT, sub + '.tmp-' + stamp)
        try {
          await _renameWithRetry(srcDir, tmpAdjacent, sub + ' (tmpRoot→tmpAdjacent)')
          const swapResult = await _swapDirSafely(tmpAdjacent, targetDir, trashDir, () => {
            // Per-dir partial: the OVERLAY fallback here means THIS
            // subdir is mid-replace. Both kind flags are already set
            // above so builds are already refused; this is for accuracy
            // if we ever surface per-subdir state.
          })
          swapStrategies[sub] = swapResult.strategy
          replacedDirs.push(sub)
        } catch (e) {
          // Best-effort cleanup of any leftover tmp/trash.
          try { await fs.promises.rm(tmpAdjacent, { recursive: true, force: true }) } catch (_) {}
          try { await fs.promises.rm(trashDir, { recursive: true, force: true }) } catch (_) {}
          try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) } catch (_) {}
          return res.status(500).json({
            error: 'failed to install ' + sub + '/: ' + e.message,
            partial: true,
            replacedSoFar: replacedDirs,
          })
        }
      }

      // Phase 2: overlay branding/ (and any other no-delete subdirs).
      for (const sub of _PROJECT_OVERLAY_DIRS) {
        const srcDir = path.join(tmpRoot, sub)
        if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) continue
        const targetDir = path.join(PROJECT_ROOT, sub)
        try {
          const r = await _overlayDirNoDelete(srcDir, targetDir)
          overlaidDirs[sub] = r.copied
        } catch (e) {
          try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) } catch (_) {}
          return res.status(500).json({
            error: 'failed to overlay ' + sub + '/: ' + e.message,
            partial: true,
            replacedSoFar: replacedDirs,
          })
        }
      }

      // Phase 3: replace each managed top-level file present in the zip.
      // Atomic-ish: copy to a sibling tmp file then rename over the
      // target. _copyFileWithRetry handles transient Windows EBUSY.
      for (const fname of _PROJECT_REPLACE_FILES) {
        const srcFile = path.join(tmpRoot, fname)
        if (!fs.existsSync(srcFile) || !fs.statSync(srcFile).isFile()) continue
        const targetFile = path.join(PROJECT_ROOT, fname)
        const tmpFile = path.join(PROJECT_ROOT, fname + '.tmp-' + stamp)
        try {
          await _copyFileWithRetry(srcFile, tmpFile)
          await _renameWithRetry(tmpFile, targetFile, fname)
          replacedFiles.push(fname)
        } catch (e) {
          try { await fs.promises.unlink(tmpFile) } catch (_) {}
          try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) } catch (_) {}
          return res.status(500).json({
            error: 'failed to install ' + fname + ': ' + e.message,
            partial: true,
            replacedSoFar: replacedDirs,
            replacedFilesSoFar: replacedFiles,
          })
        }
      }

      // All swaps succeeded. Clear both partial flags + record both
      // timestamps so the admin UI shows BOTH baselines as freshly
      // updated.
      try { dbApi.setSourcePartial('launcher', false) } catch (_) {}
      try { dbApi.setSourcePartial('server', false) } catch (_) {}
      const ts = Date.now()
      try { dbApi.setSourceUpdatedAt('launcher', ts) } catch (e) {
        console.log('[update-source-project] WARN: failed to record launcher updated-at: ' + e.message)
      }
      try { dbApi.setSourceUpdatedAt('server', ts) } catch (e) {
        console.log('[update-source-project] WARN: failed to record server updated-at: ' + e.message)
      }

      // Best-effort cleanup of the tmp extraction dir (any subdirs we
      // kept were already moved out; what's left is whatever wasn't in
      // _PROJECT_REPLACE_DIRS or _PROJECT_OVERLAY_DIRS or
      // _PROJECT_REPLACE_FILES — i.e. ignored extras).
      setImmediate(() => {
        fs.promises.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
          .catch(e => console.log('[update-source-project] WARN: failed to rm tmpRoot ' + tmpRoot + ': ' + e.message))
      })

      res.json({
        ok: true,
        updatedAt: ts,
        replacedDirs,
        skippedDirs,
        replacedFiles,
        overlaidDirs,
        swapStrategies,
        entryCount: extractStats.entryCount,
        totalUncompressed: extractStats.totalUncompressed,
        uploadBytes: file.buffer.length,
      })
    } finally {
      _sourceUpdateInFlight = false
      // Always resume — even on early-return error paths above. resumeDispatch
      // also kicks drainQueue() so any builds that piled up while we held
      // the gate start immediately.
      try { jobRunner.resumeDispatch() } catch (_) {}
    }
  }
)

// ============ INSTALL DEPS ON DEMAND ============
//
// PROBLEM: the deps banner ("Project dependencies are not installed — first
// build may take 1–3 minutes") tells the operator the truth, but the only
// way to clear it is to start a build and wait. That's annoying when the
// operator just wants to pre-install so the FIRST customer build feels fast.
//
// SOLUTION: this endpoint runs `npm install` in walok/ (and walok/server/
// if it exists) on demand, with the same guards as the build endpoint:
//   * Refuses if a build is already running (npm install + build can't share node_modules).
//   * Refuses if a source upload is in flight (the source could change mid-install).
//   * Pauses job-runner dispatch so a queued build can't autonomously start mid-install.
//   * Mutex `_installDepsInFlight` prevents double-clicks.
//
// Returns synchronously after both installs complete — the admin UI shows a
// spinner the whole time. Total wall time is ~1-3 min on first install,
// ~10s on a re-run (npm sees node_modules already present and short-circuits).
let _installDepsInFlight = false
app.post('/api/admin/install-deps', requireAdmin, async (req, res) => {
  if (!PROJECT_ROOT) return res.status(503).json({ error: 'project root not found' })
  if (_installDepsInFlight) {
    return res.status(409).json({ error: 'an install is already in progress — wait for it to finish' })
  }
  if (_sourceUpdateInFlight) {
    return res.status(409).json({ error: 'a source replacement is in progress — wait for it to finish, then try again' })
  }
  if (_hasActiveBuildJob()) {
    return res.status(409).json({ error: 'a build is currently running — wait for it to finish, then try again' })
  }
  _installDepsInFlight = true
  jobRunner.pauseDispatch()
  const startedAt = Date.now()
  const result = { root: null, server: null }
  try {
    // Root install — always.
    const rootStart = Date.now()
    try {
      await runNpmInstallAsync(PROJECT_ROOT, 'root')
      result.root = { ok: true, ms: Date.now() - rootStart, alreadyInstalled: rootDepsInstalled() }
    } catch (e) {
      result.root = { ok: false, ms: Date.now() - rootStart, error: e.message }
      return res.status(500).json({
        ok: false,
        elapsedMs: Date.now() - startedAt,
        ...result,
      })
    }
    // Server install — only if walok/server/ exists.
    const serverDir = path.join(PROJECT_ROOT, 'server')
    if (fs.existsSync(serverDir)) {
      const sStart = Date.now()
      try {
        await runNpmInstallAsync(serverDir, 'server')
        result.server = { ok: true, ms: Date.now() - sStart, alreadyInstalled: serverDepsInstalled() }
      } catch (e) {
        result.server = { ok: false, ms: Date.now() - sStart, error: e.message }
        return res.status(500).json({
          ok: false,
          elapsedMs: Date.now() - startedAt,
          ...result,
        })
      }
    } else {
      result.server = { skipped: true, reason: 'walok/server/ does not exist' }
    }
    res.json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      ...result,
      depsAfter: depsStatus(),
    })
  } finally {
    _installDepsInFlight = false
    try { jobRunner.resumeDispatch() } catch (_) {}
  }
})

// Lightweight status endpoint the admin panel calls on load + after every
// successful upload to refresh the "Last updated" indicators on each card.
app.get('/api/admin/source-status', requireAdmin, (req, res) => {
  if (!PROJECT_ROOT) return res.json({ launcher: null, server: null, projectRoot: null })
  function describe(kind) {
    const dir = path.join(PROJECT_ROOT, kind === 'launcher' ? 'src' : 'server')
    const present = fs.existsSync(dir) && fs.statSync(dir).isDirectory()
    let updatedAt = null
    try { updatedAt = dbApi.getSourceUpdatedAt(kind) } catch (_) {}
    let partial = false
    try { partial = dbApi.getSourcePartial(kind) } catch (_) {}
    return { present, updatedAt, path: dir, partial }
  }
  res.json({
    launcher: describe('launcher'),
    server: describe('server'),
    projectRoot: PROJECT_ROOT,
    activeBuild: _hasActiveBuildJob(),
  })
})

// ============ JOBS API (queue + cancel + stream) ============
// Backed by job-runner.js. Replaces the old in-file JOBS map, the per-channel
// BUILD_LOCKS lock, and the stub cancel endpoint.

app.get('/api/admin/jobs', requireAdmin, (req, res) => {
  res.json({
    queue: jobRunner.getQueueState(),
    jobs: jobRunner.listJobs(),
  })
})

// SSE stream that pushes a fresh jobs+queue snapshot whenever ACTIVE/QUEUE
// changes — lets the admin UI show live queue position + slot usage without
// polling.
app.get('/api/admin/jobs/stream', requireAdmin, (req, res) => {
  res.set('Content-Type', 'text/event-stream')
  res.set('Cache-Control', 'no-cache')
  res.set('Connection', 'keep-alive')
  res.set('X-Accel-Buffering', 'no')
  res.flushHeaders()
  res.on('error', () => {})
  const send = () => {
    try {
      res.write('data: ' + JSON.stringify({
        queue: jobRunner.getQueueState(),
        jobs: jobRunner.listJobs(),
      }) + '\n\n')
    } catch (e) {}
  }
  send()
  // Subscribe to queue/slot changes by polling the slot-change hook. The
  // hook fires synchronously after every drain, so the snapshot we send is
  // always current.
  const prev = jobRunnerOnSlotListeners
  prev.add(send)
  const hb = setInterval(() => { try { res.write(': ping\n\n') } catch (e) {} }, 25000)
  req.on('close', () => { prev.delete(send); clearInterval(hb) })
})

app.post('/api/admin/jobs/:id/cancel', requireAdmin, (req, res) => {
  const r = jobRunner.cancelJob(req.params.id)
  if (!r.ok && r.error === 'job not found') return res.status(404).json({ error: 'job not found' })
  res.json(r)
})

app.get('/api/admin/jobs/:id', requireAdmin, (req, res) => {
  const job = jobRunner.getJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({
    id: job.id, label: job.label, status: job.status, channels: job.channels,
    exitCode: job.exitCode, queuedAt: job.queuedAt, startedAt: job.startedAt,
    endedAt: job.endedAt, failedStep: job.failedStep,
    currentStep: job.currentStep, currentSubstep: job.currentSubstep,
    output: job.output,
  })
})

// === Test-only hook (Task #16): synthesise a job that emits a burst of
// log lines, used by test-build-endpoint.js to assert the SSE handler
// coalesces high-rate output. Mounted only when OTA_TEST_MODE is truthy
// so production servers never expose it. ===
if (process.env.OTA_TEST_MODE) {
  app.post('/api/admin/__test_inline_job', requireAdmin, (req, res) => {
    const lines = Math.max(1, Math.min(5000, parseInt((req.body && req.body.lines) || '100', 10)))
    const label = String((req.body && req.body.label) || 'test-burst')
    const job = jobRunner.enqueueInlineJob({
      label,
      channels: [],
      work: async (j) => {
        // Emit a tight burst with no awaits between lines — this mirrors
        // a noisy build step (electron-builder, npm install) which is
        // exactly the load profile that overwhelmed the per-line SSE
        // writer before coalescing.
        for (let i = 0; i < lines; i++) jobAppend(j, '[burst] line ' + i)
      },
    })
    res.json({ jobId: job.id, status: job.status })
  })
}

app.get('/api/admin/jobs/:id/stream', requireAdmin, (req, res) => {
  const job = jobRunner.getJob(req.params.id)
  if (!job) { res.status(404).end(); return }
  res.set('Content-Type', 'text/event-stream')
  res.set('Cache-Control', 'no-cache')
  res.set('Connection', 'keep-alive')
  res.set('X-Accel-Buffering', 'no')
  res.flushHeaders()
  // Swallow any late stream errors (e.g. ERR_STREAM_WRITE_AFTER_END from a
  // race between res.end() and a still-in-flight jobAppend). Without this,
  // an unhandled 'error' event on the ServerResponse crashes the whole
  // Node process and kills the admin panel ("Failed to fetch").
  res.on('error', () => {})

  // Replay buffered output for late subscribers (so refreshing the page
  // mid-build shows the full log instead of only new lines). Concatenate
  // into one res.write so a 5000-line buffer is shipped in one syscall
  // instead of 5000 — replay used to spike the event loop on page reload
  // mid-build.
  if (job.output.length > 0) {
    let replay = ''
    for (const e of job.output) replay += 'data: ' + JSON.stringify(e) + '\n\n'
    try { res.write(replay) } catch (e) {}
  }
  if (job.status === 'success' || job.status === 'failed' || job.status === 'cancelled') {
    res.write('data: ' + JSON.stringify({ end: true, exitCode: job.exitCode, failedStep: job.failedStep, status: job.status }) + '\n\n')
    res.end()
    return
  }
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch (e) {} }, 15000)
  let detach = null

  // Server-side SSE coalescing (Task #16). The job-runner can emit hundreds
  // of log lines per second during heavy steps (electron-builder, npm
  // install). Without coalescing, each line triggered a separate res.write
  // — and with 2 parallel builds that meant ~2000 socket writes/sec from a
  // single Node thread, which by itself was enough to make the admin SSE
  // connection feel sluggish AND starve other handlers (the panel's REST
  // calls would visibly stall while a build was loud).
  //
  // The wire format is unchanged: each log entry is still its own
  // `data: {...}\n\n` SSE event from the client's perspective. We just
  // concatenate consecutive entries into one TCP write at most every
  // OTA_SSE_COALESCE_MS (default 33ms = ~30Hz, matching the admin UI's
  // rAF-based DOM batching). {end:true} flushes synchronously so the
  // client always sees the terminal status before EventSource closes.
  const COALESCE_MS = Math.max(0, parseInt(process.env.OTA_SSE_COALESCE_MS || '33', 10))
  let buffered = ''
  let flushTimer = null
  function flushBuffer() {
    flushTimer = null
    if (!buffered) return
    const chunk = buffered
    buffered = ''
    try { res.write(chunk) } catch (e) {}
  }
  const send = (entry) => {
    if (entry.end) {
      // Drain buffered lines first — the client must see every log line
      // BEFORE the terminal {end:...} event (and before the connection
      // closes).
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      if (buffered) {
        try { res.write(buffered) } catch (e) {}
        buffered = ''
      }
      try { res.write('data: ' + JSON.stringify(entry) + '\n\n') } catch (e) {}
      clearInterval(heartbeat)
      // Detach synchronously so any further jobAppend (e.g. from a still-
      // running onComplete callback) can never call res.write on the
      // response we are about to end. Do this BEFORE res.end().
      if (detach) { detach(); detach = null }
      try { res.end() } catch (e) {}
      return
    }
    buffered += 'data: ' + JSON.stringify(entry) + '\n\n'
    if (COALESCE_MS === 0) {
      flushBuffer()
      return
    }
    if (!flushTimer) flushTimer = setTimeout(flushBuffer, COALESCE_MS)
  }
  detach = jobRunner.attachListener(req.params.id, send)
  req.on('close', () => {
    clearInterval(heartbeat)
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (detach) { detach(); detach = null }
  })
})

app.get('/api/admin/online', requireAdmin, (req, res) => {
  res.json({ online: live.snapshot() })
})

// SSE stream for the admin panel — pushes the live online registry whenever
// it changes so the dashboard updates instantly without polling.
app.get('/api/admin/online/stream', requireAdmin, (req, res) => {
  res.set('Content-Type', 'text/event-stream')
  res.set('Cache-Control', 'no-cache')
  res.set('Connection', 'keep-alive')
  res.set('X-Accel-Buffering', 'no')
  res.flushHeaders()
  res.on('error', () => {})

  const send = () => {
    try { res.write('data: ' + JSON.stringify({ online: live.snapshot() }) + '\n\n') } catch (e) {}
  }
  send()
  const off = live.onChange(send)
  const hb = setInterval(() => { try { res.write(': ping\n\n') } catch (e) {} }, 25000)
  req.on('close', () => { off(); clearInterval(hb) })
})

app.get('/api/admin/channels', requireAdmin, (req, res) => {
  if (!fs.existsSync(UPDATES_DIR)) return res.json({ channels: [] })
  const dirs = fs.readdirSync(UPDATES_DIR).filter(d => fs.statSync(path.join(UPDATES_DIR, d)).isDirectory())
  const channels = dirs.map(d => {
    const m = getChannelInfo(d)
    return { channel: d, version: m?.version || null, releasedAt: m?.releasedAt || null }
  })
  res.json({ channels })
})

app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }))

// Test-friendly export so test harnesses can require this file without
// auto-binding to PORT/HOST. Production launch path (the one the OTA host
// runs in npm start) still binds via the require.main check below.
module.exports = {
  app,
  jobRunner,
  _internal: {
    _hasActiveBuildJob,
    _validateExtractedSourceShape,
    _scheduleTrashRemoval,
  },
}

if (require.main === module) app.listen(PORT, HOST, () => {
  console.log('')
  console.log('============================================')
  console.log('  OTA UPDATE SERVER  v' + (SERVER_VERSION || '?'))
  console.log('============================================')
  console.log('  Listening on:    http://' + HOST + ':' + PORT)
  console.log('  Updates served:  ' + UPDATES_DIR)
  console.log('  Health check:    http://localhost:' + PORT + '/health')
  console.log('  Web dashboard:   http://localhost:' + PORT + '/')
  console.log('  Admin panel:     http://localhost:' + PORT + '/admin/')
  console.log('  Admin password:  (from OTA_ADMIN_PASSWORD env var)')
  console.log('  Project root:    ' + (PROJECT_ROOT || 'NOT FOUND — admin builds disabled'))
  console.log('  Customers in DB: ' + dbApi.listCustomers().length)
  console.log('============================================')
  console.log('')
  console.log('IMPORTANT: Make sure port ' + PORT + ' is open in your Windows Firewall.')
  console.log('Run start.bat which adds the firewall rule automatically.')
})
