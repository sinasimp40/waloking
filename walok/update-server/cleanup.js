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

// Channel + version regex MUST match server.js's isValidChannel/isValidVersion.
// Duplicated here so cleanup.js can reject an obviously bogus input
// (e.g. "..", "/", absolute path) on its own — defense in depth.
const CHANNEL_RE_LOCAL = /^[a-z0-9][a-z0-9-]*$/
const VERSION_RE_LOCAL = /^\d+\.\d+\.\d+/

// Path-safe deletion of EXACTLY one cancelled job's half-published payload
// + its raw build output. Used by per-job onCancel hooks so a cancelled
// build never leaves stale files behind in either:
//   <updatesPublicDir>/<channel>/<version>/        (launcher payload)
//   <updatesPublicDir>/<channel>-server/<version>/ (server payload)
//   <projectRoot>/releases/<channel>/<version>/    (raw build output)
//
// Hard rules — every targeted dir MUST satisfy ALL of:
//   1. channel + version match the strict regexes above
//   2. resolved absolute path begins with the resolved expected parent dir
//      (guards against ".." in channel/version)
//   3. final segment of the resolved path equals the literal version string
//      (guards against a channel like "good/../../etc/passwd" sneaking through
//      the regex via case mismatch — the regex already forbids it, but check
//      anyway)
//   4. resolved expected parent dir is a non-empty directory we own
//      (refuse if expected parent is the filesystem root, "/", a drive letter,
//      etc.)
//
// Refused entries appear in `skipped` with a `reason`. Successful deletions
// appear in `removed` with the channel-relative label e.g. "updates/1.2.3".
// NEVER throws — caller is in the cancel codepath and we don't want a
// cleanup miss to crash the runner.
function cleanupCancelledJob({ projectRoot, updatesPublicDir, channel, version }) {
  const removed = []
  const skipped = []

  if (!channel || !CHANNEL_RE_LOCAL.test(channel)) {
    skipped.push({ path: String(channel), reason: 'invalid channel name' })
    return { removed, skipped }
  }
  if (!version || !VERSION_RE_LOCAL.test(version)) {
    skipped.push({ path: String(version), reason: 'invalid version string' })
    return { removed, skipped }
  }

  // Build the (root, expectedChannelSegment, label) triples we are allowed
  // to touch. `root` is the absolute resolved containment dir; the targeted
  // path MUST be exactly `<root>/<channelSegment>/<version>` (3 segments
  // appended, no .. or extra components).
  const triples = []
  if (updatesPublicDir) {
    triples.push({
      root: path.resolve(updatesPublicDir),
      channelSegment: channel,
      label: 'updates/' + channel + '/' + version,
    })
    triples.push({
      root: path.resolve(updatesPublicDir),
      channelSegment: channel + '-server',
      label: 'updates/' + channel + '-server/' + version,
    })
  }
  if (projectRoot) {
    triples.push({
      root: path.resolve(projectRoot, 'releases'),
      channelSegment: channel,
      label: 'releases/' + channel + '/' + version,
    })
  }

  for (const t of triples) {
    // Reject if the containment root is itself a filesystem root or empty.
    if (!t.root || t.root === path.parse(t.root).root) {
      skipped.push({ path: t.root, reason: 'refused: containment root is filesystem root' })
      continue
    }
    // Build target by joining and resolving — then VERIFY the resolved path
    // still equals the literal expected join. If channel/version contained
    // ".." or "/" the resolved path would diverge from the literal path,
    // which we'd catch here even if the regex was somehow bypassed.
    const literalTarget = t.root + path.sep + t.channelSegment + path.sep + version
    const target = path.resolve(t.root, t.channelSegment, version)
    if (target !== literalTarget) {
      skipped.push({ path: target, reason: 'refused: resolved path diverges from literal path' })
      continue
    }
    // Belt-and-braces containment + segment checks.
    if (!target.startsWith(t.root + path.sep)) {
      skipped.push({ path: target, reason: 'refused: outside containment root' })
      continue
    }
    if (path.basename(target) !== version) {
      skipped.push({ path: target, reason: 'refused: basename mismatch (expected ' + version + ')' })
      continue
    }
    if (path.basename(path.dirname(target)) !== t.channelSegment) {
      skipped.push({ path: target, reason: 'refused: parent segment mismatch (expected ' + t.channelSegment + ')' })
      continue
    }
    if (!fs.existsSync(target)) {
      // Nothing to remove — not an error. Skip silently (don't pollute log).
      continue
    }
    try {
      const st = fs.statSync(target)
      if (!st.isDirectory()) {
        skipped.push({ path: target, reason: 'refused: not a directory' })
        continue
      }
    } catch (e) {
      skipped.push({ path: target, reason: 'stat failed: ' + e.message })
      continue
    }
    try {
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(t.label)
    } catch (e) {
      skipped.push({ path: target, reason: 'rm failed: ' + e.message })
    }
  }

  return { removed, skipped }
}

module.exports = {
  cleanupAfterBuild,
  cleanupChannel,
  cleanupCancelledJob,
  compareVersions,
}
