const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const zlib = require('zlib')
const { spawn } = require('child_process')
// `require('electron')` returns a string path when this file is loaded by
// plain Node (e.g. our pure-JS regression test in tests/test-rebrand-update.js).
// Destructuring a string yields `undefined` for each field — fine, as long as
// the helpers we test don't actually invoke `app.relaunch()` etc.
const { app, BrowserWindow } = require('electron')
const otaLive = require('./ota-live')

const CLEANUP_MARKER = '.ota-cleanup.json'

const STATE = {
  config: null,
  appRoot: null,
  pollTimer: null,
  liveSession: null,
  isChecking: false,
  isDownloading: false,
  isApplying: false,
  currentDownload: null,
  // After a rebrand-style update is applied, this points at the NEW exe so
  // restartApp() can spawn it directly instead of relaunching the OLD process
  // path that's still in process.execPath.
  nextExePath: null,
}

// In tests we can't override process.execPath, so allow the test to inject a
// fake current-exe basename via env var. Production code never sets this.
function getCurrentExeBasename() {
  if (process.env.OTA_TEST_CURRENT_EXE) return process.env.OTA_TEST_CURRENT_EXE
  return path.basename(process.execPath || '')
}

// Windows file system is case-insensitive: "BLAST.EXE" and "blast.exe" point
// at the same file. Always normalize before comparing exe basenames so a
// case-only difference in the manifest never re-triggers cleanup against the
// running exe (which would be a no-op forever and leave the marker behind).
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

function log(msg) {
  console.log('[OTA] ' + msg)
}

