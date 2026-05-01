// End-to-end fixture test for the new POST /api/admin/update-source +
// GET /api/admin/source-status endpoints. Boots the real express app
// (server.js exports it when require()'d, only listens when run directly)
// against a sandbox PROJECT_ROOT under os.tmpdir(), then drives it via
// raw http requests.
//
// Run: node walok/update-server/test-update-source.js
//
// Coverage:
//   1. zip-slip entry name → 400 (extract refuses)
//   2. launcher: missing main.jsx → 400 (validateExtractedSourceShape refuses)
//   3. launcher: top-level electron/ dir (operator zipped walok/ instead of
//      walok/src/) → 400 with a helpful error
//   4. launcher happy path → 200, atomic swap visible on disk,
//      source-status updatedAt set
//   5. server happy path → 200 (different validator contract)
//   6. concurrent build (job-runner has a running job) → 409 refusal,
//      source-on-disk untouched

process.env.NODE_ENV = 'test'
process.env.PORT = '0'                       // ephemeral
process.env.HOST = '127.0.0.1'
process.env.OTA_ADMIN_PASSWORD = 'test-pw'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const http = require('http')

// Sandbox project root. server.js's findProjectRoot validates the candidate
// by requiring EITHER a top-level package.json with name === 'nextreme-
// gaming-hub' OR a customers/ subdir. Without those it silently FALLS BACK
// to walok/ on disk — which would let this test trash the real source.
// We satisfy the validator both ways (defense-in-depth) so OTA_PROJECT_ROOT
// definitely wins.
const SANDBOX = path.join(os.tmpdir(), 'wuf-test-' + crypto.randomBytes(4).toString('hex'))
fs.mkdirSync(SANDBOX, { recursive: true })
fs.writeFileSync(path.join(SANDBOX, 'package.json'),
  JSON.stringify({ name: 'nextreme-gaming-hub', version: '0.0.0-test' }))
fs.mkdirSync(path.join(SANDBOX, 'customers'), { recursive: true })
fs.mkdirSync(path.join(SANDBOX, 'src'), { recursive: true })
fs.writeFileSync(path.join(SANDBOX, 'src', 'OLD-MARKER'), 'before swap')
fs.mkdirSync(path.join(SANDBOX, 'server'), { recursive: true })
fs.writeFileSync(path.join(SANDBOX, 'server', 'OLD-MARKER'), 'before swap')
// Force PROJECT_ROOT to the sandbox.
process.env.OTA_PROJECT_ROOT = SANDBOX
// Sandbox the OTA db away from the real one so this test never overwrites
// the operator's customer list. db.js takes OTA_DATA_DIR at module-load.
const DATA_DIR = path.join(SANDBOX, 'ota-data')
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.OTA_DATA_DIR = DATA_DIR

const yazl = (() => { try { return require('yazl') } catch (_) { return null } })()
if (!yazl) {
  console.error('yazl not installed (devDependency). Skipping update-source tests.')
  process.exit(0)
}

// Build a STORE-mode zip from { 'a/b.txt': 'content', ... }.
function buildZip(tree) {
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

// Build a zip whose first entry has a zip-slip name. yazl refuses to write
// `..` as a name component, so we build a benign zip then patch the bytes.
function buildZipSlipZip() {
  return new Promise((res, rej) => {
    const z = new yazl.ZipFile()
    z.addBuffer(Buffer.from('pwned'), 'INNOCENT_NAME_____')
    const chunks = []
    z.outputStream.on('data', c => chunks.push(c))
    z.outputStream.on('end', () => {
      const buf = Buffer.concat(chunks)
      const evil = '../../../etc/pwn'
      // Rewrite both the local-file-header name AND the central-directory
      // name. The original is exactly 18 ASCII chars (matches the new name
      // length so offsets stay valid).
      const idx1 = buf.indexOf('INNOCENT_NAME_____')
      const idx2 = buf.indexOf('INNOCENT_NAME_____', idx1 + 1)
      buf.write(evil, idx1, 'utf8')
      buf.write(evil, idx2, 'utf8')
      res(buf)
    })
    z.outputStream.on('error', rej)
    z.end()
  })
}

// Multipart/form-data builder. We only support `kind` (text) + `file` (binary).
function buildMultipart({ kind, fileBuffer, filename = 'src.zip' }) {
  const boundary = '----wuf' + crypto.randomBytes(8).toString('hex')
  const parts = []
  parts.push(Buffer.from('--' + boundary + '\r\n'))
  parts.push(Buffer.from('Content-Disposition: form-data; name="kind"\r\n\r\n'))
  parts.push(Buffer.from(kind + '\r\n'))
  parts.push(Buffer.from('--' + boundary + '\r\n'))
  parts.push(Buffer.from('Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n'))
  parts.push(Buffer.from('Content-Type: application/zip\r\n\r\n'))
  parts.push(fileBuffer)
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'))
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary }
}

