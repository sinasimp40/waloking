const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const RELEASES_DIR = path.join(ROOT, 'releases')
const UPDATE_SERVER_PUBLIC = path.join(ROOT, 'update-server', 'public', 'updates')

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
  const tar = require('child_process')
  log('Packing payload zip from: ' + path.relative(ROOT, unpackedDir))
  if (process.platform === 'win32') {
    execSync('powershell -Command "Compress-Archive -Path \\"' + unpackedDir + '\\\\*\\" -DestinationPath \\"' + outZipPath + '\\" -Force"', { stdio: 'inherit' })
  } else {
    execSync('cd "' + unpackedDir + '" && zip -r "' + outZipPath + '" . -q', { stdio: 'inherit' })
  }
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

  const exeName = computeExeName(channel, multi)
  const launcherManifest = {
    version: version,
    channel: channel,
    releasedAt: new Date().toISOString(),
    launcher: launcherInfo,
    ...(exeName ? { exeName } : {}),
    notes: 'Update v' + version
  }
  fs.writeFileSync(
    path.join(UPDATE_SERVER_PUBLIC, channel, 'latest.json'),
    JSON.stringify(launcherManifest, null, 2)
  )
  log('Manifest: ' + path.relative(ROOT, path.join(UPDATE_SERVER_PUBLIC, channel, 'latest.json')))

  if (serverInfo) {
    const serverManifestDir = path.join(UPDATE_SERVER_PUBLIC, channel + '-server', version)
    fs.mkdirSync(serverManifestDir, { recursive: true })
    const srcZip = path.join(targetChannelDir, 'server-payload.zip')
    const destZip = path.join(serverManifestDir, 'server-payload.zip')
    if (srcZip !== destZip) fs.copyFileSync(srcZip, destZip)
    const serverManifest = {
      version: version,
      channel: channel + '-server',
      releasedAt: new Date().toISOString(),
      launcher: {
        url: '/updates/' + channel + '-server/' + version + '/server-payload.zip',
        size: serverInfo.size,
        sha256: serverInfo.sha256
      },
      notes: 'Server update v' + version
    }
    fs.writeFileSync(
      path.join(UPDATE_SERVER_PUBLIC, channel + '-server', 'latest.json'),
      JSON.stringify(serverManifest, null, 2)
    )
    log('Server manifest written for channel "' + channel + '-server"')
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
