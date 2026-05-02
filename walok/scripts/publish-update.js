const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const RELEASES_DIR = path.join(ROOT, 'releases')
// IMPORTANT: when invoked from the OTA admin's build job runner, this script
// runs inside an ephemeral workspace clone at <projectRoot>/.build-jobs/<jobId>/.
// In that case ROOT points at the WORKSPACE, not the real project root, so
// publishing to ROOT/update-server/public/updates lands in a directory that
// gets wiped by finishJob seconds later — leaving the customer card with
// "[file missing — rebuild]" + "Last release: ---" despite a "successful"
// build. The OTA server passes OTA_UPDATES_DIR pointing at the REAL updates
// dir for exactly this reason; honor it when set.
// Fallback path used only when OTA_UPDATES_DIR isn't set (manual CLI use).
// As of May 2026 update-server/ lives at the REPO ROOT (sibling of walok/);
// try the new path first, fall back to the legacy in-walok layout.
const UPDATE_SERVER_PUBLIC = process.env.OTA_UPDATES_DIR
  ? path.resolve(process.env.OTA_UPDATES_DIR)
  : (fs.existsSync(path.join(ROOT, '..', 'update-server'))
      ? path.join(ROOT, '..', 'update-server', 'public', 'updates')
      : path.join(ROOT, 'update-server', 'public', 'updates'))

function log(msg) { console.log('[publish-update] ' + msg) }
function err(msg) { console.error('[publish-update] ERROR: ' + msg) }

function readVersion() {
  // Honors the same per-customer BUILD_VERSION env that build-customer.js
  // does, so the OTA admin can publish each customer at its own auto-bumped
  // version without mutating the global package.json.
  const env = process.env.BUILD_VERSION
  if (env && /^\d+\.\d+\.\d+$/.test(env)) return env
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version
}

// Mirror electron-builder's productName -> .exe filename behavior. The new
// launcher uses this manifest field to identify the NEW exe after a rebrand
// (so it can spawn it on restart and delete the old DENFI.exe afterwards).
function sanitizeExeName(productName) {
  if (!productName) return null
  const safe = String(productName).replace(/[\\/:*?"<>|]/g, '').trim()
  return safe ? safe + '.exe' : null
}

// `multi` means "this call is part of a `--all` sweep over many channels".
// In that mode we MUST NOT honor BUILD_PRODUCT_NAME (which is a single global
// env var and would re-label every channel with the value from the most
// recent single-channel build). For single-channel publishes BUILD_PRODUCT_NAME
// is the right answer because it's set by build-customer.js for that channel.
function computeExeName(channel, multi) {
  // Resolution order:
  //   1. BUILD_PRODUCT_NAME — single-channel only.
  //   2. customers/<channel>.json brandName — preferred for --all.
  //   3. branding/config.json brandName — last-resort fallback for repos
  //      that don't use the multi-customer customers/ layout.
  if (!multi) {
    const env = process.env.BUILD_PRODUCT_NAME
    if (env) return sanitizeExeName(env)
  }
  if (channel) {
    try {
      const customerFile = path.join(ROOT, 'customers', channel + '.json')
      if (fs.existsSync(customerFile)) {
        const c = JSON.parse(fs.readFileSync(customerFile, 'utf-8'))
        if (c && c.brandName) return sanitizeExeName(c.brandName)
      }
    } catch (e) {}
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'branding', 'config.json'), 'utf-8'))
    if (cfg && cfg.brandName) return sanitizeExeName(cfg.brandName)
  } catch (e) {}
  return null
}

// Server exe basename for the manifest. The companion server is built with
// productName = "<brandName> Server" (see walok/server/package.json), so
// electron-builder emits "<brandName> Server.exe". This mirrors that exact
// rule so the OTA manifest's exeName matches the file shipped inside
// server-payload.zip — without it, the server's stageOutOfProcessApply()
// short-circuits with "manifest missing exeName" and writes FAILED before
// even creating the .bat applier (the field bug the user just reported).
//
// IMPORTANT: do NOT honor BUILD_PRODUCT_NAME here — that env var is the
// LAUNCHER's product name (set by build-customer.js for the launcher build).
// The server's product name is always "<brandName> Server".
function computeServerExeName(channel, multi) {
  let brand = null
  if (channel) {
    try {
      const customerFile = path.join(ROOT, 'customers', channel + '.json')
      if (fs.existsSync(customerFile)) {
        const c = JSON.parse(fs.readFileSync(customerFile, 'utf-8'))
        if (c && c.brandName) brand = c.brandName
      }
    } catch (e) {}
  }
  if (!brand) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'branding', 'config.json'), 'utf-8'))
      if (cfg && cfg.brandName) brand = cfg.brandName
    } catch (e) {}
  }
  if (!brand) return null
  return sanitizeExeName(brand + ' Server')
}

