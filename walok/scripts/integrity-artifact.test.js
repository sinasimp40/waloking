const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const asar = require('@electron/asar')
const { finalizeIntegrityArtifact, verifyIntegrityArtifact } = require('./integrity-artifact')
const postpackHook = require('./integrity-postpack').default

async function makeArtifact(label, exeName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walok-integrity-' + label.toLowerCase() + '-'))
  const sourceDir = path.join(root, 'source')
  const unpackedDir = path.join(root, 'win-unpacked')
  const resourcesDir = path.join(unpackedDir, 'resources')
  const secret = '0123456789abcdef'.repeat(4)

  fs.mkdirSync(path.join(sourceDir, 'electron'), { recursive: true })
  fs.mkdirSync(resourcesDir, { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'electron', '_integrity_secret.json'), JSON.stringify({ k: secret }))
  await asar.createPackage(sourceDir, path.join(resourcesDir, 'app.asar'))

  const exePath = path.join(unpackedDir, exeName)
  fs.writeFileSync(exePath, Buffer.from(label + ' executable bytes before finalization'))
  return { root, sourceDir, unpackedDir, exePath, secret }
}

async function assertRole(label, exeName) {
  const fixture = await makeArtifact(label, exeName)
  try {
    const finalized = finalizeIntegrityArtifact(fixture.unpackedDir)
    assert.strictEqual(finalized.ok, true, label + ' should finalize a valid final artifact')
    assert.strictEqual(finalized.exeName, exeName)

    const clean = verifyIntegrityArtifact(fixture.unpackedDir)
    assert.strictEqual(clean.ok, true, label + ' should verify after finalization')

    fs.appendFileSync(fixture.exePath, Buffer.from(' bytes changed after initial manifest'))
    const stale = verifyIntegrityArtifact(fixture.unpackedDir)
    assert.strictEqual(stale.ok, false, label + ' must detect executable mutation after hashing')
    assert.strictEqual(stale.reason, 'executable hash mismatch')

    const refinalized = finalizeIntegrityArtifact(fixture.unpackedDir)
    assert.strictEqual(refinalized.ok, true, label + ' should regenerate for final executable bytes')
    assert.strictEqual(verifyIntegrityArtifact(fixture.unpackedDir).ok, true, label + ' should verify after regeneration')

    const manifestPath = path.join(fixture.unpackedDir, 'resources', 'integrity.dat')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    manifest.sig = '00'.repeat(32)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    const invalidSignature = verifyIntegrityArtifact(fixture.unpackedDir)
    assert.strictEqual(invalidSignature.ok, false, label + ' must reject a forged integrity manifest')
    assert.strictEqual(invalidSignature.reason, 'integrity manifest signature is invalid')
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
}

async function assertPostpackLifecycle() {
  const fixture = await makeArtifact('Postpack', 'Example Postpack.exe')
  const originalSecret = process.env.INTEGRITY_BUILD_SECRET
  try {
    process.env.INTEGRITY_BUILD_SECRET = fixture.secret
    const context = {
      electronPlatformName: 'win32',
      appOutDir: fixture.unpackedDir,
      packager: {
        appInfo: { productFilename: 'Example Postpack' },
        info: { appDir: fixture.sourceDir },
      },
    }

    await postpackHook(context)
    assert.strictEqual(verifyIntegrityArtifact(fixture.unpackedDir).ok, true,
      'afterPack hook should write a valid manifest without throwing')

    fs.appendFileSync(fixture.exePath, Buffer.from(' signed executable mutation'))
    assert.strictEqual(verifyIntegrityArtifact(fixture.unpackedDir).ok, false,
      'a post-sign executable mutation should invalidate the afterPack manifest')

    await postpackHook(context)
    assert.strictEqual(verifyIntegrityArtifact(fixture.unpackedDir).ok, true,
      'afterSign hook should regenerate a valid manifest for final executable bytes')
  } finally {
    if (originalSecret === undefined) delete process.env.INTEGRITY_BUILD_SECRET
    else process.env.INTEGRITY_BUILD_SECRET = originalSecret
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
}

async function main() {
  await assertRole('Launcher', 'Example Launcher.exe')
  await assertRole('Server', 'Example Launcher Server.exe')
  await assertPostpackLifecycle()
  console.log('Integrity artifact finalization tests passed for launcher and server.')
}

main().catch(error => {
  console.error('Integrity artifact finalization test failed:', error.stack || error.message)
  process.exit(1)
})