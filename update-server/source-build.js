// Build From Uploaded Source executor.
//
// The operator uploads a launcher source zip, server source zip, or both via
// POST /api/admin/build-from-source. This module unpacks the zip into a
// per-job workspace, validates its shape, rebrands it for the target customer,
// installs deps, runs the appropriate build, packs the resulting
// win-unpacked/ into a payload zip, and hands the buffer back to the server
// for the existing writePayloadAndManifest publish path.
//
// Critical invariants:
//   - Every spawned child process is wired to job.activeChild so cancelJob
//     can SIGKILL the entire tree (taskkill /T on Windows, kill(-pid) POSIX).
//   - Every spawn passes minimalEnv:true through runStep so OTA_ADMIN_PASSWORD
//     and other secrets cannot be read by uploaded npm scripts (postinstall
//     hooks, prebuild scripts, anything in package.json scripts.*).
//   - Zip extraction enforces zip-slip protection AND a per-entry size cap to
//     prevent zip bombs.
//   - The workspace dir is removed in a finally clause regardless of success
//     or failure so we never leak disk on a long-running admin server.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const yauzl = require('yauzl')

const jobRunner = require('./job-runner')
const { jobAppend, jobEmitPhase, runStep, rmrfWithRetry } = jobRunner

const IS_WIN = process.platform === 'win32'
const NPM_CMD = IS_WIN ? 'npm.cmd' : 'npm'
const NPX_CMD = IS_WIN ? 'npx.cmd' : 'npx'
const NODE_CMD = process.execPath

// Per-entry size cap. Real source zips can include large prebuilt binaries
// (electron itself is ~100 MB; certain native modules + assets can push a
// single entry well past 200 MB). The cap exists ONLY to refuse pathological
// zip bombs — operator uploads are authenticated, so we set this generously
// at 4 GB.
const MAX_ENTRY_SIZE = 4 * 1024 * 1024 * 1024

// Total uncompressed size cap — second line of defence so a zip with many
// small entries summing to absurd totals still gets refused. 16 GB matches
// the multer upload-side cap with comfortable headroom for a fully
// decompressed source tree.
const MAX_TOTAL_SIZE = 16 * 1024 * 1024 * 1024

// Validate a path inside the zip is safe to extract under destDir. Refuses
// absolute paths, drive letters, or any sequence that escapes destDir via ..
// Returns the safe absolute target path or throws.
function safeJoinUnderDest(destDir, entryName) {
  if (!entryName) throw new Error('zip entry has empty name')
  if (entryName.includes('\0')) throw new Error('zip entry name contains NUL byte')
  // Reject absolute paths and Windows drive letters before normalization so
  // a name like "C:\foo" or "/etc/passwd" never reaches path.resolve.
  if (path.isAbsolute(entryName) || /^[a-zA-Z]:[\\/]/.test(entryName)) {
    throw new Error('zip entry has absolute path: ' + entryName)
  }
  // Refuse any entry whose normalized form contains `..` segments. A safe zip
  // never needs them; allowing them and then "stripping" risks landing on
  // `etc/passwd` style targets that ARE under destDir but shouldn't exist
  // there. Strict refusal is the right call — this is uploaded content from
  // an authenticated admin, not a general-purpose unzipper.
  const normalized = path.normalize(entryName)
  const segments = normalized.split(/[\\/]/)
  if (segments.some(s => s === '..')) {
    throw new Error('zip entry contains parent-directory traversal (zip-slip): ' + entryName)
  }
  const target = path.resolve(destDir, normalized)
  const destResolved = path.resolve(destDir)
  const destWithSep = destResolved + path.sep
  // Belt-and-braces — even after the segment check above, verify the
  // resolved target is under destDir. Catches symbolic-link tricks if ever
  // the OS resolves through one.
  if (target !== destResolved && !target.startsWith(destWithSep)) {
    throw new Error('zip entry escapes destination (zip-slip): ' + entryName)
  }
  return target
}

