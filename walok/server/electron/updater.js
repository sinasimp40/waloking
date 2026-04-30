const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const zlib = require('zlib')
const { spawn } = require('child_process')
// `require('electron')` returns a string when this file is loaded by plain
// Node (e.g. our pure-JS regression tests). Destructuring a string yields
// `undefined` for each field — fine, as long as the helpers we test don't
// invoke `app.relaunch()` etc.
const { app, BrowserWindow } = require('electron')
const otaLive = require('./ota-live')

// Marker file written by the OLD server.exe before exit, sweeped by the NEW
// server.exe on its first launch. Same name as the launcher's marker so the
// install dir layout stays uniform. (The two markers can never collide
// because the server and launcher live in different install directories.)
const CLEANUP_MARKER = '.ota-cleanup.json'

const STATE = {
  config: null,
  appRoot: null,
  pollTimer: null,
  liveSession: null,
  isChecking: false,
  isDownloading: false,
  isApplying: false,
  // Set by applyPendingUpdateOnStartup when the manifest declares a different
  // exe name than the one currently running (rebrand). init() hands off to it
  // BEFORE any window opens; restartApp() also prefers it over app.relaunch().
  nextExePath: null,
  // Active HTTP request count, bumped by api.js's tracking middleware via
  // trackRequestStart/trackRequestEnd. scheduleAutoQuitAfterStage waits
  // for this to reach 0 (with a hard timeout) before exiting so we don't
  // sever in-flight uploads/downloads. Defense against architect finding 2.
  activeRequests: 0,
  // Idempotency guards for the post-stage auto-restart sequence — defense
  // against architect finding 3 (don't double-schedule the relauncher).
  autoQuitTimer: null,
  relaunchScheduled: false,
}

function log(msg) {
  console.log('[OTA-Server] ' + msg)
}

// In tests we can't override process.execPath, so allow the test to inject a
// fake current-exe basename via env var. Production code never sets this.
function getCurrentExeBasename() {
  if (process.env.OTA_TEST_CURRENT_EXE) return process.env.OTA_TEST_CURRENT_EXE
  return path.basename(process.execPath || '')
}

// Windows is case-insensitive: "DENFI.EXE" and "denfi.exe" point at the same
// file. Always normalize before comparing exe basenames so case-only diffs in
// the manifest never re-trigger cleanup against the running exe.
function sameExe(a, b) {
  if (!a || !b) return false
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
}

// Last-resort fallback when manifest.exeName is missing/wrong: scan the
// install dir for top-level .exe files that aren't the currently-running one.
// If exactly one candidate exists, it's almost certainly the new build's exe.
function discoverNewExe(appRoot, currentBasename) {
  try {
    const entries = fs.readdirSync(appRoot, { withFileTypes: true })
    const candidates = entries
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.exe'))
      .map(e => e.name)
      .filter(name => !sameExe(name, currentBasename))
    if (candidates.length === 1) return candidates[0]
  } catch (_) {}
  return null
}

function loadConfig(appRoot, isDev) {
  const configPaths = []
  if (isDev) {
    configPaths.push(path.join(__dirname, '..', '..', 'branding', 'ota-config-server.json'))
  } else {
    configPaths.push(path.join(process.resourcesPath, 'ota-config.json'))
    configPaths.push(path.join(appRoot, 'ota-config.json'))
  }
  for (const p of configPaths) {
    try {
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
        log('Loaded OTA config from ' + p)
        log('  channel=' + cfg.channel + ' version=' + cfg.version + ' server=' + cfg.updateServer)
        return cfg
      }
    } catch (e) {
      log('Failed reading OTA config at ' + p + ': ' + e.message)
    }
  }
  log('No ota-config.json found — OTA disabled')
  return null
}

function broadcast(channel, payload) {
  const wins = BrowserWindow.getAllWindows()
  for (const w of wins) {
    try { w.webContents.send(channel, payload) } catch (e) {}
  }
}

function fetchUrl(rawUrl, onProgress) {
  return new Promise((resolve, reject) => {
    let parsed
    try { parsed = new URL(rawUrl) } catch (e) { return reject(new Error('Invalid URL: ' + rawUrl)) }
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      timeout: 30000,
      headers: { 'User-Agent': 'example-cafe-OTA-Server-Client/1.0' },
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        return fetchUrl(res.headers.location, onProgress).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode + ' from ' + rawUrl))
      }
      const chunks = []
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let downloaded = 0
      res.on('data', (chunk) => {
        chunks.push(chunk)
        downloaded += chunk.length
        if (onProgress && total > 0) onProgress(downloaded, total)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout: ' + rawUrl)) })
  })
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

// === Per-exe identity sidecar (.ota-current-exe.json) ===
// See walok/electron/updater.js for the full design rationale (architect
// round-3 finding). Server-side mirror of the same helpers.
const CURRENT_EXE_RECORD = '.ota-current-exe.json'

function readCurrentExeRecord(appRoot) {
  if (!appRoot) return null
  const p = path.join(appRoot, CURRENT_EXE_RECORD)
  try {
    if (!fs.existsSync(p)) return null
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!data || typeof data.exe !== 'string' || !data.exe) return null
    if (typeof data.version !== 'string' || !data.version) return null
    return { exe: path.basename(String(data.exe)), version: String(data.version) }
  } catch (_) { return null }
}

function writeCurrentExeRecord(appRoot, exeBasename, version) {
  if (!appRoot || !exeBasename || !version) return false
  const p = path.join(appRoot, CURRENT_EXE_RECORD)
  try {
    const payload = {
      exe: path.basename(String(exeBasename)),
      version: String(version),
      written: Date.now(),
    }
    fs.writeFileSync(p, JSON.stringify(payload, null, 2))
    return true
  } catch (e) {
    log('Failed to write ' + CURRENT_EXE_RECORD + ': ' + e.message)
    return false
  }
}

function getBundledVersion() {
  if (process.env.OTA_TEST_BUNDLED_VERSION) return process.env.OTA_TEST_BUNDLED_VERSION
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, 'package.json'),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'))
        if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version
      }
    } catch (_) {}
  }
  return null
}

function readAdvertisedVersion(appRoot) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'ota-config.json') : null,
    appRoot ? path.join(appRoot, 'ota-config.json') : null,
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
        if (cfg && typeof cfg.version === 'string' && cfg.version) return cfg.version
      }
    } catch (_) {}
  }
  return null
}

// Successor selection: sidecar > marker.nextExe > discoverNewExe (only
// when neither sidecar nor marker exist).
function pickSuccessorExe(appRoot, currentBasename) {
  try {
    const rec = readCurrentExeRecord(appRoot)
    if (rec && rec.exe) {
      const recorded = path.join(appRoot, rec.exe)
      if (fs.existsSync(recorded) && !sameExe(rec.exe, currentBasename)) {
        return { path: recorded, basename: rec.exe, source: 'current-exe-record' }
      }
    }
  } catch (_) {}
  try {
    const meta = peekCleanupMarkerWithMeta(appRoot)
    if (meta && meta.nextExe) {
      const recorded = path.join(appRoot, meta.nextExe)
      if (fs.existsSync(recorded) && !sameExe(meta.nextExe, currentBasename)) {
        return { path: recorded, basename: meta.nextExe, source: 'marker.nextExe' }
      }
    }
  } catch (_) {}
  try {
    // peekCleanupMarkerWithMeta returns {deleteExes:[], nextExe:null}
    // even when the marker file is absent, so use a stricter check.
    const haveSidecar = !!readCurrentExeRecord(appRoot)
    const markerMeta = peekCleanupMarkerWithMeta(appRoot)
    const haveMarker = !!(markerMeta && (markerMeta.deleteExes.length > 0 || markerMeta.nextExe))
    if (!haveSidecar && !haveMarker) {
      const guess = discoverNewExe(appRoot, currentBasename)
      if (guess) {
        const guessed = path.join(appRoot, guess)
        if (fs.existsSync(guessed) && !sameExe(guess, currentBasename)) {
          return { path: guessed, basename: guess, source: 'discoverNewExe' }
        }
      }
    }
  } catch (_) {}
  return null
}

function detectVersionMismatch(appRoot, currentBasename) {
  const sidecar = readCurrentExeRecord(appRoot)
  if (sidecar) {
    if (sameExe(sidecar.exe, currentBasename)) {
      return {
        stale: false, candidate: null, reason: 'sidecar-matches',
        sidecarExe: sidecar.exe, sidecarVersion: sidecar.version,
      }
    }
    const candidate = pickSuccessorExe(appRoot, currentBasename)
    return {
      stale: true, candidate, reason: 'sidecar-points-elsewhere',
      sidecarExe: sidecar.exe, sidecarVersion: sidecar.version,
    }
  }
  const bundled = getBundledVersion()
  const advertised = readAdvertisedVersion(appRoot)
  if (!bundled || !advertised) {
    return { stale: false, candidate: null, reason: 'unknown-version', bundled, advertised }
  }
  const cmp = compareVersions(advertised, bundled)
  if (cmp <= 0) {
    return { stale: false, candidate: null, reason: 'up-to-date', bundled, advertised }
  }
  const candidate = pickSuccessorExe(appRoot, currentBasename)
  return { stale: true, candidate, reason: 'older-than-advertised', bundled, advertised }
}

