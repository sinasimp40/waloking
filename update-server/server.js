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
const notif = require('./notifications')
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

// Monitor endpoints are public because the detached Windows helper cannot hold
// an administrator credential. Their authorization must therefore be based
// solely on the network address observed by this server, never on a body field
// that an arbitrary caller can forge.
function getObservedRequestIp(req) {
  return normalizeIp(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress)
}

// Launcher-owned Telegram credentials travel only in monitor request bodies.
// They are capped, never written to the database, and only retained in the
// live monitor entry long enough to notify its later offline transition.
function readLauncherTelegram(body) {
  const botToken = typeof body?.telegram?.botToken === 'string' ? body.telegram.botToken.trim().slice(0, 256) : ''
  const chatId = typeof body?.telegram?.chatId === 'string' ? body.telegram.chatId.trim().slice(0, 128) : ''
  return botToken && chatId ? { botToken, chatId } : null
}

// Monitor routes are intentionally public so a Windows helper can run without
// storing an administrator password. Restrict them to the PC/IP allow-list
// maintained in the protected update-server admin panel; this prevents an
// internet caller from inventing PCs or Telegram game-launch messages.
function isEnrolledMonitor(cfg, ip) {
  return Array.isArray(cfg?.roster) && cfg.roster.length > 0 &&
    cfg.roster.some(entry => normalizeIp(entry?.ip) === ip)
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

// Balok is a separate product with its own customer table and its own
// updates dir. Live-push clients must be accepted for EITHER product,
// otherwise a Balok launcher's SSE connect is rejected with 404 and it
// silently degrades to the 2-minute poll (no instant OTA notification).
function getBalokChannelInfo(channel) {
  const manifestPath = path.join(BALOK_UPDATES_DIR, channel, 'latest.json')
  if (!fs.existsSync(manifestPath)) return null
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) }
  catch (e) { return null }
}

function isKnownLiveChannel(channel) {
  try {
    if (dbApi.getCustomer(channel)) return true
  } catch (e) {}
  try {
    if (dbApi.getBalokCustomer && dbApi.getBalokCustomer(channel)) return true
  } catch (e) {}
  return false
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
  if (!live.VALID_ROLES.has(role)) return res.status(400).end()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(instance)) return res.status(400).end()
  // Reject unknown channels to stop spoofed presence / registry-churn from
  // any client that can guess the URL shape. The registry stays clean.
  if (!isKnownLiveChannel(channel)) return res.status(404).end()
  const version = typeof req.query.v === 'string' && req.query.v.length <= 32 ? req.query.v : null
  const installPath = typeof req.query.p === 'string' && req.query.p.length <= 512 ? req.query.p : null
  const ip = normalizeIp(req.ip || req.connection?.remoteAddress)
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 256)
  if (role === 'monitor') {
    let cfg
    try { cfg = dbApi.getOrCreateNotifConfig(channel) } catch (_) {}
    if (!isEnrolledMonitor(cfg, ip)) {
      return res.status(403).json({ error: 'monitor IP is not enrolled for this channel' })
    }
  }

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
    || (role === 'launcher' ? getBalokChannelInfo(channel) : null)
  send({
    type: 'hello',
    channel, role, instance,
    serverVersion: SERVER_VERSION,
    publishedVersion: channelInfo ? channelInfo.version : null,
  })

  live.addClient({ channel, role, instance, version, ip, userAgent, send, close })
  // Persist last-seen on first connect so the admin sees "just now" even
  // before the first heartbeat tick (which is HEARTBEAT_MS away).
  // monitor role is not tracked in the customers table (no launcher/server col).
  if (role !== 'monitor') {
    try { dbApi.recordClientSeen(channel, role, ip, installPath) } catch (e) {}
  }

  const heartbeatTimer = setInterval(() => {
    try {
      res.write(': ping\n\n')
      live.touchClient(channel, role, instance)
      // Refresh last-seen each heartbeat — IP + path are captured at connect
      // time and reused since neither can change mid-stream.
      if (role !== 'monitor') {
        try { dbApi.recordClientSeen(channel, role, ip, installPath) } catch (e) {}
      }
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
// Also used by the monitor role (PC agents) to register presence without
// needing a persistent SSE connection.
app.post('/api/live/:channel/:role/:instance/heartbeat', (req, res) => {
  const { channel, role, instance } = req.params
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  if (!live.VALID_ROLES.has(role)) return res.status(400).json({ error: 'invalid role' })
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(instance)) return res.status(400).json({ error: 'invalid instance' })
  if (!isKnownLiveChannel(channel)) return res.status(404).json({ error: 'unknown channel' })
  const version = req.body && typeof req.body.version === 'string' ? req.body.version : null
  const installPath = req.body && typeof req.body.path === 'string' && req.body.path.length <= 512 ? req.body.path : null
  const ip = normalizeIp(req.ip || req.connection?.remoteAddress)
  const deviceName = req.body && typeof req.body.deviceName === 'string'
    ? req.body.deviceName.slice(0, 80).trim() : null
  if (role === 'monitor') {
    let cfg
    try { cfg = dbApi.getOrCreateNotifConfig(channel) } catch (_) {}
    if (!isEnrolledMonitor(cfg, ip)) {
      return res.status(403).json({ error: 'monitor IP is not enrolled for this channel' })
    }
  }
  const preferences = role === 'monitor' ? {
    notificationEnabled: req.body?.notificationEnabled !== false,
    notifyPcMonitoring: req.body?.notifyPcMonitoring !== false,
  } : null
  const telegram = role === 'monitor' ? readLauncherTelegram(req.body) : null
  const wasRegistered = live.touchClient(channel, role, instance, { version, name: deviceName, preferences, telegram })
  if (!wasRegistered) {
    // Client wasn't in registry — auto-register a "ghost" entry that has no
    // SSE socket so the admin still sees them as online.
    // For monitor role this fires the 'online' hook inside addClient.
    live.addClient({
      channel, role, instance, version, ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 256),
      send: () => {}, close: () => {}, name: deviceName, preferences, telegram,
    })
  }
  // Persist last-seen IP + install path for launcher/server roles.
  // monitor presence is tracked only in the live registry (in-memory).
  if (role !== 'monitor') {
    try { dbApi.recordClientSeen(channel, role, ip, installPath) } catch (e) {}
  }
  res.json({ ok: true, registered: !wasRegistered })
})

// ============ MONITOR EVENT HOOKS (PC presence → Telegram) ============
//
// Wired at startup: any monitor event (online/close/stale) fires a Telegram
// alert when pcMonitoring is enabled for that channel. Only TRANSITIONS
// trigger a send — heartbeats (touchClient) do NOT reach this handler.
live.onAnyMonitorEvent(async function handleMonitorEvent(channel, event, entry) {
  // Non-blocking — never propagate errors back to the event emitter.
  try {
    // Config lookup: if not found, treat as disabled (safe default).
    if (entry.preferences?.notificationEnabled === false || entry.preferences?.notifyPcMonitoring === false) return
    let cfg
    try { cfg = dbApi.getOrCreateNotifConfig(channel) } catch (_) {}
    if (!cfg || !cfg.enabled || !cfg.pcMonitoring) return

    // Launcher credentials are held only on this live monitor entry.
    if (!notif.isConfigured(entry.telegram)) return

    // Get current online monitors AFTER the transition.
    const onlinePcs = live.monitorSnapshot(channel)
    const msg = notif.buildPcMessage(event, entry, onlinePcs, cfg.roster)
    const result = await notif.send(msg, entry.telegram)
    try { dbApi.recordNotifDelivery(channel, result.ok) } catch (_) {}
  } catch (_) {}
})

// ============ UNAUTHENTICATED MONITOR ROUTES ============
//
// These routes accept data from PC agents without admin auth.
// They are safe because:
//   1. channel/role/instance are validated against known channels.
//   2. The game event route is gated by persisted config.
//   3. No sensitive data is returned.

// Compatibility heartbeat route for the detached launcher helper.
// It maps the helper's stable device ID to the canonical live monitor route.
app.post('/api/monitor/heartbeat', (req, res) => {
  const body = req.body || {}
  const channel = typeof body.channel === 'string' ? body.channel : ''
  const instance = typeof body.deviceId === 'string' ? body.deviceId : ''
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(instance)) return res.status(400).json({ error: 'invalid device id' })
  if (!isKnownLiveChannel(channel)) return res.status(404).json({ error: 'unknown channel' })

  const ip = normalizeIp(req.ip || req.connection?.remoteAddress)
  const name = typeof body.deviceName === 'string' ? body.deviceName.slice(0, 80).trim() : null
  let cfg
  try { cfg = dbApi.getOrCreateNotifConfig(channel) } catch (_) {}
  if (!isEnrolledMonitor(cfg, ip)) {
    return res.status(403).json({ error: 'monitor IP is not enrolled for this channel' })
  }
  const preferences = {
    notificationEnabled: body.notificationEnabled !== false,
    notifyPcMonitoring: body.notifyPcMonitoring !== false,
  }
  const wasRegistered = live.touchClient(channel, 'monitor', instance, { name, preferences })
  if (!wasRegistered) {
    live.addClient({
      channel, role: 'monitor', instance, version: null, ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 256),
      send: () => {}, close: () => {}, name, preferences,
    })
  }
  res.json({ ok: true, registered: !wasRegistered })
})