// Strip a single common top-level directory if present. Many source zips are
// produced by GitHub/git archive and have everything nested under
// "<repo>-<sha>/" — without this strip, every later path lookup would need to
// know the prefix. Returns { strippedRoot, hasCommonRoot }.
async function maybeStripCommonRoot(destDir) {
  const entries = await fs.promises.readdir(destDir)
  // Filter out hidden files (e.g. macOS .DS_Store) when deciding the wrap
  // dir, but DON'T move them — they get cleaned up below.
  const visible = entries.filter(e => !e.startsWith('.') && e !== '__MACOSX')
  if (visible.length !== 1) return { strippedRoot: destDir, hasCommonRoot: false }
  const onlyEntry = visible[0]
  const onlyPath = path.join(destDir, onlyEntry)
  const stat = await fs.promises.stat(onlyPath)
  if (!stat.isDirectory()) return { strippedRoot: destDir, hasCommonRoot: false }
  // Move every child of the wrap dir up one level. Done with rename to keep
  // it atomic per-entry on the same filesystem.
  const inner = await fs.promises.readdir(onlyPath)
  for (const name of inner) {
    await fs.promises.rename(path.join(onlyPath, name), path.join(destDir, name))
  }
  await fs.promises.rmdir(onlyPath)
  return { strippedRoot: destDir, hasCommonRoot: true }
}

// Extract a zip buffer into destDir with zip-slip + size protection. Resolves
// when extraction finishes, rejects on any unsafe entry or size cap breach.
function extractZipBuffer(buffer, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(new Error('not a valid zip archive: ' + err.message))
      let totalUncompressed = 0
      let entryCount = 0
      let aborted = false
      const fail = (e) => {
        if (aborted) return
        aborted = true
        try { zipfile.close() } catch (_) {}
        reject(e)
      }
      zipfile.on('error', fail)
      zipfile.on('end', () => { if (!aborted) resolve({ entryCount, totalUncompressed }) })
      zipfile.on('entry', (entry) => {
        if (aborted) return
        entryCount++
        // Yauzl uses forward slashes regardless of platform.
        const name = entry.fileName
        let target
        try { target = safeJoinUnderDest(destDir, name) } catch (e) { return fail(e) }
        // Directory entry — names ending in '/'. mkdir and continue.
        if (/\/$/.test(name)) {
          fs.promises.mkdir(target, { recursive: true })
            .then(() => zipfile.readEntry())
            .catch(fail)
          return
        }
        if (entry.uncompressedSize > MAX_ENTRY_SIZE) {
          return fail(new Error('zip entry too large (' + entry.uncompressedSize + ' bytes > ' + MAX_ENTRY_SIZE + '): ' + name))
        }
        totalUncompressed += entry.uncompressedSize
        if (totalUncompressed > MAX_TOTAL_SIZE) {
          return fail(new Error('zip total uncompressed size exceeds ' + MAX_TOTAL_SIZE + ' bytes (zip bomb refused)'))
        }
        fs.promises.mkdir(path.dirname(target), { recursive: true }).then(() => {
          zipfile.openReadStream(entry, (rsErr, readStream) => {
            if (rsErr) return fail(rsErr)
            // Belt-and-braces: also enforce per-entry cap by counting actual
            // bytes written, in case the zip's stored uncompressedSize lies.
            let writtenBytes = 0
            const writeStream = fs.createWriteStream(target)
            readStream.on('error', fail)
            writeStream.on('error', fail)
            readStream.on('data', (chunk) => {
              writtenBytes += chunk.length
              if (writtenBytes > MAX_ENTRY_SIZE) {
                readStream.destroy()
                writeStream.destroy()
                fail(new Error('zip entry actual size exceeds cap mid-stream: ' + name))
              }
            })
            writeStream.on('close', () => {
              if (aborted) return
              zipfile.readEntry()
            })
            readStream.pipe(writeStream)
          })
        }).catch(fail)
      })
      zipfile.readEntry()
    })
  })
}

// Make sure every uploaded zip is real before we touch the disk. PK\x03\x04
// is the local-file-header magic for a non-empty zip; PK\x05\x06 is the
// empty-archive end-of-central-directory marker. Refuse anything else
// outright so multer's tolerance for arbitrary mimetypes can't cause us to
// run yauzl on (e.g.) an HTML error page.
function looksLikeZip(buffer) {
  if (!buffer || buffer.length < 4) return false
  const sig = buffer.slice(0, 4)
  return (sig[0] === 0x50 && sig[1] === 0x4B && (
    (sig[2] === 0x03 && sig[3] === 0x04) ||
    (sig[2] === 0x05 && sig[3] === 0x06)
  ))
}