// Minimal HTTP helper that carries a session cookie across calls.
let _cookie = null
let _baseUrl = null
function req({ method, path: p, headers = {}, body = null }) {
  return new Promise((res, rej) => {
    const u = new URL(p, _baseUrl)
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers: { ...headers },
    }
    if (_cookie) opts.headers.cookie = _cookie
    if (body) opts.headers['content-length'] = Buffer.byteLength(body)
    const r = http.request(opts, (resp) => {
      const chunks = []
      resp.on('data', c => chunks.push(c))
      resp.on('end', () => {
        const setC = resp.headers['set-cookie']
        if (setC && setC.length) _cookie = setC[0].split(';')[0]
        const buf = Buffer.concat(chunks)
        let json = null
        try { json = JSON.parse(buf.toString('utf8')) } catch (_) {}
        res({ status: resp.statusCode, headers: resp.headers, body: buf, json })
      })
    })
    r.on('error', rej)
    if (body) r.write(body)
    r.end()
  })
}

let pass = 0, fail = 0
function ok(msg)   { pass++; console.log('  ok  ' + msg) }
function bad(msg, err) { fail++; console.error('  FAIL ' + msg + (err ? ' :: ' + err.message : '')) }
async function check(label, fn) {
  try { await fn(); ok(label) } catch (e) { bad(label, e) }
}