function loadConfig(appRoot, isDev) {
  const configPaths = []
  if (isDev) {
    configPaths.push(path.join(__dirname, '..', 'branding', 'ota-config.json'))
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
      headers: { 'User-Agent': 'example-cafe-OTA-Client/1.0' },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
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
//
// Architect round-3 finding: reading the bundled version from
// package.json inside the asar is UNSOUND. After an OTA, the asar is
// already rewritten with the NEW version, so an OLD exe that the user
// double-clicks would still see "bundled == advertised" and skip the
// mismatch handoff. The asar is NOT immutable per-exe.
//
// The fix anchors version identity to the exe basename via a small
// JSON file at appRoot, written every time apply() succeeds. Because
// it lives at appRoot (not inside the asar) and is keyed by the
// CANONICAL exe basename + version that apply() wrote, an OLD exe
// with a different basename can detect "I am not canonical" without
// any reliance on package.json contents.
//
// File path:    <appRoot>/.ota-current-exe.json
// File shape:   { exe: "BLAST.exe", version: "2.0.0", written: <epoch_ms> }
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

// Test-only hook: lets tests force a "bundled version" without
// rewriting package.json on the runner. Production code never sets
// OTA_TEST_BUNDLED_VERSION. Used ONLY by the secondary fallback check
// (sidecar absent + ota-config.json present).
function getBundledVersion() {
  if (process.env.OTA_TEST_BUNDLED_VERSION) return process.env.OTA_TEST_BUNDLED_VERSION
  // Fallback for the very first launch (before any OTA has ever
  // written .ota-current-exe.json): read whatever package.json the
  // bundle ships with. Acknowledged as imperfect — it is only used as
  // a degraded signal, never as the PRIMARY source of truth.
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

// Pick a successor exe to hand off to when we've detected we're stale,
// without relying on the cleanup marker. Selection priority:
//   1. .ota-current-exe.json record (HIGHEST confidence — exact basename)
//   2. cleanup marker's recorded `nextExe` (also exact)
//   3. discoverNewExe's heuristic guess (lowest confidence)
// We deliberately avoid picking a random `*.exe` from the install dir.
function pickSuccessorExe(appRoot, currentBasename) {
  // Tier 1: per-exe sidecar (immutable per build).
  try {
    const rec = readCurrentExeRecord(appRoot)
    if (rec && rec.exe) {
      const recorded = path.join(appRoot, rec.exe)
      if (fs.existsSync(recorded) && !sameExe(rec.exe, currentBasename)) {
        return { path: recorded, basename: rec.exe, source: 'current-exe-record' }
      }
    }
  } catch (_) {}
  // Tier 2: cleanup marker's nextExe.
  try {
    const meta = peekCleanupMarkerWithMeta(appRoot)
    if (meta && meta.nextExe) {
      const recorded = path.join(appRoot, meta.nextExe)
      if (fs.existsSync(recorded) && !sameExe(meta.nextExe, currentBasename)) {
        return { path: recorded, basename: meta.nextExe, source: 'marker.nextExe' }
      }
    }
  } catch (_) {}
  // Tier 3: discoverNewExe heuristic. Architect round-3 minor finding:
  // in a sparse install dir this could pick up a lone unrelated exe
  // (e.g. an installer the user dropped in). Restrict tier-3 to cases
  // where there is NO .ota-current-exe.json AND NO cleanup marker —
  // i.e. we have absolutely no other signal. discoverNewExe itself
  // already enforces an "exactly one obvious candidate" rule, so this
  // is a last-resort fallback for the very-first-launch edge case.
  try {
    // peekCleanupMarkerWithMeta returns a NORMALIZED shape even when the
    // file is absent (deleteExes:[], nextExe:null), so use a stricter
    // existence test for the gating condition.
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

// Detect whether the running exe is stale, using the per-exe identity
// sidecar as the PRIMARY source of truth. Returns:
//   { stale, candidate, reason, sidecarExe?, sidecarVersion?, bundled?, advertised? }
//
// Decision tree (in order):
//   1. If .ota-current-exe.json exists and its `exe` differs from our
//      basename → STALE (highest-confidence signal). The OLD exe and
//      the canonical exe coexist on disk; we must hand off.
//   2. If sidecar exists and basename matches us → up-to-date, regardless
//      of what package.json or ota-config.json say. We ARE canonical.
//   3. If no sidecar (very-first-launch / pre-rollout state):
//      degrade to the legacy bundled-vs-advertised compare. Acknowledged
//      as imperfect (architect round-3 finding A) but kept as a safety
//      net for installs that haven't run any OTA yet.
function detectVersionMismatch(appRoot, currentBasename) {
  const sidecar = readCurrentExeRecord(appRoot)
  if (sidecar) {
    if (sameExe(sidecar.exe, currentBasename)) {
      return {
        stale: false, candidate: null, reason: 'sidecar-matches',
        sidecarExe: sidecar.exe, sidecarVersion: sidecar.version,
      }
    }
    // We are NOT the canonical exe. Hand off.
    const candidate = pickSuccessorExe(appRoot, currentBasename)
    return {
      stale: true, candidate, reason: 'sidecar-points-elsewhere',
      sidecarExe: sidecar.exe, sidecarVersion: sidecar.version,
    }
  }
  // Tier-2 degraded fallback: legacy bundled-vs-advertised compare.
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

// Transactional ZIP extraction.
//
// The original implementation extracted entries one-by-one and committed each
// one in place. That left the install dir in a HALF-UPDATED state when even
// one entry failed (e.g. resources/app.asar locked by the running launcher
// while chrome_*.pak / locales/* / BLASTING.exe extracted cleanly). The user
// then booted the OLD launcher against NEW chrome resources -> black screen.
//
// New behaviour: when callers pass a `backupDir` and a `successfulEntries`
// out-array, this function preserves OLD content in `backupDir` BEFORE
// overwriting, and tracks every successful entry in `successfulEntries`.
// On ANY failure, the caller invokes `rollbackExtract(successfulEntries)`
// to restore the install dir to its pre-extract state in full.
//
// Without a backupDir (the legacy call shape) it behaves like the old code,
// committing in place. New OTA apply paths always pass a backupDir.
function extractZip(zipBuffer, destDir, opts) {
  opts = opts || {}
  const backupDir = opts.backupDir || null
  // Caller-owned scratch array. Passing it in (rather than returning it)
  // means the caller can still roll back even if THIS function throws
  // mid-stream — every entry committed up to the throw is in the array.
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

    // STEP 1: if we have a backupDir AND target exists, move the OLD file out
    // of the way first. If this fails (typically because the file is locked
    // by the running launcher: app.asar, ffmpeg.dll, icudtl.dat, etc.), mark
    // the entry as failed WITHOUT touching disk further. The locked file
    // stays exactly where it was, and the rest of the apply will be rolled
    // back by the caller.
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

    // STEP 2: write the new content via the .ota-tmp dance for atomicity
    // against power loss.
    try {
      const tmpPath = targetPath + '.ota-tmp'
      fs.writeFileSync(tmpPath, content)
      try {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
      } catch (e) {}
      try {
        fs.renameSync(tmpPath, targetPath)
        extracted++
        successfulEntries.push({ target: targetPath, backupPath, wasReplacement })
      } catch (e) {
        try { fs.copyFileSync(tmpPath, targetPath) } catch (e2) {
          failed++
          failedFiles.push(name + ' (write: ' + e2.message + ')')
          try { fs.unlinkSync(tmpPath) } catch (_) {}
          // Restore from backup so this entry's original content survives.
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
      // Write of tmp file itself failed (disk full, parent locked, etc.).
      // Restore the OLD content from backup if we moved it earlier.
      if (backupPath) {
        try { fs.renameSync(backupPath, targetPath) } catch (_) {}
      }
    }
  }
  return { extracted, failed, totalEntries, failedFiles, successfulEntries }
}

// Undo every entry in `successfulEntries` (typically populated by extractZip
// via the opts.successfulEntries out-array). For each successful entry:
//   - if entry was an ADD (new file with no prior content), delete the target
//   - if entry was a REPLACEMENT and a backup exists, delete the new target
//     and rename the backup back into place to restore OLD bytes
//   - if entry was a REPLACEMENT but NO backup exists (caller ran extractZip
//     without a backupDir, or backup failed silently), DO NOTHING — deleting
//     the target with no backup would destroy the only copy of the file. The
//     "skipped" counter surfaces this in diagnostics.
// Returns diagnostics for the FAILED marker.
function rollbackExtract(successfulEntries) {
  const restored = []
  const removed = []
  const skipped = []
  // Walk in reverse — symmetric to the forward order, and slightly safer if
  // anything depends on order (e.g. a parent dir written before its child).
  for (let i = successfulEntries.length - 1; i >= 0; i--) {
    const e = successfulEntries[i]
    if (e.wasReplacement) {
      if (!e.backupPath) {
        // No backup — refuse to delete; that would destroy the only copy
        // of this file's old AND new content (irrecoverable data loss).
        // The architect explicitly flagged this as a critical failure mode.
        skipped.push(path.basename(e.target))
        continue
      }
      try { fs.unlinkSync(e.target) } catch (_) {}
      try {
        fs.renameSync(e.backupPath, e.target)
        restored.push(path.basename(e.target))
      } catch (_) {
        // Backup restore failed — record as skipped so diagnostics expose
        // the half-rollback state for investigation.
        skipped.push(path.basename(e.target))
      }
    } else {
      // Pure addition — safe to delete; no original content to lose.
      try { fs.unlinkSync(e.target) } catch (_) {}
      removed.push(path.basename(e.target))
    }
  }
  return { restored, removed, skipped }
}

// Recover from a leftover .ota-bak directory left by a previous apply attempt
// that crashed AFTER moving originals into backup but BEFORE either
// committing the new content or completing rollback. The backup is the LAST
// good copy of those files; this restores them in place before we touch
// anything else, so a subsequent fresh attempt starts from a clean OLD state.
//
// destDir is the install root the previous attempt was extracting INTO; the
// backup mirrors that directory tree underneath backupDir.
//
// If anything in the backup tree fails to move back, we log it and KEEP the
// remaining backup files in place (do NOT delete) so a human can recover.
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
          // Remove a possibly-half-written newer file at the target so the
          // backup can take its place atomically.
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

// Maximum number of consecutive failed apply attempts before we give up and
// clear the READY marker. Without this cap, a permanently-broken payload
// (e.g. corrupted zip) would re-attempt apply on every single launch forever.
// 5 attempts is enough to ride out the legitimate "asar is locked, retry on
// the next cold start" case but small enough to not loop indefinitely.
const MAX_CONSECUTIVE_APPLY_FAILURES = 5

// Snapshot the basenames of every top-level *.exe currently in the install
// dir. Used as a "before" picture so a downstream failure-cleanup step can
// tell which .exe files are NEW (just dropped by the in-progress extractZip)
// vs OLD (already on disk before the apply started). Returns a Set of
// lower-cased names so callers can compare case-insensitively (Windows FS).
function snapshotTopLevelExes(appRoot) {
  const out = new Set()
  try {
    for (const e of fs.readdirSync(appRoot, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) out.add(e.name.toLowerCase())
    }
  } catch (_) {}
  return out
}

// When an apply attempt fails partway through, extractZip may already have
// dropped the new .exe (no name conflict, written cleanly) before failing on
// a locked file like resources/app.asar. The runtime integrity check inside
// that new exe will then fail (new exe bytes vs stale integrity.dat / asar
// secret), causing an "Application Integrity Error" popup if the user
// double-clicks it. Remove just those files — only ones that:
//   (a) appeared during this apply attempt (not in the pre-extract snapshot),
//   (b) are listed as top-level entries in the payload zip, and
//   (c) are not the currently-running exe (we'd be deleting ourselves).
// Returns the basenames that were removed for diagnostics.
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

// Read the consecutiveFailures counter from a previous FAILED marker so the
// runaway-retry guard can decide whether to keep retrying or finally give up.
// Missing/malformed marker -> 0 (treat as the first failure).
function readPriorFailureCount(failedMarker) {
  try {
    if (!fs.existsSync(failedMarker)) return 0
    const obj = JSON.parse(fs.readFileSync(failedMarker, 'utf-8'))
    if (obj && Number.isInteger(obj.consecutiveFailures)) return obj.consecutiveFailures
  } catch (_) {}
  return 0
}

// Centralised "the apply failed; record diagnostics and decide whether to
// keep READY for retry or finally give up" handler. Used by both failure
// branches in applyPendingUpdateOnStartup (the index.html sanity check and
// the result.failed > 0 path) so they behave consistently.
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

// Read-only walk of an OTA payload zip — returns the basenames of any
// top-level *.exe entries it contains, without extracting anything. Mirrors
// the LFH parser in extractZip but does no I/O. Used by the orphan-exe scan
// so we can answer "is THIS .exe in the install dir part of the just-applied
// payload, or is it stale junk from a previous build?". Top-level only — an
// .exe nested inside a subdirectory in the zip is not one of the binaries
// that sits next to the launcher and is not relevant to orphan cleanup.
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
      // Top-level only: no forward slash AND no backslash anywhere in the
      // entry name. (Some Windows zip producers emit backslashes.)
      if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1) continue
      if (!name.toLowerCase().endsWith('.exe')) continue
      out.push(name)
    }
  } catch (_) {}
  return out
}

// Read the user/operator's persistent allowlist of exe basenames that the
// orphan-exe sweep must never delete. Lives at <appRoot>/.ota-keep-exes.json
// with shape { "keepExes": ["ffmpeg.exe", "diagnostics.exe"] }. Lets ops
// ship sibling helper tools next to our exe without us deleting them on
// the next OTA. Missing/malformed file -> []. Defense against
// finding #1 from the Task #3 architect review.
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
// writeCleanupMarker. We never delete from inside this function — the
// marker + sweep flow on the *next* launch is the only safe deletion path
// (Windows holds an exclusive lock on the running exe, plus the next-launch
// model gives the user a chance to recover if a sweep would be wrong).
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

// Self-defense: if the cleanup marker says the currently-running exe is an
// orphan (e.g. user double-clicked the OLD exe AFTER the rebrand applied
// but BEFORE the NEW exe ran sweepCleanupMarker), we are guaranteed to be
// running the OLD binary against the NEW asar — that's the "garbled
// black/violet screen" bug. Hand off to the new exe and exit BEFORE any
// window opens. Returns true if a handoff was scheduled (caller should
// short-circuit init).
function isSelfMarkedAsOrphan(appRoot) {
  const list = peekCleanupMarker(appRoot)
  if (list.length === 0) return false
  const currentExe = getCurrentExeBasename()
  if (!currentExe) return false
  return list.some(n => sameExe(n, currentExe))
}

// Called early in init() (before any window opens). Deletes orphan .exe files
// left behind by a rebrand-style update. Skips the currently-running exe (we
// can never delete ourselves on Windows) and rewrites/removes the marker so
// we don't keep retrying a file that's gone.
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
  for (const rawName of list) {
    // Defense-in-depth: collapse to basename so a tampered marker
    // containing "../../system32/something.exe" can't escape the
    // install dir. After this, target is always a sibling of appRoot.
    const name = rawName ? path.basename(String(rawName)) : null
    if (!name || sameExe(name, currentExe)) continue // never delete ourselves
    const target = path.join(appRoot, name)
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target)
        log('Deleted orphan exe from previous build: ' + name)
      }
    } catch (e) {
      // Still locked (e.g. user double-clicked the old exe just before we
      // started). Keep it in the marker so we retry on the *next* launch.
      log('Could not delete orphan ' + name + ' (will retry next launch): ' + e.message)
      remaining.push(name)
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

function isPendingStaged() {
  if (!STATE.appRoot) return false
  const pendingReady = path.join(STATE.appRoot, '.ota-pending', 'READY')
  return fs.existsSync(pendingReady)
}

async function checkForUpdate(opts = {}) {
  if (!STATE.config || !STATE.config.enabled) return { hasUpdate: false }
  if (STATE.isChecking || STATE.isDownloading || STATE.isApplying) {
    return { hasUpdate: false, reason: 'busy' }
  }
  if (isPendingStaged()) {
    log('Update already staged in .ota-pending — waiting for restart, skipping check.')
    return { hasUpdate: false, reason: 'pending-restart' }
  }
  STATE.isChecking = true
  try {
    const url = STATE.config.updateServer.replace(/\/$/, '') + '/updates/' + STATE.config.channel + '/latest.json'
    log('Checking ' + url + ' (current v' + STATE.config.version + ')')
    const buf = await fetchUrl(url)
    const manifest = JSON.parse(buf.toString('utf-8'))
    const remoteVer = manifest.version || '0.0.0'
    const cmp = compareVersions(remoteVer, STATE.config.version)
    if (cmp <= 0) {
      log('Up to date (remote v' + remoteVer + ')')
      return { hasUpdate: false, currentVersion: STATE.config.version, latestVersion: remoteVer }
    }
    log('Update available: v' + remoteVer + ' (current v' + STATE.config.version + ')')
    const result = {
      hasUpdate: true,
      currentVersion: STATE.config.version,
      latestVersion: remoteVer,
      manifest: manifest,
    }
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
  STATE.currentDownload = manifest
  try {
    const payloadInfo = manifest.launcher
    if (!payloadInfo || !payloadInfo.url) throw new Error('Manifest missing launcher payload URL')

    let payloadUrl = payloadInfo.url
    if (payloadUrl.startsWith('/')) {
      payloadUrl = STATE.config.updateServer.replace(/\/$/, '') + payloadUrl
    }
    log('Downloading payload: ' + payloadUrl)

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
        throw new Error('SHA-256 mismatch — file corrupted or tampered. expected=' + payloadInfo.sha256 + ' got=' + hash)
      }
      log('SHA-256 verified.')
    } else {
      log('No SHA-256 in manifest — skipping integrity check (not recommended).')
    }

    STATE.isDownloading = false
    STATE.isApplying = true
    broadcast('ota:applying', { version: manifest.version })

    const pendingDir = path.join(STATE.appRoot, '.ota-pending')
    if (fs.existsSync(pendingDir)) {
      try { fs.rmSync(pendingDir, { recursive: true, force: true }) } catch (e) {}
    }
    fs.mkdirSync(pendingDir, { recursive: true })
    const zipPath = path.join(pendingDir, 'payload.zip')
    fs.writeFileSync(zipPath, buf)
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())

    log('Update staged at ' + pendingDir + '. Will be applied on next launch.')
    broadcast('ota:ready-to-restart', {
      version: manifest.version,
      currentVersion: STATE.config.version,
    })
  } catch (e) {
    log('Download/apply failed: ' + e.message)
    broadcast('ota:error', { stage: 'download', error: e.message })
    throw e
  } finally {
    STATE.isDownloading = false
    STATE.isApplying = false
    STATE.currentDownload = null
  }
}