// =============================================================================
// PATCH UPLOAD MODE — baseline cache + tiny incremental uploads
// =============================================================================
//
// Operators don't want to re-upload the entire repo (electron/, scripts/,
// branding/, package.json, …) every time they only changed the React UI in
// src/ or the server-side code in server/. So we keep ONE shared "baseline"
// snapshot of the un-rebranded source on the OTA server. The first build
// after an operator establishes a baseline is mode='full' (uploads the full
// repo zip — this same step also refreshes the cached baseline). Every
// subsequent build can be mode='patch-src', 'patch-server', or 'patch-both',
// where the operator uploads JUST the contents of src/ (and/or server/) in a
// tiny zip. The server reconstructs a full source tree by overlaying the
// uploaded patch onto the cached baseline, then runs the same install +
// rebrand + electron-builder + pack pipeline as the full mode.
//
// What gets snapshotted into the baseline:
//   - Everything from the uploaded full-mode source EXCEPT
//     `node_modules/`, `dist/`, `dist-electron/`, `out/`, `release/`,
//     `releases/`, `.git/`, `.build-jobs/`, `update-server/`,
//     `branding/customers/` (per-customer overlays),
//     `customers/_migrated_backup/`.
//   - Per-customer branding files in `branding/<channel>-logo.*` are NOT
//     snapshotted either (customer logos live in the OTA server DB and are
//     re-synced into the workdir per build).
//
// Why one shared baseline (not per-customer): the rebrand step is what makes
// a build customer-specific. The INPUT source is identical across customers
// — they all start from the same un-rebranded code. Per-customer baselines
// would just waste disk and make patch flow incoherent ("which customer's
// baseline was the operator targeting when they uploaded a generic src.zip?").
const BASELINE_DIR = path.join(__dirname, '.source-baseline')

// Directory entries we never copy into the baseline. Keyed by lowercased
// basename so the comparison is case-insensitive on Windows + macOS.
const BASELINE_EXCLUDE = new Set([
  'node_modules', 'dist', 'dist-electron', 'out', 'release', 'releases',
  '.git', '.build-jobs', '.source-baseline', 'update-server', 'attached_assets',
  '.replit', '.local', '.canvas', '.config', '.github', '.agents',
])

// Recursively copy srcDir → destDir, skipping any path whose basename matches
// BASELINE_EXCLUDE or any per-customer logo (`branding/<channel>-logo.*`).
// Symlinks are skipped (security: an uploaded zip can't put symlinks in,
// extractZipBuffer doesn't create them — but defense-in-depth is cheap here).
async function copyTreeForBaseline(srcDir, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true })
  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const lname = e.name.toLowerCase()
    if (BASELINE_EXCLUDE.has(lname)) continue
    const src = path.join(srcDir, e.name)
    const dst = path.join(destDir, e.name)
    if (e.isDirectory()) {
      // Per-customer logo overlays live under branding/customers/ — skip the
      // whole subtree. Generic branding assets (icon templates, fonts) DO get
      // copied because they're shared across customers.
      if (path.basename(srcDir).toLowerCase() === 'branding' && lname === 'customers') continue
      await copyTreeForBaseline(src, dst)
    } else if (e.isFile()) {
      // Per-channel logo files (`branding/<channel>-logo.<ANY-EXT>`) are also
      // skipped — they're customer-specific, the build pipeline syncs them
      // freshly into each per-customer workdir. We match ANY extension (or
      // even no extension) on purpose: the requirement is "exclude any
      // per-customer logo overlay" not "exclude these 5 image formats".
      // .ico, .bmp, .svg, .tiff and even extensionless logo files are all
      // still customer-specific and must not leak into the shared baseline.
      if (path.basename(srcDir).toLowerCase() === 'branding' &&
          /^[a-z0-9-]+-logo(\.[a-z0-9]{1,8})?$/i.test(e.name)) continue
      await fs.promises.copyFile(src, dst)
    }
    // Block devices, FIFOs, sockets etc are silently skipped — they have no
    // business in a source tree.
  }
}

