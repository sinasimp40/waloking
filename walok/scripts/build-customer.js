const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync, execFileSync } = require('child_process')

// As of May 2026 update-server/ lives at the REPO ROOT (sibling of walok/),
// not inside walok/. We try the new path first, then fall back to the old
// in-walok location so older RDP installs keep working. If neither resolves,
// degrade gracefully — the OTA server runs cleanupAfterBuild() itself in its
// onComplete hook (see server.js), so this require is duplicative for OTA-
// driven builds and only mattered for manual `node scripts/build-customer.js`
// invocations.
let cleanupAfterBuild = null
try { cleanupAfterBuild = require('../../update-server/cleanup').cleanupAfterBuild }
catch (_) {
  try { cleanupAfterBuild = require('../update-server/cleanup').cleanupAfterBuild }
  catch (_) { cleanupAfterBuild = null }
}

const ROOT = path.join(__dirname, '..')
const CUSTOMERS_DIR = path.join(ROOT, 'customers')
const RELEASES_DIR = path.join(ROOT, 'releases')
const BRANDING_DIR = path.join(ROOT, 'branding')
// Fallback path used only when OTA_UPDATES_DIR env isn't set (operator
// running this manually from the CLI). Try new layout first (repo-root
// sibling), then legacy in-walok.
const UPDATES_PUBLIC_DIR = (() => {
  const newP = path.join(ROOT, '..', 'update-server', 'public', 'updates')
  if (fs.existsSync(path.join(ROOT, '..', 'update-server'))) return newP
  return path.join(ROOT, 'update-server', 'public', 'updates')
})()

function log(msg) { console.log('[build-customer] ' + msg) }
function err(msg) { console.error('[build-customer] ERROR: ' + msg) }

// Synchronous rmrf with retry on EPERM/EBUSY. Windows Explorer / antivirus
// frequently hold transient handles on freshly-built dist directories, which
// is what produced the field EPERM crash on dist-electron. We retry up to
// 6 times with exponential backoff (200ms..6.4s) before giving up; a final
// failure is reported but does NOT throw — the build will fail naturally
// downstream if the dir really is unusable.
function rmrfWithRetrySync(p) {
  if (!fs.existsSync(p)) return true
  const delays = [200, 400, 800, 1600, 3200, 6400]
  let lastErr = null
  for (let i = 0; i <= delays.length; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      if (!fs.existsSync(p)) return true
    } catch (e) {
      lastErr = e
    }
    if (i === delays.length) break
    // Synchronous busy-wait — we're a CLI build script, blocking is fine.
    const until = Date.now() + delays[i]
    while (Date.now() < until) { /* spin */ }
  }
  if (fs.existsSync(p)) {
    log('[rmrf] WARN: could not remove ' + p + ' after ' + (delays.length + 1) + ' attempts (' +
      (lastErr ? lastErr.message : 'still present') + '). Continuing — electron-builder will report a clearer error if this matters.')
    return false
  }
  return true
}

function findCustomerFile(idOrPath) {
  if (fs.existsSync(idOrPath) && fs.statSync(idOrPath).isFile()) return idOrPath
  const direct = path.join(CUSTOMERS_DIR, idOrPath.endsWith('.json') ? idOrPath : idOrPath + '.json')
  if (fs.existsSync(direct)) return direct
  return null
}

function loadCustomer(idOrPath) {
  const file = findCustomerFile(idOrPath)
  if (!file) throw new Error('Customer config not found: ' + idOrPath)
  const c = JSON.parse(fs.readFileSync(file, 'utf-8'))
  for (const f of ['channel', 'brandName', 'subtitle', 'updateServer']) {
    if (!c[f]) throw new Error('Customer ' + idOrPath + ' missing required field: ' + f)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.channel)) {
    throw new Error('Invalid channel "' + c.channel + '" — must be lowercase letters, numbers, and dashes only.')
  }
  return c
}

function readVersion() {
  // Per-customer auto-bump: the OTA admin sets BUILD_VERSION when it spawns
  // this script so each customer can be built at its own next version
  // (computed from that customer's last published version) without mutating
  // the global package.json. Falls back to package.json when invoked directly
  // from the CLI for a fresh customer with no prior published version.
  const env = process.env.BUILD_VERSION
  if (env && /^\d+\.\d+\.\d+$/.test(env)) return env
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version
}

