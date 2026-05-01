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
const { extractZipBuffer, safeJoinUnderDest, looksLikeZip, maybeStripCommonRoot, validateSourceShape, copyTreeForBaseline, snapshotBaseline, preparePatchWorkDir } = sb._internal
const BASELINE_DIR = sb.BASELINE_DIR

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

  // ============ PATCH-MODE TESTS ============
  // The patch flow is: snapshotBaseline(workDir, kind) → cache established
  // under BASELINE_DIR/<kind>/. Then preparePatchWorkDir extracts a tiny
  // patch zip into workDir/{src,server}/ on top of the baseline copy. We
  // exercise both the failure path (no baseline) and the happy path
  // (baseline + overlay → workDir contains baseline files PLUS patched
  // ones, with the overlaid subdir wiped clean of pre-patch contents).
  if (zipBuf) {
    // 1) preparePatchWorkDir without baseline → throws clear message.
    // We have to ensure no baseline exists for the test kind. If a real
    // baseline already lives at BASELINE_DIR/launcher (dev environment),
    // skip this assertion rather than wreck their state.
    const baselineLauncherDir = path.join(BASELINE_DIR, 'launcher')
    if (!fs.existsSync(baselineLauncherDir)) {
      const tmpWs = path.join(os.tmpdir(), 'sbpatch-' + crypto.randomBytes(4).toString('hex'))
      fs.mkdirSync(tmpWs, { recursive: true })
      try {
        const patchZip = await buildZipBufferFromTree({ 'App.jsx': 'export default ()=>null' })
        await check('preparePatchWorkDir: no baseline cached → throws guidance error', async () => {
          let err
          try { await preparePatchWorkDir({ workspaceRoot: tmpWs, kind: 'launcher', patchZipBuffer: patchZip, job: { output: [], listeners: [] } }) }
          catch (e) { err = e }
          if (!err) throw new Error('expected throw')
          if (!/no baseline cached/i.test(err.message)) throw new Error('error message should mention "no baseline cached", got: ' + err.message)
        })
      } finally {
        fs.rmSync(tmpWs, { recursive: true, force: true })
      }
    } else {
      console.log('  skip "no baseline cached" test — a real baseline exists at ' + baselineLauncherDir + ' (would be unsafe to remove for the test)')
    }

    // 2) preparePatchWorkDir happy path — establish a baseline from a fake
    //    "full repo" tree, then overlay a patch zip and assert workDir
    //    contains BOTH the baseline-only files (electron/main.js,
    //    package.json) AND the patched src/ contents, AND that pre-patch
    //    src/ contents were wiped (so file deletions propagate).
    //
    //    We use a temp BASELINE_DIR via reaching into copyTreeForBaseline
    //    + snapshotBaseline directly. snapshotBaseline writes to
    //    BASELINE_DIR/<kind>; if a real baseline is already there, back
    //    it up first so we don't trash dev state.
    const realBaseline = path.join(BASELINE_DIR, 'launcher')
    const backup = realBaseline + '.bak-' + crypto.randomBytes(4).toString('hex')
    let movedBackup = false
    if (fs.existsSync(realBaseline)) {
      fs.renameSync(realBaseline, backup)
      movedBackup = true
    }
    const tmpFakeRepo = path.join(os.tmpdir(), 'sbfake-' + crypto.randomBytes(4).toString('hex'))
    fs.mkdirSync(path.join(tmpFakeRepo, 'electron'), { recursive: true })
    fs.mkdirSync(path.join(tmpFakeRepo, 'src'), { recursive: true })
    fs.writeFileSync(path.join(tmpFakeRepo, 'package.json'), '{"name":"fake","version":"1.0.0"}')
    fs.writeFileSync(path.join(tmpFakeRepo, 'electron', 'main.js'), '// baseline electron main')
    fs.writeFileSync(path.join(tmpFakeRepo, 'src', 'OLD.jsx'), 'old content')
    const tmpWs2 = path.join(os.tmpdir(), 'sbpatchws-' + crypto.randomBytes(4).toString('hex'))
    fs.mkdirSync(tmpWs2, { recursive: true })
    try {
      // Snapshot the fake repo as the launcher baseline.
      let metaCalled = null
      await snapshotBaseline(tmpFakeRepo, 'launcher', (kind, ts) => { metaCalled = { kind, ts } })
      await check('snapshotBaseline: writes to BASELINE_DIR/launcher and calls meta cb', async () => {
        if (!fs.existsSync(realBaseline)) throw new Error('baseline dir missing after snapshot')
        if (!fs.existsSync(path.join(realBaseline, 'package.json'))) throw new Error('baseline missing package.json')
        if (!fs.existsSync(path.join(realBaseline, 'electron', 'main.js'))) throw new Error('baseline missing electron/main.js')
        if (!metaCalled || metaCalled.kind !== 'launcher' || typeof metaCalled.ts !== 'number') throw new Error('setBaselineMeta not called correctly: ' + JSON.stringify(metaCalled))
      })
      // Now build a patch zip with NEW.jsx (and explicitly NO OLD.jsx) and
      // overlay it.
      const patchZip = await buildZipBufferFromTree({
        'App.jsx': 'export default ()=>null',
        'NEW.jsx': 'patched',
      })
      const workDir = await preparePatchWorkDir({
        workspaceRoot: tmpWs2, kind: 'launcher', patchZipBuffer: patchZip, job: { output: [], listeners: [] },
      })
      await check('preparePatchWorkDir: workDir has baseline files (electron/main.js, package.json)', async () => {
        if (!fs.existsSync(path.join(workDir, 'package.json'))) throw new Error('expected baseline package.json in workDir')
        if (!fs.existsSync(path.join(workDir, 'electron', 'main.js'))) throw new Error('expected baseline electron/main.js in workDir')
      })
      await check('preparePatchWorkDir: src/ contains patched files (App.jsx, NEW.jsx)', async () => {
        if (!fs.existsSync(path.join(workDir, 'src', 'App.jsx'))) throw new Error('expected patched src/App.jsx')
        if (!fs.existsSync(path.join(workDir, 'src', 'NEW.jsx'))) throw new Error('expected patched src/NEW.jsx')
      })
      await check('preparePatchWorkDir: src/ pre-patch files are gone (OLD.jsx wiped — deletions propagate)', async () => {
        if (fs.existsSync(path.join(workDir, 'src', 'OLD.jsx'))) throw new Error('OLD.jsx should have been wiped before overlay')
      })
    } finally {
      fs.rmSync(tmpFakeRepo, { recursive: true, force: true })
      fs.rmSync(tmpWs2, { recursive: true, force: true })
      // Restore baseline state: remove our test baseline, restore backup.
      fs.rmSync(realBaseline, { recursive: true, force: true })
      if (movedBackup) fs.renameSync(backup, realBaseline)
    }
  }

  // ============ PATCH-MODE TESTS (server kind) ============
  // Symmetric coverage for the server kind — overlay target is server/ not
  // src/, and the validator requires server/package.json + server/electron/
  // main.js to exist after overlay. This catches a regression where someone
  // hard-codes "src" in preparePatchWorkDir's overlaySubdir choice.
  if (zipBuf) {
    const realBaseline = path.join(BASELINE_DIR, 'server')
    const backup = realBaseline + '.bak-' + crypto.randomBytes(4).toString('hex')
    let movedBackup = false
    if (fs.existsSync(realBaseline)) {
      fs.renameSync(realBaseline, backup)
      movedBackup = true
    }
    const tmpFakeRepo = path.join(os.tmpdir(), 'sbfake-srv-' + crypto.randomBytes(4).toString('hex'))
    fs.mkdirSync(path.join(tmpFakeRepo, 'server', 'electron'), { recursive: true })
    fs.writeFileSync(path.join(tmpFakeRepo, 'package.json'), '{"name":"fake","version":"1.0.0"}')
    fs.writeFileSync(path.join(tmpFakeRepo, 'server', 'package.json'), '{"name":"fake-server"}')
    fs.writeFileSync(path.join(tmpFakeRepo, 'server', 'electron', 'main.js'), '// baseline server main')
    fs.writeFileSync(path.join(tmpFakeRepo, 'server', 'OLD_SRV.js'), 'old server file')
    const tmpWs = path.join(os.tmpdir(), 'sbpatch-srv-' + crypto.randomBytes(4).toString('hex'))
    fs.mkdirSync(tmpWs, { recursive: true })
    try {
      await snapshotBaseline(tmpFakeRepo, 'server', () => {})
      const patchZip = await buildZipBufferFromTree({
        'package.json': '{"name":"fake-server","version":"1.0.1"}',
        'electron/main.js': '// PATCHED server main',
        'NEW_SRV.js': 'patched',
      })
      const workDir = await preparePatchWorkDir({
        workspaceRoot: tmpWs, kind: 'server', patchZipBuffer: patchZip, job: { output: [], listeners: [] },
      })
      await check('preparePatchWorkDir (server kind): overlay lands in server/ not src/', async () => {
        if (!fs.existsSync(path.join(workDir, 'server', 'NEW_SRV.js'))) throw new Error('expected patched server/NEW_SRV.js')
        if (!fs.existsSync(path.join(workDir, 'server', 'electron', 'main.js'))) throw new Error('expected patched server/electron/main.js')
        if (fs.existsSync(path.join(workDir, 'server', 'OLD_SRV.js'))) throw new Error('OLD_SRV.js should have been wiped')
        // Top-level baseline package.json untouched.
        if (!fs.existsSync(path.join(workDir, 'package.json'))) throw new Error('expected baseline top-level package.json')
      })
      await check('preparePatchWorkDir (server kind): result satisfies server validator shape', async () => {
        await validateSourceShape(workDir, 'server')
      })
    } finally {
      fs.rmSync(tmpFakeRepo, { recursive: true, force: true })
      fs.rmSync(tmpWs, { recursive: true, force: true })
      fs.rmSync(realBaseline, { recursive: true, force: true })
      if (movedBackup) fs.renameSync(backup, realBaseline)
    }
  }

  console.log('== ' + pass + ' passed, ' + fail + ' failed ==')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