// Snapshot a fresh full-mode source tree into the shared baseline cache.
// Idempotent — wipes any previous baseline for this kind first so deletions
// in the new upload (e.g. a removed file) propagate. Records the refresh
// timestamp via the `setBaselineMeta` callback so the admin UI can show
// "Baseline refreshed N minutes ago".
async function snapshotBaseline(workDir, kind, setBaselineMeta) {
  const target = path.join(BASELINE_DIR, kind)
  // Atomic-ish snapshot to avoid partial reads from concurrent patch
  // requests: copy into a sibling temp dir first, then rename old→trash and
  // temp→target. Rename is atomic on the same filesystem, so a concurrent
  // preparePatchWorkDir always sees EITHER the old complete baseline OR the
  // new complete baseline — never a mid-copy halfway state, and never the
  // 50-ms window where the old dir was rm'd but the new copy hadn't started
  // yet (the bug in the original wipe-then-copy approach).
  await fs.promises.mkdir(BASELINE_DIR, { recursive: true })
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  const tmp = path.join(BASELINE_DIR, '.tmp-' + kind + '-' + stamp)
  const trash = path.join(BASELINE_DIR, '.trash-' + kind + '-' + stamp)
  await copyTreeForBaseline(workDir, tmp)
  let renamedOldOut = false
  try {
    if (fs.existsSync(target)) {
      await fs.promises.rename(target, trash)
      renamedOldOut = true
    }
    await fs.promises.rename(tmp, target)
  } catch (e) {
    // Best-effort rollback so we don't leave the baseline missing.
    if (renamedOldOut && !fs.existsSync(target)) {
      try { await fs.promises.rename(trash, target) } catch (_) {}
    }
    try { await fs.promises.rm(tmp, { recursive: true, force: true }) } catch (_) {}
    throw e
  }
  // Old baseline (now in trash/) can be removed lazily; if rm fails we
  // log + leave it for next run rather than failing the snapshot.
  try { await fs.promises.rm(trash, { recursive: true, force: true }) } catch (_) {}
  if (typeof setBaselineMeta === 'function') {
    try { setBaselineMeta(kind, Date.now()) } catch (_) {}
  }
}

// Returns { exists, refreshedAt, byteSize } for the cached baseline of `kind`.
// `getBaselineMeta` reads the timestamp the snapshot step wrote.
async function getBaselineStatus(kind, getBaselineMeta) {
  const dir = path.join(BASELINE_DIR, kind)
  const exists = fs.existsSync(dir)
  let refreshedAt = null
  if (typeof getBaselineMeta === 'function') {
    try { refreshedAt = getBaselineMeta(kind) } catch (_) {}
  }
  let byteSize = 0
  if (exists) {
    try {
      // Cheap recursive size calc — baselines are small enough that walking
      // them on a status request is fine.
      const walk = async (p) => {
        const st = await fs.promises.stat(p)
        if (st.isFile()) { byteSize += st.size; return }
        if (st.isDirectory()) {
          for (const n of await fs.promises.readdir(p)) await walk(path.join(p, n))
        }
      }
      await walk(dir)
    } catch (_) {}
  }
  return { exists, refreshedAt, byteSize }
}

// Build a workDir for a PATCH build by overlaying the uploaded patch zip on
// top of the cached baseline.
//   - kind='launcher' patch overlays into <workDir>/src/
//   - kind='server'   patch overlays into <workDir>/server/
// The target subdir is wiped first so file deletions in the user's local
// src/ or server/ folder propagate (otherwise stale files would linger).
async function preparePatchWorkDir({ workspaceRoot, kind, patchZipBuffer, job }) {
  const baselineDir = path.join(BASELINE_DIR, kind)
  if (!fs.existsSync(baselineDir)) {
    throw new Error('no baseline cached for ' + kind + ' — upload a Full Repo zip first to establish the baseline, then patch builds will work')
  }
  if (!looksLikeZip(patchZipBuffer)) {
    throw new Error('patch upload (' + kind + ') is not a zip file (missing PK header)')
  }
  const workDir = path.join(workspaceRoot, kind + '-src')
  await fs.promises.mkdir(workDir, { recursive: true })
  // 1. Copy baseline into workDir as the starting point.
  jobAppend(job, '== Restoring ' + kind + ' baseline (' + baselineDir + ')…')
  await copyTreeForBaseline(baselineDir, workDir)
  // 2. Wipe the subdir we're about to overlay (src/ for launcher, server/
  //    for server). If it doesn't exist yet (very stripped baseline) we
  //    create it. Then extract uploaded zip into it.
  const overlaySubdir = kind === 'launcher' ? 'src' : 'server'
  const overlayDir = path.join(workDir, overlaySubdir)
  await fs.promises.rm(overlayDir, { recursive: true, force: true })
  await fs.promises.mkdir(overlayDir, { recursive: true })
  jobAppend(job, '== Overlaying patch zip (' + patchZipBuffer.length + ' bytes) into ' + overlaySubdir + '/')
  const stats = await extractZipBuffer(patchZipBuffer, overlayDir)
  jobAppend(job, '   patched ' + stats.entryCount + ' entries (' + stats.totalUncompressed + ' bytes uncompressed)')
  // Strip a wrapper folder if the operator zipped the parent (so the zip
  // contains "src/foo.jsx" instead of "foo.jsx" — equivalent end result
  // either way, but only after stripping).
  await maybeStripCommonRoot(overlayDir)
  // For server kind the patched server/ folder must still satisfy the
  // server-side validator (server/package.json + server/electron/main.js
  // exist relative to workDir root). For launcher kind, package.json +
  // electron/main.js come from the baseline, not the patch — so the only
  // thing the patch needs to be is "files that go in src/". We don't enforce
  // a specific shape on src/ itself because src layouts vary widely (vite,
  // CRA, custom).
  return workDir
}

