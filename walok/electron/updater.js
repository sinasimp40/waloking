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

function extractZip(zipBuffer, destDir) {
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

    try {
      const tmpPath = targetPath + '.ota-tmp'
      fs.writeFileSync(tmpPath, content)
      try {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
      } catch (e) {}
      try {
        fs.renameSync(tmpPath, targetPath)
        extracted++
      } catch (e) {
        try { fs.copyFileSync(tmpPath, targetPath) } catch (e2) {
          failed++
          failedFiles.push(name + ' (write: ' + e2.message + ')')
          try { fs.unlinkSync(tmpPath) } catch (_) {}
          continue
        }
        try { fs.unlinkSync(tmpPath) } catch (_) {}
        extracted++
      }
    } catch (e) {
      failed++
      failedFiles.push(name + ' (write: ' + e.message + ')')
    }
  }
  return { extracted, failed, totalEntries, failedFiles }
}

// Persist a list of orphan exe basenames that the *next* launch should delete.
// Windows holds an exclusive lock on the currently-running .exe, so we can't
// delete the OLD .exe from inside the OLD process — we hand the job off to the
// NEW exe (a different process) which can safely unlink it.
function writeCleanupMarker(appRoot, oldBasenames) {
  if (!Array.isArray(oldBasenames) || oldBasenames.length === 0) return
  try {
    const file = path.join(appRoot, CLEANUP_MARKER)
    let existing = []
    try {
      if (fs.existsSync(file)) {
        const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
        if (j && Array.isArray(j.deleteExes)) existing = j.deleteExes
      }
    } catch (_) {}
    const merged = Array.from(new Set([...existing, ...oldBasenames])).filter(Boolean)
    fs.writeFileSync(file, JSON.stringify({
      writtenAt: new Date().toISOString(),
      deleteExes: merged,
    }, null, 2))
    log('Wrote cleanup marker for orphan exe(s): ' + merged.join(', '))
  } catch (e) {
    log('Could not write cleanup marker: ' + e.message)
  }
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
    else fs.writeFileSync(file, JSON.stringify({
      writtenAt: data.writtenAt, deleteExes: remaining,
    }, null, 2))
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
  try {
    const buf = fs.readFileSync(zipPath)
    const result = extractZip(buf, appRoot)
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
            head.length + ', binary=' + looksBinary + ', html=' + hasHtmlMagic + '). Refusing to mark as applied.')
          try {
            fs.writeFileSync(failedMarker, JSON.stringify({
              error: 'index.html post-extract sanity check failed',
              indexPath, size: head.length, binary: looksBinary, html: hasHtmlMagic,
              at: new Date().toISOString(),
            }, null, 2))
            fs.unlinkSync(readyMarker)
          } catch (_) {}
          return false
        }
      }
    } catch (e) {
      log('index.html sanity check skipped: ' + e.message)
    }

    if (result.failed > 0 || result.extracted === 0) {
      log('UPDATE INCOMPLETE — refusing to mark as applied.')
      result.failedFiles.slice(0, 10).forEach(f => log('  failed: ' + f))
      try {
        fs.writeFileSync(failedMarker, JSON.stringify({
          extractedAt: new Date().toISOString(),
          extracted: result.extracted,
          failed: result.failed,
          totalEntries: result.totalEntries,
          failedFiles: result.failedFiles.slice(0, 50),
        }, null, 2))
        try { fs.unlinkSync(readyMarker) } catch (_) {}
      } catch (_) {}
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
          writeCleanupMarker(appRoot, [currentBasename])
          log('Rebrand detected: new exe is "' + newExeName + '" (was "' + currentBasename + '"). init() will hand off before windows open; old exe will be removed on the next launch.')
        }
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
    try {
      fs.writeFileSync(failedMarker, JSON.stringify({
        error: e.message, at: new Date().toISOString()
      }, null, 2))
      fs.unlinkSync(readyMarker)
    } catch (_) {}
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
}
