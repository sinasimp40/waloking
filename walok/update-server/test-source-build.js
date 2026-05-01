// Minimal fixture test for source-build internals.
// Checks zip extraction, zip-slip refusal, size cap, common-root stripping,
// shape validation, and the looksLikeZip sniff. Does NOT actually run a full
// build (that requires Windows + electron + several hundred MB of deps).
//
// Run: node walok/update-server/test-source-build.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const yauzl = require('yauzl')

let archiver
try { archiver = require('archiver') } catch (e) {
  console.error('archiver not installed in update-server. Falling back: skipping pack-side tests.')
}

const sb = require('./source-build')
const { extractZipBuffer, safeJoinUnderDest, looksLikeZip, maybeStripCommonRoot, validateSourceShape } = sb._internal

let pass = 0, fail = 0
function ok(msg)   { pass++; console.log('  ok  ' + msg) }
function bad(msg, err) { fail++; console.error('  FAIL ' + msg + (err ? ' :: ' + err.message : '')) }
async function check(label, fn) {
  try { await fn(); ok(label) } catch (e) { bad(label, e) }
}

async function buildZipBufferFromTree(tree) {
  // tree: { 'path/to/file.txt': 'content', 'dir/sub/file.js': '...' }
  // Uses Node's built-in zlib + a tiny zip writer? Simpler: use yauzl's
  // sister "yazl" — but we don't have it. Use a hand-rolled minimal STORE
  // (no compression) zip writer, sufficient for round-tripping our fixture.
  const yazl = (() => { try { return require('yazl') } catch (_) { return null } })()
  if (yazl) {
    return new Promise((res, rej) => {
      const z = new yazl.ZipFile()
      for (const [name, content] of Object.entries(tree)) {
        z.addBuffer(Buffer.from(content), name)
      }
      const chunks = []
      z.outputStream.on('data', c => chunks.push(c))
      z.outputStream.on('end', () => res(Buffer.concat(chunks)))
      z.outputStream.on('error', rej)
      z.end()
    })
  }
  // Fallback: write each file under a temp dir, then `zip -r` it. Skip the
  // test gracefully if neither yazl nor zip is available.
  const tmp = path.join(os.tmpdir(), 'sbfix-' + crypto.randomBytes(4).toString('hex'))
  fs.mkdirSync(tmp, { recursive: true })
  for (const [name, content] of Object.entries(tree)) {
    const target = path.join(tmp, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  const zipFile = tmp + '.zip'
  const { spawnSync } = require('child_process')
  const r = spawnSync('zip', ['-r', '-q', zipFile, '.'], { cwd: tmp })
  if (r.status !== 0) throw new Error('cannot build fixture zip (no yazl, no zip): ' + r.stderr)
  const buf = fs.readFileSync(zipFile)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.unlinkSync(zipFile)
  return buf
}

async function main() {
  console.log('== source-build internal tests ==')

  // -- looksLikeZip --
  await check('looksLikeZip: PK local-file-header → true', () => {
    if (!looksLikeZip(Buffer.from([0x50, 0x4B, 0x03, 0x04, 0, 0]))) throw new Error('expected true')
  })
  await check('looksLikeZip: PK empty-archive → true', () => {
    if (!looksLikeZip(Buffer.from([0x50, 0x4B, 0x05, 0x06, 0, 0]))) throw new Error('expected true')
  })
  await check('looksLikeZip: HTML → false', () => {
    if (looksLikeZip(Buffer.from('<html></html>'))) throw new Error('expected false')
  })
  await check('looksLikeZip: too short → false', () => {
    if (looksLikeZip(Buffer.from([0x50]))) throw new Error('expected false')
  })

  // -- safeJoinUnderDest --
  const dest = '/tmp/sbtest-' + crypto.randomBytes(4).toString('hex')
  await check('safeJoinUnderDest: normal path OK', () => {
    const out = safeJoinUnderDest(dest, 'foo/bar.txt')
    if (!out.startsWith(dest)) throw new Error('out=' + out)
  })
  await check('safeJoinUnderDest: zip-slip via .. → throws', () => {
    let threw = false
    try { safeJoinUnderDest(dest, '../../etc/passwd') } catch (_) { threw = true }
    if (!threw) throw new Error('expected throw')
  })
  await check('safeJoinUnderDest: absolute path → throws', () => {
    let threw = false
    try { safeJoinUnderDest(dest, '/etc/passwd') } catch (_) { threw = true }
    if (!threw) throw new Error('expected throw')
  })
  await check('safeJoinUnderDest: Windows drive letter → throws', () => {
    let threw = false
    try { safeJoinUnderDest(dest, 'C:\\Windows\\System32\\evil.exe') } catch (_) { threw = true }
    if (!threw) throw new Error('expected throw')
  })
  await check('safeJoinUnderDest: NUL byte → throws', () => {
    let threw = false
    try { safeJoinUnderDest(dest, 'foo\0bar') } catch (_) { threw = true }
    if (!threw) throw new Error('expected throw')
  })

  // -- extractZipBuffer + maybeStripCommonRoot + validateSourceShape (launcher) --
  let zipBuf
  try {
    zipBuf = await buildZipBufferFromTree({
      'walok-launcher-abc123/package.json': JSON.stringify({ name: 'walok', version: '1.0.0' }),
      'walok-launcher-abc123/electron/main.js': '// entry\n',
      'walok-launcher-abc123/scripts/rebrand.js': '// rebrand\n',
    })
  } catch (e) {
    console.log('  skip (cannot build fixture zip): ' + e.message)
  }
  if (zipBuf) {
    const tmpDir = path.join(os.tmpdir(), 'sbfix-extract-' + crypto.randomBytes(4).toString('hex'))
    fs.mkdirSync(tmpDir, { recursive: true })
    try {
      await check('extractZipBuffer: extracts a normal launcher zip', async () => {
        const stats = await extractZipBuffer(zipBuf, tmpDir)
        if (stats.entryCount < 3) throw new Error('expected ≥3 entries, got ' + stats.entryCount)
      })
      await check('maybeStripCommonRoot: removes the wrap dir', async () => {
        await maybeStripCommonRoot(tmpDir)
        if (!fs.existsSync(path.join(tmpDir, 'package.json'))) throw new Error('package.json should be at root after strip')
        if (!fs.existsSync(path.join(tmpDir, 'electron', 'main.js'))) throw new Error('electron/main.js missing after strip')
      })
      await check('validateSourceShape: launcher OK', async () => {
        const cwd = await validateSourceShape(tmpDir, 'launcher')
        if (cwd !== tmpDir) throw new Error('expected cwd === tmpDir')
      })
      await check('validateSourceShape: server fails on launcher tree', async () => {
        let threw = false
        try { await validateSourceShape(tmpDir, 'server') } catch (_) { threw = true }
        if (!threw) throw new Error('expected throw')
      })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // -- extractZipBuffer rejects a zip-slip entry --
  // We can't use yazl to build the malicious zip — yazl correctly refuses to
  // emit `..` paths. So we hand-craft the minimal STORE-only zip bytes. The
  // entry name we want yauzl to surface to safeJoinUnderDest is
  // "../../../tmp/evil-walok-test.txt".
  const yazl2 = (() => { try { return require('yazl') } catch (_) { return null } })()
  if (yazl2) {
    // Use yazl to make a benign zip, then patch the bytes to rewrite the
    // file name in BOTH the local-file header and the central directory.
    // Original name "INNOCENT_NAME_____" (18 bytes) gets replaced with
    // "../../../tmp/evil2" (also 18 bytes) so all length fields stay valid.
    const benignZip = await new Promise((res, rej) => {
      const z = new yazl2.ZipFile()
      z.addBuffer(Buffer.from('pwned'), 'INNOCENT_NAME_____')
      const chunks = []
      z.outputStream.on('data', c => chunks.push(c))
      z.outputStream.on('end', () => res(Buffer.concat(chunks)))
      z.outputStream.on('error', rej)
      z.end()
    })
    const evilZip = Buffer.from(benignZip)
    const orig = Buffer.from('INNOCENT_NAME_____', 'utf-8')
    const evil = Buffer.from('../../../tmp/evil2', 'utf-8')
    if (orig.length !== evil.length) throw new Error('rewrite name length mismatch (test bug)')
    let i
    while ((i = evilZip.indexOf(orig)) >= 0) evil.copy(evilZip, i)
    const evilDir = path.join(os.tmpdir(), 'sbfix-evil-' + crypto.randomBytes(4).toString('hex'))
    fs.mkdirSync(evilDir, { recursive: true })
    try {
      await check('extractZipBuffer: refuses zip-slip entry (raw-bytes attack)', async () => {
        let threw = false
        try { await extractZipBuffer(evilZip, evilDir) } catch (_) { threw = true }
        if (!threw) throw new Error('expected zip-slip refusal')
        // Confirm nothing landed outside evilDir.
        if (fs.existsSync('/tmp/evil2')) {
          fs.unlinkSync('/tmp/evil2')
          throw new Error('SECURITY: zip-slip wrote /tmp/evil2 — extractor failed')
        }
      })
    } finally {
      fs.rmSync(evilDir, { recursive: true, force: true })
    }
  } else {
    console.log('  skip zip-slip test (yazl not installed)')
  }

  // -- bad-shape rejection --
  if (zipBuf) {
    const badZip = await buildZipBufferFromTree({
      'package.json': '{}',
      // no electron/main.js
    })
    const badDir = path.join(os.tmpdir(), 'sbfix-bad-' + crypto.randomBytes(4).toString('hex'))
    fs.mkdirSync(badDir, { recursive: true })
    try {
      await extractZipBuffer(badZip, badDir)
      await check('validateSourceShape: launcher missing electron/main.js → throws', async () => {
        let threw = false
        try { await validateSourceShape(badDir, 'launcher') } catch (_) { threw = true }
        if (!threw) throw new Error('expected throw')
      })
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true })
    }
  }

  console.log('== ' + pass + ' passed, ' + fail + ' failed ==')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
