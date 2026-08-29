const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')

const launcher = require('../electron/updater')
const server = require('../server/electron/updater')
const { migrateServerData, scanPersistedState } = require('../server/electron/data-migration')

function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const content = Buffer.from(file.content)
    const method = file.deflate ? 8 : 0
    const compressed = file.deflate ? zlib.deflateRawSync(content) : content
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const centralData = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralData.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralData, eocd])
}

function integrityFor(bytes) {
  return JSON.stringify({
    v: 1,
    alg: 'sha256-hmac',
    hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    sig: 'ab'.repeat(32),
  })
}

function assertUpdater(label, updater) {
  const oldBytes = Buffer.from(label + ' old executable')
  const zip = makeZip([
    { name: 'Old Brand.exe', content: oldBytes },
    { name: 'resources/integrity.dat', content: integrityFor(oldBytes), deflate: true },
  ])
  assert.strictEqual(updater.verifyStagedPayloadIntegrity(zip, 'Old Brand.exe').ok, true,
    label + ' verifier must support stored EXEs and deflated integrity manifests')
  assert.throws(() => updater.verifyStagedPayloadIntegrity(zip, 'New Brand.exe'), /missing exact ZIP entry/)
  const publisherZip = makeZip([
    { name: './Old Brand.exe', content: oldBytes, deflate: true },
    { name: './resources/integrity.dat', content: integrityFor(oldBytes) },
  ])
  assert.strictEqual(updater.verifyStagedPayloadIntegrity(publisherZip, 'Old Brand.exe').ok, true,
    label + ' must canonicalize publisher-style ./ entries')
  const stateAttack = makeZip([
    { name: './Old Brand.exe', content: oldBytes },
    { name: './resources/integrity.dat', content: integrityFor(oldBytes) },
    { name: './brand-data/state.db', content: 'do not install' },
  ])
  assert.throws(() => updater.verifyStagedPayloadIntegrity(stateAttack, 'Old Brand.exe'), /persisted state/,
    label + ' must detect state paths after ./ canonicalization')
  for (const unsafeStatePath of [
    './brand-data./state.db',
    './brand-assets /image.png',
    './brand-settings.json.',
    './brand-config.json ',
  ]) {
    const win32AliasAttack = makeZip([
      { name: './Old Brand.exe', content: oldBytes },
      { name: './resources/integrity.dat', content: integrityFor(oldBytes) },
      { name: unsafeStatePath, content: 'must not install' },
    ])
    assert.throws(
      () => updater.verifyStagedPayloadIntegrity(win32AliasAttack, 'Old Brand.exe'),
      /unsafe Win32 ZIP entry/,
      label + ' must reject Win32-normalized persisted-state alias ' + unsafeStatePath,
    )
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walok-ota-stage-'))
  const pending = path.join(root, '.ota-pending')
  fs.mkdirSync(pending)
  fs.writeFileSync(path.join(pending, 'payload.zip'), zip)
  fs.writeFileSync(path.join(pending, 'manifest.json'), JSON.stringify({ exeName: 'New Brand.exe', version: '9.9.9' }))
  let spawned = false
  const result = updater.stageOutOfProcessApply(root, pending, {
    _spawnFn: () => { spawned = true },
    _tmpDir: root,
  })
  assert.strictEqual(result.kind, 'error', label + ' must reject mismatched staging')
  assert.strictEqual(result.diagnostics.stage, 'integrity')
  assert.strictEqual(spawned, false)
  assert.strictEqual(fs.existsSync(path.join(pending, '.apply.lock')), false, 'failed stage must release lock')
  assert.strictEqual(fs.existsSync(path.join(pending, 'cleanup-marker.json')), false, 'integrity gate must precede overlays')
  fs.rmSync(root, { recursive: true, force: true })

  const goodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'walok-ota-good-stage-'))
  const goodPending = path.join(goodRoot, '.ota-pending')
  fs.mkdirSync(goodPending)
  fs.writeFileSync(path.join(goodPending, 'payload.zip'), publisherZip)
  fs.writeFileSync(path.join(goodPending, 'manifest.json'), JSON.stringify({ exeName: 'Old Brand.exe', version: '9.9.9' }))
  const staged = updater.stageOutOfProcessApply(goodRoot, goodPending, {
    _spawnFn: () => ({ unref() {} }),
    _tmpDir: goodRoot,
  })
  assert.strictEqual(staged.kind, 'spawned', label + ' must stage canonical publisher ZIP')
  assert.match(fs.readFileSync(path.join(goodPending, 'startup-ack-token.txt'), 'utf8'), /^[0-9a-f]{64}$/,
    label + ' must generate a cryptographically random startup token')
  fs.rmSync(goodRoot, { recursive: true, force: true })

  const bat = updater.buildPhase2ApplierBat()
  for (const token of ['app-backup', ':restore_failed', 'Get-FileHash', 'integrity.dat',
    'goto restore_failed', 'startup-ack-token.txt', 'WALOK_OTA_ACK_FILE',
    ':wait_for_startup_ack', 'taskkill /F /IM']) {
    assert.ok(bat.includes(token), label + ' BAT missing safety gate: ' + token)
  }
  assert.ok(!bat.includes('for %%F in (*)'), label + ' BAT file loop must exclude directories')
  assert.ok(bat.includes('/A-D'), label + ' BAT must enumerate files only')
  assert.ok(bat.indexOf('Get-FileHash') < bat.indexOf('launching %INSTALL_DIR%'), label + ' must hash before launch')
  assert.ok(bat.indexOf(':wait_for_startup_ack') < bat.indexOf('echo done > "%PENDING_DIR%\\SUCCESS"'),
    label + ' must mark success only after startup acknowledgement')

  const ackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'walok-ota-ack-'))
  const ackFile = path.join(ackRoot, 'ack.txt')
  const token = crypto.randomBytes(32).toString('hex')
  const env = { WALOK_OTA_ACK_FILE: ackFile, WALOK_OTA_ACK_TOKEN: token }
  assert.strictEqual(updater.acknowledgeSuccessfulStartup(env), true)
  assert.strictEqual(fs.readFileSync(ackFile, 'utf8'), token)
  assert.strictEqual(env.WALOK_OTA_ACK_FILE, undefined)
  assert.strictEqual(env.WALOK_OTA_ACK_TOKEN, undefined)
  const invalidEnv = { WALOK_OTA_ACK_FILE: path.join(ackRoot, 'bad.txt'), WALOK_OTA_ACK_TOKEN: 'wrong' }
  assert.strictEqual(updater.acknowledgeSuccessfulStartup(invalidEnv), false)
  assert.strictEqual(invalidEnv.WALOK_OTA_ACK_FILE, undefined)
  assert.strictEqual(fs.existsSync(path.join(ackRoot, 'bad.txt')), false)
  fs.rmSync(ackRoot, { recursive: true, force: true })
}

