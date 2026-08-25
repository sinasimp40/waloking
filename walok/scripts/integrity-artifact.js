const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SECRET_ENTRY = 'electron/_integrity_secret.json'
const MANIFEST_NAME = 'integrity.dat'

function tryRequireAsar() {
  try { return require('@electron/asar') } catch (_) {}
  try { return require('asar') } catch (_) {}
  return null
}

function normalizeSecret(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value) || value.length < 32 || value.length % 2 !== 0) {
    throw new Error('embedded integrity key is invalid')
  }
  const bytes = Buffer.from(value, 'hex')
  if (bytes.length < 16) throw new Error('embedded integrity key is too short')
  return value
}

function readEmbeddedSecret(asarPath) {
  if (!fs.existsSync(asarPath)) throw new Error('app.asar is missing at ' + asarPath)
  const asar = tryRequireAsar()
  if (!asar) throw new Error('neither @electron/asar nor asar is installed; cannot read the embedded integrity key')

  let raw
  try {
    raw = asar.extractFile(asarPath, SECRET_ENTRY)
  } catch (_) {
    throw new Error('app.asar does not contain ' + SECRET_ENTRY)
  }

  try {
    return normalizeSecret(JSON.parse(raw.toString('utf-8')).k)
  } catch (error) {
    throw new Error('embedded integrity key is unreadable: ' + error.message)
  }
}

function findExecutable(unpackedDir, expectedExeName) {
  if (!fs.existsSync(unpackedDir)) throw new Error('unpacked directory is missing at ' + unpackedDir)
  if (expectedExeName) {
    const expected = path.join(unpackedDir, expectedExeName)
    if (!fs.existsSync(expected)) throw new Error('expected executable is missing at ' + expected)
    return expected
  }

  const exeFiles = fs.readdirSync(unpackedDir)
    .filter(name => name.toLowerCase().endsWith('.exe'))
    .sort((a, b) => a.localeCompare(b))
  if (exeFiles.length !== 1) {
    throw new Error('expected exactly one top-level .exe in ' + unpackedDir + ', found ' + exeFiles.length)
  }
  return path.join(unpackedDir, exeFiles[0])
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function createManifest(exePath, secret) {
  const hash = hashFile(exePath)
  return {
    v: 1,
    alg: 'sha256-hmac',
    hash,
    sig: crypto.createHmac('sha256', Buffer.from(normalizeSecret(secret), 'hex')).update(hash).digest('hex'),
  }
}

function parseManifest(manifestPath) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch (error) {
    throw new Error('integrity manifest is unreadable: ' + error.message)
  }
  if (!manifest || manifest.v !== 1 || manifest.alg !== 'sha256-hmac' ||
      typeof manifest.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.hash) ||
      typeof manifest.sig !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.sig)) {
    throw new Error('integrity manifest is corrupt')
  }
  return manifest
}

function verifyManifest(exePath, manifestPath, secret) {
  if (!fs.existsSync(manifestPath)) return { ok: false, reason: 'integrity manifest is missing at ' + manifestPath }

  let manifest
  try {
    manifest = parseManifest(manifestPath)
  } catch (error) {
    return { ok: false, reason: error.message }
  }

  const expectedSig = crypto.createHmac('sha256', Buffer.from(normalizeSecret(secret), 'hex'))
    .update(manifest.hash)
    .digest('hex')
  const signatureMatches = crypto.timingSafeEqual(Buffer.from(expectedSig, 'hex'), Buffer.from(manifest.sig, 'hex'))
  if (!signatureMatches) return { ok: false, reason: 'integrity manifest signature is invalid' }

  const actualHash = hashFile(exePath)
  if (actualHash !== manifest.hash) return { ok: false, reason: 'executable hash mismatch' }

  return { ok: true, manifest, exePath }
}

function resolveArtifact(unpackedDir, expectedExeName) {
  const resourcesDir = path.join(unpackedDir, 'resources')
  const asarPath = path.join(resourcesDir, 'app.asar')
  return {
    exePath: findExecutable(unpackedDir, expectedExeName),
    manifestPath: path.join(resourcesDir, MANIFEST_NAME),
    secret: readEmbeddedSecret(asarPath),
  }
}

function writeManifest(exePath, manifestPath, secret) {
  const manifest = createManifest(exePath, secret)
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  const temporaryPath = manifestPath + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(temporaryPath, JSON.stringify(manifest))
  fs.renameSync(temporaryPath, manifestPath)
  return manifest
}

function finalizeIntegrityArtifact(unpackedDir, expectedExeName) {
  const artifact = resolveArtifact(unpackedDir, expectedExeName)
  const manifest = writeManifest(artifact.exePath, artifact.manifestPath, artifact.secret)
  const verification = verifyManifest(artifact.exePath, artifact.manifestPath, artifact.secret)
  if (!verification.ok) throw new Error('final integrity verification failed: ' + verification.reason)
  return { ...verification, manifestPath: artifact.manifestPath, exeName: path.basename(artifact.exePath) }
}

function verifyIntegrityArtifact(unpackedDir, expectedExeName) {
  try {
    const artifact = resolveArtifact(unpackedDir, expectedExeName)
    return {
      ...verifyManifest(artifact.exePath, artifact.manifestPath, artifact.secret),
      manifestPath: artifact.manifestPath,
      exeName: path.basename(artifact.exePath),
    }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

function runCli() {
  const [command, unpackedDir, expectedExeName] = process.argv.slice(2)
  if (!['--finalize', '--verify'].includes(command) || !unpackedDir) {
    throw new Error('Usage: node integrity-artifact.js --finalize|--verify <win-unpacked-dir> [exe-name]')
  }
  const result = command === '--finalize'
    ? finalizeIntegrityArtifact(unpackedDir, expectedExeName)
    : verifyIntegrityArtifact(unpackedDir, expectedExeName)
  if (!result.ok) throw new Error(result.reason)
  console.log('[integrity-artifact] ' + (command === '--finalize' ? 'Finalized' : 'Verified') +
    ' ' + result.exeName + ' (' + result.manifest.hash.slice(0, 16) + '...)')
}

module.exports = {
  createManifest,
  finalizeIntegrityArtifact,
  readEmbeddedSecret,
  verifyIntegrityArtifact,
  verifyManifest,
  writeManifest,
}

if (require.main === module) {
  try {
    runCli()
  } catch (error) {
    console.error('[integrity-artifact] FATAL: ' + error.message)
    process.exit(1)
  }
}