// Validate the extracted source has the expected shape for `kind`. Returns
// the absolute path to the build cwd (might be a sub-dir for kind=server if
// the operator zipped the full repo and the server lives under server/).
async function validateSourceShape(rootDir, kind) {
  const exists = (p) => fs.promises.access(p).then(() => true, () => false)
  const rootPkg = path.join(rootDir, 'package.json')
  if (!(await exists(rootPkg))) {
    throw new Error('zip is missing package.json at the top level (extracted to ' + rootDir + ')')
  }
  if (kind === 'launcher') {
    const main = path.join(rootDir, 'electron', 'main.js')
    if (!(await exists(main))) {
      throw new Error('launcher source missing electron/main.js — is this the launcher repo?')
    }
    return rootDir
  }
  if (kind === 'server') {
    // Server source MUST be the full repo layout (with server/ sub-dir) so
    // scripts/rebrand.js can rewrite both the launcher AND server identity
    // strings consistently — it reads electron/main.js, server/electron/
    // main.js, and server/electron/db.js. A "standalone server" upload
    // wouldn't give rebrand.js the files it needs and would silently ship
    // an unbranded server, which is exactly the field bug we're trying to
    // avoid. Refuse it with a clear human-readable error.
    const subPkg = path.join(rootDir, 'server', 'package.json')
    const subMain = path.join(rootDir, 'server', 'electron', 'main.js')
    if (!(await exists(subPkg))) {
      throw new Error('server source missing server/package.json — upload the FULL repo zip (the one that contains both top-level package.json AND server/package.json), not a standalone server folder.')
    }
    if (!(await exists(subMain))) {
      throw new Error('server source has server/package.json but missing server/electron/main.js — is this a stripped-down zip?')
    }
    return rootDir
  }
  throw new Error('unknown source kind: ' + kind)
}

// Sync the customer logo into branding/ inside the extracted source so
// rebrand.js's logo conversion picks it up. Best-effort: returns false if
// no logo is registered for this customer (the rebrand step will then just
// do find/replace without an icon swap and that's a documented degraded
// mode, not a hard failure).
//
// `logoAbsPath` is resolved by the caller (server.js knows the project root
// against which customer.logo is relative); we accept the absolute path
// directly so source-build doesn't need to import server-side path config.
async function syncCustomerLogo(buildCwd, logoAbsPath) {
  if (!logoAbsPath) return false
  if (!fs.existsSync(logoAbsPath)) return false
  const brandingDir = path.join(buildCwd, 'branding')
  await fs.promises.mkdir(brandingDir, { recursive: true })
  // Use the original extension so rebrand.js (which sniffs by extension to
  // decide whether to re-encode via sharp) does the right thing.
  const ext = path.extname(logoAbsPath) || '.png'
  const destPath = path.join(brandingDir, 'logo' + ext)
  await fs.promises.copyFile(logoAbsPath, destPath)
  return true
}