// POST /api/monitor/:channel/game-launch
// Body: { instance, game }
// Returns 200 {ok:true} or 4xx on validation failure.
// Silently succeeds (no notification sent) when channel's config has
// gameLaunches=false or notifications disabled — agent should not retry.
app.post('/api/monitor/:channel/game-launch', async (req, res) => {
  const { channel } = req.params
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  if (!isKnownLiveChannel(channel)) return res.status(404).json({ error: 'unknown channel' })

  const body = req.body || {}
  const instanceValue = typeof body.instance === 'string' ? body.instance : body.deviceId
  const instance = typeof instanceValue === 'string'
    ? instanceValue.slice(0, 128).replace(/[^A-Za-z0-9_-]/g, '') : null
  if (!instance || instance.length === 0) {
    return res.status(400).json({ error: 'instance required (alphanumeric, dash, underscore, 1-128 chars)' })
  }

  const game = typeof body.game === 'string'
    ? body.game.slice(0, 256).trim()
    : typeof body.gameName === 'string'
      ? (body.gameName + (typeof body.variation === 'string' && body.variation.trim() ? ' — ' + body.variation.trim() : '')).slice(0, 256).trim()
      : ''
  if (!game) return res.status(400).json({ error: 'game name required' })
  if (body.notificationEnabled === false || body.notifyGameLaunches === false) {
    return res.json({ ok: true, notified: false, reason: 'game launch notifications disabled locally' })
  }

  const ip = getObservedRequestIp(req)

  // Config gate — fetch config; treat missing as disabled (safe default).
  let cfg
  try { cfg = dbApi.getOrCreateNotifConfig(channel) } catch (_) {}
  if (!isEnrolledMonitor(cfg, ip)) {
    return res.status(403).json({ error: 'monitor IP is not enrolled for this channel' })
  }
  const activeMonitor = live.monitorSnapshot(channel)
    .find(entry => entry.instance === instance && entry.ip === ip)
  if (!activeMonitor) {
    return res.status(403).json({ error: 'active enrolled monitor required before reporting a game launch' })
  }
  if (!cfg || !cfg.enabled || !cfg.gameLaunches) {
    return res.json({ ok: true, notified: false, reason: 'game launch notifications disabled' })
  }

  const telegram = readLauncherTelegram(body)
  if (!notif.isConfigured(telegram)) {
    return res.json({ ok: true, notified: false, reason: 'notification service not configured' })
  }

  const reportedName = typeof body.deviceName === 'string' ? body.deviceName.slice(0, 80).trim() : null
  const msg = notif.buildGameMessage(channel, instance, ip, game, cfg.roster, reportedName)
  let result
  try {
    result = await notif.send(msg, telegram)
  } catch (_) {
    result = { ok: false, configured: true, reason: 'send error' }
  }
  try { dbApi.recordNotifDelivery(channel, result.ok) } catch (_) {}
  if (result.ok) {
    return res.json({ ok: true, notified: true })
  }
  // Don't block the agent on notification failure — still return 200.
  return res.json({ ok: true, notified: false, reason: result.reason })
})

// Compatibility game event route used by shipped launcher monitor helpers.
app.post('/api/monitor/game-launch', (req, res, next) => {
  const channel = req.body && typeof req.body.channel === 'string' ? req.body.channel : ''
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  req.params.channel = channel
  return next()
}, (req, res) => {
  // Keep the launcher helper's response deterministic while it is updated.
  // The canonical per-channel route above remains the complete handler.
  return res.status(501).json({ error: 'use /api/monitor/:channel/game-launch' })
})

// The launcher deliberately cannot authenticate as a server administrator, so
// this endpoint never sends a message. It makes the test control truthful:
// the returned connection state is safe to expose, while actual test delivery
// remains protected by POST /api/admin/notifications/:channel/test.
app.post('/api/monitor/test', (req, res) => {
  const configured = notif.isConfigured(readLauncherTelegram(req.body))
  res.json({
    ok: true,
    reason: configured ? 'ready' : 'not_configured',
    message: configured
      ? 'Monitor server is reachable and this launcher’s Telegram settings are ready.'
      : 'Enter both the Telegram Bot Token and Telegram Chat ID in this launcher.',
    configured,
  })
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
      _logoRevision: c.logo && (() => {
        try {
          const p = path.isAbsolute(c.logo) ? c.logo : path.resolve(PROJECT_ROOT, c.logo)
          return fs.statSync(p).mtimeMs
        } catch (_) { return 0 }
      })(),
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
  // Editing metadata while a replacement upload is pending must not erase the
  // current logo. The admin sends no `logo` field when a file was selected and
  // uploads it in a second request; preserving here also makes upload failures
  // non-destructive.
  const existing = dbApi.getCustomer(channel)
  const nextLogo = logo !== undefined ? (logo || null) : (existing?.logo || null)
  const stored = dbApi.upsertCustomer({ channel, brandName, subtitle, updateServer, logo: nextLogo })
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
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.removeHeader('ETag')
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
  const { channel, all, version, dryRun, roles, releaseNotes } = req.body || {}
  if (!all && !isValidChannel(channel)) return res.status(400).json({ error: 'channel required (or pass all:true)' })
  if (version && !isValidVersion(version)) return res.status(400).json({ error: 'invalid version (expected x.y.z)' })
  // Optional operator-supplied release notes shown to launcher/server users
  // in the in-app Update Modal. Trim + cap so a runaway paste can't bloat
  // the manifest. Empty string == no notes (the publisher will fall back
  // to the auto-generated "Update vX.Y.Z" placeholder).
  let releaseNotesClean = ''
  if (typeof releaseNotes === 'string') {
    releaseNotesClean = releaseNotes.trim()
    if (releaseNotesClean.length > 4000) {
      return res.status(400).json({ error: 'release notes too long (max 4000 characters)' })
    }
  } else if (releaseNotes != null) {
    return res.status(400).json({ error: 'releaseNotes must be a string' })
  }

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
  const targetChannels = all ? dbApi.listCustomers().filter(c => c.updatesEnabled !== false).map(c => c.channel) : [channel]
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
      env: Object.assign(
        roleFilter
          ? { BUILD_VERSION: v, OTA_UPDATES_DIR: UPDATES_DIR, BUILD_ROLE: roleFilter }
          : { BUILD_VERSION: v, OTA_UPDATES_DIR: UPDATES_DIR },
        // Operator-supplied release notes flow into publish-update.js as
        // RELEASE_NOTES; the script writes them into the manifest's `notes`
        // field, which the launcher/server Update Modal renders + uses to
        // gate the "Proceed Update" button.
        releaseNotesClean ? { RELEASE_NOTES: releaseNotesClean } : {}
      ),
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
let _sourceUpdateStartedAt = 0
let _sourceUpdateKind = ''

// ── Live server-side progress for source uploads ─────────────────────────────
// The browser knows exactly how many bytes it uploaded, but everything AFTER
// the last byte (extract → validate → swap dirs → copy files) used to be a
// time-based guess in the admin UI. We publish real progress here and the
// admin polls GET /api/admin/source-progress while the request is in flight,
// so the bar advances on actual work, ~1% at a time.
let _sourceProgress = { active: false, kind: null, pct: 0, label: '', detail: '', at: 0 }
function setSourceProgress(kind, pct, label, detail) {
  const p = Math.max(0, Math.min(100, Math.round(pct)))
  // Monotonic within one run so the bar never jumps backwards.
  if (_sourceProgress.active && _sourceProgress.kind === kind && p < _sourceProgress.pct) return
  _sourceProgress = { active: true, kind, pct: p, label: label || '', detail: detail || '', at: Date.now() }
}
function clearSourceProgress() {
  _sourceProgress = { active: false, kind: null, pct: 0, label: '', detail: '', at: Date.now() }
}


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
    _sourceUpdateStartedAt = Date.now()
    _sourceUpdateKind = kind
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
    _sourceUpdateStartedAt = Date.now()
    _sourceUpdateKind = 'project'
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
// ── Build Balok ──────────────────────────────────────────────────────────────
// Runs `npm run build` (Vite production build) inside the balok/ sibling
// directory. After a successful build the source tree (src/, tailwind.config.js)
// is synced into walok/ so the next "Build All Customers" immediately picks up
// the new UI — no manual copy step needed.
// Always uses shell:true so npm resolves correctly on both Windows and Linux
// (on Windows, npm is a .cmd script and cannot be spawned without shell).
const BALOK_DIR = (() => {
  const candidate = path.join(__dirname, '..', 'balok')
  return require('fs').existsSync(candidate) ? candidate : null
})()

// walok/ is the master customer-build template — balok UI is synced into it.
const WALOK_SOURCE_DIR = (() => {
  const candidate = path.join(__dirname, '..', 'walok')
  return require('fs').existsSync(candidate) ? candidate : null
})()

// Recursively copy an entire directory, overwriting existing files.
// Returns the count of files copied.
function cpDirSync(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true })
  fs.mkdirSync(dest, { recursive: true })
  let count = 0
  for (const e of entries) {
    const srcP = path.join(src, e.name)
    const destP = path.join(dest, e.name)
    if (e.isDirectory()) {
      count += cpDirSync(srcP, destP)
    } else {
      fs.copyFileSync(srcP, destP)
      count++
    }
  }
  return count
}

