// Disk-cleanup helpers — keep only the newest version per channel under
//   1. <PROJECT_ROOT>/releases/<channel>/<version>/   (raw build output)
//   2. <update-server>/public/updates/<channel>/<version>/  (published payload)
//
// Called automatically after a successful build+publish so disks don't fill
// up over time when many builds get cut for the same customer.
const fs = require('fs')
const path = require('path')

function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

function listVersionDirs(channelDir) {
  if (!fs.existsSync(channelDir)) return []
  return fs.readdirSync(channelDir)
    .filter(n => /^\d+\.\d+\.\d+/.test(n))
    .filter(n => {
      try { return fs.statSync(path.join(channelDir, n)).isDirectory() } catch (e) { return false }
    })
}

function cleanupChannel(rootDir, channel, keepVersion, opts) {
  const channelDir = path.join(rootDir, channel)
  const versions = listVersionDirs(channelDir)
  // Sort descending so the newest version is index 0.
  versions.sort((a, b) => compareVersions(b, a))
  // Keep set:
  //   - default: newest existing version + (optional) the keepVersion arg
  //   - if opts.keepNewest === false: only keepVersion (or nothing) — remove ALL
  //     other version subdirs. Used by pre-build cleanup which wants a clean
  //     slate so the about-to-run build is the sole tenant.
  const keepers = new Set()
  if (!opts || opts.keepNewest !== false) {
    if (versions[0]) keepers.add(versions[0])
  }
  if (keepVersion) keepers.add(keepVersion)
  const removed = []
  for (const v of versions) {
    if (keepers.has(v)) continue
    const dir = path.join(channelDir, v)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(v)
    } catch (e) {
      // Best-effort — log but don't crash the build pipeline.
      console.error('[cleanup] failed to remove ' + dir + ': ' + e.message)
    }
  }
  return { kept: [...keepers], removed }
}

// Run a cleanup pass for every customer channel under both the build-output
// and the published-payload roots. `version` is the just-built version that
// should always be retained even if the lexical-newest dir on disk drifts.
function cleanupAfterBuild({ projectRoot, updatesPublicDir, channels, version, keepNewest }) {
  // keepNewest defaults to true (post-build / safety-net behavior). Pass false
  // for a literal pre-build sweep that removes ALL existing version subdirs
  // for the listed channels regardless of which is currently newest.
  const opts = { keepNewest: keepNewest === false ? false : true }
  const summary = []
  for (const channel of channels) {
    const r1 = projectRoot
      ? cleanupChannel(path.join(projectRoot, 'releases'), channel, version, opts)
      : { kept: [], removed: [] }
    const r2 = updatesPublicDir
      ? cleanupChannel(updatesPublicDir, channel, version, opts)
      : { kept: [], removed: [] }
    // Server-side companion channel ("<channel>-server") used by the .exe
    // server-side updater also has its own version dirs; clean those too.
    const r3 = updatesPublicDir
      ? cleanupChannel(updatesPublicDir, channel + '-server', version, opts)
      : { kept: [], removed: [] }
    summary.push({
      channel,
      releases: r1,
      published: r2,
      publishedServer: r3,
    })
  }
  return summary
}

module.exports = { cleanupAfterBuild, cleanupChannel, compareVersions }