// Supported logo source extensions. .svg is intentionally NOT here as a build
// target — sharp's ICO pipeline expects raster bytes — but .svg sitting in
// branding/ as a sibling file is fine; we just won't pick it as a destination.
const SUPPORTED_LOGO_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp']

function syncLogo(customer) {
  if (!customer.logo) return null
  const src = path.isAbsolute(customer.logo) ? customer.logo : path.join(ROOT, customer.logo)
  if (!fs.existsSync(src)) {
    // Hard error (was: silent WARN). The silent fallback was the root cause of
    // the build-all logo-leakage bug — sibling builds would inherit whatever
    // branding/logo.<ext> had been written by the previous customer's build.
    throw new Error(
      'Logo source for channel "' + customer.channel + '" not found at ' + src +
      ' — re-upload the logo via the admin panel, or fix the customer\'s "logo" path, before building.'
    )
  }
  const ext = path.extname(src).toLowerCase()
  if (!SUPPORTED_LOGO_EXTS.includes(ext)) {
    throw new Error(
      'Logo source for channel "' + customer.channel + '" has unsupported extension "' + ext +
      '" — use one of ' + SUPPORTED_LOGO_EXTS.join(', ') + '.'
    )
  }
  // Read source bytes BEFORE any cleanup, so a delete-then-fail can't leave
  // branding/ in a broken state mid-build.
  const srcBytes = fs.readFileSync(src)
  const srcResolved = path.resolve(src)
  const destName = 'logo' + ext
  const destPath = path.join(BRANDING_DIR, destName)

  // PRECISE cleanup (replaces the old mass-delete loop): only remove a stale
  // PRIOR-DESTINATION file `branding/logo.<otherExt>` whose extension differs
  // from this customer's source. We never touch sibling per-channel source
  // assets like `branding/<other-channel>-logo.png` — that's exactly what the
  // old code did, and it's what made build-all give every customer the same
  // (first) logo: customer A's syncLogo wiped customer B's source, then B's
  // syncLogo silently fell back to whatever branding/logo.png contained
  // (still A's content). Fixed.
  for (const otherExt of SUPPORTED_LOGO_EXTS) {
    if (otherExt === ext) continue
    const stale = path.join(BRANDING_DIR, 'logo' + otherExt)
    if (!fs.existsSync(stale)) continue
    if (path.resolve(stale) === srcResolved) continue // belt-and-braces: never delete source
    try { fs.unlinkSync(stale) } catch (e) { /* best-effort */ }
  }

  fs.writeFileSync(destPath, srcBytes)
  const sha = crypto.createHash('sha256').update(srcBytes).digest('hex').slice(0, 12)
  // Logged on EVERY build so the live console makes per-customer source
  // visible to the operator. If two customers ever ship with the same sha
  // prefix in the same build batch, that's the visual cue that something
  // upstream (e.g. logo upload) is wrong.
  log('Logo synced: ' + path.relative(ROOT, src) + ' -> branding/' + destName +
    ' (sha256=' + sha + ', ' + srcBytes.length + ' bytes)')
  return { src: src, srcRelative: path.relative(ROOT, src), dest: destPath, sha: sha, bytes: srcBytes.length }
}

function writeOtaConfig(customer, version) {
  const otaConfig = {
    channel: customer.channel,
    updateServer: customer.updateServer.replace(/\/$/, ''),
    version: version,
    checkIntervalMs: 120000,
    enabled: true,
    brand: customer.brandName,
    subtitle: customer.subtitle
  }
  fs.writeFileSync(
    path.join(BRANDING_DIR, 'ota-config.json'),
    JSON.stringify(otaConfig, null, 2)
  )
  fs.writeFileSync(
    path.join(BRANDING_DIR, 'ota-config-server.json'),
    JSON.stringify({ ...otaConfig, channel: otaConfig.channel + '-server' }, null, 2)
  )
  log('OTA config written for channel "' + customer.channel + '" v' + version)
}

function run(cmd, cwd) {
  log('$ ' + cmd + (cwd ? '  (in ' + path.relative(ROOT, cwd) + ')' : ''))
  execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit' })
}

// Safer variant: argv-array form, no shell. Use this when args contain user-controlled
// strings (e.g. brandName / subtitle from customer config) so quotes / spaces / shell
// metacharacters can never break command parsing.
function runArgs(cmd, args, cwd) {
  log('$ ' + cmd + ' ' + args.map(a => JSON.stringify(a)).join(' ') + (cwd ? '  (in ' + path.relative(ROOT, cwd) + ')' : ''))
  execFileSync(cmd, args, { cwd: cwd || ROOT, stdio: 'inherit' })
}