// Numeric semver compare: -1 / 0 / 1
function _cmpSemver(a, b) {
  const pa = String(a).split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// Read/write balok/package.json version field
function readBalokPkg() {
  if (!BALOK_DIR) return null
  try { return JSON.parse(fs.readFileSync(path.join(BALOK_DIR, 'package.json'), 'utf8')) } catch { return null }
}
function writeBalokVersion(version) {
  const pkgPath = path.join(BALOK_DIR, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  pkg.version = version
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

// Return current balok version + directory status
app.get('/api/admin/balok-info', requireAdmin, (req, res) => {
  if (!BALOK_DIR) return res.status(503).json({ error: 'balok/ directory not found' })
  const pkg = readBalokPkg()
  res.json({
    version: pkg ? pkg.version : null,
    dir: BALOK_DIR,
    hasNodeModules: fs.existsSync(path.join(BALOK_DIR, 'node_modules')),
  })
})

// Persist the Balok version to balok/package.json. The admin "Set Version"
// button used to only change the label in the DOM, so the value reverted to
// whatever package.json still held on the next refresh/build.
app.post('/api/admin/balok-version', requireAdmin, (req, res) => {
  if (!BALOK_DIR) return res.status(503).json({ error: 'balok/ directory not found' })
  const version = String((req.body && req.body.version) || '').trim()
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    return res.status(400).json({ error: 'invalid semver version: ' + version })
  }
  try {
    writeBalokVersion(version)
  } catch (e) {
    return res.status(500).json({ error: 'failed to write balok/package.json: ' + e.message })
  }
  res.json({ ok: true, version })
})



// ============ BALOK: UPDATE SOURCE FILES ============
// Same model as the Walok "Update Project Source" upload, but targeting the
// balok/ folder. The operator zips the CONTENTS of balok/ and uploads it
// here; the next Balok build (dev build or per-customer build) compiles from
// the freshly replaced source, so a new Balok version ships over OTA.
const _BALOK_REPLACE_DIRS = ['src', 'electron', 'scripts', 'public']
const _BALOK_OVERLAY_DIRS = ['branding'] // per-customer logos live here — never delete
const _BALOK_REPLACE_FILES = [
  'package.json',
  'package-lock.json',
  'index.html',
  'vite.config.js',
  'vite-igdb-plugin.js',
  'tailwind.config.js',
  'postcss.config.js',
]

function _validateBalokZipShape(rootDir) {
  const requiredDirs = ['src', 'electron']
  const markers = [['src', 'main.jsx'], ['src', 'App.jsx'], ['electron', 'main.js'], ['package.json']]
  const missing = []
  for (const parts of markers) {
    if (!fs.existsSync(path.join(rootDir, ...parts))) missing.push(parts.join('/'))
  }
  for (const d of requiredDirs) {
    const p = path.join(rootDir, d)
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) missing.push(d + '/ (directory)')
  }
  if (missing.length > 0) {
    throw new Error(
      'balok zip is missing required entries: ' + missing.join(', ') +
      ' — expected the CONTENTS of balok/ at the top level (src/, electron/, package.json, vite.config.js, …). Did you zip balok/src/ instead of balok/?',
    )
  }
}

app.get('/api/admin/balok-source-status', requireAdmin, (req, res) => {
  if (!BALOK_DIR) return res.json({ present: false, updatedAt: null, path: null, activeBuild: _hasActiveBuildJob() })
  let updatedAt = null
  try {
    const v = dbApi.getMeta('source_balok_updated_at')
    const n = v ? parseInt(v, 10) : NaN
    updatedAt = Number.isFinite(n) ? n : null
  } catch (_) {}
  let partial = false
  try { partial = !!dbApi.getMeta('source_balok_partial') } catch (_) {}
  res.json({
    present: fs.existsSync(path.join(BALOK_DIR, 'src')),
    updatedAt,
    partial,
    path: BALOK_DIR,
    activeBuild: _hasActiveBuildJob(),
  })
})

// Live server-side progress for whichever source upload is being processed.
// Polled by the admin UI (~3x/sec) between "last byte sent" and "response
// received" so the bar reflects real extract/swap work instead of a timer.
app.get('/api/admin/source-progress', requireAdmin, (req, res) => {
  res.json({
    ..._sourceProgress,
    inFlight: _sourceUpdateInFlight,
    inFlightKind: _sourceUpdateKind || null,
    startedAt: _sourceUpdateStartedAt || null,
  })
})


app.post('/api/admin/update-source-balok',
  requireAdmin,
  (req, res, next) => {
    uploadSource.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message })
      next()
    })
  },
  async (req, res) => {
    if (!BALOK_DIR) return res.status(503).json({ error: 'balok/ directory not found' })
    const file = req.file
    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ error: 'no file uploaded (use field name "file")' })
    }
    if (!sourceBuild._internal.looksLikeZip(file.buffer)) {
      return res.status(400).json({ error: 'uploaded file is not a valid zip (PK magic missing)' })
    }
    if (_sourceUpdateInFlight) {
      return res.status(409).json({ error: 'another source replacement is already in progress — wait for it to finish' })
    }
    if (_hasActiveBuildJob()) {
      return res.status(409).json({ error: 'a build is currently running — wait for it to finish (or cancel it) before replacing Balok source' })
    }
    _sourceUpdateInFlight = true
    _sourceUpdateStartedAt = Date.now()
    _sourceUpdateKind = 'balok'
    jobRunner.pauseDispatch()
    setSourceProgress('balok', 1, 'Extracting…', '')

    // The uploaded zip carries its own package.json, whose version is usually
    // stale (1.0.0). Remember what the operator set on disk so a lower/equal
    // version in the zip can't silently roll the release version back.
    const prevBalokVersion = readBalokPkg()?.version || null

    const stamp = Date.now() + '-' + crypto.randomBytes(3).toString('hex')
    const tmpRoot = path.join(BALOK_DIR, '.upload-balok-' + stamp)


    try {
      let extractStats = null
      try {
        fs.mkdirSync(tmpRoot, { recursive: true })
        // Extraction is ~60% of post-upload work; report per file so the
        // admin bar ticks in real 1% steps instead of an ETA curve.
        extractStats = await sourceBuild._internal.extractZipBuffer(file.buffer, tmpRoot, (done, total) => {
          const frac = total > 0 ? done / total : 0
          setSourceProgress('balok', 1 + frac * 59, 'Extracting…', done + ' / ' + (total || '?') + ' files')
        })
        setSourceProgress('balok', 62, 'Validating source shape…', '')
        await sourceBuild._internal.maybeStripCommonRoot(tmpRoot)
        _validateBalokZipShape(tmpRoot)
      } catch (e) {
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) } catch (_) {}
        return res.status(400).json({ error: 'extract/validate failed: ' + e.message })
      }

      if (_hasActiveBuildJob()) {
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) } catch (_) {}
        return res.status(409).json({ error: 'a build started during upload — cancel it (or wait) and retry' })
      }

      try { dbApi.setMeta('source_balok_partial', '1') } catch (_) {}
      setSourceProgress('balok', 65, 'Installing files…', '')


      const replacedDirs = []
      const skippedDirs = []
      const replacedFiles = []
      const overlaidDirs = {}

      // Install stage spans 65 → 97%. One tick per dir/file so the operator
      // sees named, real progress for every unit of work.
      const _installUnits = _BALOK_REPLACE_DIRS.length + _BALOK_OVERLAY_DIRS.length + _BALOK_REPLACE_FILES.length
      let _installDone = 0
      const tickInstall = (what) => {
        _installDone++
        const frac = _installUnits > 0 ? _installDone / _installUnits : 1
        setSourceProgress('balok', 65 + frac * 32, 'Installing files…', what)
      }

      for (const sub of _BALOK_REPLACE_DIRS) {
        const srcDir = path.join(tmpRoot, sub)
        if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) { skippedDirs.push(sub); tickInstall('skipped ' + sub + '/'); continue }
        const targetDir = path.join(BALOK_DIR, sub)
        const trashDir = path.join(BALOK_DIR, sub + '.trash-' + stamp)
        const tmpAdjacent = path.join(BALOK_DIR, sub + '.tmp-' + stamp)
        try {
          await _renameWithRetry(srcDir, tmpAdjacent, sub + ' (tmpRoot→tmpAdjacent)')
          await _swapDirSafely(tmpAdjacent, targetDir, trashDir, () => {})
          replacedDirs.push(sub)
          tickInstall(sub + '/')
        } catch (e) {
          try { await fs.promises.rm(tmpAdjacent, { recursive: true, force: true }) } catch (_) {}
          try { await fs.promises.rm(trashDir, { recursive: true, force: true }) } catch (_) {}
          try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) } catch (_) {}
          return res.status(500).json({ error: 'failed to install ' + sub + '/: ' + e.message, partial: true, replacedSoFar: replacedDirs })
        }
      }

      for (const sub of _BALOK_OVERLAY_DIRS) {
        const srcDir = path.join(tmpRoot, sub)
        if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) { tickInstall('skipped ' + sub + '/'); continue }
        try {
          const r = await _overlayDirNoDelete(srcDir, path.join(BALOK_DIR, sub))
          overlaidDirs[sub] = r.copied
          tickInstall(sub + '/ (overlay)')
        } catch (e) {
          try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) } catch (_) {}
          return res.status(500).json({ error: 'failed to overlay ' + sub + '/: ' + e.message, partial: true, replacedSoFar: replacedDirs })
        }
      }

      for (const fname of _BALOK_REPLACE_FILES) {
        const srcFile = path.join(tmpRoot, fname)
        if (!fs.existsSync(srcFile) || !fs.statSync(srcFile).isFile()) { tickInstall('skipped ' + fname); continue }
        const targetFile = path.join(BALOK_DIR, fname)
        const tmpFile = path.join(BALOK_DIR, fname + '.tmp-' + stamp)
        try {
          await _copyFileWithRetry(srcFile, tmpFile)
          await _renameWithRetry(tmpFile, targetFile, fname)
          replacedFiles.push(fname)
          tickInstall(fname)
        } catch (e) {
          try { await fs.promises.unlink(tmpFile) } catch (_) {}
          try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) } catch (_) {}
          return res.status(500).json({ error: 'failed to install ' + fname + ': ' + e.message, partial: true, replacedSoFar: replacedDirs })
        }
      }

      // Don't let a stale package.json in the zip roll the version backwards.
      try {
        const zipVersion = readBalokPkg()?.version || null
        if (prevBalokVersion && zipVersion && _cmpSemver(zipVersion, prevBalokVersion) < 0) {
          writeBalokVersion(prevBalokVersion)
          console.log('[update-source-balok] kept on-disk version ' + prevBalokVersion + ' (zip had ' + zipVersion + ')')
        }
      } catch (e) {
        console.log('[update-source-balok] WARN: version preserve failed: ' + e.message)
      }



      setSourceProgress('balok', 99, 'Finalising…', '')


      try { dbApi.setMeta('source_balok_partial', '') } catch (_) {}
      const ts = Date.now()
      try { dbApi.setMeta('source_balok_updated_at', String(ts)) } catch (e) {
        console.log('[update-source-balok] WARN: failed to record updated-at: ' + e.message)
      }

      setImmediate(() => {
        fs.promises.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
          .catch(e => console.log('[update-source-balok] WARN: failed to rm tmpRoot ' + tmpRoot + ': ' + e.message))
      })

      const pkg = readBalokPkg()
      res.json({
        ok: true,
        updatedAt: ts,
        version: pkg ? pkg.version : null,
        replacedDirs,
        skippedDirs,
        replacedFiles,
        overlaidDirs,
        entryCount: extractStats.entryCount,
        totalUncompressed: extractStats.totalUncompressed,
        uploadBytes: file.buffer.length,
      })
    } finally {
      _sourceUpdateInFlight = false
      clearSourceProgress()
      try { jobRunner.resumeDispatch() } catch (_) {}
    }

  }
)


