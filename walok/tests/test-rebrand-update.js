// Pure-JS regression test for Task #11 (rebrand-style OTA update bugs).
//
// Why pure-JS: we can't run a real Windows electron .exe inside Replit (Linux
// container, no Wine), so this test stubs the install layout and drives the
// SAME functions that the launcher calls in production:
//   1. applyPendingUpdateOnStartup() — extracts the staged payload, bumps
//      ota-config.json, learns the new exe identity from the manifest, and
//      writes a .ota-cleanup.json marker for the orphan OLD exe.
//   2. sweepCleanupMarker() — runs at the start of the NEXT launch (when the
//      OLD exe is no longer locked, because we're now the NEW exe) and
//      deletes the orphan from the install dir.
//
// The test "becomes" the OLD exe by setting OTA_TEST_CURRENT_EXE=OLD.exe,
// then "becomes" the NEW exe by changing it to NEW.exe before the sweep.

const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')

let pass = 0, fail = 0
function ok(msg) { pass++; console.log('  PASS  ' + msg) }
function bad(msg) { fail++; console.log('  FAIL  ' + msg) }
function assert(cond, msg) { cond ? ok(msg) : bad(msg) }

// Build a minimal ZIP that the launcher's stdlib-only extractZip() can read.
// The parser only walks Local File Header records (signature 0x04034b50) and
// stops at the first non-LFH signature, so a bare LFH stream with deflated
// data is sufficient — no central directory needed.
function makeMinimalZip(entries) {
  const parts = []
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const compressed = zlib.deflateRawSync(e.data)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)              // signature
    lfh.writeUInt16LE(20, 4)                       // version needed
    lfh.writeUInt16LE(0, 6)                        // flags
    lfh.writeUInt16LE(8, 8)                        // method = deflate
    lfh.writeUInt16LE(0, 10)                       // mtime
    lfh.writeUInt16LE(0, 12)                       // mdate
    lfh.writeUInt32LE(0, 14)                       // crc32 (extractZip skips)
    lfh.writeUInt32LE(compressed.length, 18)       // compressed size
    lfh.writeUInt32LE(e.data.length, 22)           // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)                       // extra length
    parts.push(lfh, nameBuf, compressed)
  }
  return Buffer.concat(parts)
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) {}
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-rebrand-test-'))
  console.log('TEMP install dir: ' + tmp)

  try {
    // ---- Set up the "currently installed app" (DENFI build) ----
    fs.writeFileSync(path.join(tmp, 'OLD.exe'), 'old-electron-binary-bytes')
    fs.writeFileSync(path.join(tmp, 'app.asar'), 'OLD ASAR contents v1.0.0')
    fs.writeFileSync(path.join(tmp, 'ota-config.json'), JSON.stringify({
      enabled: true,
      channel: 'rebrand-test',
      version: '1.0.0',
      updateServer: 'http://example.test',
    }, null, 2))

    // ---- Stage a pending update (rebrand DENFI -> BLAST: NEW.exe) ----
    const pendingDir = path.join(tmp, '.ota-pending')
    fs.mkdirSync(pendingDir)
    const payloadZip = makeMinimalZip([
      { name: 'NEW.exe', data: Buffer.from('new-electron-binary-bytes-v2') },
      { name: 'app.asar', data: Buffer.from('NEW ASAR contents v2.0.0') },
    ])
    fs.writeFileSync(path.join(pendingDir, 'payload.zip'), payloadZip)
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify({
      version: '2.0.0',
      channel: 'rebrand-test',
      exeName: 'NEW.exe',
    }, null, 2))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())

    // ---- Become the OLD exe and require the launcher updater ----
    process.env.OTA_TEST_CURRENT_EXE = 'OLD.exe'
    // Force a fresh require so STATE is reset between tests if this file is
    // re-run in the same Node process.
    delete require.cache[require.resolve('../electron/updater.js')]
    delete require.cache[require.resolve('../electron/ota-live.js')]
    const updater = require('../electron/updater.js')

    // ---- Drive the apply step ----
    const applied = updater.applyPendingUpdateOnStartup(tmp)

    assert(applied === true, 'applyPendingUpdateOnStartup returns true')
    assert(fs.existsSync(path.join(tmp, 'NEW.exe')), 'NEW.exe was extracted into install dir')
    assert(
      fs.readFileSync(path.join(tmp, 'NEW.exe'), 'utf-8') === 'new-electron-binary-bytes-v2',
      'NEW.exe has the v2 payload bytes',
    )
    assert(
      fs.readFileSync(path.join(tmp, 'app.asar'), 'utf-8') === 'NEW ASAR contents v2.0.0',
      'app.asar was overwritten with v2 contents',
    )
    assert(fs.existsSync(path.join(tmp, 'OLD.exe')), 'OLD.exe is still on disk (Windows would have it locked at this point)')
    assert(!fs.existsSync(pendingDir), '.ota-pending/ was removed after successful apply')

    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'ota-config.json'), 'utf-8'))
    assert(cfg.version === '2.0.0', 'ota-config.json version bumped to 2.0.0')

    const markerPath = path.join(tmp, '.ota-cleanup.json')
    assert(fs.existsSync(markerPath), '.ota-cleanup.json marker was written for the orphan exe')
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
    assert(
      Array.isArray(marker.deleteExes) && marker.deleteExes.includes('OLD.exe'),
      'cleanup marker lists OLD.exe in deleteExes',
    )

    // Architect round-3 fix: per-exe identity sidecar must be written by
    // the apply step. This is the immutable record that lets an OLD exe
    // detect "I am no longer canonical" on a later relaunch, without
    // depending on the OTA-mutated package.json inside the asar.
    const sidecarPath = path.join(tmp, '.ota-current-exe.json')
    assert(fs.existsSync(sidecarPath), '.ota-current-exe.json written by apply step')
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'))
    assert(sidecar.exe === 'NEW.exe', 'sidecar.exe = NEW.exe (the canonical successor)')
    assert(sidecar.version === '2.0.0', 'sidecar.version = 2.0.0 (the just-applied version)')
    assert(typeof sidecar.written === 'number' && sidecar.written > 0, 'sidecar.written timestamp present')

    // INTEGRATION test for the architect's blocking finding: after the
    // apply has run, if the user RE-LAUNCHES OLD.exe (e.g. it's in their
    // taskbar, or they renamed it before sweep ran), detectVersionMismatch
    // must report stale=true via the sidecar tier — NOT via the legacy
    // bundled-vs-advertised path that silently defaults to "up-to-date"
    // when the asar was overwritten in place.
    const prevHook = process.env.OTA_TEST_BUNDLED_VERSION
    delete process.env.OTA_TEST_BUNDLED_VERSION
    try {
      const stale = updater.detectVersionMismatch(tmp, 'OLD.exe')
      assert(stale.stale === true,
        'OLD.exe relaunched after apply: detected stale via sidecar (no env hook)')
      assert(stale.reason === 'sidecar-points-elsewhere',
        'reason=sidecar-points-elsewhere (proves tier-1 path active)')
      assert(stale.candidate && stale.candidate.basename === 'NEW.exe',
        'OLD.exe would correctly hand off to NEW.exe')
      assert(stale.candidate.source === 'current-exe-record',
        'handoff source is the highest-confidence sidecar tier')
    } finally {
      if (prevHook !== undefined) process.env.OTA_TEST_BUNDLED_VERSION = prevHook
    }

    // ---- Simulate the next launch: we are now the NEW exe ----
    // (process.execPath can't be changed; the env var is the test-only hook.)
    process.env.OTA_TEST_CURRENT_EXE = 'NEW.exe'

    updater.sweepCleanupMarker(tmp)

    assert(!fs.existsSync(path.join(tmp, 'OLD.exe')), 'next launch sweep deleted the orphan OLD.exe')
    assert(fs.existsSync(path.join(tmp, 'NEW.exe')), 'NEW.exe (the running exe) was NOT touched by the sweep')
    assert(!fs.existsSync(markerPath), '.ota-cleanup.json removed once the orphan list is empty')

    // ---- Edge case: a same-name update (no rebrand) must NOT write a marker ----
    // Reset and re-run with manifest.exeName === current exe basename.
    rmrf(path.join(tmp, '.ota-cleanup.json'))
    fs.writeFileSync(path.join(tmp, 'ota-config.json'), JSON.stringify({
      enabled: true, channel: 'rebrand-test', version: '2.0.0', updateServer: 'http://example.test',
    }, null, 2))
    fs.mkdirSync(pendingDir)
    fs.writeFileSync(path.join(pendingDir, 'payload.zip'), makeMinimalZip([
      { name: 'NEW.exe', data: Buffer.from('new-electron-binary-bytes-v3') },
    ]))
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify({
      version: '3.0.0', channel: 'rebrand-test', exeName: 'NEW.exe',
    }, null, 2))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())

    const applied2 = updater.applyPendingUpdateOnStartup(tmp)
    assert(applied2 === true, 'same-name update applies cleanly')
    assert(!fs.existsSync(path.join(tmp, '.ota-cleanup.json')),
      'no cleanup marker is written when the new exe name matches the running exe')

    // ---- Edge case: legacy manifest without exeName, BUT a new .exe was
    //      added by the payload — discoverNewExe() should still trigger
    //      the rebrand handoff so we never load NEW asar in OLD exe. ----
    rmrf(pendingDir)
    fs.mkdirSync(pendingDir)
    fs.writeFileSync(path.join(pendingDir, 'payload.zip'), makeMinimalZip([
      { name: 'BLAST.exe', data: Buffer.from('blast-binary-v4') },
      { name: 'app.asar', data: Buffer.from('NEW ASAR v4') },
    ]))
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify({
      version: '4.0.0', channel: 'rebrand-test',
      // no exeName — old-style manifest
    }, null, 2))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())
    // We're "currently" NEW.exe; the legacy payload added BLAST.exe — that's
    // the new build's exe and should trigger a handoff cleanup marker.
    process.env.OTA_TEST_CURRENT_EXE = 'NEW.exe'

    const applied3 = updater.applyPendingUpdateOnStartup(tmp)
    assert(applied3 === true, 'legacy manifest (no exeName) still applies successfully')
    assert(fs.existsSync(path.join(tmp, '.ota-cleanup.json')),
      'discoverNewExe finds BLAST.exe -> cleanup marker is written for the running NEW.exe')
    const marker3 = JSON.parse(fs.readFileSync(path.join(tmp, '.ota-cleanup.json'), 'utf-8'))
    assert(marker3.deleteExes.includes('NEW.exe'),
      'legacy-flow marker lists the now-orphaned previous exe (NEW.exe)')

    // Clean up the marker before the next case (so it doesn't leak in).
    rmrf(path.join(tmp, '.ota-cleanup.json'))
    rmrf(path.join(tmp, 'BLAST.exe'))
    process.env.OTA_TEST_CURRENT_EXE = 'NEW.exe'

    // ---- Edge case: case-only manifest exeName must NOT trigger a marker ----
    fs.mkdirSync(pendingDir)
    fs.writeFileSync(path.join(pendingDir, 'payload.zip'), makeMinimalZip([
      { name: 'NEW.exe', data: Buffer.from('new-electron-binary-bytes-v5') },
    ]))
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify({
      version: '5.0.0', channel: 'rebrand-test', exeName: 'new.EXE', // different case
    }, null, 2))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())

    const applied4 = updater.applyPendingUpdateOnStartup(tmp)
    assert(applied4 === true, 'case-only exeName difference still applies cleanly')
    assert(!fs.existsSync(path.join(tmp, '.ota-cleanup.json')),
      'case-only exeName difference does NOT write a cleanup marker (would otherwise self-delete on Windows)')

    // ---- Edge case: malformed cleanup marker is removed gracefully ----
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), '{ not valid json')
    updater.sweepCleanupMarker(tmp)
    assert(!fs.existsSync(path.join(tmp, '.ota-cleanup.json')),
      'malformed cleanup marker is deleted by sweepCleanupMarker')

    // ---- Edge case: cleanup marker that targets the running exe (case-only
    //      mismatch) must skip the delete — we must never delete ourselves. ----
    fs.writeFileSync(path.join(tmp, 'NEW.exe'), 'currently-running-binary')
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), JSON.stringify({
      writtenAt: new Date().toISOString(),
      deleteExes: ['new.EXE'], // case-only difference vs OTA_TEST_CURRENT_EXE='NEW.exe'
    }))
    updater.sweepCleanupMarker(tmp)
    assert(fs.existsSync(path.join(tmp, 'NEW.exe')),
      'sweep does NOT delete the running exe even when marker uses different casing')
    assert(!fs.existsSync(path.join(tmp, '.ota-cleanup.json')),
      'sweep removes the marker after skipping the self-reference (nothing left to delete)')

    // ---- Defense-in-depth: a tampered marker containing path-traversal
    //      entries must NOT escape the install dir. We collapse each entry
    //      to its basename before joining with appRoot. ----
    const sentinel = path.join(os.tmpdir(), 'ota-sentinel-' + process.pid + '.dat')
    fs.writeFileSync(sentinel, 'must-not-be-deleted')
    fs.writeFileSync(path.join(tmp, 'unrelated.exe'), 'orphan-from-traversal-test')
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), JSON.stringify({
      writtenAt: new Date().toISOString(),
      deleteExes: [
        '../../' + path.basename(sentinel),       // tries to escape upward
        '/tmp/' + path.basename(sentinel),        // absolute-path attempt
        'unrelated.exe',                           // legit sibling, should be deleted
      ],
    }))
    updater.sweepCleanupMarker(tmp)
    assert(fs.existsSync(sentinel),
      'sweep does NOT follow ../ in marker entries — sentinel outside install dir survives')
    assert(!fs.existsSync(path.join(tmp, 'unrelated.exe')),
      'sweep still deletes the legitimate orphan listed alongside the traversal attempts')
    try { fs.unlinkSync(sentinel) } catch (_) {}
  } finally {
    rmrf(tmp)
    delete process.env.OTA_TEST_CURRENT_EXE
  }

  console.log('')
  console.log('=== ' + pass + ' passed, ' + fail + ' failed ===')
  process.exit(fail === 0 ? 0 : 1)
}

main()