// Transactional ZIP extraction. See walok/electron/updater.js for the long
// rationale; mirrored here so the embedded server binary has the same
// rollback-on-partial-failure semantics as the launcher.
function extractZip(zipBuffer, destDir, opts) {
  opts = opts || {}
  const backupDir = opts.backupDir || null
  const successfulEntries = opts.successfulEntries || []
  let pos = 0
  let extracted = 0
  let failed = 0
  const failedFiles = []
  let totalEntries = 0
  while (pos + 4 <= zipBuffer.length) {
    const sig = zipBuffer.readUInt32LE(pos)
    if (sig !== 0x04034b50) break
    const method = zipBuffer.readUInt16LE(pos + 8)
    const compSize = zipBuffer.readUInt32LE(pos + 18)
    const nameLen = zipBuffer.readUInt16LE(pos + 26)
    const extraLen = zipBuffer.readUInt16LE(pos + 28)
    const name = zipBuffer.slice(pos + 30, pos + 30 + nameLen).toString('utf8')
    const dataStart = pos + 30 + nameLen + extraLen
    const compData = zipBuffer.slice(dataStart, dataStart + compSize)
    pos = dataStart + compSize
    if (!name || name.includes('..')) continue
    const entryName = name.replace(/\//g, path.sep)
    const targetPath = path.resolve(destDir, entryName)
    const normalizedDest = path.resolve(destDir) + path.sep
    if (!targetPath.startsWith(normalizedDest) && targetPath !== path.resolve(destDir)) continue
    if (name.endsWith('/') || name.endsWith('\\')) {
      try { fs.mkdirSync(targetPath, { recursive: true }) } catch (e) {}
      continue
    }
    totalEntries++
    const parentDir = path.dirname(targetPath)
    if (!fs.existsSync(parentDir)) {
      try { fs.mkdirSync(parentDir, { recursive: true }) } catch (e) {}
    }
    let content
    try {
      if (method === 0) content = compData
      else if (method === 8) content = zlib.inflateRawSync(compData)
      else { failed++; failedFiles.push(name + ' (unsupported method ' + method + ')'); continue }
    } catch (e) {
      failed++
      failedFiles.push(name + ' (decompress: ' + e.message + ')')
      continue
    }
    const wasReplacement = fs.existsSync(targetPath)
    let backupPath = null
    if (backupDir && wasReplacement) {
      const relForBackup = path.relative(destDir, targetPath)
      backupPath = path.join(backupDir, relForBackup)
      try {
        const backupParent = path.dirname(backupPath)
        if (!fs.existsSync(backupParent)) fs.mkdirSync(backupParent, { recursive: true })
      } catch (_) {}
      try {
        fs.renameSync(targetPath, backupPath)
      } catch (e) {
        failed++
        failedFiles.push(name + ' (backup: ' + e.message + ')')
        continue
      }
    }
    try {
      const tmpPath = targetPath + '.ota-tmp'
      fs.writeFileSync(tmpPath, content)
      try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath) } catch (e) {}
      try {
        fs.renameSync(tmpPath, targetPath)
        extracted++
        successfulEntries.push({ target: targetPath, backupPath, wasReplacement })
      } catch (e) {
        try { fs.copyFileSync(tmpPath, targetPath) } catch (e2) {
          failed++
          failedFiles.push(name + ' (write: ' + e2.message + ')')
          try { fs.unlinkSync(tmpPath) } catch (_) {}
          if (backupPath) {
            try { fs.renameSync(backupPath, targetPath) } catch (_) {}
          }
          continue
        }
        try { fs.unlinkSync(tmpPath) } catch (_) {}
        extracted++
        successfulEntries.push({ target: targetPath, backupPath, wasReplacement })
      }
    } catch (e) {
      failed++
      failedFiles.push(name + ' (write: ' + e.message + ')')
      if (backupPath) {
        try { fs.renameSync(backupPath, targetPath) } catch (_) {}
      }
    }
  }
  return { extracted, failed, totalEntries, failedFiles, successfulEntries }
}

// Mirror of walok/electron/updater.js rollbackExtract.
// NEVER unlinks a replacement target without a backupPath (data loss).
function rollbackExtract(successfulEntries) {
  const restored = []
  const removed = []
  const skipped = []
  for (let i = successfulEntries.length - 1; i >= 0; i--) {
    const e = successfulEntries[i]
    if (e.wasReplacement) {
      if (!e.backupPath) {
        skipped.push(path.basename(e.target))
        continue
      }
      try { fs.unlinkSync(e.target) } catch (_) {}
      try {
        fs.renameSync(e.backupPath, e.target)
        restored.push(path.basename(e.target))
      } catch (_) {
        skipped.push(path.basename(e.target))
      }
    } else {
      try { fs.unlinkSync(e.target) } catch (_) {}
      removed.push(path.basename(e.target))
    }
  }
  return { restored, removed, skipped }
}

// Mirror of walok/electron/updater.js recoverFromLeftoverBackup.
function recoverFromLeftoverBackup(backupDir, destDir) {
  const restored = []
  const failed = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(abs)
        try { fs.rmdirSync(abs) } catch (_) {}
      } else if (ent.isFile()) {
        const rel = path.relative(backupDir, abs)
        const target = path.join(destDir, rel)
        try {
          const targetParent = path.dirname(target)
          if (!fs.existsSync(targetParent)) fs.mkdirSync(targetParent, { recursive: true })
          try { fs.unlinkSync(target) } catch (_) {}
          fs.renameSync(abs, target)
          restored.push(rel)
        } catch (e) {
          failed.push(rel + ' (' + e.message + ')')
        }
      }
    }
  }
  walk(backupDir)
  return { restored, failed }
}

// Read-only walk of an OTA payload zip — returns the basenames of any
// top-level *.exe entries it contains, without extracting anything. Mirrors
// the LFH parser in extractZip but does no I/O. Used by the orphan-exe scan
// so we can answer "is THIS .exe in the install dir part of the just-applied
// payload, or is it stale junk from a previous build?". Top-level only — an
// .exe nested inside a subdirectory in the zip is not one of the binaries
// that sits next to server.exe and is not relevant to orphan cleanup.
function listTopLevelExesInZip(zipBuffer) {
  const out = []
  try {
    let pos = 0
    while (pos + 30 <= zipBuffer.length) {
      const sig = zipBuffer.readUInt32LE(pos)
      if (sig !== 0x04034b50) break
      const compSize = zipBuffer.readUInt32LE(pos + 18)
      const nameLen = zipBuffer.readUInt16LE(pos + 26)
      const extraLen = zipBuffer.readUInt16LE(pos + 28)
      const name = zipBuffer.slice(pos + 30, pos + 30 + nameLen).toString('utf8')
      pos = pos + 30 + nameLen + extraLen + compSize
      if (!name || name.includes('..')) continue
      if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1) continue
      if (!name.toLowerCase().endsWith('.exe')) continue
      out.push(name)
    }
  } catch (_) {}
  return out
}

// Maximum consecutive failed apply attempts before clearing READY. See the
// matching comment in walok/electron/updater.js — same retry-with-cap policy
// so the server-side OTA never strands the user in an infinite retry loop on
// a permanently-broken payload.
const MAX_CONSECUTIVE_APPLY_FAILURES = 5

// "Before" snapshot of top-level *.exe basenames in the install dir so the
// failure-cleanup step can identify which exes were just dropped by the
// in-progress extractZip. Returns lower-cased names (Windows FS).
function snapshotTopLevelExes(appRoot) {
  const out = new Set()
  try {
    for (const e of fs.readdirSync(appRoot, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) out.add(e.name.toLowerCase())
    }
  } catch (_) {}
  return out
}

// Sweep partially-extracted new exes after a failed apply so the user can't
// double-click an integrity-failing binary. Mirrors the launcher-side helper.
function sweepPartialNewExes(appRoot, preExtractExes, payloadExeNames, currentBasename) {
  const removed = []
  const currentLower = currentBasename ? currentBasename.toLowerCase() : null
  const payloadLower = new Set((payloadExeNames || []).map(n => n.toLowerCase()))
  try {
    for (const e of fs.readdirSync(appRoot, { withFileTypes: true })) {
      if (!e.isFile()) continue
      const lower = e.name.toLowerCase()
      if (!lower.endsWith('.exe')) continue
      if (preExtractExes.has(lower)) continue
      if (!payloadLower.has(lower)) continue
      if (currentLower && lower === currentLower) continue
      try {
        fs.unlinkSync(path.join(appRoot, e.name))
        removed.push(e.name)
      } catch (_) {}
    }
  } catch (_) {}
  return removed
}

// Read the consecutiveFailures counter from a previous FAILED marker.
function readPriorFailureCount(failedMarker) {
  try {
    if (!fs.existsSync(failedMarker)) return 0
    const obj = JSON.parse(fs.readFileSync(failedMarker, 'utf-8'))
    if (obj && Number.isInteger(obj.consecutiveFailures)) return obj.consecutiveFailures
  } catch (_) {}
  return 0
}

// Centralised "the apply failed; record diagnostics; decide retry vs give up"
// handler. Mirrors the launcher-side helper.
function recordApplyFailure({ readyMarker, failedMarker, diagnostics }) {
  const priorFailures = readPriorFailureCount(failedMarker)
  const consecutiveFailures = priorFailures + 1
  const giveUp = consecutiveFailures >= MAX_CONSECUTIVE_APPLY_FAILURES
  try {
    fs.writeFileSync(failedMarker, JSON.stringify(Object.assign({}, diagnostics, {
      at: new Date().toISOString(),
      consecutiveFailures,
      gaveUp: giveUp,
    }), null, 2))
  } catch (_) {}
  if (giveUp) {
    log('Apply has failed ' + consecutiveFailures + ' times in a row — clearing READY so the user is not stuck retrying a permanently-broken payload.')
    try { fs.unlinkSync(readyMarker) } catch (_) {}
  } else {
    log('Apply failed (' + consecutiveFailures + '/' + MAX_CONSECUTIVE_APPLY_FAILURES + ' consecutive) — keeping READY so the next launch can retry once the locked files are released.')
  }
}

// Read the operator's persistent allowlist of exe basenames the orphan-exe
// sweep must never delete. Lives at <appRoot>/.ota-keep-exes.json with shape
// { "keepExes": ["ffmpeg.exe", ...] }. Lets ops ship sibling helper tools
// next to server.exe without having them deleted on the next OTA.
// Defense against finding #1 from the Task #3 architect review.
function readKeepExesSidecar(appRoot) {
  try {
    const file = path.join(appRoot, '.ota-keep-exes.json')
    if (!fs.existsSync(file)) return []
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    // Accept three shapes — operators will mistype this, so be forgiving:
    //   ["a.exe","b.exe"]                      (plain array)
    //   { "keep":     ["a.exe", ...] }         (terse object form)
    //   { "keepExes": ["a.exe", ...] }         (verbose object form)
    let arr = null
    if (Array.isArray(data)) arr = data
    else if (data && Array.isArray(data.keep)) arr = data.keep
    else if (data && Array.isArray(data.keepExes)) arr = data.keepExes
    if (!arr) return []
    return arr
      .map(n => (n ? path.basename(String(n)) : null))
      .filter(Boolean)
  } catch (_) {
    return []
  }
}