app.post('/api/admin/build-balok', requireAdmin, (req, res) => {
  if (!BALOK_DIR) {
    return res.status(503).json({ error: 'balok/ directory not found — expected at ' + path.join(__dirname, '..', 'balok') })
  }

  // Optional: bump the version in balok/package.json before building
  const newVersion = (req.body && typeof req.body.version === 'string') ? req.body.version.trim() : ''
  if (newVersion) {
    if (!/^\d+\.\d+\.\d+/.test(newVersion)) {
      return res.status(400).json({ error: 'Invalid version format — use semver, e.g. 1.2.3' })
    }
    try { writeBalokVersion(newVersion) } catch (e) {
      return res.status(500).json({ error: 'Failed to write version to balok/package.json: ' + e.message })
    }
  }

  const job = jobRunner.enqueueInlineJob({
    label: 'Build Balok' + (newVersion ? ' v' + newVersion : ''),
    channels: [],
    work: async (j) => {
      const { jobAppend, runStep, jobEmitPhase } = jobRunner
      // Emit the first phase immediately so the admin card leaves
      // "Waiting in queue… 0%" the moment the job is dispatched and the bar
      // starts ticking 1%, 2%, … instead of sitting at zero.
      jobEmitPhase(j, 'bkd-prepare')
      jobAppend(j, '[balok] ── Starting Balok web build ──')
      jobAppend(j, '[balok] Directory: ' + BALOK_DIR)
      if (newVersion) jobAppend(j, '[balok] Version: ' + newVersion)

      // ── Task #6: Delete Replit-generated package-lock.json ───────────────
      // The lock file is generated inside Replit and contains resolved URLs
      // pointing to http://package-firewall.replit.local/ — an internal proxy
      // unreachable on Windows. Deleting it before install forces npm to
      // re-resolve packages from the public npmjs.com registry.
      const lockPath = path.join(BALOK_DIR, 'package-lock.json')
      if (fs.existsSync(lockPath)) {
        try {
          const snippet = fs.readFileSync(lockPath, 'utf8').slice(0, 4096)
          if (snippet.includes('package-firewall.replit.local')) {
            jobAppend(j, '[balok] Replit-generated package-lock.json detected — removing for clean install…')
            fs.unlinkSync(lockPath)
          }
        } catch (_) { /* best-effort — non-fatal */ }
      }

      // Install dependencies if node_modules is absent
      const nmDir = path.join(BALOK_DIR, 'node_modules')
      const needsInstall = !fs.existsSync(nmDir)
      jobEmitPhase(j, 'bkd-install')
      if (needsInstall) {
        jobAppend(j, '[balok] node_modules missing — running npm install…')
        // shell:true is required on Windows (npm is a .cmd script) and harmless on Linux
        const installCode = await runStep(j, 'npm', ['install', '--no-audit', '--no-fund'], { cwd: BALOK_DIR, shell: true })
        if (j.cancelRequested) return
        if (installCode !== 0) throw new Error('npm install failed (exit ' + installCode + ')')
        jobAppend(j, '[balok] npm install done')
      } else {
        jobAppend(j, '[balok] node_modules present — skipping install')
      }

      // Production Vite build
      jobEmitPhase(j, 'bkd-build')
      jobAppend(j, '[balok] Running: npm run build')
      const buildCode = await runStep(j, 'npm', ['run', 'build'], { cwd: BALOK_DIR, shell: true })
      if (j.cancelRequested) return
      if (buildCode !== 0) throw new Error('npm run build failed (exit ' + buildCode + ')')

      jobAppend(j, '[balok] ✓ Build complete — output in balok/dist/')
    },

  })

  res.json({ jobId: job.id, version: newVersion || readBalokPkg()?.version || null })
})