// Pack a directory into a zip buffer using the platform-native zipper. We
// avoid pulling in archiver (and its pile of transitive deps) because we
// already have to invoke a native zip elsewhere in the OTA toolchain and
// keeping update-server's dep tree minimal lowers the security surface.
async function packDirToBuffer(srcDir, job, kind) {
  const tmpFile = path.join(os.tmpdir(), 'walok-payload-' + crypto.randomBytes(6).toString('hex') + '.zip')
  try {
    let cmd, args, shell
    if (IS_WIN) {
      // PowerShell Compress-Archive zips the CONTENTS of srcDir when the
      // path ends with \*. Force overwrite with -Force; -CompressionLevel
      // Optimal matches what the existing collect step does.
      cmd = 'powershell.exe'
      args = [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${srcDir.replace(/'/g, "''")}\\*' -DestinationPath '${tmpFile.replace(/'/g, "''")}' -Force -CompressionLevel Optimal`,
      ]
      shell = false
    } else {
      // POSIX `zip -r out.zip .` zips the contents of cwd. Run with cwd =
      // srcDir so the archive paths are relative (no srcDir prefix in zip).
      cmd = 'zip'
      args = ['-r', '-q', tmpFile, '.']
      shell = false
    }
    const exit = await runStep(job, cmd, args, {
      cwd: IS_WIN ? srcDir : srcDir,
      shell,
      minimalEnv: true,
    })
    if (exit !== 0) throw new Error('payload pack (' + kind + ') failed with exit ' + exit)
    const buf = await fs.promises.readFile(tmpFile)
    return buf
  } finally {
    // Always remove the temp zip (the buffer is already in memory by now).
    try { await fs.promises.unlink(tmpFile) } catch (_) {}
  }
}

// Find win-unpacked/ inside a build-output directory. electron-builder writes
// it directly under directories.output by default. We also accept the
// existing build-customer.js layout where it might be one level deeper.
function findWinUnpacked(searchRoot) {
  const direct = path.join(searchRoot, 'win-unpacked')
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct
  if (!fs.existsSync(searchRoot)) return null
  for (const name of fs.readdirSync(searchRoot)) {
    const p = path.join(searchRoot, name)
    try {
      if (!fs.statSync(p).isDirectory()) continue
    } catch (_) { continue }
    const nested = path.join(p, 'win-unpacked')
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) return nested
  }
  return null
}