// Scan the install dir for top-level *.exe files that are stale: not the
// running exe, not the just-staged new exe, and not an entry in the payload
// we just extracted. Returns the basenames so the caller can hand them to
// writeCleanupMarker. Never deletes from inside this function — the
// marker + sweep flow on the *next* launch is the only safe deletion path.
//
// `manifestKeepExes` is an optional allowlist published by the staged
// manifest (manifest.keepExes). It's merged with the on-disk sidecar
// (.ota-keep-exes.json) so operators can protect sibling tools either
// transiently (per-update via manifest) or persistently (sidecar file).
function scanForOrphanExes(appRoot, payloadExeNames, currentBasename, newExeName, manifestKeepExes) {
  const orphans = []
  try {
    const exclude = new Set()
    if (currentBasename) exclude.add(String(currentBasename).toLowerCase())
    if (newExeName) exclude.add(String(newExeName).toLowerCase())
    // payloadExeNames already comes from listTopLevelExesInZip which
    // emits basenames; manifestKeepExes is operator-authored, so we
    // basename-normalize it the same way readKeepExesSidecar does. This
    // means a manifest entry like "tools/ffmpeg.exe" still protects the
    // on-disk ffmpeg.exe under appRoot.
    for (const n of (payloadExeNames || [])) exclude.add(String(n).toLowerCase())
    for (const n of (manifestKeepExes || [])) {
      if (!n) continue
      exclude.add(path.basename(String(n)).toLowerCase())
    }
    for (const n of readKeepExesSidecar(appRoot)) exclude.add(String(n).toLowerCase())
    for (const e of fs.readdirSync(appRoot, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.exe')) continue
      if (exclude.has(e.name.toLowerCase())) continue
      orphans.push(e.name)
    }
  } catch (_) {}
  return orphans
}

// === Cleanup-marker (rebrand orphan-exe deletion) ===

// Persist a list of orphan exe basenames that the *next* launch should delete.
// Windows holds an exclusive lock on the currently-running .exe, so we can't
// delete the OLD .exe from inside the OLD process — we hand the job off to the
// NEW exe (a different process) which can safely unlink it.
//
// `nextExeBasename` (optional): the resolved new exe basename for this
// rebrand. Persisting it in the marker lets init-time self-defense hand
// off to the EXACT exe the rebrand intended, instead of relying on
// discoverNewExe (which would happily pick up an unrelated setup.exe a
// user dropped in the install dir). Defense against finding A from the
// Task #3 architect review. We always keep the latest non-empty value if
// multiple writes happen.
function writeCleanupMarker(appRoot, oldBasenames, nextExeBasename) {
  if (!Array.isArray(oldBasenames) || oldBasenames.length === 0) return
  try {
    const file = path.join(appRoot, CLEANUP_MARKER)
    let existing = []
    let existingNext = null
    try {
      if (fs.existsSync(file)) {
        const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
        if (j && Array.isArray(j.deleteExes)) existing = j.deleteExes
        if (j && typeof j.nextExe === 'string' && j.nextExe.trim()) existingNext = j.nextExe
      }
    } catch (_) {}
    const merged = Array.from(new Set([...existing, ...oldBasenames])).filter(Boolean)
    const nextExe = (nextExeBasename && String(nextExeBasename).trim())
      ? path.basename(String(nextExeBasename))
      : existingNext
    const payload = {
      writtenAt: new Date().toISOString(),
      deleteExes: merged,
    }
    if (nextExe) payload.nextExe = nextExe
    fs.writeFileSync(file, JSON.stringify(payload, null, 2))
    log('Wrote cleanup marker for orphan exe(s): ' + merged.join(', ')
      + (nextExe ? ' (next exe: ' + nextExe + ')' : ''))
  } catch (e) {
    log('Could not write cleanup marker: ' + e.message)
  }
}

// Read the cleanup marker WITHOUT modifying or deleting it. Returns the
// list of basenames the previous launch queued for deletion, or [] if no
// marker exists. Used by the init-time self-defense check ("am I a marked
// orphan?") which must run BEFORE sweepCleanupMarker would otherwise drop
// our self-reference and continue booting.
function peekCleanupMarker(appRoot) {
  return peekCleanupMarkerWithMeta(appRoot).deleteExes
}

// Same as peekCleanupMarker but also returns the recorded `nextExe`
// (when present). Self-defense uses this to hand off to the EXACT exe the
// rebrand intended, instead of guessing via discoverNewExe.
function peekCleanupMarkerWithMeta(appRoot) {
  try {
    const file = path.join(appRoot, CLEANUP_MARKER)
    if (!fs.existsSync(file)) return { deleteExes: [], nextExe: null }
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!data || !Array.isArray(data.deleteExes)) return { deleteExes: [], nextExe: null }
    const deleteExes = data.deleteExes
      .map(n => (n ? path.basename(String(n)) : null))
      .filter(Boolean)
    const nextExe = (typeof data.nextExe === 'string' && data.nextExe.trim())
      ? path.basename(data.nextExe.trim())
      : null
    return { deleteExes, nextExe }
  } catch (_) {
    return { deleteExes: [], nextExe: null }
  }
}

// Self-defense: returns true if the cleanup marker says the currently-running
// exe is an orphan (e.g. user double-clicked the OLD server.exe AFTER a
// rebrand applied but BEFORE the NEW server.exe ran sweepCleanupMarker).
// Loading the new asar inside the old binary would produce a server with
// the wrong identity. The caller hands off to the new exe and exits.
function isSelfMarkedAsOrphan(appRoot) {
  const list = peekCleanupMarker(appRoot)
  if (list.length === 0) return false
  const currentExe = getCurrentExeBasename()
  if (!currentExe) return false
  return list.some(n => sameExe(n, currentExe))
}

// Called early in init() (before any window opens). Deletes orphan .exe files
// AND any Start-menu / Desktop shortcuts that point at them. Skips the
// currently-running exe (we can never delete ourselves on Windows) and
// rewrites/removes the marker so we don't keep retrying a file that's gone.
function sweepCleanupMarker(appRoot) {
  const file = path.join(appRoot, CLEANUP_MARKER)
  if (!fs.existsSync(file)) return
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (e) {
    log('Cleanup marker malformed, removing: ' + e.message)
    try { fs.unlinkSync(file) } catch (_) {}
    return
  }
  const list = Array.isArray(data.deleteExes) ? data.deleteExes : []
  const remaining = []
  const currentExe = getCurrentExeBasename()
  const sweptExes = []
  for (const rawName of list) {
    // Defense-in-depth: collapse to basename so a tampered marker
    // containing "../../system32/something.exe" can't escape the install dir.
    const name = rawName ? path.basename(String(rawName)) : null
    if (!name || sameExe(name, currentExe)) continue // never delete ourselves
    const target = path.join(appRoot, name)
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target)
        log('Deleted orphan exe from previous build: ' + name)
      }
      sweptExes.push(name)
    } catch (e) {
      // Still locked (e.g. user double-clicked the old exe just before we
      // started). Keep it in the marker so we retry on the *next* launch.
      log('Could not delete orphan ' + name + ' (will retry next launch): ' + e.message)
      remaining.push(name)
    }
  }
  // After deleting orphan exes, sweep dangling shortcuts (.lnk) on Windows
  // that point at any of them. Without this, the Start menu still shows
  // "DENFI" after a rebrand to "BLAST" and clicking it produces a missing-
  // target error popup. Tolerated to be a no-op on POSIX (no .lnk format)
  // and on machines without obvious shortcut dirs.
  if (sweptExes.length > 0) {
    try {
      const removed = removeShortcutsTo(appRoot, sweptExes)
      if (removed.length > 0) {
        log('Removed orphan shortcut(s): ' + removed.map(r => r.replace(/^.*[\\\/]/, '')).join(', '))
      }
    } catch (e) {
      log('Shortcut sweep failed (non-fatal): ' + e.message)
    }
  }
  try {
    if (remaining.length === 0) fs.unlinkSync(file)
    else {
      // Carry forward nextExe so that the next-launch self-defense check
      // still has the recorded successor exe to hand off to. Dropping it
      // would silently re-introduce the heuristic discoverNewExe path
      // and re-open the "spawn the wrong exe" risk on retry.
      const out = { writtenAt: data.writtenAt, deleteExes: remaining }
      if (data && typeof data.nextExe === 'string' && data.nextExe) {
        out.nextExe = path.basename(String(data.nextExe))
      }
      fs.writeFileSync(file, JSON.stringify(out, null, 2))
    }
  } catch (_) {}
}

// === Orphan-shortcut sweep ===