// ── Balok customer CRUD & per-customer build pipeline ─────────────────────────
// Balok is a SEPARATE product from walok with its own customer list, OTA
// builds, and download links. Architecture mirrors walok exactly — same DB
// pattern, same job runner, same OTA manifest format — but uses the balok/
// source tree and publishes to public/balok-updates/<channel>/.

const BALOK_BRANDING_DIR = path.join(__dirname, 'balok-branding')
const BALOK_BUILDS_DIR   = path.join(__dirname, '.balok-builds')
const BALOK_UPDATES_DIR  = path.join(__dirname, 'public', 'balok-updates')
for (const d of [BALOK_BRANDING_DIR, BALOK_BUILDS_DIR, BALOK_UPDATES_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

// OTA gate for Balok — mirrors the /updates gate: if the customer has
// updates disabled, return 204 so the launcher knows not to prompt.
// Payload zips fall through to the express.static handler unchanged.
app.get('/balok-updates/:channel/latest.json', (req, res, next) => {
  const ch = req.params.channel
  if (!isValidChannel(ch)) return next()
  const c = dbApi.getBalokCustomer(ch)
  if (!c) return next()
  if (c.updatesEnabled === false) return res.status(204).end()
  next()
})

// Serve Balok OTA payloads and manifests.  Public — no auth — so installed
// launchers can fetch updates without a session cookie.
app.use('/balok-updates', express.static(BALOK_UPDATES_DIR, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  },
}))

// List all Balok customers with version/file presence info
app.get('/api/admin/balok-customers', requireAdmin, (req, res) => {
  const safeForPath = v => typeof v === 'string' && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v)
  const customers = dbApi.listBalokCustomers().map(c => {
    const candidates = [balokArtifactNames(c).launcher, ...LEGACY_BALOK_ZIPS]
    const found = c.version && safeForPath(c.version)
      ? candidates.find(n => fs.existsSync(path.join(BALOK_UPDATES_DIR, c.channel, c.version, n)))
      : null
    let logoRevision = 0
    if (c.logo) {
      try {
        const p = path.isAbsolute(c.logo) ? c.logo : path.resolve(__dirname, c.logo)
        logoRevision = fs.statSync(p).mtimeMs
      } catch (_) {}
    }
    return { ...c, _fileExists: !!found, _launcherZip: found || null, _logoRevision: logoRevision }
  })

  res.json({ customers, balokVersion: readBalokPkg()?.version || null })
})

app.post('/api/admin/balok-customers', requireAdmin, (req, res) => {
  const { channel, brandName, subtitle, updateServer } = req.body || {}
  if (!channel || !brandName || !subtitle || !updateServer)
    return res.status(400).json({ error: 'channel, brandName, subtitle, updateServer required' })
  if (!isValidChannel(channel))
    return res.status(400).json({ error: 'channel must be lowercase letters, numbers, dashes only (1-50 chars)' })
  if (dbApi.getBalokCustomer(channel))
    return res.status(409).json({ error: 'Balok customer "' + channel + '" already exists' })
  const c = dbApi.upsertBalokCustomer({ channel, brandName, subtitle, updateServer })
  res.json({ ok: true, customer: c })
})

app.post('/api/admin/balok-customers/:channel/edit', requireAdmin, (req, res) => {
  const ch = req.params.channel
  if (!isValidChannel(ch)) return res.status(400).json({ error: 'invalid channel' })
  const existing = dbApi.getBalokCustomer(ch)
  if (!existing) return res.status(404).json({ error: 'not found' })
  const { brandName, subtitle, updateServer } = req.body || {}
  const c = dbApi.upsertBalokCustomer({
    channel: ch,
    brandName: brandName || existing.brandName,
    subtitle: subtitle || existing.subtitle,
    updateServer: updateServer || existing.updateServer,
    logo: existing.logo,
  })
  res.json({ ok: true, customer: c })
})

app.post('/api/admin/balok-customers/:channel/updates-enabled', requireAdmin, (req, res) => {
  const ch = req.params.channel
  if (!isValidChannel(ch)) return res.status(400).json({ error: 'invalid channel' })
  const c = dbApi.setBalokUpdatesEnabled(ch, !!(req.body && req.body.enabled))
  if (!c) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true, customer: c })
})

app.delete('/api/admin/balok-customers/:channel', requireAdmin, (req, res) => {
  const ch = req.params.channel
  if (!isValidChannel(ch)) return res.status(400).json({ error: 'invalid channel' })
  if (!dbApi.getBalokCustomer(ch)) return res.status(404).json({ error: 'not found' })
  dbApi.deleteBalokCustomer(ch)
  try { fs.rmSync(path.join(BALOK_UPDATES_DIR, ch), { recursive: true, force: true }) } catch (_) {}
  res.json({ ok: true })
})

// Logo upload / serve for Balok customers
const balokLogoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!fs.existsSync(BALOK_BRANDING_DIR)) fs.mkdirSync(BALOK_BRANDING_DIR, { recursive: true })
      cb(null, BALOK_BRANDING_DIR)
    },
    filename: (req, file, cb) => {
      const ch = req.params.channel
      if (!isValidChannel(ch)) return cb(new Error('invalid channel'))
      const ext = path.extname(file.originalname).toLowerCase()
      const safeExt = ['.png','.jpg','.jpeg','.webp','.bmp'].includes(ext) ? ext : '.png'
      cb(null, ch + '-logo' + safeExt)
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/png','image/jpeg','image/webp','image/bmp'].includes(file.mimetype)
    cb(ok ? null : new Error('Only PNG/JPG/WEBP/BMP allowed'), ok)
  },
})

