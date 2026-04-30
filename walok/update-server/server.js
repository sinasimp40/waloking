const express = require('express')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
const cookieParser = require('cookie-parser')
const multer = require('multer')

const dbApi = require('./db')
const live = require('./live')
const { cleanupAfterBuild } = require('./cleanup')
const jobRunner = require('./job-runner')

const PORT = parseInt(process.env.OTA_PORT || '4231', 10)
const HOST = process.env.OTA_HOST || '0.0.0.0'

const PUBLIC_DIR = path.join(__dirname, 'public')
const UPDATES_DIR = path.join(PUBLIC_DIR, 'updates')
const ADMIN_DIR = path.join(PUBLIC_DIR, 'admin')
const PASSWORD_FILE = path.join(__dirname, '.admin-password')

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

function resolveAdminPassword() {
  if (process.env.OTA_ADMIN_PASSWORD && process.env.OTA_ADMIN_PASSWORD.length >= 8) {
    return { value: process.env.OTA_ADMIN_PASSWORD, source: 'env' }
  }
  if (fs.existsSync(PASSWORD_FILE)) {
    const v = fs.readFileSync(PASSWORD_FILE, 'utf-8').trim()
    if (v.length >= 8) return { value: v, source: 'file' }
  }
  const generated = crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16)
  fs.writeFileSync(PASSWORD_FILE, generated, { mode: 0o600 })
  return { value: generated, source: 'generated' }
}
const ADMIN_PWD_INFO = resolveAdminPassword()
const ADMIN_PASSWORD = ADMIN_PWD_INFO.value

