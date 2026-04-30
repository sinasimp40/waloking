const fs = require('fs')
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
      try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath) } catch (e) {}
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

// === Cleanup-marker (rebrand orphan-exe deletion) ===

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
    else fs.writeFileSync(file, JSON.stringify({
      writtenAt: data.writtenAt, deleteExes: remaining,
    }, null, 2))
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
  } catch (e) {
    log('Download/apply failed: ' + e.message)
    broadcast('ota:error', { stage: 'download', error: e.message })
    throw e
  } finally {
    STATE.isDownloading = false
    STATE.isApplying = false
  }
}

function applyPendingUpdateOnStartup(appRoot) {
  const pendingDir = path.join(appRoot, '.ota-pending')
  const readyMarker = path.join(pendingDir, 'READY')
  const zipPath = path.join(pendingDir, 'payload.zip')
  const failedMarker = path.join(pendingDir, 'FAILED')
  if (!fs.existsSync(readyMarker) || !fs.existsSync(zipPath)) return false
  log('Found pending server update — applying...')
  let stagedManifest = null
  try {
    const buf = fs.readFileSync(zipPath)
    const result = extractZip(buf, appRoot)
    log('Extraction: ' + result.extracted + '/' + result.totalEntries + ' files OK, ' + result.failed + ' failed.')
    if (result.failed > 0 || result.extracted === 0) {
      log('UPDATE INCOMPLETE — refusing to mark as applied.')
      result.failedFiles.slice(0, 10).forEach(f => log('  failed: ' + f))
      try {
        fs.writeFileSync(failedMarker, JSON.stringify(result, null, 2))
        fs.unlinkSync(readyMarker)
      } catch (_) {}
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
          writeCleanupMarker(appRoot, [currentBasename])
          log('Rebrand detected: new server exe is "' + newExeName + '" (was "' + currentBasename + '"). init() will hand off before listen; old exe will be removed on the next launch.')
        }
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
    try {
      fs.writeFileSync(failedMarker, JSON.stringify({ error: e.message, at: new Date().toISOString() }, null, 2))
      fs.unlinkSync(readyMarker)
    } catch (_) {}
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

module.exports = {
  init, checkForUpdate, restartApp, applyPendingUpdateOnStartup,
  // Exported so tests can drive the rebrand-style apply + cleanup-marker
  // flow (and the orphan-shortcut sweep) without a real electron build.
  sweepCleanupMarker, writeCleanupMarker, getCurrentExeBasename,
  removeShortcutsTo, gracefulQuitForUpdate,
}
