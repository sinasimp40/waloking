const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

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

  // Sanity check: confirm the secret is actually inside app.asar (read-only).
  // This guarantees the secret we'll HMAC with matches what the runtime check reads.
  let asar
  try {
    asar = require('@electron/asar')
  } catch (e) {
    try { asar = require('asar') } catch (e2) { asar = null }
  }
  if (asar) {
    let packed = null
    try {
      const buf = asar.extractFile(asarPath, 'electron/_integrity_secret.json')
      packed = JSON.parse(buf.toString('utf-8')).k
    } catch (e) {
      throw new Error('[integrity] FATAL: app.asar does not contain electron/_integrity_secret.json — beforePack hook did not run or did not write the secret to source. Aborting.')
    }
    if (packed !== secret) {
      throw new Error('[integrity] FATAL: secret in app.asar does not match INTEGRITY_BUILD_SECRET env var — secret was rotated mid-build. Aborting.')
    }
  } else {
    console.log('[integrity] WARN: asar package not available, cannot sanity-check secret embedding')
  }

  const exeBuf = fs.readFileSync(exePath)
  const hash = crypto.createHash('sha256').update(exeBuf).digest('hex')
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(hash).digest('hex')

  const manifest = { v: 1, alg: 'sha256-hmac', hash: hash, sig: sig }
  const manifestPath = path.join(resourcesDir, 'integrity.dat')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  console.log('[integrity] Manifest written to resources/integrity.dat')
  console.log('[integrity] EXE hash: ' + hash.slice(0, 16) + '...' + hash.slice(-8))

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