function findProjectRoot() {
  const candidates = [
    process.env.OTA_PROJECT_ROOT,
    path.join(__dirname, '..'),
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

// Auto-bump per-customer build version. Strategy:
//   1. If the customer has a previously-published launcher version, take the
//      MAX of (launcher_version, server_version) and bump the patch by 1.
//      This guarantees strict monotonicity even if launcher and server got
//      out of sync via manual upload.
//   2. Otherwise (fresh customer, no prior publish), seed from the global
//      package.json version so the very first BUILD ships at e.g. 1.0.0
//      instead of arbitrarily jumping to 1.0.1.
// The result is purely advisory — the upload routes still enforce strict
// monotonicity at write time, so a stale read here can't downgrade an
// already-published payload.
function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '')
  if (!m) return null
  return m[1] + '.' + m[2] + '.' + (parseInt(m[3], 10) + 1)
}
function maxSemver(a, b) {
  if (!a) return b
  if (!b) return a
  const pa = a.split('.').map(n => parseInt(n, 10))
  const pb = b.split('.').map(n => parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return a
    if ((pa[i] || 0) < (pb[i] || 0)) return b
  }
  return a
}
function computeNextVersion(channel) {
  // dbApi.getCustomer() returns camelCase fields (launcherVersion /
  // serverVersion) — the snake_case columns are mapped at the boundary in
  // db.js. Read both, take the max so an out-of-sync launcher/server pair
  // still produces a strictly-monotonic next version.
  const c = dbApi.getCustomer(channel)
  const prior = c ? maxSemver(c.launcherVersion, c.serverVersion) : null
  if (prior && /^\d+\.\d+\.\d+$/.test(prior)) {
    const bumped = bumpPatch(prior)
    if (bumped) return bumped
  }
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
// "is the SSE crash fix really deployed?" can be answered in seconds. Note:
// this GET coexists with the existing POST /api/admin/version (which bumps
// the PROJECT version, not the update-server version) — Express dispatches
// by method, but consumers should prefer this endpoint's name to avoid
// confusion.
app.get('/api/admin/build-info', requireAdmin, (req, res) => {
  res.json(BUILD_STAMP)
})

app.get('/api/admin/customers', requireAdmin, (req, res) => {
  if (!PROJECT_ROOT) return res.status(503).json({ error: 'project root not found — cannot manage customers' })
  const reqIp = req.ip || req.connection?.remoteAddress || ''
  const onlineSnapshot = live.snapshot()
  const customers = dbApi.listCustomers().map(c => {
    const launcherInfo = getChannelInfo(c.channel)
    const serverInfo = getChannelInfo(c.channel + '-server')
    const cls = classifyUpdateServerUrl(c.updateServer, reqIp)
    const online = onlineSnapshot[c.channel] || { launchers: [], servers: [], total: 0 }
    return {
      ...c,
      _launcherVersion: launcherInfo?.version || null,
      _serverVersion: serverInfo?.version || null,
      _launcherReleased: launcherInfo?.releasedAt || null,
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
app.post('/api/admin/build', requireAdmin, (req, res) => {
  if (!PROJECT_ROOT) return res.status(503).json({ error: 'project root not found — cannot run builds' })
  const { channel, all, version, dryRun } = req.body || {}
  if (!all && !isValidChannel(channel)) return res.status(400).json({ error: 'channel required (or pass all:true)' })
  if (version && !isValidVersion(version)) return res.status(400).json({ error: 'invalid version (expected x.y.z)' })

  const reqIp = req.ip || req.connection?.remoteAddress || ''
  const targetChannels = all ? dbApi.listCustomers().map(c => c.channel) : [channel]
  if (targetChannels.length === 0) {
    return res.status(400).json({ error: 'no customers configured — add one before building' })
  }

  // Resolve per-customer build version BEFORE spawning anything:
  //   - explicit `version` from request: used for ALL target channels (admin
  //     override, e.g. emergency major bump).
  //   - otherwise: each customer auto-bumps its own patch from its DB row.
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

  // Build steps run inside a per-job isolated workspace (job-runner.js
  // copies the source tree under .build-jobs/<jobId>/ and junctions
  // node_modules in). Step cwd values are RELATIVE to the workspace root.
  // This isolation is what makes the 2-slot parallel queue safe — two
  // builds for different customers can rebrand + vite + electron-builder
  // concurrently without touching each other's files. Channel conflict
  // avoidance in job-runner ensures we never publish the same channel
  // from two parallel builds.
  const serverDir = path.join(PROJECT_ROOT, 'server')
  const steps = [
    {
      label: 'Install root dependencies (npm install)',
      cmd: NPM_CMD, args: ['install', '--no-audit', '--no-fund'],
      cwd: '.', shell: true,
      // skipIf inspects the MAIN project's node_modules — already populated
      // means the workspace's junction will resolve everything; skip this
      // slow step entirely.
      skipIf: () => rootDepsInstalled(),
    },
  ]
  if (fs.existsSync(serverDir)) {
    steps.push({
      label: 'Install server dependencies (npm install in server/)',
      cmd: NPM_CMD, args: ['install', '--no-audit', '--no-fund'],
      cwd: 'server', shell: true,
      skipIf: () => serverDepsInstalled(),
    })
  }
  for (const ch of targetChannels) {
    const v = perChannelVersion[ch]
    steps.push({
      label: 'Build customer "' + ch + '" v' + v,
      cmd: process.execPath, args: ['scripts/build-customer.js', ch],
      cwd: '.',
      env: { BUILD_VERSION: v },
    })
    steps.push({
      label: 'Ship "' + ch + '" v' + v + ' to update server',
      cmd: process.execPath, args: ['scripts/publish-update.js', ch],
      cwd: '.',
      env: { BUILD_VERSION: v, OTA_UPDATES_DIR: UPDATES_DIR },
    })
  }

  const job = jobRunner.enqueueBuildJob({
    label: all ? 'build-all' : 'build-' + channel,
    channels: all ? [] : targetChannels,
    projectRoot: PROJECT_ROOT,
    steps,
    onComplete: (exitCode, j) => {
      if (exitCode !== 0) return
      // Per-channel cleanup + db record + live-push (post-build).
      for (const ch of targetChannels) {
        const v = perChannelVersion[ch]
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
        try {
          dbApi.recordLauncherPublished(ch, v)
          dbApi.recordServerPublished(ch, v)
          dbApi.recordBuild(ch)
        } catch (e) {
          jobAppend(j, '[db] WARN: failed to record version for ' + ch + ': ' + e.message)
        }
        const launcherCount = live.broadcast(ch, { type: 'update', version: v, role: 'launcher' })
        const serverCount = live.broadcast(ch, { type: 'update', version: v, role: 'server' })
        jobAppend(j, '[live-push] ' + ch + ' v' + v + ' -> ' + (launcherCount + serverCount) + ' online client(s)')
      }
    },
  })

  const queueState = jobRunner.getQueueState()
  res.json({
    jobId: job.id,
    status: job.status,
    queuePosition: job.status === 'queued' ? queueState.queued.indexOf(job.id) + 1 : null,
  })

  // Pre-pend the resolved version map + URL warnings to the job log so the
  // operator sees them as soon as the SSE stream connects.
  jobAppend(job, '== Auto-bumped per-customer build versions:')
  for (const ch of targetChannels) {
    jobAppend(job, '   ' + ch + ' -> v' + perChannelVersion[ch])
  }
  jobAppend(job, '')
  for (const ch of targetChannels) {
    const c = dbApi.getCustomer(ch)
    if (!c) continue
    const cls = classifyUpdateServerUrl(c.updateServer, reqIp)
    if (cls === 'placeholder') {
      jobAppend(job, '!! WARNING: customer "' + ch + '" still has a PLACEHOLDER updateServer (' + c.updateServer + ').')
      jobAppend(job, '!! The launcher built from this config will NOT receive OTA updates until you set the URL to your real RDP IP.')
      jobAppend(job, '')
    } else if (cls === 'loopback-when-remote') {
      jobAppend(job, '!! WARNING: customer "' + ch + '" has updateServer = ' + c.updateServer + ' (loopback address).')
      jobAppend(job, '!! You are accessing this admin panel REMOTELY — installed launchers will dial THEIR own loopback, not this server, and never receive updates.')
      jobAppend(job, '')
    }
  }
})

// ============ MANUAL UPLOAD-PRE-BUILT-UPDATE ============
// Lets the operator drop a pre-built launcher-payload.zip (and optionally a
// server-payload.zip) into update-server/public/updates/<channel>/<version>/
// without re-running the build pipeline. Useful when a build was produced
// out-of-band (e.g. on a different machine or by hand).
const uploadPayload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB per zip
})

function sha256OfBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// Mirror electron-builder's productName -> .exe filename behavior. The new
// launcher uses this manifest field to identify the NEW exe after a rebrand
// (so it can spawn it on restart and delete the old DENFI.exe afterwards).
function sanitizeExeName(productName) {
  if (!productName) return null
  const safe = String(productName).replace(/[\\/:*?"<>|]/g, '').trim()
  return safe ? safe + '.exe' : null
}

function writePayloadAndManifest({ channel, version, launcherZip, serverZip, notes }) {
  const channelDir = path.join(UPDATES_DIR, channel, version)
  fs.mkdirSync(channelDir, { recursive: true })
  let launcherInfo = null
  if (launcherZip) {
    const dest = path.join(channelDir, 'launcher-payload.zip')
    fs.writeFileSync(dest, launcherZip)
    launcherInfo = {
      url: '/updates/' + channel + '/' + version + '/launcher-payload.zip',
      size: launcherZip.length,
      sha256: sha256OfBuffer(launcherZip),
    }
  }
  let serverInfo = null
  if (serverZip) {
    const serverDir = path.join(UPDATES_DIR, channel + '-server', version)
    fs.mkdirSync(serverDir, { recursive: true })
    const dest = path.join(serverDir, 'server-payload.zip')
    fs.writeFileSync(dest, serverZip)
    serverInfo = {
      url: '/updates/' + channel + '-server/' + version + '/server-payload.zip',
      size: serverZip.length,
      sha256: sha256OfBuffer(serverZip),
    }
  }
  if (launcherInfo) {
    let exeName = null
    try {
      const cust = dbApi.getCustomer(channel)
      if (cust && cust.brandName) exeName = sanitizeExeName(cust.brandName)
    } catch (e) {}
    const m = {
      version, channel,
      releasedAt: new Date().toISOString(),
      launcher: launcherInfo,
      ...(exeName ? { exeName } : {}),
      notes: notes || ('Manual upload v' + version),
    }
    fs.writeFileSync(path.join(UPDATES_DIR, channel, 'latest.json'), JSON.stringify(m, null, 2))
  }
  if (serverInfo) {
    const m = {
      version, channel: channel + '-server',
      releasedAt: new Date().toISOString(),
      launcher: serverInfo,
      notes: notes || ('Manual upload server v' + version),
    }
    fs.writeFileSync(path.join(UPDATES_DIR, channel + '-server', 'latest.json'), JSON.stringify(m, null, 2))
  }
  return { launcherInfo, serverInfo }
}

app.post('/api/admin/customers/:channel/upload-update',
  requireAdmin,
  (req, res, next) => {
    uploadPayload.fields([
      { name: 'launcher', maxCount: 1 },
      { name: 'server', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message })
      next()
    })
  },
  (req, res) => {
    const channel = req.params.channel
    if (!isValidChannel(channel)) return res.status(400).json({ error: 'invalid channel' })
    if (!dbApi.getCustomer(channel)) return res.status(404).json({ error: 'unknown channel' })
    const version = (req.body && req.body.version) || ''
    if (!isValidVersion(version)) return res.status(400).json({ error: 'invalid version (expected x.y.z)' })

    // Refuse uploads of an older or same version — uploading an older zip would
    // silently downgrade every online install. Strict monotonicity, no override.
    // To re-issue an existing version number, the operator must bump it (e.g.
    // 1.2.3 → 1.2.4) before re-uploading.
    const cmp = (a, b) => {
      const pa = a.split('.').map(n => parseInt(n, 10) || 0)
      const pb = b.split('.').map(n => parseInt(n, 10) || 0)
      for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i] }
      return 0
    }
    {
      const l = getChannelInfo(channel)
      const s = getChannelInfo(channel + '-server')
      const live1 = l && l.version
      const live2 = s && s.version
      if (live1 && cmp(version, live1) <= 0) {
        return res.status(409).json({ error: `version ${version} is not newer than the currently shipped launcher version ${live1}. Bump the version and re-upload.` })
      }
      if (live2 && cmp(version, live2) <= 0) {
        return res.status(409).json({ error: `version ${version} is not newer than the currently shipped server version ${live2}. Bump the version and re-upload.` })
      }
    }
    const launcherFile = req.files?.launcher?.[0]
    const serverFile = req.files?.server?.[0]
    if (!launcherFile && !serverFile) return res.status(400).json({ error: 'at least one of launcher / server payload zip required' })

    // Tolerate clients sending other zip types but flag it so the operator notices.
    for (const f of [launcherFile, serverFile]) {
      if (!f) continue
      if (f.mimetype && !['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(f.mimetype)) {
        // Not fatal — we still proceed, but log the mismatch.
        console.log('[upload-update] note: mimetype "' + f.mimetype + '" for ' + f.fieldname + ', proceeding anyway')
      }
    }

    let result
    try {
      result = writePayloadAndManifest({
        channel, version,
        launcherZip: launcherFile ? launcherFile.buffer : null,
        serverZip: serverFile ? serverFile.buffer : null,
        notes: (req.body && req.body.notes) || null,
      })
    } catch (e) {
      return res.status(500).json({ error: 'failed to write payload: ' + e.message })
    }

    // Clean up older versions for this channel (keep newest only)
    try {
      cleanupAfterBuild({
        projectRoot: PROJECT_ROOT,
        updatesPublicDir: UPDATES_DIR,
        channels: [channel],
        version,
      })
    } catch (e) {
      console.log('[upload-update] cleanup warn: ' + e.message)
    }

    // Record published version + timestamp so the admin pill reflects the
    // upload immediately (without waiting for a manifest re-read).
    try {
      if (launcherFile) dbApi.recordLauncherPublished(channel, version)
      if (serverFile) dbApi.recordServerPublished(channel, version)
    } catch (e) {
      console.log('[upload-update] db record warn: ' + e.message)
    }

    // Live push
    const launcherCount = live.broadcast(channel, { type: 'update', version, role: 'launcher' })
    const serverCount = live.broadcast(channel, { type: 'update', version, role: 'server' })

    res.json({
      ok: true,
      channel, version,
      launcher: result.launcherInfo,
      server: result.serverInfo,
      pushedTo: launcherCount + serverCount,
    })
  }
)

// Multi-target upload — same payload as /api/admin/customers/:channel/upload-update
// but accepts a `target` form field that can be a single channel OR the literal
// "__all__" to push the same zip(s) to every customer in the DB. Runs as a
// tracked job so progress streams to the BUILD CONSOLE via the existing SSE
// pipeline (/api/admin/jobs/:id/stream).
app.post('/api/admin/upload-update',
  requireAdmin,
  (req, res, next) => {
    uploadPayload.fields([
      { name: 'launcher', maxCount: 1 },
      { name: 'server', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message })
      next()
    })
  },
  (req, res) => {
    const target = (req.body && req.body.target) || ''
    const version = (req.body && req.body.version) || ''
    const notes = (req.body && req.body.notes) || null
    if (!isValidVersion(version)) return res.status(400).json({ error: 'invalid version (expected x.y.z)' })

    let channels
    if (target === '__all__') {
      channels = dbApi.listCustomers().map(c => c.channel)
      if (channels.length === 0) return res.status(400).json({ error: 'no customers in database' })
    } else if (isValidChannel(target) && dbApi.getCustomer(target)) {
      channels = [target]
    } else {
      return res.status(400).json({ error: 'target must be a known channel or "__all__"' })
    }

    const launcherFile = req.files?.launcher?.[0]
    const serverFile = req.files?.server?.[0]
    if (!launcherFile && !serverFile) {
      return res.status(400).json({ error: 'at least one of launcher / server payload zip required' })
    }

    // Strict monotonicity guard — applies per channel. No override: an old
    // upload would silently downgrade every online install. Bump the version
    // and re-upload to re-issue.
    {
      const cmp = (a, b) => {
        const pa = a.split('.').map(n => parseInt(n, 10) || 0)
        const pb = b.split('.').map(n => parseInt(n, 10) || 0)
        for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i] }
        return 0
      }
      for (const ch of channels) {
        const l = getChannelInfo(ch)
        const s = getChannelInfo(ch + '-server')
        if (l && cmp(version, l.version) <= 0) {
          return res.status(409).json({ error: `version ${version} is not newer than ${ch} launcher v${l.version}. Bump the version and re-upload.` })
        }
        if (s && cmp(version, s.version) <= 0) {
          return res.status(409).json({ error: `version ${version} is not newer than ${ch} server v${s.version}. Bump the version and re-upload.` })
        }
      }
    }

    // upload-update never runs an external child process — it just writes
    // payloads + does cleanup + live-pushes. We still get a queue slot via
    // enqueueInlineJob so the upload is properly serialised against builds
    // for the same channel (no race on writePayloadAndManifest + manifest
    // write), and the existing SSE/progress UI works unchanged.
    const job = jobRunner.enqueueInlineJob({
      label: target === '__all__' ? 'UPLOAD UPDATE -> ALL CUSTOMERS' : 'UPLOAD UPDATE -> ' + target,
      channels: target === '__all__' ? [] : channels,
      work: async (j) => {
        jobAppend(j, '== upload-update v' + version + ' -> ' + channels.length + ' channel(s): ' + channels.join(', ') + ' ==')
        let totalPushed = 0
        for (const ch of channels) {
          jobAppend(j, '[upload] ' + ch + ' v' + version + ' staging...')
          try {
            writePayloadAndManifest({
              channel: ch, version,
              launcherZip: launcherFile ? launcherFile.buffer : null,
              serverZip: serverFile ? serverFile.buffer : null,
              notes,
            })
          } catch (e) {
            jobAppend(j, '[upload] ' + ch + ' FAILED: ' + e.message)
            continue
          }
          try {
            const summary = cleanupAfterBuild({
              projectRoot: PROJECT_ROOT,
              updatesPublicDir: UPDATES_DIR,
              channels: [ch],
              version,
            })
            for (const s of summary) {
              const removed = [
                ...(s.released?.removed || s.releases?.removed || []).map(v => 'releases/' + v),
                ...(s.published.removed || []).map(v => 'updates/' + v),
                ...(s.publishedServer.removed || []).map(v => 'updates-server/' + v),
              ]
              if (removed.length > 0) jobAppend(j, '[cleanup] ' + ch + ' — removed: ' + removed.join(', '))
            }
          } catch (e) {
            jobAppend(j, '[cleanup] ' + ch + ' WARN: ' + e.message)
          }
          try {
            if (launcherFile) dbApi.recordLauncherPublished(ch, version)
            if (serverFile) dbApi.recordServerPublished(ch, version)
          } catch (e) {
            jobAppend(j, '[db] ' + ch + ' WARN: failed to record version: ' + e.message)
          }
          const launcherCount = live.broadcast(ch, { type: 'update', version, role: 'launcher' })
          const serverCount = live.broadcast(ch, { type: 'update', version, role: 'server' })
          totalPushed += launcherCount + serverCount
          jobAppend(j, '[live-push] ' + ch + ' v' + version + ' -> ' + (launcherCount + serverCount) + ' online client(s)')
        }
        jobAppend(j, '== Done. Total live notifications: ' + totalPushed + ' ==')
      },
    })
    res.json({ jobId: job.id, status: job.status })
  }
)

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
  // mid-build shows the full log instead of only new lines).
  for (const e of job.output) {
    res.write('data: ' + JSON.stringify(e) + '\n\n')
  }
  if (job.status === 'success' || job.status === 'failed' || job.status === 'cancelled') {
    res.write('data: ' + JSON.stringify({ end: true, exitCode: job.exitCode, failedStep: job.failedStep, status: job.status }) + '\n\n')
    res.end()
    return
  }
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch (e) {} }, 15000)
  let detach = null
  const send = (entry) => {
    try { res.write('data: ' + JSON.stringify(entry) + '\n\n') } catch (e) {}
    if (entry.end) {
      clearInterval(heartbeat)
      // Detach synchronously so any further jobAppend (e.g. from a still-
      // running onComplete callback) can never call res.write on the
      // response we are about to end. Do this BEFORE res.end().
      if (detach) { detach(); detach = null }
      try { res.end() } catch (e) {}
    }
  }
  detach = jobRunner.attachListener(req.params.id, send)
  req.on('close', () => { clearInterval(heartbeat); if (detach) { detach(); detach = null } })
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

