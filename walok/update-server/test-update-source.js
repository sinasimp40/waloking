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

  // -- 6. 409 refusal while a build job is RUNNING. The endpoint asks
  //    job-runner.listJobs() and checks for any 'running' or 'cancelling'
  //    job. We monkey-patch listJobs on the exported jobRunner to simulate
  //    that state, then confirm the next upload is rejected with 409 +
  //    the live source on disk is not disturbed.
  await check('409 refusal while a build is running', async () => {
    // Pre-condition: confirm src/ is currently the post-happy-path tree.
    if (!fs.existsSync(path.join(SANDBOX, 'src', 'NEW-MARKER'))) {
      throw new Error('precondition: NEW-MARKER missing — earlier test failed')
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
      if (!fs.existsSync(path.join(SANDBOX, 'src', 'NEW-MARKER'))) {
        throw new Error('live src/ NEW-MARKER vanished during refused upload')
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