// Return the directories where Windows places user-visible app shortcuts.
// On non-Windows, returns []. Honors OTA_TEST_SHORTCUT_DIRS (path-separated
// list) for tests, so we can verify the sweep without a real Windows desktop.
function getShortcutSweepDirs() {
  if (process.env.OTA_TEST_SHORTCUT_DIRS) {
    return process.env.OTA_TEST_SHORTCUT_DIRS.split(path.delimiter).filter(Boolean)
  }
  if (process.platform !== 'win32') return []
  const dirs = []
  const userProfile = process.env.USERPROFILE || ''
  const appData = process.env.APPDATA || ''
  const programData = process.env.PROGRAMDATA || ''
  const publicProfile = process.env.PUBLIC || (userProfile ? path.join(path.dirname(userProfile), 'Public') : '')
  if (userProfile) dirs.push(path.join(userProfile, 'Desktop'))
  if (publicProfile) dirs.push(path.join(publicProfile, 'Desktop'))
  if (appData) dirs.push(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  if (programData) dirs.push(path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  return dirs
}

// Read the target path embedded in a Windows .lnk shortcut without needing
// COM/ActiveX (which Node can't call). The .lnk format is a Microsoft Shell
// Link binary; the target path is in the LinkInfo or a StringData section.
// We do a fast, conservative scan: look for ".exe" sequences in the file's
// UTF-16LE content and return the longest preceding path-like string. This
// is "good enough" for our needs — we only use the result to decide whether
// to delete the shortcut, never to follow it.
function readLnkTarget(lnkPath) {
  try {
    const buf = fs.readFileSync(lnkPath)
    if (buf.length < 76 || buf.readUInt32LE(0) !== 0x0000004C) {
      // Missing Shell Link signature — not a real .lnk.
      return null
    }
    // Scan for "<...>.exe" sequences anywhere in the file. Modern .lnk files
    // can store the target in either ANSI or UTF-16; we cover both. We accept
    // either a Windows drive path (C:\...) or a POSIX absolute path (/...) —
    // the latter only ever appears in tests, but accepting it lets the same
    // helper run on Linux CI without a Wine harness.
    const candidates = []
    // Windows drive-letter path: C:\foo\bar.exe
    const winRe = /([A-Za-z]:\\[^\u0000-\u001f<>"|?*\n\r]*?\.exe)/g
    // POSIX absolute path: /tmp/foo/bar.exe (test harness only)
    const posixRe = /(\/[^\u0000-\u001f<>"|?*\n\r]*?\.exe)/g
    const text = buf.toString('latin1')
    let m
    while ((m = winRe.exec(text))) candidates.push(m[1])
    while ((m = posixRe.exec(text))) candidates.push(m[1])
    // UTF-16LE scan (drop every other byte to get a low-byte view, scan there)
    const lo = Buffer.alloc(Math.floor(buf.length / 2))
    for (let i = 0; i < lo.length; i++) lo[i] = buf[i * 2]
    const wideText = lo.toString('latin1')
    while ((m = winRe.exec(wideText))) candidates.push(m[1])
    while ((m = posixRe.exec(wideText))) candidates.push(m[1])
    if (candidates.length === 0) return null
    // Return the longest match — most likely the full target path rather
    // than some embedded "icon location" sub-path.
    candidates.sort((a, b) => b.length - a.length)
    return candidates[0]
  } catch (_) {
    return null
  }
}

// Remove any .lnk in the standard sweep dirs whose target points at one of
// the orphan exes (matched on basename, case-insensitive). Returns the list
// of removed shortcut paths.
function removeShortcutsTo(appRoot, orphanBasenames) {
  const removed = []
  const orphans = new Set(orphanBasenames.map(n => path.basename(n).toLowerCase()))
  const ourAppRoot = path.resolve(appRoot).toLowerCase()
  for (const dir of getShortcutSweepDirs()) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { continue }
    for (const e of entries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.lnk')) continue
      const full = path.join(dir, e.name)
      const target = readLnkTarget(full)
      if (!target) continue
      const targetBase = path.basename(target).toLowerCase()
      if (!orphans.has(targetBase)) continue
      // Conservative safety check: only remove the shortcut if its target
      // sits inside OUR install dir. Without this check, two unrelated apps
      // that happen to share an exe basename (e.g. "Update.exe") could get
      // each other's Start-menu shortcuts deleted.
      const targetDir = path.dirname(target).toLowerCase()
      if (!targetDir.startsWith(ourAppRoot)) continue
      try {
        fs.unlinkSync(full)
        removed.push(full)
      } catch (_) { /* shortcut might be locked, leave it */ }
    }
  }
  return removed
}

function isPendingStaged() {
  if (!STATE.appRoot) return false
  return fs.existsSync(path.join(STATE.appRoot, '.ota-pending', 'READY'))
}

async function checkForUpdate(opts = {}) {
  if (!STATE.config || !STATE.config.enabled) return { hasUpdate: false }
  if (STATE.isChecking || STATE.isDownloading || STATE.isApplying) return { hasUpdate: false, reason: 'busy' }
  if (isPendingStaged()) {
    log('Update already staged — waiting for restart.')
    return { hasUpdate: false, reason: 'pending-restart' }
  }
  STATE.isChecking = true
  try {
    const url = STATE.config.updateServer.replace(/\/$/, '') + '/updates/' + STATE.config.channel + '/latest.json'
    log('Checking ' + url + ' (current v' + STATE.config.version + ')')
    const buf = await fetchUrl(url)
    const manifest = JSON.parse(buf.toString('utf-8'))
    const remoteVer = manifest.version || '0.0.0'
    if (compareVersions(remoteVer, STATE.config.version) <= 0) {
      log('Up to date (remote v' + remoteVer + ')')
      return { hasUpdate: false, currentVersion: STATE.config.version, latestVersion: remoteVer }
    }
    log('Server update available: v' + remoteVer)
    const result = { hasUpdate: true, currentVersion: STATE.config.version, latestVersion: remoteVer, manifest }
    broadcast('ota:update-available', result)
    if (!opts.checkOnly) {
      setImmediate(() => downloadAndApply(manifest).catch(e => {
        log('Auto-apply failed: ' + e.message)
        broadcast('ota:error', { stage: 'apply', error: e.message })
      }))
    }
    return result
  } catch (e) {
    log('Check failed: ' + e.message)
    broadcast('ota:error', { stage: 'check', error: e.message })
    return { hasUpdate: false, error: e.message }
  } finally {
    STATE.isChecking = false
  }
}

async function downloadAndApply(manifest) {
  if (STATE.isDownloading || STATE.isApplying) return
  STATE.isDownloading = true
  try {
    const payloadInfo = manifest.launcher
    if (!payloadInfo || !payloadInfo.url) throw new Error('Manifest missing payload URL')
    let payloadUrl = payloadInfo.url
    if (payloadUrl.startsWith('/')) {
      payloadUrl = STATE.config.updateServer.replace(/\/$/, '') + payloadUrl
    }
    log('Downloading server payload: ' + payloadUrl)
    broadcast('ota:download-start', { version: manifest.version, totalSize: payloadInfo.size || 0 })
    let lastReport = 0
    const buf = await fetchUrl(payloadUrl, (downloaded, total) => {
      const now = Date.now()
      if (now - lastReport > 200 || downloaded === total) {
        lastReport = now
        broadcast('ota:download-progress', {
          downloaded, total,
          percent: total > 0 ? Math.round((downloaded / total) * 100) : 0
        })
      }
    })
    log('Downloaded ' + buf.length + ' bytes. Verifying...')
    broadcast('ota:verifying', { version: manifest.version })
    if (payloadInfo.sha256) {
      const hash = sha256(buf)
      if (hash !== payloadInfo.sha256) {
        throw new Error('SHA-256 mismatch — file corrupted or tampered')
      }
      log('SHA-256 verified.')
    }
    STATE.isDownloading = false
    STATE.isApplying = true
    broadcast('ota:applying', { version: manifest.version })
    const pendingDir = path.join(STATE.appRoot, '.ota-pending')
    if (fs.existsSync(pendingDir)) {
      try { fs.rmSync(pendingDir, { recursive: true, force: true }) } catch (e) {}
    }
    fs.mkdirSync(pendingDir, { recursive: true })
    fs.writeFileSync(path.join(pendingDir, 'payload.zip'), buf)
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())
    log('Server update staged at ' + pendingDir)
    broadcast('ota:ready-to-restart', { version: manifest.version, currentVersion: STATE.config.version })

    // Auto-restart: previously the server.exe would sit on a staged update
    // forever waiting for someone to call /api/internal/quit-for-update. The
    // launcher does that, but in the user's deployment server.exe runs as
    // an auto-started OS service with no launcher attached, so the update
    // was applied "next time the box rebooted" — never. Trigger a graceful
    // quit ourselves; the OS auto-start brings server.exe back up and the
    // new instance applies .ota-pending on init().
    try { scheduleAutoQuitAfterStage('post-stage auto-restart (v' + manifest.version + ')') } catch (e) {
      log('Could not schedule post-stage auto-restart (non-fatal): ' + e.message)
    }
  } catch (e) {
    log('Download/apply failed: ' + e.message)
    broadcast('ota:error', { stage: 'download', error: e.message })
    throw e
  } finally {
    STATE.isDownloading = false
    STATE.isApplying = false
  }
}

// See walok/electron/updater.js for the full design rationale of the
// out-of-process Windows applier — server-side mirror. PowerShell-based
// applier: hides the console reliably (-WindowStyle Hidden), extracts
// payload.zip directly via Expand-Archive, and uses StartTime to defeat
// PID reuse in the parent-wait loop.
function buildPhase2ApplierPs1() {
  return [
    'param(',
    '  [int]$ParentPid,',
    '  [string]$PendingDir,',
    '  [string]$InstallDir,',
    '  [string]$NewExe',
    ')',
    '$ErrorActionPreference = "Continue"',
    '$applyLog = Join-Path $PendingDir "apply.log"',
    'function Log($msg) {',
    '  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg',
    '  try { Add-Content -LiteralPath $applyLog -Value $line -Encoding utf8 -ErrorAction SilentlyContinue } catch {}',
    '}',
    'Log "phase2 start parent=$ParentPid install=$InstallDir newExe=$NewExe"',
    '',
    '$origStart = $null',
    'try {',
    '  $p0 = Get-Process -Id $ParentPid -ErrorAction Stop',
    '  $origStart = $p0.StartTime',
    '  Log "parent alive at start, StartTime=$origStart"',
    '} catch {',
    '  Log "parent already gone at script start"',
    '}',
    '',
    '$waited = 0',
    'while ($origStart -ne $null) {',
    '  $stillAlive = $false',
    '  try {',
    '    $p = Get-Process -Id $ParentPid -ErrorAction Stop',
    '    if ($p.StartTime -eq $origStart) { $stillAlive = $true }',
    '    else { Log "PID $ParentPid was reused (StartTime differs); treating parent as gone" }',
    '  } catch { }',
    '  if (-not $stillAlive) { break }',
    '  if ($waited -ge 60) {',
    '    Log "timeout waiting for parent $ParentPid"',
    '    "timeout" | Out-File -LiteralPath (Join-Path $PendingDir "FAILED") -Encoding utf8',
    '    exit 1',
    '  }',
    '  Start-Sleep -Seconds 1',
    '  $waited++',
    '}',
    'Log ("parent gone after " + $waited + "s, 3s grace before extract...")',
    'Start-Sleep -Seconds 3',
    '',
    '$zip = Join-Path $PendingDir "payload.zip"',
    '$attempt = 0',
    '$maxAttempts = 5',
    'while ($true) {',
    '  $attempt++',
    '  try {',
    '    Expand-Archive -LiteralPath $zip -DestinationPath $InstallDir -Force -ErrorAction Stop',
    '    Log "Expand-Archive ok on attempt $attempt"',
    '    break',
    '  } catch {',
    '    $msg = $_.Exception.Message',
    '    Log "Expand-Archive attempt $attempt failed: $msg"',
    '    if ($attempt -ge $maxAttempts) {',
    '      "extract" | Out-File -LiteralPath (Join-Path $PendingDir "FAILED") -Encoding utf8',
    '      exit 1',
    '    }',
    '    Start-Sleep -Seconds 2',
    '  }',
    '}',
    '',
    '$mergedCfg = Join-Path $PendingDir "merged-ota-config.json"',
    'if (Test-Path -LiteralPath $mergedCfg) {',
    '  $resDir = Join-Path $InstallDir "resources"',
    '  if (Test-Path -LiteralPath $resDir) {',
    '    $cfgTarget = Join-Path $resDir "ota-config.json"',
    '  } else {',
    '    $cfgTarget = Join-Path $InstallDir "ota-config.json"',
    '  }',
    '  try { Copy-Item -LiteralPath $mergedCfg -Destination $cfgTarget -Force; Log "merged ota-config.json -> $cfgTarget" }',
    '  catch { Log "ota-config copy failed: $_" }',
    '}',
    '$cleanupSrc = Join-Path $PendingDir "cleanup-marker.json"',
    'if (Test-Path -LiteralPath $cleanupSrc) {',
    '  try { Copy-Item -LiteralPath $cleanupSrc -Destination (Join-Path $InstallDir ".ota-cleanup.json") -Force; Log "cleanup marker placed" }',
    '  catch { Log "cleanup marker copy failed: $_" }',
    '}',
    '$sidecarSrc = Join-Path $PendingDir "current-exe-sidecar.json"',
    'if (Test-Path -LiteralPath $sidecarSrc) {',
    '  try { Copy-Item -LiteralPath $sidecarSrc -Destination (Join-Path $InstallDir ".ota-current-exe.json") -Force; Log "current-exe sidecar placed" }',
    '  catch { Log "sidecar copy failed: $_" }',
    '}',
    '',
    '$newExePath = Join-Path $InstallDir $NewExe',
    'try {',
    '  Start-Process -FilePath $newExePath -WorkingDirectory $InstallDir',
    '  Log "launched $newExePath"',
    '  "done" | Out-File -LiteralPath (Join-Path $PendingDir "SUCCESS") -Encoding utf8',
    '} catch {',
    '  Log "launch failed: $_"',
    '  "launch" | Out-File -LiteralPath (Join-Path $PendingDir "FAILED") -Encoding utf8',
    '  exit 1',
    '}',
    '',
    '$selfPath = $PSCommandPath',
    `$pdEsc = $PendingDir.Replace("'", "''")`,
    `$spEsc = $selfPath.Replace("'", "''")`,
    `$cleanupCmd = "Start-Sleep -Seconds 5; Remove-Item -LiteralPath '" + $pdEsc + "' -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '" + $spEsc + "' -Force -ErrorAction SilentlyContinue"`,
    'try {',
    '  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-WindowStyle","Hidden","-ExecutionPolicy","Bypass","-Command",$cleanupCmd) -WindowStyle Hidden',
    '} catch { Log "cleanup schedule failed: $_" }',
    'exit 0',
    '',
  ].join('\r\n')
}

function isSafeExeBasename(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 128
    && /^[A-Za-z0-9._-]+\.exe$/i.test(name)
}

function stageOutOfProcessApply(appRoot, pendingDir, opts) {
  opts = opts || {}
  const zipPath = path.join(pendingDir, 'payload.zip')
  const manifestPath = path.join(pendingDir, 'manifest.json')
  const lockPath = path.join(pendingDir, '.apply.lock')

  // Inter-process lock — atomic O_CREAT|O_EXCL.
  let lockFd = null
  try {
    lockFd = fs.openSync(lockPath, 'wx')
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      let mtimeMs = 0
      try { mtimeMs = fs.statSync(lockPath).mtimeMs || 0 } catch (_) {}
      const age = Date.now() - mtimeMs
      if (age >= 0 && age < 5 * 60 * 1000) {
        return { kind: 'skipped', reason: 'apply lock held (age ' + age + 'ms)' }
      }
      try { fs.rmSync(lockPath, { force: true }) } catch (_) {}
      try { lockFd = fs.openSync(lockPath, 'wx') } catch (e2) {
        return { kind: 'skipped', reason: 'apply lock recreate failed: ' + e2.message }
      }
    } else {
      return { kind: 'error', error: 'apply lock open failed: ' + e.message, diagnostics: { stage: 'lock' } }
    }
  }
  try { fs.writeSync(lockFd, String(process.pid) + '\n' + new Date().toISOString() + '\n') } catch (_) {}
  try { fs.closeSync(lockFd) } catch (_) {}

  const releaseLock = () => { try { fs.rmSync(lockPath, { force: true }) } catch (_) {} }

  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    releaseLock()
    return { kind: 'error', error: 'manifest read failed: ' + e.message, diagnostics: { stage: 'manifest' } }
  }
  if (!manifest.exeName || !manifest.version) {
    releaseLock()
    return { kind: 'error', error: 'manifest missing exeName/version', diagnostics: { stage: 'manifest', manifest } }
  }
  if (!isSafeExeBasename(manifest.exeName)) {
    releaseLock()
    return { kind: 'error', error: 'manifest exeName "' + manifest.exeName + '" is not a safe basename', diagnostics: { stage: 'manifest', manifest } }
  }

  // Validate the payload zip declares the manifest exeName at top level
  // (case-insensitive). Resolve the actual cased name without extracting.
  let resolvedExeName = null
  try {
    const buf = fs.readFileSync(zipPath)
    const tops = listTopLevelExesInZip(buf)
    const want = String(manifest.exeName).trim().toLowerCase()
    for (const n of tops) {
      if (n.toLowerCase() === want) { resolvedExeName = n; break }
    }
  } catch (e) {
    releaseLock()
    return { kind: 'error', error: 'payload scan failed: ' + e.message, diagnostics: { stage: 'payload' } }
  }
  if (!resolvedExeName) {
    releaseLock()
    return { kind: 'error', error: 'payload.zip missing manifest exeName "' + manifest.exeName + '"', diagnostics: { stage: 'verify' } }
  }
  if (!isSafeExeBasename(resolvedExeName)) {
    releaseLock()
    return { kind: 'error', error: 'resolved exe "' + resolvedExeName + '" is not a safe basename', diagnostics: { stage: 'verify' } }
  }

  const oldExe = getCurrentExeBasename() || 'unknown.exe'

  // Pre-write overlay files at the pending-dir root. The PowerShell
  // applier copies them into the install dir after Expand-Archive. No
  // string interpolation of user content into the script — exeName,
  // version, and customer ota-config fields all travel through JSON.
  try {
    const installResourcesCfg = path.join(appRoot, 'resources', 'ota-config.json')
    const installRootCfg      = path.join(appRoot, 'ota-config.json')
    let baseline = null
    if (fs.existsSync(installResourcesCfg)) {
      try { baseline = JSON.parse(fs.readFileSync(installResourcesCfg, 'utf-8')) } catch (_) {}
    } else if (fs.existsSync(installRootCfg)) {
      try { baseline = JSON.parse(fs.readFileSync(installRootCfg, 'utf-8')) } catch (_) {}
    }
    if (baseline && typeof baseline === 'object') {
      baseline.version = String(manifest.version)
      fs.writeFileSync(
        path.join(pendingDir, 'merged-ota-config.json'),
        JSON.stringify(baseline, null, 2),
        { encoding: 'utf-8' },
      )
    }
  } catch (e) {
    log('OOP: ota-config.json pre-merge failed (will continue, next OTA poll will heal): ' + e.message)
  }

  try {
    fs.writeFileSync(
      path.join(pendingDir, 'cleanup-marker.json'),
      JSON.stringify({
        deleteExes: [oldExe],
        nextExe: resolvedExeName,
        createdAt: new Date().toISOString(),
      }, null, 2),
      { encoding: 'utf-8' },
    )
  } catch (e) {
    releaseLock()
    return { kind: 'error', error: 'cleanup-marker.json write failed: ' + e.message, diagnostics: { stage: 'cleanup-marker' } }
  }

  try {
    fs.writeFileSync(
      path.join(pendingDir, 'current-exe-sidecar.json'),
      JSON.stringify({
        exe: resolvedExeName,
        version: String(manifest.version),
        written: Date.now(),
      }, null, 2),
      { encoding: 'utf-8' },
    )
  } catch (e) {
    releaseLock()
    return { kind: 'error', error: 'current-exe-sidecar.json write failed: ' + e.message, diagnostics: { stage: 'sidecar' } }
  }

  const tmpDir = opts._tmpDir || os.tmpdir()
  const applierPath = path.join(tmpDir, 'walok-ota-srv-apply-' + Date.now() + '-' + process.pid + '.ps1')
  const script = opts._ps1Script || buildPhase2ApplierPs1()
  try {
    fs.writeFileSync(applierPath, script, { encoding: 'utf-8' })
  } catch (e) {
    releaseLock()
    return { kind: 'error', error: 'apply.ps1 write failed: ' + e.message, diagnostics: { stage: 'script', applierPath } }
  }

  const args = [
    '-NoProfile',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', applierPath,
    '-ParentPid', String(process.pid),
    '-PendingDir', pendingDir,
    '-InstallDir', appRoot,
    '-NewExe', resolvedExeName,
  ]
  const spawnFn = opts._spawnFn || ((cmd, sa, so) => spawn(cmd, sa, so))
  try {
    const child = spawnFn('powershell.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    if (child && typeof child.unref === 'function') child.unref()
    log('OOP applier spawned (powershell.exe ' + applierPath + '). Exiting so app.asar lock releases.')
    return { kind: 'spawned', applierPath, resolvedExeName, manifest }
  } catch (e) {
    releaseLock()
    return { kind: 'error', error: 'powershell.exe spawn failed: ' + e.message, diagnostics: { stage: 'spawn', applierPath } }
  }
}

function applyPendingUpdateOnStartup(appRoot, _opts) {
  _opts = _opts || {}
  const pendingDir = path.join(appRoot, '.ota-pending')
  const readyMarker = path.join(pendingDir, 'READY')
  const zipPath = path.join(pendingDir, 'payload.zip')
  const failedMarker = path.join(pendingDir, 'FAILED')
  const successMarker = path.join(pendingDir, 'SUCCESS')

  // OOP success sweep: if a prior PowerShell applier wrote SUCCESS but
  // its background self-cleanup didn't sweep the pending dir before we
  // booted, wipe it now so we don't re-apply on every launch.
  if (fs.existsSync(successMarker)) {
    log('Found .ota-pending/SUCCESS from a prior OOP apply — sweeping pending dir.')
    try { fs.rmSync(pendingDir, { recursive: true, force: true }) }
    catch (e) { log('SUCCESS sweep failed (non-fatal): ' + e.message) }
    return false
  }

  if (!fs.existsSync(readyMarker) || !fs.existsSync(zipPath)) return false
  log('Found pending server update — applying...')

  // OOP path: required on Windows. See launcher updater.js for rationale.
  const useOOP = _opts._forceOutOfProcess === true
    || (_opts._forceOutOfProcess !== false && process.platform === 'win32')
  if (useOOP) {
    // Hard kill via process.exit. app.exit was unreliable here because
    // init() runs pre-whenReady in main.js (line 67), where Electron's
    // app.exit doesn't always terminate the parent — leaving the asar
    // lock held and nothing extracting. Mirrors the launcher fix.
    const oopExitFn = _opts._exitFn || ((code) => process.exit(code))
    const stageRes = stageOutOfProcessApply(appRoot, pendingDir, _opts)
    if (stageRes.kind === 'spawned') {
      log('Phase 2 applier handed off — exiting OLD server process now.')
      try { oopExitFn(0) } catch (_) {}
      return true
    }
    if (stageRes.kind === 'skipped') {
      log('OOP apply skipped: ' + stageRes.reason + '. Leaving pending dir for the running applier to finish.')
      return false
    }
    log('OOP staging failed: ' + stageRes.error + '. Recording failure.')
    recordApplyFailure({
      readyMarker, failedMarker,
      diagnostics: Object.assign({ error: stageRes.error, path: 'oop-stage' }, stageRes.diagnostics || {}),
    })
    return false
  }

  let stagedManifest = null
  // Hoisted so the outer catch can roll back when extractZip throws mid-stream.
  let payloadExeNames = null
  const successfulEntries = []
  let backupDir = null
  try {
    const buf = fs.readFileSync(zipPath)
    payloadExeNames = listTopLevelExesInZip(buf)
    backupDir = path.join(pendingDir, '.ota-bak')
    // Recover any leftover backup from a previous killed attempt before
    // wiping it. If recovery is incomplete, abort rather than lose the bytes.
    if (fs.existsSync(backupDir)) {
      try {
        const rec = recoverFromLeftoverBackup(backupDir, appRoot)
        if (rec.restored.length > 0 || rec.failed.length > 0) {
          log('Recovered ' + rec.restored.length + ' file(s) from leftover backup at ' +
            backupDir + (rec.failed.length > 0 ? '; ' + rec.failed.length + ' failed: ' + rec.failed.slice(0, 5).join(', ') : '') + '.')
        }
        if (rec.failed.length > 0) {
          log('UPDATE BLOCKED — leftover backup at ' + backupDir + ' could not be fully recovered. Manual intervention required.')
          recordApplyFailure({
            readyMarker, failedMarker,
            diagnostics: {
              error: 'leftover backup recovery failed',
              backupDir,
              recovered: rec.restored.length,
              failed: rec.failed,
            },
          })
          return false
        }
        try { fs.rmSync(backupDir, { recursive: true, force: true }) } catch (_) {}
      } catch (e) {
        log('UPDATE BLOCKED — could not inspect leftover backup at ' + backupDir + ': ' + e.message)
        recordApplyFailure({
          readyMarker, failedMarker,
          diagnostics: { error: 'leftover backup inspect failed: ' + e.message, backupDir },
        })
        return false
      }
    }
    // Refuse to extract if we can't create the backup dir — running without
    // backups would mean rollback can't restore replaced files (data loss).
    try {
      fs.mkdirSync(backupDir, { recursive: true })
    } catch (e) {
      log('UPDATE BLOCKED — could not create backup dir at ' + backupDir + ': ' + e.message + '. Refusing to extract without transactional rollback.')
      recordApplyFailure({
        readyMarker, failedMarker,
        diagnostics: { error: 'backup dir create failed: ' + e.message, backupDir },
      })
      backupDir = null
      return false
    }
    const result = extractZip(buf, appRoot, { backupDir, successfulEntries })
    log('Extraction: ' + result.extracted + '/' + result.totalEntries + ' files OK, ' + result.failed + ' failed.')
    if (result.failed > 0 || result.extracted === 0) {
      log('UPDATE INCOMPLETE — rolling back to pre-apply state.')
      result.failedFiles.slice(0, 10).forEach(f => log('  failed: ' + f))
      const rb = rollbackExtract(successfulEntries)
      log('Rollback: restored ' + rb.restored.length + ' file(s), removed ' + rb.removed.length + ' new file(s).')
      recordApplyFailure({
        readyMarker, failedMarker,
        diagnostics: Object.assign({}, result, {
          rolledBack: { restored: rb.restored.length, removed: rb.removed.length },
        }),
      })
      return false
    }
    try {
      const manifestPath = path.join(pendingDir, 'manifest.json')
      if (fs.existsSync(manifestPath)) {
        stagedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        const otaCfgPath = path.join(process.resourcesPath || appRoot, 'ota-config.json')
        if (fs.existsSync(otaCfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(otaCfgPath, 'utf-8'))
          cfg.version = stagedManifest.version
          fs.writeFileSync(otaCfgPath, JSON.stringify(cfg, null, 2))
          log('Server OTA config bumped to v' + stagedManifest.version)
        }
      }
    } catch (e) {
      log('Could not bump version: ' + e.message + ' — keeping pending dir for retry.')
      return false
    }

    // Rebrand-aware step (mirrors electron/updater.js): when the manifest
    // declares a different exe name than the one we're currently running
    // (e.g. DENFI-server.exe -> BLAST-server.exe), stash the new exe path so
    // init() can hand off BEFORE creating any window/server-listen, and
    // write a cleanup marker so the NEXT launch unlinks the now-orphaned
    // old exe (currently locked by us).
    try {
      const currentBasename = getCurrentExeBasename()
      let newExeName = null
      const resolveExeOnDisk = (claimed) => {
        try {
          const want = String(claimed).trim().toLowerCase()
          for (const e of fs.readdirSync(appRoot, { withFileTypes: true })) {
            if (e.isFile() && e.name.toLowerCase() === want) return e.name
          }
        } catch (_) {}
        return null
      }
      if (stagedManifest && typeof stagedManifest.exeName === 'string' && stagedManifest.exeName.trim()) {
        const claimed = stagedManifest.exeName.trim()
        const resolved = resolveExeOnDisk(claimed)
        if (resolved) {
          newExeName = resolved
        } else {
          const guess = discoverNewExe(appRoot, currentBasename)
          if (guess) {
            log('WARNING: manifest exeName "' + claimed + '" not found after extraction — discovered "' + guess + '" instead.')
            newExeName = guess
          } else {
            log('WARNING: manifest exeName "' + claimed + '" not found and no unique replacement .exe could be discovered — startup will fall back to app.relaunch().')
          }
        }
      } else {
        const guess = discoverNewExe(appRoot, currentBasename)
        if (guess) {
          log('Legacy manifest had no exeName, but discovered new exe "' + guess + '" in install dir.')
          newExeName = guess
        }
      }
      if (newExeName) {
        STATE.nextExePath = path.join(appRoot, newExeName)
        if (currentBasename && !sameExe(newExeName, currentBasename)) {
          // Persist `newExeName` in the marker so init-time self-defense
          // can hand off to the EXACT exe (defense against architect
          // finding A — never spawn an unrelated installer).
          writeCleanupMarker(appRoot, [currentBasename], newExeName)
          log('Rebrand detected: new server exe is "' + newExeName + '" (was "' + currentBasename + '"). init() will hand off before listen; old exe will be removed on the next launch.')
        }
      }

      // Orphan-exe sweep: queue any sibling *.exe that's not us, not the
      // new exe, and not part of the just-extracted payload. Same logic as
      // the launcher updater — prevents accumulated orphans across many
      // rebrands from piling up next to server.exe.
      // Manifest may publish a `keepExes` allowlist for sibling helper
      // tools (e.g. ffmpeg.exe) that must NOT be swept.
      const manifestKeepExes = (stagedManifest && Array.isArray(stagedManifest.keepExes))
        ? stagedManifest.keepExes : []
      const orphanExtras = scanForOrphanExes(
        appRoot, payloadExeNames, currentBasename, newExeName, manifestKeepExes,
      )
      if (orphanExtras.length > 0) {
        writeCleanupMarker(appRoot, orphanExtras, newExeName || null)
        log('Orphan-exe scan queued ' + orphanExtras.length + ' extra .exe(s) for next-launch cleanup: ' + orphanExtras.join(', '))
      }

      // Write the per-exe identity sidecar (.ota-current-exe.json).
      // Architect round-3 fix: anchors version identity to exe basename
      // so an OLD exe relaunched later detects "I am not canonical"
      // without relying on the OTA-mutated package.json inside the asar.
      // Loud-log a write failure: a stale sidecar could later suppress
      // stale-detection on a subsequent apply (architect round-3 minor).
      try {
        const canonicalExe = newExeName || currentBasename
        const canonicalVersion = (stagedManifest && stagedManifest.version) || null
        if (canonicalExe && canonicalVersion) {
          const wrote = writeCurrentExeRecord(appRoot, canonicalExe, canonicalVersion)
          if (!wrote) {
            log('SEVERE: failed to update .ota-current-exe.json sidecar after apply. ' +
              'A subsequent old-server-exe relaunch may not be detected as stale. Investigate disk permissions.')
          }
        } else {
          log('Skipped sidecar write: canonicalExe=' + canonicalExe + ' canonicalVersion=' + canonicalVersion)
        }
      } catch (e) {
        log('SEVERE: exception writing current-exe identity sidecar: ' + e.message)
      }
    } catch (e) {
      log('Rebrand-aware apply step failed (continuing with default relaunch): ' + e.message)
    }

    try {
      fs.rmSync(pendingDir, { recursive: true, force: true })
    } catch (e) {
      log('Update applied but could not clean .ota-pending: ' + e.message)
    }
    return true
  } catch (e) {
    log('Failed to apply pending update: ' + e.message)
    // If extractZip threw mid-stream, every entry committed before the throw
    // lives in successfulEntries. Roll them back so the install ends up at
    // its pre-extract state instead of a half-replaced black-screen mess.
    let rb = { restored: [], removed: [] }
    if (successfulEntries.length > 0) {
      try {
        rb = rollbackExtract(successfulEntries)
        log('Rollback after exception: restored ' + rb.restored.length + ' file(s), removed ' + rb.removed.length + ' new file(s).')
      } catch (e2) {
        log('Rollback after exception itself failed: ' + e2.message)
      }
    }
    // Same retry-with-cap policy as the partial-extract branch: keep READY
    // for retry on the next launch, capped by MAX_CONSECUTIVE_APPLY_FAILURES.
    recordApplyFailure({
      readyMarker, failedMarker,
      diagnostics: {
        error: e.message,
        stack: e.stack,
        rolledBack: { restored: rb.restored.length, removed: rb.removed.length },
      },
    })
    return false
  }
}

// Spawn a target .exe detached and exit. Returns true on success (caller
// should treat their process as terminated).
function spawnAndExit(targetExe, reason) {
  try {
    log(reason + ': ' + path.basename(targetExe))
    const child = spawn(targetExe, [], {
      detached: true,
      stdio: 'ignore',
      cwd: STATE.appRoot || path.dirname(targetExe),
    })
    child.unref()
    if (app && typeof app.exit === 'function') app.exit(0)
    else process.exit(0)
    return true
  } catch (e) {
    log('Direct spawn failed (' + e.message + ')')
    return false
  }
}

function restartApp() {
  log('Restarting server app...')
  // Preferred: rebrand-aware spawn of the NEW exe directly. app.relaunch()
  // would re-spawn process.execPath which is the OLD exe — that's the same
  // class of bug as the launcher's "garbled window" symptom, here it would
  // produce a server.exe that boots an unbrandable identity.
  try {
    const targetExe = STATE.nextExePath
    if (targetExe && fs.existsSync(targetExe)) {
      if (!sameExe(path.basename(targetExe), getCurrentExeBasename())) {
        if (spawnAndExit(targetExe, 'Spawning new server exe directly')) return
        log('Falling back to app.relaunch()')
      }
    }
  } catch (e) {
    log('restart spawn check failed: ' + e.message)
  }
  if (app && typeof app.relaunch === 'function') {
    app.relaunch()
    app.exit(0)
  } else {
    process.exit(0)
  }
}

function init({ appRoot, isDev, ipcMain }) {
  STATE.appRoot = appRoot

  if (!isDev) {
    // Self-defense FIRST — before sweep, before apply. If the previous
    // launch wrote a cleanup marker that lists OUR basename, we are an
    // orphan that the user just double-clicked (e.g. via a stale shortcut
    // the sweep hadn't reached yet). Loading the new asar inside our old
    // binary produces a server.exe with the wrong identity. Hand off to
    // the discovered new exe and exit immediately.
    try {
      const meta = peekCleanupMarkerWithMeta(appRoot)
      const currentExe = getCurrentExeBasename()
      const isOrphan = currentExe && meta.deleteExes.some(n => sameExe(n, currentExe))
      if (isOrphan) {
        // Prefer the marker-recorded `nextExe` (written at rebrand time).
        // Only fall back to discoverNewExe for legacy markers without that
        // field — and even then only when discovery returns a single
        // confident candidate. This blocks "spawn the wrong exe" when a
        // user drops setup.exe in the install dir. Defense against
        // architect finding A.
        let target = null
        let chosenName = null
        if (meta.nextExe) {
          const recorded = path.join(appRoot, meta.nextExe)
          if (fs.existsSync(recorded) && !sameExe(meta.nextExe, currentExe)) {
            target = recorded
            chosenName = meta.nextExe
          } else {
            log('Self-defense: marker recorded nextExe "' + meta.nextExe + '" but it is missing or matches us — refusing to fall back to discovery for safety.')
          }
        } else {
          const guess = discoverNewExe(appRoot, currentExe)
          if (guess) { target = path.join(appRoot, guess); chosenName = guess }
        }
        if (target) {
          log('Self-defense: this server exe (' + currentExe + ') is listed as an orphan in the cleanup marker — handing off to ' + chosenName + '.')
          if (spawnAndExit(target, 'Orphan self-handoff (pre-init)')) return
          log('Orphan self-handoff failed — continuing as old exe; server identity may be wrong.')
        } else {
          log('Self-defense: marked as orphan but no safe replacement .exe is available. Continuing as old exe.')
        }
      }
    } catch (e) {
      log('Self-defense check failed: ' + e.message)
    }

    // SECONDARY self-defense: explicit version-mismatch detection. Even
    // when the cleanup marker is gone (already swept clean by a previous
    // launch, or never written because the user manually relocated an
    // old exe), comparing the bundled version against the on-disk
    // ota-config.json catches "I'm running a stale binary" cases.
    // Defense against the architect's blocking finding on the first
    // round-2 review pass.
    try {
      const currentExe = getCurrentExeBasename()
      const mismatch = detectVersionMismatch(appRoot, currentExe)
      if (mismatch.stale) {
        log('Version-mismatch self-defense: bundled=v' + mismatch.bundled +
          ' advertised=v' + mismatch.advertised + ' (stale).')
        if (mismatch.candidate) {
          log('  Handing off to ' + mismatch.candidate.basename +
            ' (source=' + mismatch.candidate.source + ').')
          if (spawnAndExit(mismatch.candidate.path, 'Version-mismatch self-handoff (pre-init)')) return
          log('  Version-mismatch handoff failed — continuing as old exe; server identity may be wrong.')
        } else {
          log('  No safe successor exe available — continuing as old exe; server identity may be wrong.')
        }
      }
    } catch (e) {
      log('Version-mismatch self-defense failed (non-fatal): ' + e.message)
    }

    // Sweep first so an orphan exe (and its dangling shortcuts) from a
    // previous rebrand are removed BEFORE we apply any new pending update.
    try { sweepCleanupMarker(appRoot) } catch (e) { log('cleanup sweep failed: ' + e.message) }
    applyPendingUpdateOnStartup(appRoot)

    // CRITICAL handoff (mirrors launcher): when the apply step detected a
    // rebrand, we are STILL the OLD process. If we let init() return and the
    // server's HTTP listener spins up, we'll be running the NEW asar inside
    // the OLD binary — same symptom class as the launcher's garbled window.
    // Hand off NOW: spawn the NEW exe (which will run its own init() in a
    // clean process) and exit immediately.
    try {
      const next = STATE.nextExePath
      if (next && fs.existsSync(next) && !sameExe(path.basename(next), getCurrentExeBasename())) {
        if (spawnAndExit(next, 'Rebrand handoff (pre-listen)')) {
          return // process is exiting; don't continue init()
        }
        log('Pre-listen handoff failed — continuing init() so the user can manually restart.')
      }
    } catch (e) {
      log('Pre-listen handoff check failed (continuing as old exe): ' + e.message)
    }
  }

  STATE.config = loadConfig(appRoot, isDev)

  if (ipcMain) {
    ipcMain.handle('ota:get-status', () => ({
      enabled: !!(STATE.config && STATE.config.enabled),
      currentVersion: STATE.config ? STATE.config.version : null,
      channel: STATE.config ? STATE.config.channel : null,
      updateServer: STATE.config ? STATE.config.updateServer : null,
      brand: STATE.config ? (STATE.config.brand || null) : null,
      isChecking: STATE.isChecking,
      isDownloading: STATE.isDownloading,
      isApplying: STATE.isApplying,
    }))
    ipcMain.handle('ota:check-now', () => checkForUpdate({ checkOnly: false }))
    ipcMain.handle('ota:restart', () => { restartApp(); return { success: true } })
  }

  if (STATE.config && STATE.config.enabled && !isDev) {
    const interval = STATE.config.checkIntervalMs || 120000
    setTimeout(() => { checkForUpdate().catch(() => {}) }, 5000)
    STATE.pollTimer = setInterval(() => { checkForUpdate().catch(() => {}) }, interval)
    log('Polling every ' + Math.round(interval / 1000) + 's (fallback if live push is offline)')

    // Live SSE push channel — same as the launcher updater. The server's
    // OTA config carries channel "<base>-server", but the admin broadcasts
    // to the BASE channel for both roles, so strip the "-server" suffix
    // before subscribing.
    try {
      const baseChannel = String(STATE.config.channel || '').replace(/-server$/, '')
      STATE.liveSession = otaLive.startLive({
        appRoot: STATE.appRoot,
        baseUrl: STATE.config.updateServer,
        channel: baseChannel,
        role: 'server',
        currentVersion: STATE.config.version,
        logPrefix: 'server',
        onUpdate: ({ trigger, version }) => {
          log('Live ' + trigger + ' notification (v' + version + ') — checking for update now')
          checkForUpdate().catch(e => log('live-triggered check failed: ' + e.message))
        },
      })
    } catch (e) { log('live channel init failed: ' + e.message) }
  }

  if (app && typeof app.on === 'function') {
    app.on('before-quit', shutdown)
    app.on('will-quit', shutdown)
  }
}

function shutdown() {
  if (STATE.pollTimer) {
    try { clearInterval(STATE.pollTimer) } catch (e) {}
    STATE.pollTimer = null
  }
  if (STATE.liveSession && typeof STATE.liveSession.close === 'function') {
    try { STATE.liveSession.close() } catch (e) {}
  }
  STATE.liveSession = null
}

// Trigger a graceful shutdown of the server.exe so a pending OTA update can
// be applied on the next launch. Called by the /api/internal/quit-for-update
// HTTP endpoint (api.js wires it up). Schedules the actual exit on the next
// tick so the HTTP response can flush before the process dies.
function gracefulQuitForUpdate(reason) {
  log('Graceful quit-for-update requested: ' + (reason || '(no reason)'))
  setTimeout(() => {
    try {
      if (app && typeof app.quit === 'function') app.quit()
      else process.exit(0)
    } catch (_) {
      process.exit(0)
    }
  }, 250)
}

// Belt-and-braces self-relaunch (Windows-only). Spawn a tiny detached
// cmd.exe helper that:
//   1. Waits `delaySec` seconds (using `ping` because Windows' built-in
//      `timeout.exe` blocks on stdin and is unreliable when detached).
//   2. Runs `start "" "<exe>"` to launch the new process. `start` is a
//      cmd.exe builtin and does not block.
// The parent server.exe will already be gone by the time the timer fires,
// so the new instance can grab the install dir's lock and apply the
// pending update cleanly.
//
// Why this exists: the user's Windows machine has an OS-level auto-start
// for server.exe (Task Scheduler / startup folder / Service). If that
// mechanism is mis-configured or temporarily disabled, the post-stage
// auto-quit would leave the server down. This helper is a safety net.
// Returns true if a relaunch was scheduled, false on non-Windows or any
// failure (logged and treated as non-fatal). Idempotent: subsequent calls
// in the same process are a no-op (defense against architect finding 3 —
// duplicate detached helpers would each call `start` and produce two
// server.exes after exit).
function scheduleSelfRelaunch(targetExePath, delaySec) {
  // OTA_TEST_FORCE_RELAUNCH=1 lets the test suite exercise the spawn path
  // on a Linux runner — production code never sets it.
  const isWin = process.platform === 'win32' || process.env.OTA_TEST_FORCE_RELAUNCH === '1'
  if (!isWin) return false
  if (!targetExePath) return false
  if (STATE.relaunchScheduled) {
    log('Belt-and-braces relauncher already scheduled — skipping duplicate.')
    return false
  }
  const seconds = Math.max(2, Math.min(60, parseInt(delaySec, 10) || 5))
  // `ping -n N` waits N-1 seconds, so add 1 to land at `seconds`.
  const pingCount = seconds + 1
  // Quote the exe path for cmd.exe — embedded spaces are common in
  // "Program Files" installs. The empty "" after `start` is its window
  // title placeholder; without it, start treats a quoted path as a title.
  const cmdLine = 'ping 127.0.0.1 -n ' + pingCount + ' > nul && start "" "' + targetExePath + '"'
  try {
    const child = spawn('cmd.exe', ['/c', cmdLine], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
      cwd: STATE.appRoot || path.dirname(targetExePath),
    })
    child.unref()
    STATE.relaunchScheduled = true
    log('Belt-and-braces relauncher scheduled: ' + path.basename(targetExePath) + ' in ~' + seconds + 's')
    return true
  } catch (e) {
    log('Belt-and-braces relauncher failed (non-fatal): ' + e.message)
    return false
  }
}

// === Drain-aware request tracker ===
//
// api.js installs a middleware that bumps STATE.activeRequests on every
// non-internal request and decrements on response finish/close. The
// post-stage auto-quit then waits (with a hard cap) for the count to
// reach 0 before exiting, so a 500MB save upload or a long download
// isn't sliced at the 7-second mark. Defense against architect finding 2.
function trackRequestStart() { STATE.activeRequests++ }
function trackRequestEnd() {
  STATE.activeRequests = Math.max(0, STATE.activeRequests - 1)
}
function getActiveRequestCount() { return STATE.activeRequests }

// Wait for in-flight requests to drain, polling every 100ms. Resolves to
// true if the count hit 0 within `maxMs`, false otherwise. Never throws.
function waitForActiveRequestsToDrain(maxMs) {
  const cap = Math.max(0, parseInt(maxMs, 10) || 0)
  return new Promise((resolve) => {
    if (STATE.activeRequests === 0) return resolve(true)
    const start = Date.now()
    const tick = () => {
      if (STATE.activeRequests === 0) return resolve(true)
      if (Date.now() - start >= cap) return resolve(false)
      setTimeout(tick, 100)
    }
    tick()
  })
}

// Schedule the post-stage auto-restart sequence. Called by downloadAndApply
// once the .ota-pending/READY marker is on disk. The delay gives:
//   - any in-flight HTTP responses time to flush,
//   - the SSE liveSession a chance to push the "ready-to-restart" event,
//   - the launcher (if connected) time to invoke /api/internal/quit-for-update
//     itself, which would short-circuit ours but produces the same outcome.
// OTA_DISABLE_AUTO_QUIT=1 disables this for tests / debugging sessions.
//
// Idempotent: a second call while a timer is still pending is a no-op.
// Defense against architect finding 3.
function scheduleAutoQuitAfterStage(reason) {
  if (process.env.OTA_DISABLE_AUTO_QUIT === '1') {
    log('Auto-quit after stage skipped (OTA_DISABLE_AUTO_QUIT=1).')
    return
  }
  if (STATE.autoQuitTimer) {
    log('Auto-quit after stage already scheduled — skipping duplicate.')
    return
  }
  const delayMs = 7000
  // Hard cap on how long we wait for in-flight requests to drain past
  // the 7s mark. After this, we exit anyway — leaving the server up
  // forever just because someone is downloading would defeat the OTA.
  const drainMaxMs = 25000
  log('Scheduling post-stage auto-restart in ' + Math.round(delayMs / 1000) + 's…')
  STATE.autoQuitTimer = setTimeout(async () => {
    try {
      const inFlight = STATE.activeRequests
      if (inFlight > 0) {
        log('Waiting for ' + inFlight + ' in-flight request(s) to drain (max ' + Math.round(drainMaxMs / 1000) + 's)…')
        const drained = await waitForActiveRequestsToDrain(drainMaxMs)
        if (!drained) {
          log('Drain timeout — proceeding with auto-quit despite ' + STATE.activeRequests + ' in-flight request(s).')
        } else {
          log('All in-flight requests drained.')
        }
      }
    } catch (e) {
      log('Drain wait failed (non-fatal, proceeding): ' + e.message)
    }
    // Belt-and-braces FIRST so it's already running before we exit. We
    // pass process.execPath (the currently-running server exe) as the
    // relaunch target — the OS auto-start mechanism is the primary path,
    // this is just insurance.
    try { scheduleSelfRelaunch(process.execPath, 5) } catch (_) {}
    gracefulQuitForUpdate(reason || 'post-stage auto-restart')
  }, delayMs)
  // Don't let the timer pin the event loop in a test runner that's
  // waiting for natural quiescence.
  if (STATE.autoQuitTimer && typeof STATE.autoQuitTimer.unref === 'function') {
    STATE.autoQuitTimer.unref()
  }
}

module.exports = {
  init, checkForUpdate, restartApp, applyPendingUpdateOnStartup,
  // Exported so tests can drive the rebrand-style apply + cleanup-marker
  // flow (and the orphan-shortcut sweep) without a real electron build.
  sweepCleanupMarker, writeCleanupMarker, getCurrentExeBasename,
  removeShortcutsTo, gracefulQuitForUpdate,
  // Exported for Task #3 tests
  listTopLevelExesInZip, scanForOrphanExes, peekCleanupMarker, isSelfMarkedAsOrphan,
  scheduleSelfRelaunch, scheduleAutoQuitAfterStage,
  // Exported for the architect-review hardening (Task #3 round 2):
  //   - peekCleanupMarkerWithMeta + readKeepExesSidecar back the new
  //     "exact-match handoff" and "operator allowlist" defenses.
  //   - The request-tracker functions are wired into api.js so we can
  //     drain in-flight requests before auto-quit.
  peekCleanupMarkerWithMeta, readKeepExesSidecar,
  trackRequestStart, trackRequestEnd, getActiveRequestCount,
  waitForActiveRequestsToDrain,
  // Exported for the version-mismatch self-defense tests (Task #3 round 2,
  // architect blocking-finding follow-up):
  getBundledVersion, readAdvertisedVersion, pickSuccessorExe, detectVersionMismatch,
  // round-3 fix: per-exe identity sidecar
  readCurrentExeRecord, writeCurrentExeRecord,
  // partial-apply hardening (rebrand-cleanup bug fix): exposed for tests
  snapshotTopLevelExes, sweepPartialNewExes, recordApplyFailure,
  readPriorFailureCount, MAX_CONSECUTIVE_APPLY_FAILURES,
  // out-of-process Windows applier (Task #18 — phase-2 cmd.exe swap)
  stageOutOfProcessApply, buildPhase2ApplierPs1,
}