app.post('/api/admin/balok-customers/:channel/logo', requireAdmin, (req, res) => {
  if (!isValidChannel(req.params.channel)) return res.status(400).json({ error: 'invalid channel' })
  balokLogoUpload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'no file' })
    const ch = req.params.channel
    // Remove stale siblings when the replacement uses another extension.
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.bmp']) {
      const sibling = path.join(BALOK_BRANDING_DIR, ch + '-logo' + ext)
      if (sibling !== req.file.path) { try { fs.rmSync(sibling, { force: true }) } catch (_) {} }
    }
    const logoRel = 'balok-branding/' + req.file.filename
    if (dbApi.getBalokCustomer(ch)) dbApi.setBalokLogo(ch, logoRel)
    res.json({ ok: true, logo: logoRel })
  })
})

app.get('/api/admin/balok-customers/:channel/logo', requireAdmin, (req, res) => {
  if (!isValidChannel(req.params.channel)) return res.status(400).end()
  const c = dbApi.getBalokCustomer(req.params.channel)
  if (!c || !c.logo) return res.status(404).end()
  const abs = path.isAbsolute(c.logo) ? c.logo : path.resolve(__dirname, c.logo)
  if (!abs.startsWith(BALOK_BRANDING_DIR)) return res.status(404).end()
  if (!fs.existsSync(abs)) return res.status(404).end()
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.removeHeader('ETag')
  res.sendFile(abs)
})

// ── Per-customer Balok build ───────────────────────────────────────────────────
// 1. Copy balok/ source to a temp workspace (excluding node_modules/dist)
// 2. Symlink node_modules from balok/ (fast) or run npm install (cold start)
// 3. Apply customer branding: write branding/ota-config.json + patch package.json
// 4. npm run build (Vite web build)
// 5. Zip dist/ → balok-payload.zip
// 6. Publish to public/balok-updates/<channel>/<version>/ + write latest.json
// 7. Record version in DB; clean up workspace

function copyBalokSource(src, dest) {
  const SKIP = new Set(['node_modules','dist','dist-electron','.balok-builds','.build-jobs','.git','branding'])
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const s = path.join(src, e.name), d = path.join(dest, e.name)
    if (e.isDirectory()) copyBalokSource(s, d)
    else fs.copyFileSync(s, d)
  }
}