async function main() {
  console.log('== update-source endpoint tests ==')
  console.log('  sandbox: ' + SANDBOX)

  // Boot the real app. Requireing server.js does NOT call app.listen() any
  // more (it's gated behind require.main === module). We listen ourselves
  // on an ephemeral port so multiple test runs don't collide.
  const srv = require('./server')
  // SAFETY: hard-bail if findProjectRoot resolved to anything other than the
  // sandbox. Without this guard a misconfigured test would happily wipe the
  // real walok/src on disk via the atomic swap.
  await new Promise((res) => setImmediate(res))
  const status = await new Promise((res, rej) => {
    const httpProbe = srv.app.listen(0, '127.0.0.1', () => {
      const addr = httpProbe.address()
      const probeUrl = 'http://127.0.0.1:' + addr.port
      http.get(probeUrl + '/api/admin/status', (resp) => {
        const chunks = []
        resp.on('data', c => chunks.push(c))
        resp.on('end', () => {
          httpProbe.close()
          try { res(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { rej(e) }
        })
      }).on('error', rej)
    })
  })
  if (status.projectRoot !== SANDBOX) {
    console.error('FATAL: server resolved PROJECT_ROOT=' + status.projectRoot + ' but expected ' + SANDBOX)
    console.error('  Refusing to run — this would write to the real walok/src.')
    process.exit(2)
  }
  await new Promise((res, rej) => {
    const httpSrv = srv.app.listen(0, '127.0.0.1', () => {
      const addr = httpSrv.address()
      _baseUrl = 'http://127.0.0.1:' + addr.port
      console.log('  listening on ' + _baseUrl)
      res()
    })
    httpSrv.on('error', rej)
  })

  // -- login (every admin route is gated behind requireAdmin) --
  await check('login → 200 + cookie', async () => {
    const r = await req({
      method: 'POST', path: '/api/admin/login',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ password: 'test-pw' })),
    })
    if (r.status !== 200) throw new Error('status ' + r.status + ' :: ' + (r.body && r.body.toString().slice(0, 200)))
    if (!_cookie) throw new Error('no session cookie set')
  })

  // -- 1. zip-slip refusal: POST a zip with `../../../etc/pwn` entry. The
  //    extractZipBuffer primitive guards via safeJoinUnderDest. The
  //    endpoint should return 400 and leave the live src/ untouched.
  await check('zip-slip → 400 (extract refuses)', async () => {
    const evil = await buildZipSlipZip()
    const mp = buildMultipart({ kind: 'launcher', fileBuffer: evil })
    const r = await req({
      method: 'POST', path: '/api/admin/update-source',
      headers: { 'content-type': mp.contentType }, body: mp.body,
    })
    if (r.status !== 400) throw new Error('expected 400, got ' + r.status + ' :: ' + (r.json && r.json.error))
    // Live src/ must still contain the OLD-MARKER (untouched).
    if (!fs.existsSync(path.join(SANDBOX, 'src', 'OLD-MARKER'))) {
      throw new Error('live src/ was disturbed by a refused zip-slip upload')
    }
  })

  // -- 2. launcher missing main.jsx → 400. The launcher tree expects the
  //    CONTENTS of walok/src/ (App.jsx + main.jsx + index.css + components/
  //    + store/). Without main.jsx the validator must refuse, leaving the
  //    live src/ untouched.
  await check('launcher missing main.jsx → 400 (validate refuses)', async () => {
    const buf = await buildZip({
      'App.jsx': '// only App.jsx',
      'index.css': '/* nope */',
    })
    const mp = buildMultipart({ kind: 'launcher', fileBuffer: buf })
    const r = await req({
      method: 'POST', path: '/api/admin/update-source',
      headers: { 'content-type': mp.contentType }, body: mp.body,
    })
    if (r.status !== 400) throw new Error('expected 400, got ' + r.status + ' :: ' + (r.json && r.json.error))
    if (!/main\.jsx/.test((r.json && r.json.error) || '')) {
      throw new Error('error did not mention main.jsx: ' + (r.json && r.json.error))
    }
    if (!fs.existsSync(path.join(SANDBOX, 'src', 'OLD-MARKER'))) {
      throw new Error('live src/ was disturbed by a refused validate-fail upload')
    }
  })

  // -- 3. launcher with a top-level electron/ dir (operator zipped walok/
  //    instead of walok/src/) must be rejected with a clear "wrong tree"
  //    message. This is the bug class that the architect flagged: without
  //    this guard the operator could clobber walok/src with a totally
  //    different shape.
  await check('launcher with top-level electron/ → 400 (wrong tree)', async () => {
    const buf = await buildZip({
      'package.json': '{"name":"walok","version":"0.0.0"}',
      'main.jsx': '// has main.jsx but is actually the wrong tree',
      'App.jsx': '// also has App.jsx',
      'electron/main.js': '// gives it away',
    })
    const mp = buildMultipart({ kind: 'launcher', fileBuffer: buf })
    const r = await req({
      method: 'POST', path: '/api/admin/update-source',
      headers: { 'content-type': mp.contentType }, body: mp.body,
    })
    if (r.status !== 400) throw new Error('expected 400, got ' + r.status + ' :: ' + (r.json && r.json.error))
    if (!/electron/.test((r.json && r.json.error) || '')) {
      throw new Error('error did not mention the offending electron/ dir: ' + (r.json && r.json.error))
    }
    if (!fs.existsSync(path.join(SANDBOX, 'src', 'OLD-MARKER'))) {
      throw new Error('live src/ was disturbed by a refused wrong-tree upload')
    }
  })

  // -- 4. launcher happy path. Valid launcher tree (CONTENTS of walok/src/)
  //    replaces sandbox/src/ atomically. OLD-MARKER must be gone; the
  //    required files + NEW-MARKER must be present; source-status reports
  //    updatedAt > 0.
  await check('launcher happy path → 200 + atomic swap', async () => {
    const buf = await buildZip({
      'main.jsx': 'import React from "react"',
      'App.jsx': 'export default function App() {}',
      'index.css': 'body { margin: 0; }',
      'components/Header.jsx': 'export default function Header() {}',
      'NEW-MARKER': 'after swap',
    })
    const mp = buildMultipart({ kind: 'launcher', fileBuffer: buf })
    const r = await req({
      method: 'POST', path: '/api/admin/update-source',
      headers: { 'content-type': mp.contentType }, body: mp.body,
    })
    if (r.status !== 200) throw new Error('expected 200, got ' + r.status + ' :: ' + (r.json && r.json.error))
    if (!r.json || r.json.ok !== true) throw new Error('response not ok: ' + JSON.stringify(r.json))
    if (!r.json.updatedAt || r.json.updatedAt <= 0) throw new Error('missing updatedAt in response')
    // On-disk: OLD gone, NEW present, plus the required files.
    if (fs.existsSync(path.join(SANDBOX, 'src', 'OLD-MARKER'))) throw new Error('OLD-MARKER not removed')
    if (!fs.existsSync(path.join(SANDBOX, 'src', 'NEW-MARKER'))) throw new Error('NEW-MARKER not present')
    if (!fs.existsSync(path.join(SANDBOX, 'src', 'main.jsx'))) throw new Error('main.jsx not present')
    if (!fs.existsSync(path.join(SANDBOX, 'src', 'App.jsx'))) throw new Error('App.jsx not present')
    if (!fs.existsSync(path.join(SANDBOX, 'src', 'components', 'Header.jsx'))) throw new Error('components/Header.jsx not present')
    // source-status reflects the updatedAt (allow up to 5s of clock skew).
    const s = await req({ method: 'GET', path: '/api/admin/source-status' })
    if (s.status !== 200) throw new Error('source-status status ' + s.status)
    if (!s.json.launcher.present) throw new Error('source-status reports launcher missing')
    if (!s.json.launcher.updatedAt || (Date.now() - s.json.launcher.updatedAt) > 5000) {
      throw new Error('source-status updatedAt missing or stale: ' + s.json.launcher.updatedAt)
    }
  })

  // -- 5. server happy path. The server validator has a DIFFERENT contract:
  //    expects top-level package.json + electron/main.js (the contents of
  //    walok/server/). Confirm this works end-to-end and that the launcher
  //    tree we just installed is left alone.
  await check('server happy path → 200 + atomic swap (separate target)', async () => {
    const buf = await buildZip({
      'package.json': '{"name":"walok-server","version":"1.0.0"}',
      'electron/main.js': 'console.log("server main")',
      'src/index.js': 'module.exports = {}',
      'SERVER-NEW-MARKER': 'after swap',
    })
    const mp = buildMultipart({ kind: 'server', fileBuffer: buf })
    const r = await req({
      method: 'POST', path: '/api/admin/update-source',
      headers: { 'content-type': mp.contentType }, body: mp.body,
    })
    if (r.status !== 200) throw new Error('expected 200, got ' + r.status + ' :: ' + (r.json && r.json.error))
    if (fs.existsSync(path.join(SANDBOX, 'server', 'OLD-MARKER'))) throw new Error('server OLD-MARKER not removed')
    if (!fs.existsSync(path.join(SANDBOX, 'server', 'SERVER-NEW-MARKER'))) throw new Error('SERVER-NEW-MARKER not present')
    if (!fs.existsSync(path.join(SANDBOX, 'server', 'package.json'))) throw new Error('server/package.json not present')
    if (!fs.existsSync(path.join(SANDBOX, 'server', 'electron', 'main.js'))) throw new Error('server/electron/main.js not present')
    // The launcher tree from the previous test must NOT have been touched.
    if (!fs.existsSync(path.join(SANDBOX, 'src', 'main.jsx'))) {
      throw new Error('server upload disturbed launcher tree (main.jsx missing)')
    }
  })

  // -- 6b. Windows-lock fallback. Simulate the persistent EBUSY that
  //     OneDrive / Defender produce on Desktop by monkey-patching
  //     fs.renameSync to throw EBUSY whenever the destination ends in
  //     ".trash-*" (i.e. only the live→trash rename). The endpoint must
  //     fall back to the file-by-file overlay and still leave the live
  //     src/ matching the new tree.
  await check('overlay fallback when live→trash rename is blocked', async () => {
    const realRenameSync = fs.renameSync
    fs.renameSync = function patchedRename(src, dst) {
      if (typeof dst === 'string' && /\.trash-/.test(dst)) {
        const err = new Error('EBUSY: simulated lock for test')
        err.code = 'EBUSY'
        throw err
      }
      return realRenameSync(src, dst)
    }
    try {
      // Pre-condition: drop a stale file into live src/ that the new tree
      // does NOT contain — overlay must delete it.
      fs.writeFileSync(path.join(SANDBOX, 'src', 'STALE-TO-REMOVE'), 'old garbage')
      const buf = await buildZip({
        'main.jsx': '// overlay',
        'App.jsx': '// overlay',
        'index.css': '/* overlay */',
        'OVERLAY-MARKER': 'after overlay',
      })
      const mp = buildMultipart({ kind: 'launcher', fileBuffer: buf })
      const r = await req({
        method: 'POST', path: '/api/admin/update-source',
        headers: { 'content-type': mp.contentType }, body: mp.body,
      })
      if (r.status !== 200) throw new Error('expected 200, got ' + r.status + ' :: ' + (r.json && r.json.error))
      if (r.json.swapStrategy !== 'overlay') {
        throw new Error('expected swapStrategy=overlay, got ' + r.json.swapStrategy)
      }
      if (!fs.existsSync(path.join(SANDBOX, 'src', 'OVERLAY-MARKER'))) throw new Error('OVERLAY-MARKER not present after overlay')
      if (!fs.existsSync(path.join(SANDBOX, 'src', 'main.jsx'))) throw new Error('main.jsx not present after overlay')
      if (fs.existsSync(path.join(SANDBOX, 'src', 'STALE-TO-REMOVE'))) throw new Error('STALE-TO-REMOVE was not pruned by overlay')
    } finally {
      fs.renameSync = realRenameSync
    }
  })

  // -- 6c. tmp→live failure with successful trash→live ROLLBACK. We let
  //     the live→trash rename succeed normally, then make tmp→live throw
  //     EBUSY for all retries, and confirm: (1) endpoint returns 500 with
  //     a "rolled back" message, (2) the live src/ tree is intact (NOT
  //     gone — rollback worked), (3) the partial flag is NOT set (this
  //     is the rename path, not overlay).
  await check('rollback when tmp→live rename fails after live→trash succeeds', async () => {
    // Read pre-state so we can verify rollback restored exactly this tree.
    const pre = fs.readdirSync(path.join(SANDBOX, 'src')).sort().join(',')
    const realRenameSync = fs.renameSync
    let liveTrashSeen = false
    fs.renameSync = function patchedRename(src, dst) {
      // Let live→trash through (so we hit the rollback path).
      if (typeof dst === 'string' && /\.trash-/.test(dst)) {
        liveTrashSeen = true
        return realRenameSync(src, dst)
      }
      // Fail tmp→live: source path contains ".tmp-" AND target is live src/.
      // (The rollback rename has src containing ".trash-" so it falls through
      // and succeeds — exactly what we want to verify.)
      if (liveTrashSeen
          && typeof src === 'string' && /\.tmp-/.test(src)
          && dst === path.join(SANDBOX, 'src')) {
        const err = new Error('EBUSY: simulated tmp→live failure for test')
        err.code = 'EBUSY'
        throw err
      }
      return realRenameSync(src, dst)
    }
    try {
      const buf = await buildZip({
        'main.jsx': '// rollback test',
        'App.jsx': '// rollback test',
        'ROLLBACK-MARKER': 'should NOT land',
      })
      const mp = buildMultipart({ kind: 'launcher', fileBuffer: buf })
      const r = await req({
        method: 'POST', path: '/api/admin/update-source',
        headers: { 'content-type': mp.contentType }, body: mp.body,
      })
      if (r.status !== 500) throw new Error('expected 500, got ' + r.status + ' :: ' + JSON.stringify(r.json))
      if (!/rolled back/i.test(r.json.error || '')) {
        throw new Error('expected error to mention rollback, got: ' + r.json.error)
      }
      if (r.json.partial) throw new Error('rename-path failure should NOT set partial flag, got partial=true')
      // Live src/ should be RESTORED — same contents as before.
      if (!fs.existsSync(path.join(SANDBOX, 'src'))) {
        throw new Error('CRITICAL: live src/ disappeared — rollback failed')
      }
      const post = fs.readdirSync(path.join(SANDBOX, 'src')).sort().join(',')
      if (post !== pre) throw new Error('post-rollback src/ contents differ from pre. pre=[' + pre + '] post=[' + post + ']')
      if (fs.existsSync(path.join(SANDBOX, 'src', 'ROLLBACK-MARKER'))) {
        throw new Error('ROLLBACK-MARKER landed — rollback did not undo the swap')
      }
    } finally {
      fs.renameSync = realRenameSync
    }
  })

  // -- 6d. Overlay PARTIAL FAILURE → partial flag set + build refusal.
  //     Force live→trash rename to fail (drives overlay path) AND make
  //     copyFile fail on a specific file midway, so the overlay copies
  //     SOME files then crashes. Confirm: (1) endpoint returns 500 with
  //     partial:true, (2) /api/admin/source-status reports launcher.partial
  //     === true, (3) /api/admin/build refuses 409 while the flag is set,
  //     (4) a successful re-upload clears the flag.
  await check('overlay mid-failure sets partial flag + blocks builds + clears on re-upload', async () => {
    const realRenameSync = fs.renameSync
    const realCopyFile = fs.promises.copyFile
    fs.renameSync = function patchedRename(src, dst) {
      if (typeof dst === 'string' && /\.trash-/.test(dst)) {
        const err = new Error('EBUSY: forced overlay path')
        err.code = 'EBUSY'
        throw err
      }
      return realRenameSync(src, dst)
    }
    fs.promises.copyFile = async function patchedCopyFile(src, dst) {
      if (typeof dst === 'string' && /PARTIAL-FAIL-FILE/.test(dst)) {
        const err = new Error('EACCES: simulated mid-overlay copy failure')
        err.code = 'EACCES'
        throw err
      }
      return realCopyFile(src, dst)
    }
    try {
      // Drive the partial failure.
      const buf = await buildZip({
        'main.jsx': '// partial',
        'App.jsx': '// partial',
        'PARTIAL-FAIL-FILE': 'this copy will throw',
        'AFTER-FAIL-FILE': 'never reached',
      })
      const mp = buildMultipart({ kind: 'launcher', fileBuffer: buf })
      const r = await req({
        method: 'POST', path: '/api/admin/update-source',
        headers: { 'content-type': mp.contentType }, body: mp.body,
      })
      if (r.status !== 500) throw new Error('expected 500, got ' + r.status + ' :: ' + JSON.stringify(r.json))
      if (r.json.partial !== true) throw new Error('expected partial=true on response, got ' + r.json.partial)
      // source-status should report launcher.partial = true.
      const ss = await req({ method: 'GET', path: '/api/admin/source-status' })
      if (!ss.json.launcher || ss.json.launcher.partial !== true) {
        throw new Error('source-status should show launcher.partial=true, got ' + JSON.stringify(ss.json.launcher))
      }
      // /api/admin/build should refuse 409 while flag is set.
      const buildResp = await req({
        method: 'POST', path: '/api/admin/build',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ all: true })),
      })
      if (buildResp.status !== 409) {
        throw new Error('build should be refused with 409, got ' + buildResp.status + ' :: ' + JSON.stringify(buildResp.json))
      }
      if (!Array.isArray(buildResp.json.partialKinds) || !buildResp.json.partialKinds.includes('launcher')) {
        throw new Error('build refusal should list launcher in partialKinds, got ' + JSON.stringify(buildResp.json))
      }
      // Now restore copyFile + renameSync and re-upload successfully — this
      // should clear the partial flag.
      fs.promises.copyFile = realCopyFile
      fs.renameSync = realRenameSync
      const buf2 = await buildZip({
        'main.jsx': '// recovered',
        'App.jsx': '// recovered',
        'RECOVERED-MARKER': 'cleanup',
      })
      const mp2 = buildMultipart({ kind: 'launcher', fileBuffer: buf2 })
      const r2 = await req({
        method: 'POST', path: '/api/admin/update-source',
        headers: { 'content-type': mp2.contentType }, body: mp2.body,
      })
      if (r2.status !== 200) throw new Error('re-upload should succeed, got ' + r2.status + ' :: ' + (r2.json && r2.json.error))
      const ss2 = await req({ method: 'GET', path: '/api/admin/source-status' })
      if (ss2.json.launcher.partial !== false) {
        throw new Error('partial flag should be cleared after successful re-upload, got ' + ss2.json.launcher.partial)
      }
    } finally {
      fs.renameSync = realRenameSync
      fs.promises.copyFile = realCopyFile
    }
  })

  // -- 6. 409 refusal while a build job is RUNNING. The endpoint asks
  //    job-runner.listJobs() and checks for any 'running' or 'cancelling'
  //    job. We monkey-patch listJobs on the exported jobRunner to simulate
  //    that state, then confirm the next upload is rejected with 409 +
  //    the live source on disk is not disturbed.
  await check('409 refusal while a build is running', async () => {
    // Pre-condition: confirm src/ is currently the post-recovery tree
    // (test 6d ended with a successful re-upload that left RECOVERED-MARKER).
    if (!fs.existsSync(path.join(SANDBOX, 'src', 'RECOVERED-MARKER'))) {
      throw new Error('precondition: RECOVERED-MARKER missing — earlier test failed')
    }
    const orig = srv.jobRunner.listJobs.bind(srv.jobRunner)
    srv.jobRunner.listJobs = () => [{ id: 'fake-running', status: 'running' }]
    try {
      const buf = await buildZip({
        'main.jsx': '// v2',
        'App.jsx': '// v2',
        'V2-MARKER': 'should not land',
      })
      const mp = buildMultipart({ kind: 'launcher', fileBuffer: buf })
      const r = await req({
        method: 'POST', path: '/api/admin/update-source',
        headers: { 'content-type': mp.contentType }, body: mp.body,
      })
      if (r.status !== 409) throw new Error('expected 409, got ' + r.status + ' :: ' + (r.json && r.json.error))
      if (fs.existsSync(path.join(SANDBOX, 'src', 'V2-MARKER'))) {
        throw new Error('live src/ was disturbed by a refused upload (V2-MARKER landed)')
      }
      if (!fs.existsSync(path.join(SANDBOX, 'src', 'RECOVERED-MARKER'))) {
        throw new Error('live src/ RECOVERED-MARKER vanished during refused upload')
      }
    } finally {
      srv.jobRunner.listJobs = orig
    }
  })

  console.log('')
  console.log('== summary == pass=' + pass + ' fail=' + fail)
  // Best-effort sandbox cleanup. Don't blow up the run if rmrf races.
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch (_) {}
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