app.listen(PORT, HOST, () => {
  console.log('')
  console.log('============================================')
  console.log('  OTA UPDATE SERVER  v' + (SERVER_VERSION || '?'))
  console.log('============================================')
  console.log('  Listening on:    http://' + HOST + ':' + PORT)
  console.log('  Updates served:  ' + UPDATES_DIR)
  console.log('  Health check:    http://localhost:' + PORT + '/health')
  console.log('  Web dashboard:   http://localhost:' + PORT + '/')
  console.log('  Admin panel:     http://localhost:' + PORT + '/admin/')
  if (ADMIN_PWD_INFO.source === 'env') {
    console.log('  Admin password:  (from OTA_ADMIN_PASSWORD env)')
  } else if (ADMIN_PWD_INFO.source === 'generated') {
    console.log('  Admin password:  ' + ADMIN_PASSWORD + '  (generated, saved to update-server/.admin-password)')
    console.log('                   Set OTA_ADMIN_PASSWORD to change, or read .admin-password file')
  } else {
    console.log('  Admin password:  (loaded from update-server/.admin-password)')
  }
  console.log('  Project root:    ' + (PROJECT_ROOT || 'NOT FOUND — admin builds disabled'))
  console.log('  Customers in DB: ' + dbApi.listCustomers().length)
  console.log('============================================')
  console.log('')
  console.log('IMPORTANT: Make sure port ' + PORT + ' is open in your Windows Firewall.')
  console.log('Run start.bat which adds the firewall rule automatically.')
})