// Artifact file names are derived from the customer's BRAND NAME, not the
// hardcoded "balok" product name, so a download reads e.g.
// "Balok-Lounge-Launcher.zip" / "Balok-Lounge-Update.zip".
function brandFileBase(c) {
  const slug = String((c && c.brandName) || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || String((c && c.channel) || 'balok')
}
function balokArtifactNames(c) {
  const base = brandFileBase(c)
  return { update: base + '-Update.zip', launcher: base + '-Launcher.zip' }
}
// Legacy names published by older builds — still accepted when checking
// whether a published build exists on disk.
const LEGACY_BALOK_ZIPS = ['balok-payload.zip', 'balok-dist.zip']


app.post('/api/admin/build-balok-customer', requireAdmin, (req, res) => {
  if (!BALOK_DIR) return res.status(503).json({ error: 'balok/ directory not found' })
  const { channel, all, releaseNotes } = req.body || {}
  if (!all && !channel) return res.status(400).json({ error: 'channel or all:true required' })
  const targets = all ? dbApi.listBalokCustomers() : [dbApi.getBalokCustomer(channel)].filter(Boolean)
  if (targets.length === 0) return res.status(404).json({ error: 'no Balok customers found' })
  const releaseNotesClean = typeof releaseNotes === 'string' ? releaseNotes.trim().slice(0, 4000) : ''
  // Version guard: if the version currently on disk was ALREADY published to
  // one of the target channels, republishing it verbatim makes installed
  // launchers show "v1.0.0 -> v1.0.0" (a rebump) instead of a real update.
  //
  // NOTE: Unlike Walok, Balok enforces version separation even if the operator
  // forgot to bump. If the current balok/package.json version matches what's
  // already in latest.json for any target, we auto-increment so the update
  // is detectable.
  const pkgVersion = readBalokPkg()?.version || '1.0.0'
  let buildVersion = pkgVersion

  // For "Build All", we filter targetCustomers to only those whose latest
  // published version is older than buildVersion.
  const skipped = []
  let targetCustomers = targets

  if (all) {
    targetCustomers = targets.filter(c => {
      const info = getBalokChannelInfo(c.channel)
      const current = info?.version || '0.0.0'
      const isNewer = _cmpSemver(buildVersion, current) > 0
      if (!isNewer) skipped.push({ channel: c.channel, current })
      return isNewer
    })
  }

  const jobs = targetCustomers.map(c => {
    const job = jobRunner.enqueueInlineJob({
      label: 'Build Balok: ' + c.channel,
      channels: ['balok-' + c.channel],
      work: async (j) => {
        const { jobAppend, runStep, jobEmitPhase } = jobRunner
        const wsDir = path.join(BALOK_BUILDS_DIR, j.id)
        jobAppend(j, '[balok] ── Building ' + c.channel + ' v' + buildVersion + ' ──')
        jobAppend(j, '[balok] Brand: ' + c.brandName)

        // 1. Copy source
        jobEmitPhase(j, 'bkc-workspace')
        jobAppend(j, '[balok] Copying source to workspace…')
        copyBalokSource(BALOK_DIR, wsDir)

        // 2. Remove Replit-generated lock file
        const lockPath = path.join(wsDir, 'package-lock.json')
        if (fs.existsSync(lockPath)) {
          try {
            if (fs.readFileSync(lockPath, 'utf8').slice(0, 4096).includes('package-firewall.replit.local')) {
              fs.unlinkSync(lockPath)
              jobAppend(j, '[balok] Removed Replit-generated package-lock.json')
            }
          } catch (_) {}
        }

        // 3. Symlink node_modules (fast) or npm install (cold start)
        const nmSrc  = path.join(BALOK_DIR, 'node_modules')
        const nmDest = path.join(wsDir, 'node_modules')
        if (fs.existsSync(nmSrc)) {
          try { fs.symlinkSync(nmSrc, nmDest, 'junction'); jobAppend(j, '[balok] node_modules linked') }
          catch (_) { jobAppend(j, '[balok] Symlink failed — will npm install') }
        }
        if (!fs.existsSync(nmDest)) {
          jobEmitPhase(j, 'bkc-install')
          jobAppend(j, '[balok] Running npm install…')
          const ic = await runStep(j, 'npm', ['install', '--no-audit', '--no-fund'], { cwd: wsDir, shell: true })
          if (j.cancelRequested) return
          if (ic !== 0) throw new Error('npm install failed (exit ' + ic + ')')
        }

        // 4. Apply customer branding
        jobEmitPhase(j, 'bkc-brand')
        const brandDir = path.join(wsDir, 'branding')
        fs.mkdirSync(brandDir, { recursive: true })
        const buildId = String(Date.now()) + '-' + require('crypto').randomBytes(3).toString('hex')
        // Copy logo FIRST so ota-config.json can reference its filename —
        // the launcher renderer uses logoFile as the default brand logo.
        let logoFile = null
        if (c.logo) {
          const logoSrc = path.isAbsolute(c.logo) ? c.logo : path.resolve(__dirname, c.logo)
          if (fs.existsSync(logoSrc)) {
            const pubDir = path.join(wsDir, 'public')
            fs.mkdirSync(pubDir, { recursive: true })
            logoFile = 'logo' + path.extname(logoSrc)
            fs.copyFileSync(logoSrc, path.join(pubDir, logoFile))
            jobAppend(j, '[balok] Logo copied: ' + path.basename(logoSrc))
          }
        }
        // Generate a Windows .ico from the customer logo so the built exe,
        // taskbar, and shortcuts show the customer brand instead of the
        // default Electron icon (balok ships no public/icon.ico of its own).
        if (logoFile) {
          try {
            jobAppend(j, '[balok] Generating icon.ico from logo…')
            const sharpMod = require(path.join(nmDest, 'sharp'))
            const pngToIcoMod = require(path.join(nmDest, 'png-to-ico'))
            const pngToIco = pngToIcoMod.default || pngToIcoMod
            const logoAbs = path.join(wsDir, 'public', logoFile)
            const sizes = [16, 24, 32, 48, 64, 128, 256]
            const pngs = []
            for (const s of sizes) {
              pngs.push(await sharpMod(logoAbs)
                .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png().toBuffer())
            }
            const ico = await pngToIco(pngs)
            fs.writeFileSync(path.join(wsDir, 'public', 'icon.ico'), ico)
            jobAppend(j, '[balok] ✓ icon.ico generated from logo')
          } catch (e) {
            jobAppend(j, '[balok] WARNING: icon generation failed (' + e.message + ') — build continues with default icon')
          }
        }

        // Patch the HTML <title> so the window title (Windows taskbar,
        // Alt-Tab, Task Manager) shows the customer brand, not "BALOK".
        // The renderer also sets document.title at runtime; this covers the
        // moments before React mounts and any place the raw title leaks.
        try {
          const idxPath = path.join(wsDir, 'index.html')
          const safeBrand = String(c.brandName).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          const idx = fs.readFileSync(idxPath, 'utf8')
            .replace(/<title>[^<]*<\/title>/, '<title>' + safeBrand + '</title>')
          fs.writeFileSync(idxPath, idx)
          jobAppend(j, '[balok] HTML title → ' + c.brandName)
        } catch (e) {
          jobAppend(j, '[balok] WARNING: could not patch index.html title: ' + e.message)
        }

        const otaConfig = {
          channel: c.channel, brandName: c.brandName, subtitle: c.subtitle,
          updateServerUrl: c.updateServer.replace(/\/$/, ''),
          version: buildVersion, buildId, logoFile,
        }
        fs.writeFileSync(path.join(brandDir, 'ota-config.json'), JSON.stringify(otaConfig, null, 2))
        // Also drop it in public/ so the built dist (and every OTA payload
        // made from it) carries the branding — the renderer fetches
        // /ota-config.json when the Electron IPC isn't available.
        {
          const pubDir = path.join(wsDir, 'public')
          fs.mkdirSync(pubDir, { recursive: true })
          fs.writeFileSync(path.join(pubDir, 'ota-config.json'), JSON.stringify(otaConfig, null, 2))
        }
        const pkgPath = path.join(wsDir, 'package.json')
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        pkg.version = buildVersion
        if (pkg.build) { pkg.build.appId = 'com.balok.' + c.channel; pkg.build.productName = c.brandName }
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
        jobAppend(j, '[balok] Branding applied (v' + buildVersion + ')')

        // 5. Vite build (renderer bundle — same as walok step 1)
        const isWin = process.platform === 'win32'
        const NPM_CMD_B = isWin ? 'npm.cmd' : 'npm'
        const NPX_CMD_B = isWin ? 'npx.cmd' : 'npx'
        jobEmitPhase(j, 'bkc-vite')
        jobAppend(j, '[balok] Running: npm run build')
        const bc = await runStep(j, NPM_CMD_B, ['run', 'build'], { cwd: wsDir, shell: isWin })
        if (j.cancelRequested) return
        if (bc !== 0) throw new Error('npm run build failed (exit ' + bc + ')')

        // 5b. Zip dist/ → <Brand>-Update.zip — this is the OTA payload.
        //     Installed launchers stage it into userData/<brand>-update/dist/
        //     and load index.html from it, so it must be the WEB dist, not
        //     the unpacked Electron app (whose index.html sits inside asar).
        const artifacts = balokArtifactNames(c)
        const distDir = path.join(wsDir, 'dist')
        if (!fs.existsSync(path.join(distDir, 'index.html'))) {
          throw new Error('vite build produced no dist/index.html')
        }
        jobEmitPhase(j, 'bkc-pack-dist')
        jobAppend(j, '[balok] Packing dist/ → ' + artifacts.update + ' (OTA payload)')
        const distZipPath = path.join(wsDir, artifacts.update)

        let dzCode
        if (isWin) {
          dzCode = await runStep(j, 'powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Compress-Archive -Path '${distDir}\\*' -DestinationPath '${distZipPath}' -Force`,
          ], { shell: false })
        } else {
          dzCode = await runStep(j, 'zip', ['-r', distZipPath, '.'], { cwd: distDir })
        }
        if (dzCode !== 0) throw new Error('Failed to create dist zip (exit ' + dzCode + ')')

        // 6. electron-builder → full Electron .exe in win-unpacked/ (same as walok)
        jobEmitPhase(j, 'bkc-pack-app')
        jobAppend(j, '[balok] Running: electron-builder')
        const ebOutDir = path.join(wsDir, 'dist-electron')
        const ebCode = await runStep(j, NPX_CMD_B, [
          'electron-builder',
          '-c.directories.output=' + ebOutDir,
          '--publish', 'never',
        ], { cwd: wsDir, shell: isWin })
        if (j.cancelRequested) return
        if (ebCode !== 0) throw new Error('electron-builder failed (exit ' + ebCode + ')')

        // 7. Find the unpacked app dir and zip it as the payload (mirrors walok exactly).
        //    electron-builder produces win-unpacked/ on Windows, linux-unpacked/ on Linux.
        const appUnpacked = (() => {
          if (!fs.existsSync(ebOutDir)) return null
          for (const name of fs.readdirSync(ebOutDir)) {
            if (!name.endsWith('-unpacked')) continue
            const p = path.join(ebOutDir, name)
            try { if (fs.statSync(p).isDirectory()) return p } catch (_) {}
          }
          // One level deeper (some eb layouts)
          for (const name of fs.readdirSync(ebOutDir)) {
            const sub = path.join(ebOutDir, name)
            try { if (!fs.statSync(sub).isDirectory()) continue } catch (_) { continue }
            for (const n2 of fs.readdirSync(sub)) {
              if (!n2.endsWith('-unpacked')) continue
              const p = path.join(sub, n2)
              try { if (fs.statSync(p).isDirectory()) return p } catch (_) {}
            }
          }
          return null
        })()
        if (!appUnpacked) throw new Error('electron-builder succeeded but *-unpacked/ not found under ' + ebOutDir)
        jobAppend(j, '[balok] Packing ' + path.basename(appUnpacked) + '/ → ' + artifacts.launcher)
        const zipPath = path.join(wsDir, artifacts.launcher)
        let zipCode
        if (isWin) {
          zipCode = await runStep(j, 'powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Compress-Archive -Path '${appUnpacked}\\*' -DestinationPath '${zipPath}' -Force`,
          ], { shell: false })
        } else {
          zipCode = await runStep(j, 'zip', ['-r', zipPath, '.'], { cwd: appUnpacked })
        }
        if (zipCode !== 0) throw new Error('Failed to create payload zip (exit ' + zipCode + ')')

        jobEmitPhase(j, 'bkc-publish')
        // 8. Publish OTA — two artifacts, both named after the brand:
        //    <Brand>-Update.zip   → OTA payload launchers stage + hot-load
        //    <Brand>-Launcher.zip → full unpacked Electron app (fresh installs)
        const outDir = path.join(BALOK_UPDATES_DIR, c.channel, buildVersion)
        fs.mkdirSync(outDir, { recursive: true })
        fs.copyFileSync(distZipPath, path.join(outDir, artifacts.update))
        fs.copyFileSync(zipPath, path.join(outDir, artifacts.launcher))
        const sha256Of = (p) => require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex')
        const distSha = sha256Of(distZipPath), distSize = fs.statSync(distZipPath).size
        const appSha = sha256Of(zipPath), appSize = fs.statSync(zipPath).size
        const now = Date.now()
        const urlBase = '/balok-updates/' + encodeURIComponent(c.channel) + '/' + encodeURIComponent(buildVersion) + '/'
        // Exe basename the launcher must hand off to after applying. Read it
        // off the real unpacked build (productName drives it) rather than
        // re-deriving from brandName, so a rename can never desync.
        const exeName = (() => {
          try {
            const exes = fs.readdirSync(appUnpacked).filter(n => n.toLowerCase().endsWith('.exe'))
            if (exes.length === 1) return exes[0]
            const wanted = String(c.brandName) + '.exe'
            return exes.find(n => n.toLowerCase() === wanted.toLowerCase()) || exes[0] || null
          } catch (_) { return null }
        })()
        if (!exeName) {
          jobAppend(j, '[balok] WARNING: no .exe found in ' + path.basename(appUnpacked) +
            ' — launchers will fall back to exe discovery after applying.')
        } else {
          jobAppend(j, '[balok] OTA exeName: ' + exeName)
        }
        fs.writeFileSync(path.join(BALOK_UPDATES_DIR, c.channel, 'latest.json'), JSON.stringify({
          channel: c.channel, version: buildVersion, buildId, releasedAt: now,
          notes: releaseNotesClean || '',
          // Full-install OTA (walok parity): the payload is the whole unpacked
          // Electron app, so an update replaces the exe, the Electron shell and
          // resources/ota-config.json — not just the web bundle. exeName lets
          // the launcher hand off to the new (possibly renamed) exe and queue
          // the old one for deletion on the next launch.
          exeName: exeName || undefined,
          keepExes: [],
          launcher: {
            version: buildVersion,
            url: urlBase + encodeURIComponent(artifacts.launcher),
            sha256: appSha, size: appSize,
          },
          balok: {
            version: buildVersion,
            // Full app — this is now the OTA payload launchers install.
            appZipUrl: urlBase + encodeURIComponent(artifacts.launcher),
            appSha256: appSha, appSize,
            // Legacy dist-only payload, kept published so pre-full-install
            // launchers still update (they ignore the launcher block).
            zipUrl: urlBase + encodeURIComponent(artifacts.update),
            sha256: distSha, size: distSize,
          },
        }, null, 2))
        dbApi.recordBalokBuild(c.channel, buildVersion, now)
        jobAppend(j, '[balok] ✓ OTA published: ' + c.channel + ' v' + buildVersion)
        jobAppend(j, '[balok] OTA payload:  ' + urlBase + artifacts.update)
        jobAppend(j, '[balok] Full app:     ' + urlBase + artifacts.launcher)


        // Push a live "update available" event so connected launchers pick
        // the build up within seconds instead of the next poll.
        try {
          const n = live.broadcast(c.channel, { type: 'update', version: buildVersion, buildId, role: 'launcher' })
          jobAppend(j, '[balok] Live push → ' + (n || 0) + ' connected client(s)')
        } catch (e) {
          jobAppend(j, '[balok] Live push failed (non-fatal): ' + e.message)
        }

        // 9. Clean workspace
        try { fs.rmSync(wsDir, { recursive: true, force: true }) } catch (_) {}
        jobAppend(j, '[balok] ✓ Done!')
      },
    })
    return { jobId: job.id, channel: c.channel }
  })
  res.json({ jobs, skipped, version: buildVersion })
})

