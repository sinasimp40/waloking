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

// Per-entry size cap. A legitimate launcher source zip is well under this; a
// zip bomb that decompresses to multiple GB is refused before we touch the
// disk. 200 MB is generous (electron prebuilt binaries can be ~100MB).
const MAX_ENTRY_SIZE = 200 * 1024 * 1024

// Total uncompressed size cap — second line of defence so a zip with many
// "small" entries summing to multiple GB still gets refused. 800 MB.
const MAX_TOTAL_SIZE = 800 * 1024 * 1024

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
async function buildOneFromSource({
  job,
  channel,           // string, e.g. 'cafe-x'
  kind,              // 'launcher' | 'server'
  sourceZipBuffer,   // Buffer
  version,           // '1.2.3'
  customer,          // dbApi.getCustomer(channel) — may be null for very-first ship
  customerLogoAbsPath, // absolute path to the customer's logo file (or null/undefined)
  workspaceRoot,     // <update-server>/.build-jobs/<jobId>/  (caller pre-creates)
}) {
  // Per-kind workspace dir so launcher and server source trees never collide
  // when both are uploaded for the same job.
  const workDir = path.join(workspaceRoot, kind + '-src')
  await fs.promises.mkdir(workDir, { recursive: true })

  // ---- sb-extract --------------------------------------------------------
  jobEmitPhase(job, 'sb-extract')
  jobAppend(job, '== Extracting ' + kind + ' source archive (' + sourceZipBuffer.length + ' bytes)…')
  if (!looksLikeZip(sourceZipBuffer)) {
    throw new Error(kind + ' upload is not a zip file (missing PK header)')
  }
  const extractStats = await extractZipBuffer(sourceZipBuffer, workDir)
  jobAppend(job, '   extracted ' + extractStats.entryCount + ' entries (' + extractStats.totalUncompressed + ' bytes uncompressed)')
  await maybeStripCommonRoot(workDir)

  // ---- sb-validate -------------------------------------------------------
  jobEmitPhase(job, 'sb-validate')
  const buildCwd = await validateSourceShape(workDir, kind)
  jobAppend(job, '   build cwd: ' + buildCwd)

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
  // Exported for the unit-style fixture test.
  _internal: { extractZipBuffer, safeJoinUnderDest, looksLikeZip, maybeStripCommonRoot, validateSourceShape, findWinUnpacked, MAX_ENTRY_SIZE, MAX_TOTAL_SIZE },
}