// Sub-step markers consumed by the admin server's SSE stream so that build
// failures inside this single child process can still be attributed to a
// specific phase ("vite build (launcher)" vs "electron-builder (server)" etc).
// The admin reads the most recent SUBSTEP_BEGIN that wasn't followed by
// SUBSTEP_END_OK and reports it as the failing sub-step.
function substep(label, fn) {
  console.log('[SUBSTEP_BEGIN] ' + label)
  try {
    fn()
    console.log('[SUBSTEP_END_OK] ' + label)
  } catch (e) {
    console.log('[SUBSTEP_END_FAIL] ' + label)
    throw e
  }
}

function copyArtifacts(customer, version) {
  const channelDir = path.join(RELEASES_DIR, customer.channel, version)
  fs.mkdirSync(channelDir, { recursive: true })

  // BUILD_OUTPUT_DIR / BUILD_SERVER_OUTPUT_DIR are set by the OTA admin
  // server's job-runner so each parallel build can use its own per-job
  // dist directory (e.g. dist-electron-<jobId>). Falls back to the canonical
  // dist-electron paths when this script is invoked directly from the CLI.
  const launcherDist = process.env.BUILD_OUTPUT_DIR && fs.existsSync(process.env.BUILD_OUTPUT_DIR)
    ? process.env.BUILD_OUTPUT_DIR
    : path.join(ROOT, 'dist-electron')
  const serverDist = process.env.BUILD_SERVER_OUTPUT_DIR && fs.existsSync(process.env.BUILD_SERVER_OUTPUT_DIR)
    ? process.env.BUILD_SERVER_OUTPUT_DIR
    : path.join(ROOT, 'server', 'dist-electron')

  let copied = 0
  if (fs.existsSync(launcherDist)) {
    for (const f of fs.readdirSync(launcherDist)) {
      if (f.endsWith('.zip') || f.endsWith('.exe')) {
        const target = path.join(channelDir, 'launcher-' + f)
        fs.copyFileSync(path.join(launcherDist, f), target)
        copied++
        log('Copied: ' + path.relative(ROOT, target))
      }
    }
    const unpackedLauncher = path.join(launcherDist, 'win-unpacked')
    if (fs.existsSync(unpackedLauncher)) {
      copyDir(unpackedLauncher, path.join(channelDir, 'launcher-unpacked'))
      log('Copied launcher-unpacked/')
    }
  }
  if (fs.existsSync(serverDist)) {
    for (const f of fs.readdirSync(serverDist)) {
      if (f.endsWith('.zip') || f.endsWith('.exe')) {
        const target = path.join(channelDir, 'server-' + f)
        fs.copyFileSync(path.join(serverDist, f), target)
        copied++
        log('Copied: ' + path.relative(ROOT, target))
      }
    }
    const unpackedServer = path.join(serverDist, 'win-unpacked')
    if (fs.existsSync(unpackedServer)) {
      copyDir(unpackedServer, path.join(channelDir, 'server-unpacked'))
      log('Copied server-unpacked/')
    }
  }
  log('Total artifacts copied: ' + copied)
  return channelDir
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

async function main() {
  const customerId = process.argv[2]
  if (!customerId) {
    err('Usage: node scripts/build-customer.js <customer-id-or-path>')
    process.exit(1)
  }

  const customer = loadCustomer(customerId)
  log('=== Building customer: ' + customer.brandName + ' (' + customer.channel + ') ===')

  // Pre-build cleanup: literal sweep — remove EVERY prior version subdir for
  // this channel from releases/ AND update-server/public/updates/ so the
  // about-to-run build is the sole tenant. Failures are logged but non-fatal;
  // a half-cleaned tree is still a valid input for a fresh build.
  // Skipped silently when cleanup module isn't available (update-server/ not
  // resolvable from this build workspace) — the OTA server runs cleanup
  // independently in its onComplete hook.
  try {
    if (!cleanupAfterBuild) {
      log('[cleanup] skipped — update-server/cleanup module not reachable from this workspace (OTA server will clean up post-build instead)')
      throw { skipCleanup: true }
    }
    const summary = cleanupAfterBuild({
      projectRoot: ROOT,
      updatesPublicDir: UPDATES_PUBLIC_DIR,
      channels: [customer.channel],
      version: null,
      keepNewest: false,
    })
    for (const s of summary) {
      const removed = [
        ...(s.releases.removed || []).map(v => 'releases/' + v),
        ...(s.published.removed || []).map(v => 'updates/' + v),
        ...(s.publishedServer.removed || []).map(v => 'updates-server/' + v),
      ]
      if (removed.length > 0) log('[cleanup] removed: ' + removed.join(', '))
    }
  } catch (e) {
    if (e && e.skipCleanup) { /* already logged */ }
    else log('[cleanup] WARN: pre-build cleanup failed: ' + (e && e.message ? e.message : String(e)))
  }

  substep('sync logo + rebrand source', () => {
    const synced = syncLogo(customer)
    if (synced) {
      log('Logo source for ' + customer.channel + ': ' + synced.srcRelative + ' (sha256=' + synced.sha + ')')
    }
    log('Step 1/5: Rebranding source...')
    runArgs(process.execPath, [path.join('scripts', 'rebrand.js'), customer.brandName, customer.subtitle])
  })

  const version = readVersion()
  writeOtaConfig(customer, version)

  // Per-job output dirs (set by the OTA admin server's job-runner). When
  // these are set we override electron-builder's `directories.output` so
  // each parallel build writes to its own folder instead of fighting over
  // the canonical dist-electron/. This also fixes EPERM crashes the field
  // hit when a previous build's leftover handle on dist-electron/ blocked
  // the next build's wipe — a fresh per-job folder has no stale handles.
  const launcherOutDir = process.env.BUILD_OUTPUT_DIR || path.join(ROOT, 'dist-electron')
  const serverOutDir = process.env.BUILD_SERVER_OUTPUT_DIR || path.join(ROOT, 'server', 'dist-electron')

  // BUILD_ROLE — set by the OTA admin's role-filtered build button on each
  // customer card so the operator can ship JUST a launcher OR JUST a server
  // payload for one customer (e.g. emergency launcher hotfix while the
  // server is mid-game and shouldn't be replaced).
  //
  //   BUILD_ROLE=launcher → run vite + electron-builder (launcher) ONLY,
  //                         skip electron-builder (server). publish-update
  //                         only ships roles whose <role>-unpacked/ exists,
  //                         so omitting the server build correctly results
  //                         in a launcher-only manifest write — no separate
  //                         flag plumbed into publish-update.js needed.
  //   BUILD_ROLE=server   → skip vite + launcher, run electron-builder
  //                         (server) ONLY.
  //   (unset)             → both, full build, original behavior.
  //
  // Anything else (including '', 'both', 'all') means both — defensive
  // default so a typo can't accidentally ship nothing.
  const role = (process.env.BUILD_ROLE || '').toLowerCase()
  const buildLauncher = role !== 'server'
  const buildServer = role !== 'launcher'
  if (role) log('BUILD_ROLE=' + role + ' → launcher=' + buildLauncher + ', server=' + buildServer)

  if (buildLauncher) {
    rmrfWithRetrySync(launcherOutDir)
    substep('vite build (launcher)', () => {
      log('Step 2/5: Vite build (launcher)...')
      run('npm run build')
    })
    substep('electron-builder (launcher)', () => {
      log('Step 3/5: electron-builder (launcher) -> ' + path.relative(ROOT, launcherOutDir))
      run('npx electron-builder -c.directories.output=' + JSON.stringify(launcherOutDir))
    })
  } else {
    log('Skipping launcher build (BUILD_ROLE=server)')
  }

  if (buildServer) {
    rmrfWithRetrySync(serverOutDir)
    substep('electron-builder (server)', () => {
      log('Step 4/5: electron-builder (server) -> ' + path.relative(ROOT, serverOutDir))
      // dist:server is `electron-builder --config server/package.json` per the
      // launcher package.json; override its output dir the same way.
      run('npm run dist:server -- -c.directories.output=' + JSON.stringify(serverOutDir))
    })
  } else {
    log('Skipping server build (BUILD_ROLE=launcher)')
  }

  substep('collect artifacts', () => {
    log('Step 5/5: Collecting artifacts to releases/' + customer.channel + '/' + version + '/')
    const out = copyArtifacts(customer, version)
    log('=== DONE: ' + customer.brandName + ' v' + version + ' ===')
    log('Output: ' + out)
  })
}

module.exports = { syncLogo, SUPPORTED_LOGO_EXTS }

if (require.main === module) {
  main().catch(e => { err(e.message); process.exit(1) })
}
