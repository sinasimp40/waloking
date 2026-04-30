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

    // ---- Regression: partial-extract failure must clean up the new exe AND
    //      preserve READY for retry, so the user can't trigger an
    //      "Application Integrity Error" by double-clicking a new exe that
    //      was extracted next to a stale (still-locked) app.asar. ----
    //
    // We simulate the locked-asar failure by monkey-patching fs.writeFileSync
    // to throw whenever extractZip tries to write to app.asar's .ota-tmp.
    // Other writes (FAILED marker, exe writes) are passed through unchanged.
    {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-partial-fail-'))
      try {
        fs.writeFileSync(path.join(tmp2, 'OLD.exe'), 'old-binary')
        fs.writeFileSync(path.join(tmp2, 'app.asar'), 'OLD asar v1')
        // Field-reported regression: a NON-locked file (e.g. a chrome pak
        // sitting next to the launcher) used to get replaced with NEW
        // content while the locked asar stayed OLD — leaving the user with
        // OLD launcher + NEW chrome paks = black/violet screen on launch.
        // This test now asserts that chrome.pak is RESTORED to its OLD
        // content during rollback.
        fs.writeFileSync(path.join(tmp2, 'chrome.pak'), 'OLD chrome pak v1')
        fs.writeFileSync(path.join(tmp2, 'ota-config.json'), JSON.stringify({
          enabled: true, channel: 'rebrand-test', version: '1.0.0', updateServer: 'http://example.test',
        }, null, 2))

        const pd = path.join(tmp2, '.ota-pending')
        fs.mkdirSync(pd)
        fs.writeFileSync(path.join(pd, 'payload.zip'), makeMinimalZip([
          { name: 'NEW.exe', data: Buffer.from('new-binary-v2') },
          { name: 'chrome.pak', data: Buffer.from('NEW chrome pak v2') },
          { name: 'app.asar', data: Buffer.from('NEW asar v2') },
        ]))
        fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({
          version: '2.0.0', channel: 'rebrand-test', exeName: 'NEW.exe',
        }, null, 2))
        const readyPath = path.join(pd, 'READY')
        fs.writeFileSync(readyPath, new Date().toISOString())

        process.env.OTA_TEST_CURRENT_EXE = 'OLD.exe'
        delete require.cache[require.resolve('../electron/updater.js')]
        delete require.cache[require.resolve('../electron/ota-live.js')]
        const updater2 = require('../electron/updater.js')

        // Patch fs.writeFileSync to fail the asar write (simulates Windows
        // file lock by the running OLD.exe holding app.asar mmap'd).
        const origWFS = fs.writeFileSync
        fs.writeFileSync = function (p, data, opts) {
          if (typeof p === 'string' && p.endsWith('app.asar.ota-tmp')) {
            const err = new Error('SIMULATED: app.asar tmp write failed (mimicking Windows asar file lock)')
            err.code = 'EBUSY'
            throw err
          }
          return origWFS(p, data, opts)
        }
        let appliedFail
        try {
          appliedFail = updater2.applyPendingUpdateOnStartup(tmp2)
        } finally {
          fs.writeFileSync = origWFS
        }

        assert(appliedFail === false, 'partial-extract failure: applyPendingUpdateOnStartup returns false')
        assert(fs.existsSync(readyPath),
          'partial-extract failure: READY marker is PRESERVED so the next launch can retry (was previously deleted, stranding the user)')
        assert(!fs.existsSync(path.join(tmp2, 'NEW.exe')),
          'partial-extract failure: the partially-dropped NEW.exe was swept (would otherwise show "Application Integrity Error" on double-click)')
        assert(fs.existsSync(path.join(tmp2, 'OLD.exe')),
          'partial-extract failure: pre-existing OLD.exe is preserved (sweep only touches files NEW to this attempt)')
        assert(
          fs.readFileSync(path.join(tmp2, 'app.asar'), 'utf-8') === 'OLD asar v1',
          'partial-extract failure: app.asar was NOT replaced (still has OLD contents)',
        )
        // CRITICAL: chrome.pak (which extractZip CAN replace because it isn't
        // locked) must be RESTORED to its OLD content by rollback. Without
        // this restoration, the OLD launcher loads OLD asar against NEW
        // chrome paks -> black/violet screen (the field-reported bug).
        assert(
          fs.readFileSync(path.join(tmp2, 'chrome.pak'), 'utf-8') === 'OLD chrome pak v1',
          'partial-extract failure: chrome.pak was RESTORED to OLD content via rollback (not left at NEW content -> would cause black-screen mismatch)',
        )
        assert(!fs.existsSync(path.join(tmp2, '.ota-cleanup.json')),
          'partial-extract failure: no cleanup marker is written when the apply did not succeed')
        // No leftover backup/tmp scratch files in the install dir.
        const leftoverTmp = fs.readdirSync(tmp2).filter(n => n.endsWith('.ota-tmp') || n.endsWith('.ota-bak'))
        assert(leftoverTmp.length === 0,
          'partial-extract failure: no .ota-tmp / .ota-bak scratch files left in the install dir after rollback')

        const failedMarkerPath = path.join(pd, 'FAILED')
        assert(fs.existsSync(failedMarkerPath),
          'partial-extract failure: FAILED diagnostics marker written')
        const failedDoc = JSON.parse(fs.readFileSync(failedMarkerPath, 'utf-8'))
        assert(failedDoc.consecutiveFailures === 1,
          'partial-extract failure: consecutiveFailures = 1 on first attempt')
        assert(failedDoc.gaveUp === false,
          'partial-extract failure: gaveUp = false on first attempt')
        assert(failedDoc.rolledBack && typeof failedDoc.rolledBack.removed === 'number'
          && typeof failedDoc.rolledBack.restored === 'number',
          'partial-extract failure: FAILED diagnostics records rollback counts (restored / removed)')
        assert(failedDoc.rolledBack.removed >= 1 && failedDoc.rolledBack.restored >= 1,
          'partial-extract failure: rollback removed at least 1 new file (NEW.exe) AND restored at least 1 replaced file (chrome.pak)')

        // ---- Runaway-retry guard: 5 consecutive failures must drop READY ----
        // Re-trigger the same failure path 4 more times (we already have 1).
        for (let i = 2; i <= 5; i++) {
          fs.writeFileSync(readyPath, new Date().toISOString()) // restage READY
          fs.writeFileSync = function (p, data, opts) {
            if (typeof p === 'string' && p.endsWith('app.asar.ota-tmp')) {
              const err = new Error('SIMULATED locked asar')
              err.code = 'EBUSY'
              throw err
            }
            return origWFS(p, data, opts)
          }
          try {
            updater2.applyPendingUpdateOnStartup(tmp2)
          } finally {
            fs.writeFileSync = origWFS
          }
        }
        const finalFailed = JSON.parse(fs.readFileSync(failedMarkerPath, 'utf-8'))
        assert(finalFailed.consecutiveFailures === 5,
          'runaway-retry guard: consecutiveFailures climbs to 5 after repeated failures')
        assert(finalFailed.gaveUp === true,
          'runaway-retry guard: gaveUp = true once the cap is hit')
        assert(!fs.existsSync(readyPath),
          'runaway-retry guard: READY is dropped after MAX_CONSECUTIVE_APPLY_FAILURES so the user is not stuck retrying a permanently-broken payload')
      } finally {
        rmrf(tmp2)
      }
    }

    // ---- Regression (architect nit): hard throw MID-extract (not a per-entry
    //      failure) must also sweep the partially-dropped exe via the outer
    //      catch. Reproduces the case where extractZip's own header-read
    //      throws RangeError on a truncated zip after NEW.exe was already
    //      written to disk. Without the outer-catch sweep, that exe would
    //      survive and trip "Application Integrity Error" on double-click. ----
    {
      const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-mid-throw-'))
      try {
        fs.writeFileSync(path.join(tmp3, 'OLD.exe'), 'old-binary')
        fs.writeFileSync(path.join(tmp3, 'app.asar'), 'OLD asar v1')
        fs.writeFileSync(path.join(tmp3, 'ota-config.json'), JSON.stringify({
          enabled: true, channel: 'rebrand-test', version: '1.0.0', updateServer: 'http://example.test',
        }, null, 2))

        const pd = path.join(tmp3, '.ota-pending')
        fs.mkdirSync(pd)
        // Build a payload with a valid LFH for NEW.exe + 4 trailing magic bytes
        // (0x04034b50 little-endian). The loop will enter on the magic, then
        // throw RangeError when reading the rest of the truncated header.
        const validZip = makeMinimalZip([
          { name: 'NEW.exe', data: Buffer.from('new-binary-mid-throw') },
        ])
        const truncatedTail = Buffer.from([0x50, 0x4B, 0x03, 0x04])
        const corruptZip = Buffer.concat([validZip, truncatedTail])
        fs.writeFileSync(path.join(pd, 'payload.zip'), corruptZip)
        fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({
          version: '2.0.0', channel: 'rebrand-test', exeName: 'NEW.exe',
        }, null, 2))
        const readyPath = path.join(pd, 'READY')
        fs.writeFileSync(readyPath, new Date().toISOString())

        process.env.OTA_TEST_CURRENT_EXE = 'OLD.exe'
        delete require.cache[require.resolve('../electron/updater.js')]
        delete require.cache[require.resolve('../electron/ota-live.js')]
        const updater3 = require('../electron/updater.js')

        const appliedThrow = updater3.applyPendingUpdateOnStartup(tmp3)

        assert(appliedThrow === false,
          'mid-extract throw: applyPendingUpdateOnStartup returns false (outer catch fired)')
        assert(fs.existsSync(readyPath),
          'mid-extract throw: READY preserved (outer catch keeps READY for retry)')
        assert(!fs.existsSync(path.join(tmp3, 'NEW.exe')),
          'mid-extract throw: outer-catch sweep removed the partial NEW.exe (no integrity-error popup possible)')
        assert(fs.existsSync(path.join(tmp3, 'OLD.exe')),
          'mid-extract throw: pre-existing OLD.exe is preserved')

        const failedMarker = path.join(pd, 'FAILED')
        assert(fs.existsSync(failedMarker),
          'mid-extract throw: FAILED diagnostics marker written by outer catch')
        const failedDoc = JSON.parse(fs.readFileSync(failedMarker, 'utf-8'))
        assert(failedDoc.consecutiveFailures === 1,
          'mid-extract throw: consecutiveFailures = 1')
        assert(failedDoc.rolledBack && typeof failedDoc.rolledBack.removed === 'number',
          'mid-extract throw: outer-catch FAILED diagnostics record rollback counts')
        assert(failedDoc.rolledBack.removed >= 1,
          'mid-extract throw: rollback removed at least 1 new file (NEW.exe) before the throw was handled')
      } finally {
        rmrf(tmp3)
      }
    }

    // ---- Regression: if .ota-bak cannot be created the apply must refuse
    //      to extract instead of running without rollback (which would let a
    //      later failure unlink replaced files with no backup to restore). ----
    {
      const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-no-backup-'))
      try {
        fs.writeFileSync(path.join(tmp4, 'OLD.exe'), 'old-binary-must-survive')
        fs.writeFileSync(path.join(tmp4, 'app.asar'), 'OLD asar must survive')
        fs.writeFileSync(path.join(tmp4, 'chrome.pak'), 'OLD chrome pak must survive')
        fs.writeFileSync(path.join(tmp4, 'ota-config.json'), JSON.stringify({
          enabled: true, channel: 'rebrand-test', version: '1.0.0', updateServer: 'http://example.test',
        }, null, 2))

        const pd = path.join(tmp4, '.ota-pending')
        fs.mkdirSync(pd)
        fs.writeFileSync(path.join(pd, 'payload.zip'), makeMinimalZip([
          { name: 'NEW.exe', data: Buffer.from('new-binary') },
          { name: 'chrome.pak', data: Buffer.from('NEW chrome pak') },
          { name: 'app.asar', data: Buffer.from('NEW asar v2') },
        ]))
        fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({
          version: '2.0.0', channel: 'rebrand-test', exeName: 'NEW.exe',
        }, null, 2))
        const readyPath = path.join(pd, 'READY')
        fs.writeFileSync(readyPath, new Date().toISOString())

        process.env.OTA_TEST_CURRENT_EXE = 'OLD.exe'
        delete require.cache[require.resolve('../electron/updater.js')]
        delete require.cache[require.resolve('../electron/ota-live.js')]
        const updater4 = require('../electron/updater.js')

        // Force backup-dir creation to fail by replacing fs.mkdirSync for the
        // .ota-bak path only. mkdirSync is invoked from STEP 2 of apply with
        // the backupDir path; throwing simulates EACCES / read-only volume.
        const realMkdir = fs.mkdirSync
        const targetBak = path.join(pd, '.ota-bak')
        fs.mkdirSync = function (p, opts) {
          if (typeof p === 'string' && path.resolve(p) === path.resolve(targetBak)) {
            const err = new Error('EACCES: permission denied (test injection)')
            err.code = 'EACCES'
            throw err
          }
          return realMkdir.call(this, p, opts)
        }
        let appliedNoBackup
        try {
          appliedNoBackup = updater4.applyPendingUpdateOnStartup(tmp4)
        } finally {
          fs.mkdirSync = realMkdir
        }

        assert(appliedNoBackup === false,
          'no-backup refusal: applyPendingUpdateOnStartup returns false when backup dir cannot be created')
        // No pre-existing file was touched: extract was refused.
        assert(fs.readFileSync(path.join(tmp4, 'OLD.exe'), 'utf-8') === 'old-binary-must-survive',
          'no-backup refusal: pre-existing OLD.exe is untouched (extract was refused, not run-without-backup)')
        assert(fs.readFileSync(path.join(tmp4, 'app.asar'), 'utf-8') === 'OLD asar must survive',
          'no-backup refusal: pre-existing app.asar is untouched')
        assert(fs.readFileSync(path.join(tmp4, 'chrome.pak'), 'utf-8') === 'OLD chrome pak must survive',
          'no-backup refusal: pre-existing chrome.pak is untouched')
        assert(!fs.existsSync(path.join(tmp4, 'NEW.exe')),
          'no-backup refusal: NEW.exe never landed (extract was refused)')
        const failedMarker = path.join(pd, 'FAILED')
        assert(fs.existsSync(failedMarker),
          'no-backup refusal: FAILED diagnostics marker written')
        const failedDoc = JSON.parse(fs.readFileSync(failedMarker, 'utf-8'))
        assert(typeof failedDoc.error === 'string' && /backup dir create failed/i.test(failedDoc.error),
          'no-backup refusal: FAILED diagnostics record reason "backup dir create failed"')
      } finally {
        rmrf(tmp4)
      }
    }

    // ---- Regression: if a previous attempt was killed after moving
    //      originals into .ota-bak but before commit or rollback, the next
    //      apply must restore those backup files in place before wiping. ----
    {
      const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-leftover-bak-'))
      try {
        fs.writeFileSync(path.join(tmp5, 'OLD.exe'), 'old-binary')
        // Note: app.asar and chrome.pak are MISSING from the install dir to
        // simulate the previous-attempt-killed-mid-flight scenario where
        // those files were already moved into .ota-bak and never restored.
        fs.writeFileSync(path.join(tmp5, 'ota-config.json'), JSON.stringify({
          enabled: true, channel: 'rebrand-test', version: '1.0.0', updateServer: 'http://example.test',
        }, null, 2))

        const pd = path.join(tmp5, '.ota-pending')
        fs.mkdirSync(pd)
        // Pre-populate .ota-bak as if a previous attempt had moved originals
        // there and was killed. These bytes are the LAST good copy.
        const leftoverBak = path.join(pd, '.ota-bak')
        fs.mkdirSync(leftoverBak, { recursive: true })
        fs.writeFileSync(path.join(leftoverBak, 'app.asar'), 'OLD asar (last good copy)')
        fs.writeFileSync(path.join(leftoverBak, 'chrome.pak'), 'OLD chrome pak (last good copy)')

        // Now stage a fresh, INVALID payload so apply tries to extract,
        // fails, and we can confirm the leftover backup was recovered first
        // (independent of whether the new attempt itself succeeds).
        fs.writeFileSync(path.join(pd, 'payload.zip'), Buffer.from('not-a-zip'))
        fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({
          version: '2.0.0', channel: 'rebrand-test', exeName: 'NEW.exe',
        }, null, 2))
        fs.writeFileSync(path.join(pd, 'READY'), new Date().toISOString())

        process.env.OTA_TEST_CURRENT_EXE = 'OLD.exe'
        delete require.cache[require.resolve('../electron/updater.js')]
        delete require.cache[require.resolve('../electron/ota-live.js')]
        const updater5 = require('../electron/updater.js')

        updater5.applyPendingUpdateOnStartup(tmp5)

        // Leftover backup bytes were restored before the new attempt began.
        assert(fs.existsSync(path.join(tmp5, 'app.asar'))
          && fs.readFileSync(path.join(tmp5, 'app.asar'), 'utf-8') === 'OLD asar (last good copy)',
          'leftover backup recovery: app.asar was restored from .ota-bak before the new attempt began')
        assert(fs.existsSync(path.join(tmp5, 'chrome.pak'))
          && fs.readFileSync(path.join(tmp5, 'chrome.pak'), 'utf-8') === 'OLD chrome pak (last good copy)',
          'leftover backup recovery: chrome.pak was restored from .ota-bak before the new attempt began')
      } finally {
        rmrf(tmp5)
      }
    }

    // ---- Task #18: Windows out-of-process applier. The launcher cannot
    //      overwrite app.asar from inside the running Electron process
    //      (the asar is locked). Test the staging path: extract to
    //      .ota-pending/staged/, pre-stage cleanup marker + sidecar +
    //      bumped ota-config.json from Node (no PowerShell escaping
    //      surface), write apply.cmd to %TEMP%, "spawn" cmd.exe via
    //      injected mock, exit. The actual robocopy step runs only on
    //      real Windows; we verify everything up to the handoff. ----
    {
      const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-oop-stage-'))
      try {
        fs.writeFileSync(path.join(tmp6, 'OLD.exe'), 'old-binary-must-survive-staging')
        fs.writeFileSync(path.join(tmp6, 'app.asar'), 'OLD asar must survive staging')
        fs.writeFileSync(path.join(tmp6, 'chrome.pak'), 'OLD chrome pak must survive staging')
        // ota-config.json holds customer-specific data (channel, customer
        // ID, server URL). The bump must preserve EVERY other field and
        // change ONLY version.
        fs.mkdirSync(path.join(tmp6, 'resources'))
        const oldOtaCfg = {
          enabled: true,
          channel: 'rebrand-test',
          version: '1.0.0',
          updateServer: 'http://example.test',
          customerId: 'cust-42-MUST-BE-PRESERVED',
          extraField: { nested: 'value-MUST-SURVIVE' },
        }
        fs.writeFileSync(path.join(tmp6, 'resources', 'ota-config.json'), JSON.stringify(oldOtaCfg, null, 2))

        const pd = path.join(tmp6, '.ota-pending')
        fs.mkdirSync(pd)
        const payload = makeMinimalZip([
          { name: 'NEW.exe',    data: Buffer.from('new-launcher-binary') },
          { name: 'app.asar',   data: Buffer.from('NEW asar v2') },
          { name: 'chrome.pak', data: Buffer.from('NEW chrome pak v2') },
        ])
        fs.writeFileSync(path.join(pd, 'payload.zip'), payload)
        fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({
          version: '2.0.0', channel: 'rebrand-test', exeName: 'NEW.exe',
        }, null, 2))
        fs.writeFileSync(path.join(pd, 'READY'), new Date().toISOString())

        process.env.OTA_TEST_CURRENT_EXE = 'OLD.exe'
        delete require.cache[require.resolve('../electron/updater.js')]
        delete require.cache[require.resolve('../electron/ota-live.js')]
        const updater6 = require('../electron/updater.js')

        // Capture the cmd.exe spawn so the test can verify args without
        // actually running cmd.exe (it doesn't exist on Linux).
        const spawned = []
        const fakeSpawnFn = (cmd, args, opts) => {
          spawned.push({ cmd, args, opts })
          return { unref() {}, pid: 99999 }
        }
        let exitedWith = null
        const fakeExitFn = (code) => { exitedWith = code }

        const tmpScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-oop-tmp-'))
        const result = updater6.applyPendingUpdateOnStartup(tmp6, {
          _forceOutOfProcess: true,
          _spawnFn: fakeSpawnFn,
          _exitFn: fakeExitFn,
          _tmpDir: tmpScriptDir,
        })

        assert(result === true,
          'OOP staging: applyPendingUpdateOnStartup returns true after handoff')
        assert(exitedWith === 0,
          'OOP staging: exit hook called with code 0 (so OS releases asar lock)')

        // Pre-existing files in the install dir must be UNTOUCHED — the
        // OOP path only writes to .ota-pending/staged/ from the OLD process.
        assert(fs.readFileSync(path.join(tmp6, 'OLD.exe'), 'utf-8') === 'old-binary-must-survive-staging',
          'OOP staging: install-dir OLD.exe untouched (the cmd.exe applier handles the swap after parent exits)')
        assert(fs.readFileSync(path.join(tmp6, 'app.asar'), 'utf-8') === 'OLD asar must survive staging',
          'OOP staging: install-dir app.asar untouched (no in-process write attempted)')
        assert(fs.readFileSync(path.join(tmp6, 'chrome.pak'), 'utf-8') === 'OLD chrome pak must survive staging',
          'OOP staging: install-dir chrome.pak untouched')
        assert(!fs.existsSync(path.join(tmp6, 'NEW.exe')),
          'OOP staging: NEW.exe NOT yet in install dir (lives in staged/ until applier moves it)')

        // Staged dir must contain a complete copy of the payload.
        const stagedDir = path.join(pd, 'staged')
        assert(fs.existsSync(stagedDir),
          'OOP staging: .ota-pending/staged/ created')
        assert(fs.existsSync(path.join(stagedDir, 'NEW.exe'))
          && fs.readFileSync(path.join(stagedDir, 'NEW.exe'), 'utf-8') === 'new-launcher-binary',
          'OOP staging: staged/NEW.exe extracted (this is what apply.cmd will move into install dir)')
        assert(fs.existsSync(path.join(stagedDir, 'app.asar'))
          && fs.readFileSync(path.join(stagedDir, 'app.asar'), 'utf-8') === 'NEW asar v2',
          'OOP staging: staged/app.asar extracted (apply.cmd moves this on top of locked install asar after parent exits)')
        assert(fs.existsSync(path.join(stagedDir, 'chrome.pak'))
          && fs.readFileSync(path.join(stagedDir, 'chrome.pak'), 'utf-8') === 'NEW chrome pak v2',
          'OOP staging: staged/chrome.pak extracted')

        // Verify cmd.exe spawn args. The args contract is now small and
        // injection-free: only Node-controlled values (pid, paths,
        // whitelisted exe basename). Version + oldExe live in the staged
        // JSON files so the cmd script never sees user content.
        assert(spawned.length === 1, 'OOP staging: cmd.exe spawned exactly once')
        if (spawned.length === 1) {
          const sp = spawned[0]
          assert(sp.cmd === 'cmd.exe', 'OOP staging: spawn target is cmd.exe')
          assert(sp.args[0] === '/c', 'OOP staging: cmd.exe invoked with /c')
          assert(typeof sp.args[1] === 'string' && sp.args[1].endsWith('.cmd'),
            'OOP staging: arg[1] is the apply.cmd path')
          assert(sp.args[2] === String(process.pid),
            'OOP staging: arg[2] is parent PID (so apply.cmd waits for THIS process to exit)')
          assert(sp.args[3] === pd,
            'OOP staging: arg[3] is pending dir')
          assert(sp.args[4] === tmp6,
            'OOP staging: arg[4] is install dir')
          assert(sp.args[5] === 'NEW.exe',
            'OOP staging: arg[5] is new exe basename (resolved case-insensitively against staged/)')
          assert(sp.args.length === 6,
            'OOP staging: cmd args end at the new exe basename — version + oldExe live in staged JSON, NOT in the cmd line (no shell-injection surface)')
          assert(sp.opts && sp.opts.detached === true && sp.opts.windowsHide === true,
            'OOP staging: cmd.exe spawned detached + windowsHide so it survives our exit and runs without a visible window')

          // Verify the apply.cmd file was actually written to disk.
          const applierPath = sp.args[1]
          assert(fs.existsSync(applierPath),
            'OOP staging: apply.cmd file exists on disk at the path passed to cmd.exe')
          const applierContent = fs.readFileSync(applierPath, 'utf-8')
          assert(applierContent.startsWith('@echo off'),
            'OOP staging: apply.cmd starts with @echo off')
          assert(applierContent.includes('robocopy'),
            'OOP staging: apply.cmd uses robocopy to swap staged into install dir')
          assert(applierContent.includes('tasklist'),
            'OOP staging: apply.cmd polls tasklist to wait for parent exit (so locks release)')
          assert(applierContent.includes('timeout /t 3'),
            'OOP staging: apply.cmd grants 3s grace after parent exit so OS releases handles before robocopy')
          assert(!applierContent.includes('powershell'),
            'OOP staging: apply.cmd contains NO PowerShell — every JSON write was pre-staged in Node, eliminating the PS string-interpolation injection surface')
        }

        // Pre-staged metadata — the contents the cmd applier will move
        // into the install dir without needing PowerShell.
        const cleanupMarker = path.join(stagedDir, '.ota-cleanup.json')
        assert(fs.existsSync(cleanupMarker),
          'OOP staging: .ota-cleanup.json pre-staged in staged/ (robocopy moves it into install dir)')
        const cleanup = JSON.parse(fs.readFileSync(cleanupMarker, 'utf-8'))
        assert(Array.isArray(cleanup.deleteExes) && cleanup.deleteExes[0] === 'OLD.exe',
          'OOP staging: cleanup marker lists OLD.exe for next-launch sweep')
        assert(cleanup.nextExe === 'NEW.exe',
          'OOP staging: cleanup marker records nextExe so the launcher knows which exe should be running')

        const sidecar = path.join(stagedDir, '.ota-current-exe.json')
        assert(fs.existsSync(sidecar),
          'OOP staging: .ota-current-exe.json sidecar pre-staged (lets a manually-relaunched OLD exe self-handoff)')
        const sc = JSON.parse(fs.readFileSync(sidecar, 'utf-8'))
        assert(sc.exe === 'NEW.exe' && sc.version === '2.0.0',
          'OOP staging: sidecar carries new exe + version (JSON.stringify safely escapes both)')

        // ota-config.json: bumped version, ALL other fields preserved.
        const stagedCfg = path.join(stagedDir, 'resources', 'ota-config.json')
        assert(fs.existsSync(stagedCfg),
          'OOP staging: bumped ota-config.json pre-staged at the install-relative path (resources/ subdir)')
        const cfg = JSON.parse(fs.readFileSync(stagedCfg, 'utf-8'))
        assert(cfg.version === '2.0.0',
          'OOP staging: ota-config.json version bumped to 2.0.0')
        assert(cfg.customerId === 'cust-42-MUST-BE-PRESERVED',
          'OOP staging: customer ID preserved (NOT clobbered by the bump)')
        assert(cfg.channel === 'rebrand-test' && cfg.updateServer === 'http://example.test',
          'OOP staging: channel + updateServer preserved')
        assert(cfg.extraField && cfg.extraField.nested === 'value-MUST-SURVIVE',
          'OOP staging: nested fields preserved')

        // Apply lock file present (will be cleaned up by the cmd applier).
        assert(fs.existsSync(path.join(pd, '.apply.lock')),
          'OOP staging: .apply.lock created (atomic O_EXCL — prevents two OLD-exe instances from racing into apply)')
      } finally {
        rmrf(tmp6)
      }
    }

    // ---- Task #18: OOP path must skip when an in-flight applier already
    //      holds the .apply.lock. Prevents two OLD-exe instances from
    //      racing to wipe each other's staging. ----
    {
      const tmp7 = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-oop-skip-'))
      try {
        fs.writeFileSync(path.join(tmp7, 'OLD.exe'), 'old')
        fs.writeFileSync(path.join(tmp7, 'app.asar'), 'old asar')
        const pd = path.join(tmp7, '.ota-pending')
        fs.mkdirSync(pd)
        // Pre-create the lock file with current mtime to simulate
        // "another applier already running."
        fs.writeFileSync(path.join(pd, '.apply.lock'), '99999\nin-progress\n')
        // Pre-create staged/ as it would be from the in-flight applier.
        const stagedDir = path.join(pd, 'staged')
        fs.mkdirSync(stagedDir)
        fs.writeFileSync(path.join(stagedDir, 'NEW.exe'), 'new-from-other-applier')
        fs.writeFileSync(path.join(pd, 'payload.zip'), makeMinimalZip([
          { name: 'NEW.exe', data: Buffer.from('new') },
        ]))
        fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({
          version: '2.0.0', channel: 'rebrand-test', exeName: 'NEW.exe',
        }, null, 2))
        fs.writeFileSync(path.join(pd, 'READY'), new Date().toISOString())

        process.env.OTA_TEST_CURRENT_EXE = 'OLD.exe'
        delete require.cache[require.resolve('../electron/updater.js')]
        delete require.cache[require.resolve('../electron/ota-live.js')]
        const updater7 = require('../electron/updater.js')

        let spawnCalled = false
        let exitCalled = false
        const result = updater7.applyPendingUpdateOnStartup(tmp7, {
          _forceOutOfProcess: true,
          _spawnFn: () => { spawnCalled = true; return { unref() {} } },
          _exitFn: () => { exitCalled = true },
          _tmpDir: os.tmpdir(),
        })

        assert(result === false,
          'OOP skip-when-busy: returns false when .apply.lock is held (lets the running applier finish)')
        assert(spawnCalled === false,
          'OOP skip-when-busy: did NOT spawn another cmd.exe')
        assert(exitCalled === false,
          'OOP skip-when-busy: did NOT exit our process')
        // Staged dir from the "other applier" must remain untouched so it
        // can complete its work.
        assert(fs.readFileSync(path.join(stagedDir, 'NEW.exe'), 'utf-8') === 'new-from-other-applier',
          'OOP skip-when-busy: staged dir contents preserved')
        assert(fs.existsSync(path.join(pd, '.apply.lock')),
          'OOP skip-when-busy: lock file preserved (we did not steal it)')
      } finally {
        rmrf(tmp7)
      }
    }

    // ---- Task #18: defense-in-depth — manifest.exeName that doesn't
    //      match the safe-basename whitelist (e.g. contains shell
    //      metacharacters) must be rejected before staging spawns
    //      cmd.exe. This kills the cmd-injection vector at the door even
    //      though resolution is case-insensitive against staged/. ----
    {
      const tmp8 = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-oop-evil-'))
      try {
        fs.writeFileSync(path.join(tmp8, 'OLD.exe'), 'old')
        const pd = path.join(tmp8, '.ota-pending')
        fs.mkdirSync(pd)
        fs.writeFileSync(path.join(pd, 'payload.zip'), makeMinimalZip([
          { name: 'evil & calc.exe', data: Buffer.from('payload') },
        ]))
        fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({
          version: '2.0.0', channel: 'rebrand-test', exeName: 'evil & calc.exe',
        }, null, 2))
        fs.writeFileSync(path.join(pd, 'READY'), new Date().toISOString())

        process.env.OTA_TEST_CURRENT_EXE = 'OLD.exe'
        delete require.cache[require.resolve('../electron/updater.js')]
        delete require.cache[require.resolve('../electron/ota-live.js')]
        const updater8 = require('../electron/updater.js')

        let spawnCalled = false
        let exitCalled = false
        const result = updater8.applyPendingUpdateOnStartup(tmp8, {
          _forceOutOfProcess: true,
          _spawnFn: () => { spawnCalled = true; return { unref() {} } },
          _exitFn: () => { exitCalled = true },
          _tmpDir: os.tmpdir(),
        })

        assert(result === false,
          'OOP exeName whitelist: returns false when manifest exeName contains shell metacharacters')
        assert(spawnCalled === false,
          'OOP exeName whitelist: did NOT spawn cmd.exe with an unsafe basename')
        assert(exitCalled === false,
          'OOP exeName whitelist: did NOT exit our process')
        assert(fs.existsSync(path.join(pd, 'FAILED')),
          'OOP exeName whitelist: FAILED marker written for diagnostics')
      } finally {
        rmrf(tmp8)
      }
    }
  } finally {
    rmrf(tmp)
    delete process.env.OTA_TEST_CURRENT_EXE
  }

  console.log('')
  console.log('=== ' + pass + ' passed, ' + fail + ' failed ===')
  process.exit(fail === 0 ? 0 : 1)
}

main()