function validDb(size) {
  const out = Buffer.alloc(Math.max(size, 16), 1)
  Buffer.from('SQLite format 3\0').copy(out)
  return out
}

function validZip(size) {
  const out = Buffer.alloc(Math.max(size, 4), 2)
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(out)
  return out
}

function writeState(dir, dbSize, zipSizes) {
  fs.mkdirSync(path.join(dir, 'saves'), { recursive: true })
  if (dbSize) fs.writeFileSync(path.join(dir, 'state.db'), validDb(dbSize))
  for (let i = 0; i < zipSizes.length; i++) {
    fs.writeFileSync(path.join(dir, 'saves', 'save-' + i + '.zip'), validZip(zipSizes[i]))
  }
}

function assertRicherDataMigration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walok-data-migration-'))
  const current = path.join(root, 'current-server-data')
  const emptyLegacy = path.join(root, 'empty-server-data')
  const richLegacy = path.join(root, 'rich-server-data')
  fs.mkdirSync(emptyLegacy)
  fs.writeFileSync(path.join(emptyLegacy, 'corrupt.db'), Buffer.alloc(9000))
  fs.writeFileSync(path.join(emptyLegacy, 'corrupt.zip'), Buffer.alloc(9000))
  writeState(richLegacy, 8192, [16384])

  const result = migrateServerData({
    appRoot: root,
    currentSlug: 'current',
    legacySlugs: ['empty', 'rich'],
    now: 123,
  })
  assert.strictEqual(result.adopted, richLegacy, 'must scan past the first corrupt legacy')
  const state = scanPersistedState(current)
  assert.strictEqual(state.databaseBytes, 8192)
  assert.strictEqual(state.archiveCount, 1)
  assert.strictEqual(state.archiveBytes, 16384)
  assert.ok(fs.existsSync(emptyLegacy), 'nonselected corrupt legacy must remain untouched')
  assert.strictEqual(result.backup, null)
  fs.rmSync(root, { recursive: true, force: true })

  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'walok-data-current-rich-'))
  const current2 = path.join(root2, 'current-server-data')
  const legacyA = path.join(root2, 'a-server-data')
  const legacyB = path.join(root2, 'b-server-data')
  writeState(current2, 32768, [32768, 32768])
  writeState(legacyA, 4096, [1024])
  writeState(legacyB, 8192, [])
  const result2 = migrateServerData({
    appRoot: root2,
    currentSlug: 'current',
    legacySlugs: ['a', 'b'],
    now: 456,
  })
  assert.strictEqual(result2.adopted, null)
  assert.ok(fs.existsSync(legacyA), 'weaker legacy A must not be renamed')
  assert.ok(fs.existsSync(legacyB), 'weaker legacy B must not be renamed')
  assert.strictEqual(scanPersistedState(current2).archiveCount, 2)
  fs.rmSync(root2, { recursive: true, force: true })

  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'walok-data-replace-small-'))
  const current3 = path.join(root3, 'current-server-data')
  const legacy3 = path.join(root3, 'legacy-server-data')
  writeState(current3, 1024, [])
  writeState(legacy3, 8192, [8192])
  const result3 = migrateServerData({
    appRoot: root3,
    currentSlug: 'current',
    legacySlugs: ['legacy'],
    now: 789,
  })
  assert.strictEqual(result3.adopted, legacy3)
  assert.ok(fs.existsSync(path.join(root3, 'current-server-data.bak.789', 'state.db')),
    'existing weaker current tree must be backed up')
  fs.rmSync(root3, { recursive: true, force: true })
}

assertUpdater('launcher', launcher)
assertUpdater('server', server)
assertRicherDataMigration()
console.log('OTA staged-integrity, rollback BAT, and data-migration safety tests passed.')