function sha256OfFile(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function listChannels() {
  if (!fs.existsSync(RELEASES_DIR)) return []
  return fs.readdirSync(RELEASES_DIR).filter(d =>
    fs.statSync(path.join(RELEASES_DIR, d)).isDirectory()
  )
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const item of fs.readdirSync(src)) {
    const s = path.join(src, item)
    const d = path.join(dest, item)
    const stat = fs.statSync(s)
    if (stat.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function buildPayload(unpackedDir, outZipPath) {
  log('Packing payload zip from: ' + path.relative(ROOT, unpackedDir))
  const t0 = Date.now()
  if (process.platform === 'win32') {
    // $ProgressPreference='SilentlyContinue' kills Compress-Archive's progress
    // bar — that bar emits thousands of [oooo...] lines per zip via stdout,
    // which (a) freezes the parent cmd.exe console and (b) saturates the SSE
    // pipe to the admin UI so it appears stuck on RUNNING. With it silenced,
    // the command emits ~0 lines.
    // stdio:'pipe' (instead of 'inherit') means even an unexpected stderr
    // burst is captured into a string rather than dumped to the parent
    // terminal — we surface anything non-empty through log() one line at a
    // time, so the rate-limit is bounded by the number of actual lines.
    // -NoProfile skips loading $PROFILE (saves hundreds of ms per invocation
    // on machines with PS profiles). -NonInteractive prevents any prompt from
    // ever blocking the build. Together they make the call faster AND silent.
    const cmd = 'powershell -NoProfile -NonInteractive -Command "$ProgressPreference=' + "'SilentlyContinue'" +
      '; Compress-Archive -Path \\"' + unpackedDir + '\\\\*\\" -DestinationPath \\"' + outZipPath + '\\" -Force"'
    try {
      const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' })
      if (out && out.trim()) for (const ln of out.split(/\r?\n/)) if (ln.trim()) log('  ' + ln)
    } catch (e) {
      if (e.stdout) for (const ln of String(e.stdout).split(/\r?\n/)) if (ln.trim()) log('  ' + ln)
      if (e.stderr) for (const ln of String(e.stderr).split(/\r?\n/)) if (ln.trim()) err('  ' + ln)
      throw e
    }
  } else {
    try {
      execSync('cd "' + unpackedDir + '" && zip -r "' + outZipPath + '" . -q', { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' })
    } catch (e) {
      if (e.stderr) for (const ln of String(e.stderr).split(/\r?\n/)) if (ln.trim()) err('  ' + ln)
      throw e
    }
  }
  const sz = fs.existsSync(outZipPath) ? fs.statSync(outZipPath).size : 0
  log('Packed ' + (sz / 1024 / 1024).toFixed(2) + ' MiB in ' + (Date.now() - t0) + ' ms → ' + path.relative(ROOT, outZipPath))
}

// Read the buildId that build-customer.js baked into the unpacked role's
// resources/ota-config.json. Returns null if the field isn't present (e.g.
// a build produced by an older build-customer.js that predates the rebump-
// detection feature). When null, the manifest simply omits buildId and the
// launcher falls back to the version-only compare path — preserving prior
// behavior for legacy artifacts.
function readBakedBuildId(unpackedDir) {
  if (!unpackedDir) return null
  const cfgPath = path.join(unpackedDir, 'resources', 'ota-config.json')
  try {
    if (!fs.existsSync(cfgPath)) return null
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    if (cfg && typeof cfg.buildId === 'string' && cfg.buildId) return cfg.buildId
  } catch (_) {}
  return null
}

function publishChannel(channel, version, multi) {
  const channelDir = path.join(RELEASES_DIR, channel, version)
  if (!fs.existsSync(channelDir)) {
    err('No build found at: ' + channelDir + '. Run build-customer.js first.')
    return false
  }

  const launcherUnpacked = path.join(channelDir, 'launcher-unpacked')
  const serverUnpacked = path.join(channelDir, 'server-unpacked')

  const targetChannelDir = path.join(UPDATE_SERVER_PUBLIC, channel, version)
  fs.mkdirSync(targetChannelDir, { recursive: true })

  let launcherInfo = null
  let serverInfo = null

  if (fs.existsSync(launcherUnpacked)) {
    const launcherZip = path.join(targetChannelDir, 'launcher-payload.zip')
    buildPayload(launcherUnpacked, launcherZip)
    launcherInfo = {
      url: '/updates/' + channel + '/' + version + '/launcher-payload.zip',
      size: fs.statSync(launcherZip).size,
      sha256: sha256OfFile(launcherZip)
    }
    log('Launcher payload: ' + launcherInfo.size + ' bytes, sha256=' + launcherInfo.sha256.slice(0, 12) + '...')
  } else {
    log('No launcher-unpacked/ found, skipping launcher payload')
  }

  if (fs.existsSync(serverUnpacked)) {
    const serverZip = path.join(targetChannelDir, 'server-payload.zip')
    buildPayload(serverUnpacked, serverZip)
    serverInfo = {
      url: '/updates/' + channel + '-server/' + version + '/server-payload.zip',
      size: fs.statSync(serverZip).size,
      sha256: sha256OfFile(serverZip)
    }
    log('Server payload: ' + serverInfo.size + ' bytes')
  }

  // Guard: only write the launcher manifest when we actually produced a
  // launcher payload. Writing one with `launcher: null` (the previous
  // behavior when launcher-unpacked/ was missing) leaves the admin UI in
  // a confusing half-state where the customer card claims a version but
  // the [download] link 404s — the customers endpoint now defends against
  // that with a file-existence check, but we should still not write a
  // bogus manifest in the first place.
  if (launcherInfo) {
    const exeName = computeExeName(channel, multi)
    // Lift the buildId baked by build-customer.js out of the unpacked
    // launcher's ota-config.json. Including it in the manifest lets the
    // running launcher detect a same-version REBUMP — when local.buildId
    // != manifest.buildId, the launcher pulls even though `version` is
    // unchanged. Omitted gracefully for legacy builds without a buildId.
    const launcherBuildId = readBakedBuildId(launcherUnpacked)
    const launcherManifest = {
      version: version,
      channel: channel,
      releasedAt: new Date().toISOString(),
      launcher: launcherInfo,
      ...(exeName ? { exeName } : {}),
      ...(launcherBuildId ? { buildId: launcherBuildId } : {}),
      notes: 'Update v' + version
    }
    const manifestPath = path.join(UPDATE_SERVER_PUBLIC, channel, 'latest.json')
    fs.writeFileSync(manifestPath, JSON.stringify(launcherManifest, null, 2))
    // Final sanity check: confirm both the manifest AND the zip the manifest
    // points at are present on disk. Surfacing this in the build console
    // gives the operator unambiguous confirmation that the customer card
    // will show a working [download] link the moment it next refreshes.
    const zipPath = path.join(UPDATE_SERVER_PUBLIC, channel, version, 'launcher-payload.zip')
    if (fs.existsSync(manifestPath) && fs.existsSync(zipPath)) {
      log('Launcher OK: ' + path.relative(ROOT, manifestPath) + ' (' + launcherInfo.size + ' bytes)')
    } else {
      err('Launcher publish INCOMPLETE — manifest=' + fs.existsSync(manifestPath) + ' zip=' + fs.existsSync(zipPath))
    }
  } else {
    log('Skipping launcher manifest (no launcher-unpacked/ for v' + version + ')')
  }

  if (serverInfo) {
    const serverManifestDir = path.join(UPDATE_SERVER_PUBLIC, channel + '-server', version)
    fs.mkdirSync(serverManifestDir, { recursive: true })
    const srcZip = path.join(targetChannelDir, 'server-payload.zip')
    const destZip = path.join(serverManifestDir, 'server-payload.zip')
    if (srcZip !== destZip) fs.copyFileSync(srcZip, destZip)
    // Compute the server exe basename so the OTA out-of-process applier can
    // identify the new exe after a rebrand. Without exeName the server-side
    // stageOutOfProcessApply() rejects the manifest at the first gate and
    // writes .ota-pending/FAILED before any .bat / overlay JSON is produced
    // (the field bug: server folder never wiped, payload never extracted).
    // We refuse to publish a server manifest with no exeName — silently
    // shipping it would just reproduce the field bug for every install.
    const serverExeName = computeServerExeName(channel, multi)
    if (!serverExeName) {
      err('Server publish ABORTED — could not determine serverExeName for channel "' + channel +
        '" (no brandName in customers/' + channel + '.json or branding/config.json). ' +
        'Server OTA needs exeName in the manifest or applyPendingUpdateOnStartup will write FAILED.')
      return false
    }
    // Mirror the launcher's buildId behavior for the server manifest. The
    // server build's resources/ota-config.json (sourced from
    // branding/ota-config-server.json) carries the same buildId that
    // build-customer.js wrote, so a rebump rebuilds both roles with a fresh
    // buildId and both companion installs pull the new payload.
    const serverBuildId = readBakedBuildId(serverUnpacked)
    const serverManifest = {
      version: version,
      channel: channel + '-server',
      releasedAt: new Date().toISOString(),
      launcher: {
        url: '/updates/' + channel + '-server/' + version + '/server-payload.zip',
        size: serverInfo.size,
        sha256: serverInfo.sha256
      },
      ...(serverExeName ? { exeName: serverExeName } : {}),
      ...(serverBuildId ? { buildId: serverBuildId } : {}),
      notes: 'Server update v' + version
    }
    const serverManifestPath = path.join(UPDATE_SERVER_PUBLIC, channel + '-server', 'latest.json')
    fs.writeFileSync(serverManifestPath, JSON.stringify(serverManifest, null, 2))
    if (fs.existsSync(serverManifestPath) && fs.existsSync(destZip)) {
      log('Server OK: ' + path.relative(ROOT, serverManifestPath) + ' (' + serverInfo.size + ' bytes)')
    } else {
      err('Server publish INCOMPLETE — manifest=' + fs.existsSync(serverManifestPath) + ' zip=' + fs.existsSync(destZip))
    }
  } else {
    log('Skipping server manifest (no server-unpacked/ for v' + version + ')')
  }

  log('Published channel "' + channel + '" v' + version)
  return true
}

function main() {
  const arg = process.argv[2]
  if (!arg) {
    err('Usage: node scripts/publish-update.js <channel>  OR  --all')
    process.exit(1)
  }
  const version = readVersion()
  fs.mkdirSync(UPDATE_SERVER_PUBLIC, { recursive: true })

  if (arg === '--all') {
    const allChannels = listChannels()
    if (allChannels.length === 0) {
      err('No releases found in releases/. Run build-all.js first.')
      process.exit(1)
    }
    // Filter out stale channel folders (e.g. left over from a renamed or
    // deleted customer) that have no build for the version we're about to
    // publish. Without this, a stale `releases/example-cafe/` directory
    // would cause `--all` to hard-fail with "No build found at ..." even
    // though every LIVE customer was built and shipped just fine.
    const channels = []
    const skipped = []
    for (const ch of allChannels) {
      if (fs.existsSync(path.join(RELEASES_DIR, ch, version))) channels.push(ch)
      else skipped.push(ch)
    }
    if (skipped.length > 0) {
      log('Skipping ' + skipped.length + ' stale channel(s) with no v' + version + ' build: ' + skipped.join(', '))
    }
    if (channels.length === 0) {
      err('No releases for v' + version + ' found in releases/. Run build-all.js first.')
      process.exit(1)
    }
    let ok = 0, fail = 0
    for (const ch of channels) {
      if (publishChannel(ch, version, true)) ok++
      else fail++
    }
    log('Published: ' + ok + ' OK, ' + fail + ' failed')
    process.exit(fail === 0 ? 0 : 1)
  } else {
    const success = publishChannel(arg, version)
    process.exit(success ? 0 : 1)
  }
}

main()