// MAIN ENTRY. Build one (kind, channel) pair from one uploaded source zip.
// Caller (server.js) wraps this with writePayloadAndManifest for publish.
//
// `mode` controls whether the upload is a full repo or a tiny patch on top
// of the cached baseline:
//   - 'full' (default): sourceZipBuffer is the whole repo. After successful
//     extract+validate, the source is snapshotted into the shared baseline
//     cache so subsequent patch builds can use it. setBaselineMeta is called
//     with (kind, timestamp) once the snapshot lands.
//   - 'patch': sourceZipBuffer is just the contents of src/ (kind=launcher)
//     or server/ (kind=server). The baseline cache is restored into workDir
//     first, then the uploaded patch overlays the target subdir. No baseline
//     refresh happens — patch builds NEVER mutate the cached baseline.
async function buildOneFromSource({
  job,
  channel,           // string, e.g. 'cafe-x'
  kind,              // 'launcher' | 'server'
  sourceZipBuffer,   // Buffer
  version,           // '1.2.3'
  customer,          // dbApi.getCustomer(channel) — may be null for very-first ship
  customerLogoAbsPath, // absolute path to the customer's logo file (or null/undefined)
  workspaceRoot,     // <update-server>/.build-jobs/<jobId>/  (caller pre-creates)
  mode,              // 'full' | 'patch' (default 'full')
  setBaselineMeta,   // optional fn(kind, ts) called when full-mode baseline refresh succeeds
}) {
  const buildMode = mode === 'patch' ? 'patch' : 'full'

  let workDir
  if (buildMode === 'patch') {
    // ---- sb-patch-overlay (replaces extract) -----------------------------
    jobEmitPhase(job, 'sb-patch-overlay')
    workDir = await preparePatchWorkDir({
      workspaceRoot, kind, patchZipBuffer: sourceZipBuffer, job,
    })
  } else {
    // Per-kind workspace dir so launcher and server source trees never collide
    // when both are uploaded for the same job.
    workDir = path.join(workspaceRoot, kind + '-src')
    await fs.promises.mkdir(workDir, { recursive: true })

    // ---- sb-extract ----------------------------------------------------
    jobEmitPhase(job, 'sb-extract')
    jobAppend(job, '== Extracting ' + kind + ' source archive (' + sourceZipBuffer.length + ' bytes)…')
    if (!looksLikeZip(sourceZipBuffer)) {
      throw new Error(kind + ' upload is not a zip file (missing PK header)')
    }
    const extractStats = await extractZipBuffer(sourceZipBuffer, workDir)
    jobAppend(job, '   extracted ' + extractStats.entryCount + ' entries (' + extractStats.totalUncompressed + ' bytes uncompressed)')
    await maybeStripCommonRoot(workDir)
  }

  // ---- sb-validate -------------------------------------------------------
  jobEmitPhase(job, 'sb-validate')
  const buildCwd = await validateSourceShape(workDir, kind)
  jobAppend(job, '   build cwd: ' + buildCwd)

  // ---- sb-baseline-snapshot (full mode only, AFTER successful validate) --
  // Only refresh the baseline once the uploaded source is known to be
  // shape-correct. We don't wait for a successful electron-builder run on
  // purpose — a buildable source that fails to install deps is still a
  // valid baseline (next patch build can re-try install with the new
  // package-lock from THIS upload). Refusing to snapshot until after
  // electron-builder would also mean a baseline never gets refreshed when
  // an operator uploads to fix a build script bug.
  if (buildMode === 'full' && typeof setBaselineMeta === 'function') {
    try {
      jobAppend(job, '== Refreshing ' + kind + ' baseline cache…')
      await snapshotBaseline(buildCwd, kind, setBaselineMeta)
      jobAppend(job, '   baseline refreshed at ' + path.join(BASELINE_DIR, kind))
    } catch (e) {
      // Non-fatal: a baseline-snapshot failure shouldn't kill an otherwise
      // good build. Future patch uploads will fail with a clear "no
      // baseline" error and the operator can re-do a full upload.
      jobAppend(job, '[warn] baseline snapshot failed (' + e.message + ') — patch builds will be unavailable until next full upload succeeds')
    }
  }

  // ---- sb-install-* ------------------------------------------------------
  jobEmitPhase(job, kind === 'launcher' ? 'sb-install-launcher' : 'sb-install-server')
  const hasLock = fs.existsSync(path.join(buildCwd, 'package-lock.json'))
  const installArgs = hasLock
    ? ['ci', '--no-audit', '--no-fund', '--prefer-offline']
    : ['install', '--no-audit', '--no-fund', '--no-package-lock']
  jobAppend(job, '== Installing deps (' + (hasLock ? 'npm ci' : 'npm install (no lockfile)') + ')…')
  let exit = await runStep(job, NPM_CMD, installArgs, {
    cwd: buildCwd,
    shell: IS_WIN,    // npm.cmd needs shell on Windows
    minimalEnv: true,
  })
  if (exit !== 0) throw new Error('npm install failed with exit ' + exit)

  // ---- sb-rebrand-* ------------------------------------------------------
  jobEmitPhase(job, kind === 'launcher' ? 'sb-rebrand-launcher' : 'sb-rebrand-server')
  const rebrandScript = path.join(buildCwd, 'scripts', 'rebrand.js')
  if (customer && customer.brandName) {
    if (!fs.existsSync(rebrandScript)) {
      jobAppend(job, '[warn] scripts/rebrand.js not found in source — skipping rebrand. Build will use whatever brand is hard-coded in the uploaded source.')
    } else {
      const haveLogo = await syncCustomerLogo(buildCwd, customerLogoAbsPath)
      if (!haveLogo) {
        jobAppend(job, '[warn] no logo on file for customer "' + customer.channel + '" — rebrand will run text-only (icon stays whatever the source had).')
      }
      jobAppend(job, '== Rebranding for "' + customer.brandName + '"…')
      exit = await runStep(job, NODE_CMD, [rebrandScript, customer.brandName, customer.subtitle || ''], {
        cwd: buildCwd,
        shell: false,
        minimalEnv: true,
      })
      if (exit !== 0) throw new Error('rebrand failed with exit ' + exit)
    }
  } else {
    jobAppend(job, '[warn] no customer brand info for channel "' + channel + '" — skipping rebrand step.')
  }

  // ---- sb-build-* --------------------------------------------------------
  // Per-job dist output dir INSIDE workspaceRoot so payload pack knows where
  // to look without any guesswork against the source's default dist-electron/.
  const outDir = path.join(workspaceRoot, kind + '-out')
  await fs.promises.mkdir(outDir, { recursive: true })

  jobEmitPhase(job, kind === 'launcher' ? 'sb-build-launcher' : 'sb-build-server')
  if (kind === 'launcher') {
    // 1) vite (or whatever the launcher's `build` script is). Required so
    // electron-builder bundles the production renderer assets, not dev.
    const pkgJson = JSON.parse(fs.readFileSync(path.join(buildCwd, 'package.json'), 'utf-8'))
    if (pkgJson.scripts && pkgJson.scripts.build) {
      jobAppend(job, '== npm run build (launcher renderer)…')
      exit = await runStep(job, NPM_CMD, ['run', 'build'], { cwd: buildCwd, shell: IS_WIN, minimalEnv: true })
      if (exit !== 0) throw new Error('npm run build (launcher) failed with exit ' + exit)
    } else {
      jobAppend(job, '[warn] no "build" script in package.json — skipping renderer bundle step.')
    }
    jobAppend(job, '== electron-builder (launcher) -> ' + outDir)
    exit = await runStep(job, NPX_CMD, ['electron-builder', '-c.directories.output=' + outDir], {
      cwd: buildCwd,
      shell: IS_WIN,
      minimalEnv: true,
      env: { BUILD_VERSION: version, BUILD_OUTPUT_DIR: outDir },
    })
    if (exit !== 0) throw new Error('electron-builder (launcher) failed with exit ' + exit)
  } else {
    // server build. Prefer `npm run dist:server` if defined (matches existing
    // build-customer.js convention); otherwise fall back to running
    // electron-builder against server/package.json.
    const pkgJson = JSON.parse(fs.readFileSync(path.join(buildCwd, 'package.json'), 'utf-8'))
    if (pkgJson.scripts && pkgJson.scripts['dist:server']) {
      jobAppend(job, '== npm run dist:server -> ' + outDir)
      exit = await runStep(job, NPM_CMD, ['run', 'dist:server', '--', '-c.directories.output=' + outDir], {
        cwd: buildCwd,
        shell: IS_WIN,
        minimalEnv: true,
        env: { BUILD_VERSION: version, BUILD_SERVER_OUTPUT_DIR: outDir },
      })
      if (exit !== 0) throw new Error('npm run dist:server failed with exit ' + exit)
    } else {
      // Standalone server repo — electron-builder against the root.
      jobAppend(job, '== electron-builder (server, standalone layout) -> ' + outDir)
      exit = await runStep(job, NPX_CMD, ['electron-builder', '-c.directories.output=' + outDir], {
        cwd: buildCwd,
        shell: IS_WIN,
        minimalEnv: true,
        env: { BUILD_VERSION: version, BUILD_SERVER_OUTPUT_DIR: outDir },
      })
      if (exit !== 0) throw new Error('electron-builder (server) failed with exit ' + exit)
    }
  }

  // ---- sb-pack-* ---------------------------------------------------------
  jobEmitPhase(job, kind === 'launcher' ? 'sb-pack-launcher' : 'sb-pack-server')
  const winUnpacked = findWinUnpacked(outDir)
  if (!winUnpacked) {
    throw new Error('build succeeded but win-unpacked/ was not found under ' + outDir +
      ' — electron-builder may have produced a different layout. Check the build log above.')
  }
  jobAppend(job, '== Packing payload from ' + winUnpacked)
  const payloadBuffer = await packDirToBuffer(winUnpacked, job, kind)
  jobAppend(job, '   payload bytes: ' + payloadBuffer.length)

  return { payloadBuffer }
}

module.exports = {
  buildOneFromSource,
  // Patch upload helpers — server.js uses these for the baseline status
  // endpoint and to validate patch uploads before enqueueing.
  getBaselineStatus,
  BASELINE_DIR,
  // Exported for the unit-style fixture test.
  _internal: { extractZipBuffer, safeJoinUnderDest, looksLikeZip, maybeStripCommonRoot, validateSourceShape, findWinUnpacked, MAX_ENTRY_SIZE, MAX_TOTAL_SIZE, copyTreeForBaseline, snapshotBaseline, preparePatchWorkDir },
}