function applyPendingUpdateOnStartup(appRoot) {
  const pendingDir = path.join(appRoot, '.ota-pending')
  const readyMarker = path.join(pendingDir, 'READY')
  const zipPath = path.join(pendingDir, 'payload.zip')
  const failedMarker = path.join(pendingDir, 'FAILED')

  if (!fs.existsSync(readyMarker) || !fs.existsSync(zipPath)) return false

  log('Found pending update — applying before app starts...')
  // These two are hoisted so the outer catch can also roll back when
  // extractZip itself throws mid-stream (corrupt zip header, disk full, etc.)
  // — not just when it returns result.failed > 0. successfulEntries is the
  // out-array that extractZip pushes a record into for each entry it commits
  // to disk; rollbackExtract walks it to undo every change.
  let payloadExeNames = null
  const successfulEntries = []
  let backupDir = null
  try {
    const buf = fs.readFileSync(zipPath)
    payloadExeNames = listTopLevelExesInZip(buf)
    // Per-apply backup dir, scoped INSIDE .ota-pending so a successful apply
    // (which removes .ota-pending entirely) also removes the backup; and a
    // failed apply that gets rolled back leaves the backup dir empty for the
    // OS to clean up next sweep. Lives outside appRoot proper to avoid being
    // mistaken for an installed file.
    backupDir = path.join(pendingDir, '.ota-bak')
    // STEP 1 — recover from any leftover .ota-bak left by a previous attempt
    // that was killed mid-apply. Those backup files are the LAST good copy
    // of the originals; we must restore them in place BEFORE doing anything
    // else. Only after recovery is finished do we wipe the directory.
    if (fs.existsSync(backupDir)) {
      try {
        const rec = recoverFromLeftoverBackup(backupDir, appRoot)
        if (rec.restored.length > 0 || rec.failed.length > 0) {
          log('Recovered ' + rec.restored.length + ' file(s) from leftover backup at ' +
            backupDir + (rec.failed.length > 0 ? '; ' + rec.failed.length + ' failed: ' + rec.failed.slice(0, 5).join(', ') : '') + '.')
        }
        if (rec.failed.length > 0) {
          // Some backup files could not be restored. Refuse to proceed —
          // wiping the dir now would lose those bytes forever, and applying
          // a fresh update on top of a half-recovered install is worse than
          // surfacing the problem.
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
    // STEP 2 — create the backup dir for THIS attempt. If we cannot, REFUSE
    // to extract; running extractZip without a backupDir would replace files
    // that we then have no way to restore on rollback (data loss). The
    // architect explicitly flagged this as a critical failure mode.
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

    // Hardened sanity check (Task #17): if the launcher's renderer index.html
    // came out missing or replaced by binary garbage, refuse the swap. This
    // guards against the "black screen on launch" symptom the field reported
    // when extractZip silently truncated index.html. The check is opportunistic
    // (only enforced when index.html ended up loose on disk — many builds
    // bundle it inside app.asar where Node can't read it directly).
    try {
      const candidates = [
        path.join(appRoot, 'resources', 'app.asar.unpacked', 'dist', 'index.html'),
        path.join(appRoot, 'dist', 'index.html'),
        path.join(appRoot, 'resources', 'app', 'dist', 'index.html'),
      ]
      const indexPath = candidates.find(p => fs.existsSync(p))
      if (indexPath) {
        const head = fs.readFileSync(indexPath).slice(0, 1024)
        const text = head.toString('latin1')
        const hasHtmlMagic = /<!doctype\s+html|<html[\s>]/i.test(text)
        const looksBinary = head.includes(0)
        if (head.length === 0 || looksBinary || !hasHtmlMagic) {
          log('UPDATE INCOMPLETE — index.html at ' + indexPath + ' looks corrupted (size=' +
            head.length + ', binary=' + looksBinary + ', html=' + hasHtmlMagic + '). Rolling back.')
          // Full transactional rollback: every entry that was written so far
          // is reverted (new files deleted, replaced files restored from
          // backup) so the install dir ends up at its pre-extract state.
          const rb = rollbackExtract(successfulEntries)
          log('Rollback: restored ' + rb.restored.length + ' file(s), removed ' + rb.removed.length + ' new file(s).')
          recordApplyFailure({
            readyMarker, failedMarker,
            diagnostics: {
              error: 'index.html post-extract sanity check failed',
              indexPath, size: head.length, binary: looksBinary, html: hasHtmlMagic,
              rolledBack: { restored: rb.restored.length, removed: rb.removed.length },
            },
          })
          return false
        }
      }
    } catch (e) {
      log('index.html sanity check skipped: ' + e.message)
    }

    if (result.failed > 0 || result.extracted === 0) {
      log('UPDATE INCOMPLETE — rolling back to pre-apply state.')
      result.failedFiles.slice(0, 10).forEach(f => log('  failed: ' + f))
      // The classic "asar locked by the running launcher" failure mode lives
      // here: extractZip cleanly drops some unlocked entries (chrome paks,
      // locales, the new exe) but fails to overwrite resources/app.asar
      // and the locked native deps. Without rollback, the OLD launcher
      // boots against a MIX of OLD asar + NEW chrome paks -> black screen.
      // Full rollback restores all replaced files and deletes all newly-
      // added files, so the install ends up exactly where it started.
      const rb = rollbackExtract(successfulEntries)
      log('Rollback: restored ' + rb.restored.length + ' file(s), removed ' + rb.removed.length + ' new file(s).')
      recordApplyFailure({
        readyMarker, failedMarker,
        diagnostics: {
          extractedAt: new Date().toISOString(),
          extracted: result.extracted,
          failed: result.failed,
          totalEntries: result.totalEntries,
          failedFiles: result.failedFiles.slice(0, 50),
          rolledBack: { restored: rb.restored.length, removed: rb.removed.length },
        },
      })
      return false
    }

    let stagedManifest = null
    try {
      const manifestPath = path.join(pendingDir, 'manifest.json')
      if (fs.existsSync(manifestPath)) {
        stagedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        const otaCfgPath = path.join(process.resourcesPath || appRoot, 'ota-config.json')
        if (fs.existsSync(otaCfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(otaCfgPath, 'utf-8'))
          cfg.version = stagedManifest.version
          fs.writeFileSync(otaCfgPath, JSON.stringify(cfg, null, 2))
          log('OTA config version bumped to v' + stagedManifest.version)
        } else {
          log('WARNING: ota-config.json not found at ' + otaCfgPath + ' — version will not be bumped, but files were updated. Next check may re-download.')
        }
      }
    } catch (e) {
      log('Could not bump version in ota-config: ' + e.message + ' — pending dir kept for retry.')
      return false
    }

    // Rebrand-aware step: when the manifest declares a different exe name
    // than the one we're currently running (e.g. DENFI.exe -> BLAST.exe), the
    // new payload will have ADDED the new exe but extractZip can't delete the
    // old one (it never deletes orphan files). Stash the new exe path so
    // init() can hand off to it BEFORE creating any window (otherwise the
    // OLD exe would load the NEW asar and produce the garbled-text bug),
    // and write a cleanup marker so the NEXT launch unlinks the old
    // (currently-locked) exe.
    try {
      const currentBasename = getCurrentExeBasename()
      let newExeName = null
      // Resolve a manifest exeName against the install dir using
      // case-insensitive matching so this code behaves the same on Windows
      // (case-insensitive FS) and Linux dev machines (case-sensitive FS).
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
          // Manifest lied (or was generated against a different productName).
          // Try to recover by scanning the install dir for a single .exe that
          // isn't the running one — almost always the new build's exe.
          const guess = discoverNewExe(appRoot, currentBasename)
          if (guess) {
            log('WARNING: manifest exeName "' + claimed + '" not found after extraction — discovered "' + guess + '" instead.')
            newExeName = guess
          } else {
            log('WARNING: manifest exeName "' + claimed + '" not found and no unique replacement .exe could be discovered — startup will fall back to app.relaunch().')
          }
        }
      } else {
        // Legacy server (no exeName in manifest). If the install dir suddenly
        // contains a different .exe than the one we're running, we still need
        // to hand off — never silently boot the old binary against a new asar.
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
          // can hand off to the EXACT exe (not whatever discoverNewExe
          // happens to find). Defense against architect finding A.
          writeCleanupMarker(appRoot, [currentBasename], newExeName)
          log('Rebrand detected: new exe is "' + newExeName + '" (was "' + currentBasename + '"). init() will hand off before windows open; old exe will be removed on the next launch.')
        }
      }

      // Orphan-exe sweep: if a previous failed/aborted update (or a
      // user-dropped sibling) left other *.exe files in the install dir,
      // queue them for deletion on the next launch too. This is what
      // prevents the "two .exes side by side" state the user reported
      // when a long history of renames accumulates over time.
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

      // Write the per-exe identity sidecar BEFORE returning success.
      // This is the immutable record an OLD exe will read to detect it
      // is no longer canonical (architect round-3 fix). Canonical exe is
      // the just-applied one if known, otherwise stay with current.
      // Loud-log a write failure: a stale sidecar could later suppress
      // stale-detection on a subsequent apply (architect round-3 minor).
      try {
        const canonicalExe = newExeName || currentBasename
        const canonicalVersion = (stagedManifest && stagedManifest.version) || null
        if (canonicalExe && canonicalVersion) {
          const wrote = writeCurrentExeRecord(appRoot, canonicalExe, canonicalVersion)
          if (!wrote) {
            log('SEVERE: failed to update .ota-current-exe.json sidecar after apply. ' +
              'A subsequent old-exe relaunch may not be detected as stale. Investigate disk permissions.')
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
      log('Pending update applied successfully and cleaned up.')
    } catch (e) {
      log('Update applied but could not clean .ota-pending: ' + e.message)
    }
    return true
  } catch (e) {
    log('Failed to apply pending update: ' + e.message)
    // If extractZip threw mid-stream (corrupt header, decompression error,
    // disk full, etc.), every entry that was already committed lives in
    // successfulEntries (extractZip pushes BEFORE the throw). Roll them back
    // so the install ends up at its pre-extract state.
    let rb = { restored: [], removed: [] }
    if (successfulEntries.length > 0) {
      try {
        rb = rollbackExtract(successfulEntries)
        log('Rollback after exception: restored ' + rb.restored.length + ' file(s), removed ' + rb.removed.length + ' new file(s).')
      } catch (e2) {
        log('Rollback after exception itself failed: ' + e2.message)
      }
    }
    // Same retry-with-cap policy as the partial-extract branches: keep READY
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

// Spawn a target .exe detached and exit. Returns true if the spawn succeeded
// (caller should treat their process as terminated).
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
  log('Restarting app to apply update...')
  // Preferred path: a rebrand-style update set STATE.nextExePath to the NEW
  // exe (e.g. BLAST.exe). app.relaunch() would re-spawn process.execPath which
  // is the OLD exe (e.g. DENFI.exe) — that's the original bug that produces a
  // garbled "?????" window because the old binary tries to load the new asar.
  try {
    const targetExe = STATE.nextExePath
    if (targetExe && fs.existsSync(targetExe)) {
      if (!sameExe(path.basename(targetExe), getCurrentExeBasename())) {
        if (spawnAndExit(targetExe, 'Spawning new exe directly')) return
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
    // orphan that the user just double-clicked (e.g. via an old shortcut
    // that the shortcut-sweep hadn't reached yet). Loading the new asar
    // inside our old binary produces the "black/violet garbled screen"
    // bug. Hand off to the discovered new exe and exit immediately.
    try {
      const meta = peekCleanupMarkerWithMeta(appRoot)
      const currentExe = getCurrentExeBasename()
      const isOrphan = currentExe && meta.deleteExes.some(n => sameExe(n, currentExe))
      if (isOrphan) {
        // Prefer the marker-recorded `nextExe` (written by writeCleanupMarker
        // at rebrand time). Only fall back to discoverNewExe for legacy
        // markers without that field — and ONLY when the install dir has
        // exactly one obvious candidate, to avoid spawning a random sibling
        // (e.g. an installer setup.exe). Defense against architect finding A.
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
          // Legacy marker (pre-Task-#3 nextExe field). Use discoverNewExe
          // but only if it returns a single confident answer.
          const guess = discoverNewExe(appRoot, currentExe)
          if (guess) { target = path.join(appRoot, guess); chosenName = guess }
        }
        if (target) {
          log('Self-defense: this exe (' + currentExe + ') is listed as an orphan in the cleanup marker — handing off to ' + chosenName + '.')
          if (spawnAndExit(target, 'Orphan self-handoff (pre-init)')) return
          log('Orphan self-handoff failed — continuing as old exe; UI may render incorrectly.')
        } else {
          log('Self-defense: marked as orphan but no safe replacement .exe is available. Continuing as old exe (UI may render incorrectly).')
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
          log('  Version-mismatch handoff failed — continuing as old exe (UI may render incorrectly).')
        } else {
          log('  No safe successor exe available — continuing as old exe (UI may render incorrectly).')
        }
      }
    } catch (e) {
      log('Version-mismatch self-defense failed (non-fatal): ' + e.message)
    }

    // Sweep first so an orphan exe from a previous rebrand is removed BEFORE
    // we apply any new pending update (keeps install dir tidy in all cases).
    try { sweepCleanupMarker(appRoot) } catch (e) { log('cleanup sweep failed: ' + e.message) }
    applyPendingUpdateOnStartup(appRoot)

    // CRITICAL handoff: when the apply step renamed the exe (DENFI -> BLAST),
    // we are STILL the OLD process. If we let init() return and electron
    // proceeds to create the BrowserWindow, we'll be loading the NEW asar
    // inside the OLD binary — that's the original violet/garbled-text bug.
    // Hand off NOW: spawn the NEW exe (which will run its own init() in a
    // clean process) and exit immediately. The NEW exe's first launch will
    // pick up the .ota-cleanup.json marker and unlink the OLD exe (we just
    // released our lock by exiting).
    try {
      const next = STATE.nextExePath
      if (next && fs.existsSync(next) && !sameExe(path.basename(next), getCurrentExeBasename())) {
        // Only short-circuit init() if the handoff actually succeeded
        // (spawnAndExit() returned true and called app.exit/process.exit).
        // If spawn failed, we MUST keep going through init() so the old
        // exe at least sets up IPC handlers and the user can manually
        // restart — otherwise the window opens but UpdateModal/restart
        // never wires up and the user is stuck.
        if (spawnAndExit(next, 'Rebrand handoff (pre-window)')) {
          return // process is exiting; don't continue init()
        }
        log('Pre-window handoff failed — continuing init() so the user can restart manually.')
      }
    } catch (e) {
      log('Pre-window handoff check failed (continuing as old exe — UI may be broken): ' + e.message)
    }
  }

  STATE.config = loadConfig(appRoot, isDev)

  if (ipcMain) {
    ipcMain.handle('ota:get-status', () => ({
      enabled: !!(STATE.config && STATE.config.enabled),
      currentVersion: STATE.config ? STATE.config.version : null,
      channel: STATE.config ? STATE.config.channel : null,
      updateServer: STATE.config ? STATE.config.updateServer : null,
      // Brand text from ota-config.json so UpdateModal can show
      // "// {BRAND} OTA SYSTEM //" without hardcoding the seed brand at
      // build time (renames now happen via OTA, not just rebrand.js).
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

    // Live SSE push channel — fires checkForUpdate the instant the admin
    // publishes a new build, instead of waiting for the next poll tick.
    try {
      STATE.liveSession = otaLive.startLive({
        appRoot: STATE.appRoot,
        baseUrl: STATE.config.updateServer,
        channel: STATE.config.channel,
        role: 'launcher',
        currentVersion: STATE.config.version,
        logPrefix: 'launcher',
        onUpdate: ({ trigger, version }) => {
          log('Live ' + trigger + ' notification (v' + version + ') — checking for update now')
          checkForUpdate().catch(e => log('live-triggered check failed: ' + e.message))
        },
      })
    } catch (e) { log('live channel init failed: ' + e.message) }
  } else {
    log('OTA polling disabled (dev mode or no config)')
  }

  // Clean shutdown so we don't leak the SSE socket or fire a poll while the
  // window is being torn down.
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

module.exports = {
  init, checkForUpdate, restartApp, applyPendingUpdateOnStartup,
  // exported so tests/test-rebrand-update.js can drive the rebrand-style
  // apply + cleanup-marker flow without a real electron build
  sweepCleanupMarker, writeCleanupMarker, getCurrentExeBasename,
  // exported for Task #3 tests (orphan-exe scan + init-time self-defense)
  listTopLevelExesInZip, scanForOrphanExes, peekCleanupMarker, isSelfMarkedAsOrphan,
  // exported for the architect-review hardening tests (Task #3 round 2)
  peekCleanupMarkerWithMeta, readKeepExesSidecar,
  // exported for the version-mismatch self-defense tests (Task #3 round 2,
  // architect blocking-finding follow-up)
  getBundledVersion, readAdvertisedVersion, pickSuccessorExe, detectVersionMismatch,
  // round-3 fix: per-exe identity sidecar
  readCurrentExeRecord, writeCurrentExeRecord,
  // partial-apply hardening (rebrand-cleanup bug fix): exposed for tests
  snapshotTopLevelExes, sweepPartialNewExes, recordApplyFailure,
  readPriorFailureCount, MAX_CONSECUTIVE_APPLY_FAILURES,
}