// ~10s on a re-run (npm sees node_modules already present and short-circuits).
let _installDepsInFlight = false
let _installDepsStartedAt = 0
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
  _installDepsStartedAt = Date.now()
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

app.get('/api/admin/busy-state', requireAdmin, (req, res) => {
  res.json({
    depsInstalling: _installDepsInFlight,
    depsStartedAt: _installDepsInFlight ? _installDepsStartedAt : null,
    sourceReplacing: _sourceUpdateInFlight,
    sourceStartedAt: _sourceUpdateInFlight ? _sourceUpdateStartedAt : null,
    sourceKind: _sourceUpdateInFlight ? _sourceUpdateKind : null,
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

// ============ ADMIN NOTIFICATION CONFIG ROUTES ============
//
// GET /api/admin/notifications/:channel
//   Returns persisted notification config for the channel (no credentials).
//   Also includes the notification service status (configured/not-configured).
//
// PUT /api/admin/notifications/:channel
//   Body: { enabled?, gameLaunches?, pcMonitoring?, roster? }
//   roster is an array of { name: string, ip: string } — names shown in alerts.
//   Max 100 entries, name/ip capped at 128 chars each.
//
// POST /api/admin/notifications/:channel/test
//   Sends a test Telegram message for this channel.
//   Returns clear configured/not-configured status.

app.get('/api/admin/notifications/:channel', requireAdmin, (req, res) => {
  const { channel } = req.params
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  if (!isKnownLiveChannel(channel)) return res.status(404).json({ error: 'unknown channel' })

  let cfg
  try { cfg = dbApi.getOrCreateNotifConfig(channel) } catch (e) {
    return res.status(500).json({ error: 'failed to read notification config: ' + e.message })
  }
  res.json({
    config: cfg,
    service: notif.configStatus(),
  })
})

app.put('/api/admin/notifications/:channel', requireAdmin, (req, res) => {
  const { channel } = req.params
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  if (!isKnownLiveChannel(channel)) return res.status(404).json({ error: 'unknown channel' })

  const body = req.body || {}

  // Validate roster if provided.
  let roster
  if ('roster' in body) {
    if (!Array.isArray(body.roster)) {
      return res.status(400).json({ error: 'roster must be an array' })
    }
    if (body.roster.length > 100) {
      return res.status(400).json({ error: 'roster may not exceed 100 entries' })
    }
    roster = []
    for (let i = 0; i < body.roster.length; i++) {
      const entry = body.roster[i]
      if (!entry || typeof entry !== 'object') {
        return res.status(400).json({ error: 'roster[' + i + '] must be an object with name and ip' })
      }
      const name = typeof entry.name === 'string' ? entry.name.slice(0, 128).trim() : ''
      const ip   = typeof entry.ip   === 'string' ? entry.ip.slice(0, 128).trim()   : ''
      if (!name) return res.status(400).json({ error: 'roster[' + i + '].name is required' })
      if (!ip)   return res.status(400).json({ error: 'roster[' + i + '].ip is required' })
      roster.push({ name, ip })
    }
  }

  const patch = {}
  if ('enabled'      in body) patch.enabled      = !!body.enabled
  if ('gameLaunches' in body) patch.gameLaunches  = !!body.gameLaunches
  if ('pcMonitoring' in body) patch.pcMonitoring  = !!body.pcMonitoring
  if (roster !== undefined)   patch.roster        = roster

  let cfg
  try { cfg = dbApi.setNotifConfig(channel, patch) } catch (e) {
    return res.status(500).json({ error: 'failed to save notification config: ' + e.message })
  }
  res.json({
    ok: true,
    config: cfg,
    service: notif.configStatus(),
  })
})

app.post('/api/admin/notifications/:channel/test', requireAdmin, async (req, res) => {
  const { channel } = req.params
  if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
  if (!isKnownLiveChannel(channel)) return res.status(404).json({ error: 'unknown channel' })

  const status = notif.configStatus()
  if (!status.configured) {
    return res.json({
      ok: false,
      configured: false,
      service: status,
      reason: 'Telegram credentials not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables on the server.',
    })
  }

  const text = '🔔 <b>Test notification</b>\nChannel: <code>' +
    channel + '</code>\nServer running OK — Telegram delivery confirmed.'

  let result
  try {
    result = await notif.send(text)
  } catch (e) {
    result = { ok: false, configured: true, reason: 'unexpected error: ' + e.message }
  }

  try { dbApi.recordNotifDelivery(channel, result.ok) } catch (_) {}

  res.json({
    ok: result.ok,
    configured: result.configured,
    service: status,
    ...(result.ok ? {} : { reason: result.reason }),
  })
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
    getObservedRequestIp,
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
