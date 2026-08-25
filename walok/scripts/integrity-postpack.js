const fs = require('fs')
const path = require('path')
const { readEmbeddedSecret, writeManifest } = require('./integrity-artifact')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'win32') {
    console.log('[integrity] Skipping (non-Windows platform: ' + context.electronPlatformName + ')')
    return
  }

  const appOutDir = context.appOutDir
  const productFilename = context.packager.appInfo.productFilename
  const exeName = productFilename + '.exe'
  const exePath = path.join(appOutDir, exeName)
  const resourcesDir = path.join(appOutDir, 'resources')
  const asarPath = path.join(resourcesDir, 'app.asar')

  console.log('\n[integrity] Generating integrity manifest for ' + exeName)

  if (!fs.existsSync(exePath)) {
    throw new Error('[integrity] FATAL: EXE not found at ' + exePath + ' — aborting build to avoid shipping unprotected installer')
  }
  if (!fs.existsSync(asarPath)) {
    throw new Error('[integrity] FATAL: app.asar not found at ' + asarPath + ' — aborting build to avoid shipping unprotected installer')
  }

  const secret = process.env.INTEGRITY_BUILD_SECRET
  if (!secret || typeof secret !== 'string' || secret.length < 32) {
    throw new Error('[integrity] FATAL: INTEGRITY_BUILD_SECRET not set in env — beforePack hook must run first to inject the secret into app.asar. Aborting build.')
  }

  // Confirm that the secret used here is exactly the one that runtime code
  // will read from app.asar. The finalizer repeats this after every build
  // path completes, after any code-signing mutation of the executable.
  let packed
  try {
    packed = readEmbeddedSecret(asarPath)
  } catch (error) {
    throw new Error('[integrity] FATAL: ' + error.message + '. Aborting.')
  }
  if (packed !== secret) {
    throw new Error('[integrity] FATAL: secret in app.asar does not match INTEGRITY_BUILD_SECRET env var — secret was rotated mid-build. Aborting.')
  }

  const manifestPath = path.join(resourcesDir, 'integrity.dat')
  const manifest = writeManifest(exePath, manifestPath, secret)

  console.log('[integrity] Manifest written to resources/integrity.dat')
  console.log('[integrity] EXE hash: ' + manifest.hash.slice(0, 16) + '...' + manifest.hash.slice(-8))

  // Best-effort cleanup of source-tree secret file. It was packed into
  // app.asar already, so removing the source copy keeps the working tree
  // clean (and prevents accidentally committing it).
  const appDir = (context.packager && context.packager.info && context.packager.info.appDir) || process.cwd()
  const sourceSecret = path.join(appDir, 'electron', '_integrity_secret.json')
  try {
    if (fs.existsSync(sourceSecret)) {
      fs.unlinkSync(sourceSecret)
      console.log('[integrity] Cleaned up source secret file: ' + path.relative(process.cwd(), sourceSecret))
    }
  } catch (e) {}
}
