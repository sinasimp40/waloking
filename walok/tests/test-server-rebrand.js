// Pure-JS regression test for Task #17 (server.exe rebrand-style OTA update).
//
// Mirrors tests/test-rebrand-update.js but drives the SERVER updater
// (server/electron/updater.js). Adds two new assertions specific to Task
// #17:
//   1. Orphan exe deletion across rebrand (same flow as launcher).
//   2. Orphan-shortcut sweep — the cleanup marker also removes any Windows
//      .lnk shortcut on the user's Desktop / Start menu that points at the
//      now-deleted exe. Verified via OTA_TEST_SHORTCUT_DIRS, which lets the
//      sweep treat an arbitrary tmpdir as if it were the Start menu.

const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')

let pass = 0, fail = 0
function ok(msg) { pass++; console.log('  PASS  ' + msg) }
function bad(msg) { fail++; console.log('  FAIL  ' + msg) }
function assert(cond, msg) { cond ? ok(msg) : bad(msg) }

function makeMinimalZip(entries) {
  const parts = []
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const compressed = zlib.deflateRawSync(e.data)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0, 6)
    lfh.writeUInt16LE(8, 8)
    lfh.writeUInt16LE(0, 10)
    lfh.writeUInt16LE(0, 12)
    lfh.writeUInt32LE(0, 14)
    lfh.writeUInt32LE(compressed.length, 18)
    lfh.writeUInt32LE(e.data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)
    parts.push(lfh, nameBuf, compressed)
  }
  return Buffer.concat(parts)
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) {}
}

// Build a minimal Windows .lnk (Shell Link Binary File) that readLnkTarget()
// can parse. We only need:
//   - the 0x4C signature in the first 4 bytes ("L"-shaped marker)
//   - a recognizable ASCII <drive>:\\...\\<exeName> string somewhere in the body
// readLnkTarget() does a regex sweep, so a bare LinkInfo is not required.
function makeFakeLnk(targetPath) {
  const sig = Buffer.alloc(76, 0)
  sig.writeUInt32LE(0x0000004C, 0) // HeaderSize / Shell Link signature
  // A real .lnk also carries a CLSID at offset 4 + flags/etc. The header just
  // needs to be at least 76 bytes; the rest can be zero for our parser.
  const body = Buffer.from(targetPath, 'latin1')
  return Buffer.concat([sig, body])
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-server-rebrand-test-'))
  const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-srv-desktop-'))
  const startMenuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-srv-startmenu-'))
  console.log('TEMP install dir: ' + tmp)
  console.log('TEMP desktop dir: ' + desktopDir)
  console.log('TEMP start menu dir: ' + startMenuDir)

  // Point the shortcut sweep at our tmp dirs (so we don't poke the real
  // user's Desktop/Start menu in the test environment).
  process.env.OTA_TEST_SHORTCUT_DIRS = [desktopDir, startMenuDir].join(path.delimiter)

  try {
    // ---- Set up the "currently installed server" (DENFI-server build) ----
    fs.writeFileSync(path.join(tmp, 'OLD-server.exe'), 'old-server-binary-v1')
    fs.writeFileSync(path.join(tmp, 'app.asar'), 'OLD server ASAR v1.0.0')
    fs.writeFileSync(path.join(tmp, 'ota-config.json'), JSON.stringify({
      enabled: true,
      channel: 'rebrand-test-server',
      version: '1.0.0',
      updateServer: 'http://example.test',
    }, null, 2))

    // Stage shortcuts pointing at the OLD exe — both inside and outside our
    // install dir. The sweep must remove the in-tree one, leave the
    // out-of-tree one alone (safety: another app might share the basename).
    const ourShortcutPath = path.join(desktopDir, 'EXAMPLE CAFE Server.lnk')
    const ourStartMenuShortcut = path.join(startMenuDir, 'EXAMPLE CAFE Server.lnk')
    const unrelatedShortcut = path.join(desktopDir, 'Unrelated App.lnk')
    fs.writeFileSync(ourShortcutPath, makeFakeLnk(path.join(tmp, 'OLD-server.exe')))
    fs.writeFileSync(ourStartMenuShortcut, makeFakeLnk(path.join(tmp, 'OLD-server.exe')))
    // Unrelated shortcut: same basename "OLD-server.exe" but in a totally
    // different install dir — sweep MUST NOT touch it.
    fs.writeFileSync(unrelatedShortcut,
      makeFakeLnk(path.join(os.tmpdir(), 'some-other-app', 'OLD-server.exe')))

    // ---- Stage a pending update (rebrand DENFI-server -> BLAST-server) ----
    const pendingDir = path.join(tmp, '.ota-pending')
    fs.mkdirSync(pendingDir)
    const payloadZip = makeMinimalZip([
      { name: 'NEW-server.exe', data: Buffer.from('new-server-binary-v2') },
      { name: 'app.asar', data: Buffer.from('NEW server ASAR v2.0.0') },
    ])
    fs.writeFileSync(path.join(pendingDir, 'payload.zip'), payloadZip)
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify({
      version: '2.0.0',
      channel: 'rebrand-test-server',
      exeName: 'NEW-server.exe',
    }, null, 2))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())

    // ---- Become the OLD server exe and require the server updater ----
    process.env.OTA_TEST_CURRENT_EXE = 'OLD-server.exe'
    delete require.cache[require.resolve('../server/electron/updater.js')]
    delete require.cache[require.resolve('../server/electron/ota-live.js')]
    const updater = require('../server/electron/updater.js')

    // ---- Drive the apply step ----
    const applied = updater.applyPendingUpdateOnStartup(tmp)

    assert(applied === true, 'server applyPendingUpdateOnStartup returns true')
    assert(fs.existsSync(path.join(tmp, 'NEW-server.exe')), 'NEW-server.exe was extracted into install dir')
    assert(
      fs.readFileSync(path.join(tmp, 'NEW-server.exe'), 'utf-8') === 'new-server-binary-v2',
      'NEW-server.exe has the v2 payload bytes',
    )
    assert(
      fs.readFileSync(path.join(tmp, 'app.asar'), 'utf-8') === 'NEW server ASAR v2.0.0',
      'app.asar overwritten with v2 contents',
    )
    assert(fs.existsSync(path.join(tmp, 'OLD-server.exe')),
      'OLD-server.exe is still on disk (Windows would have it locked at this point)')
    assert(!fs.existsSync(pendingDir), '.ota-pending/ removed after successful apply')

    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'ota-config.json'), 'utf-8'))
    assert(cfg.version === '2.0.0', 'server ota-config.json version bumped to 2.0.0')

    const markerPath = path.join(tmp, '.ota-cleanup.json')
    assert(fs.existsSync(markerPath), '.ota-cleanup.json marker written for orphan server exe')
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
    assert(
      Array.isArray(marker.deleteExes) && marker.deleteExes.includes('OLD-server.exe'),
      'cleanup marker lists OLD-server.exe in deleteExes',
    )

    // Architect round-3 fix: per-exe identity sidecar must be written.
    const sidecarPath = path.join(tmp, '.ota-current-exe.json')
    assert(fs.existsSync(sidecarPath), '.ota-current-exe.json written by server apply step')
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'))
    assert(sidecar.exe === 'NEW-server.exe', 'sidecar.exe = NEW-server.exe (canonical successor)')
    assert(sidecar.version === '2.0.0', 'sidecar.version = 2.0.0')

    // INTEGRATION test: relaunching OLD-server.exe must detect stale via
    // the sidecar tier without relying on OTA_TEST_BUNDLED_VERSION.
    const prevHook = process.env.OTA_TEST_BUNDLED_VERSION
    delete process.env.OTA_TEST_BUNDLED_VERSION
    try {
      const stale = updater.detectVersionMismatch(tmp, 'OLD-server.exe')
      assert(stale.stale === true,
        'OLD-server.exe relaunched after apply: stale via sidecar (no env hook)')
      assert(stale.reason === 'sidecar-points-elsewhere',
        'reason=sidecar-points-elsewhere (proves tier-1 active)')
      assert(stale.candidate && stale.candidate.basename === 'NEW-server.exe',
        'OLD-server.exe would correctly hand off to NEW-server.exe')
      assert(stale.candidate.source === 'current-exe-record',
        'handoff source is the highest-confidence sidecar tier')
    } finally {
      if (prevHook !== undefined) process.env.OTA_TEST_BUNDLED_VERSION = prevHook
    }

    // ---- Simulate the next launch: we are now the NEW server exe ----
    process.env.OTA_TEST_CURRENT_EXE = 'NEW-server.exe'

    updater.sweepCleanupMarker(tmp)

    assert(!fs.existsSync(path.join(tmp, 'OLD-server.exe')),
      'next launch sweep deleted the orphan OLD-server.exe')
    assert(fs.existsSync(path.join(tmp, 'NEW-server.exe')),
      'NEW-server.exe (the running exe) was NOT touched by the sweep')
    assert(!fs.existsSync(markerPath),
      '.ota-cleanup.json removed once the orphan list is empty')

    // ---- Task #17 NEW: orphan-shortcut sweep ----
    assert(!fs.existsSync(ourShortcutPath),
      'Desktop shortcut pointing at OLD-server.exe was removed')
    assert(!fs.existsSync(ourStartMenuShortcut),
      'Start-menu shortcut pointing at OLD-server.exe was removed')
    assert(fs.existsSync(unrelatedShortcut),
      'Unrelated shortcut (target outside our install dir) was NOT removed (safety check)')

    // ---- Edge case: same-name update must NOT write a marker ----
    rmrf(path.join(tmp, '.ota-cleanup.json'))
    fs.writeFileSync(path.join(tmp, 'ota-config.json'), JSON.stringify({
      enabled: true, channel: 'rebrand-test-server', version: '2.0.0', updateServer: 'http://example.test',
    }, null, 2))
    fs.mkdirSync(pendingDir)
    fs.writeFileSync(path.join(pendingDir, 'payload.zip'), makeMinimalZip([
      { name: 'NEW-server.exe', data: Buffer.from('new-server-binary-v3') },
    ]))
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify({
      version: '3.0.0', channel: 'rebrand-test-server', exeName: 'NEW-server.exe',
    }, null, 2))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())

    const applied2 = updater.applyPendingUpdateOnStartup(tmp)
    assert(applied2 === true, 'same-name server update applies cleanly')
    assert(!fs.existsSync(path.join(tmp, '.ota-cleanup.json')),
      'no cleanup marker is written when the new exe name matches the running server exe')

    // ---- Edge case: legacy manifest without exeName, but a new .exe added ----
    rmrf(pendingDir)
    fs.mkdirSync(pendingDir)
    fs.writeFileSync(path.join(pendingDir, 'payload.zip'), makeMinimalZip([
      { name: 'BLAST-server.exe', data: Buffer.from('blast-server-binary-v4') },
      { name: 'app.asar', data: Buffer.from('NEW server ASAR v4') },
    ]))
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify({
      version: '4.0.0', channel: 'rebrand-test-server',
    }, null, 2))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())
    process.env.OTA_TEST_CURRENT_EXE = 'NEW-server.exe'

    const applied3 = updater.applyPendingUpdateOnStartup(tmp)
    assert(applied3 === true, 'legacy server manifest (no exeName) still applies')
    assert(fs.existsSync(path.join(tmp, '.ota-cleanup.json')),
      'discoverNewExe finds BLAST-server.exe -> cleanup marker is written')
    const marker3 = JSON.parse(fs.readFileSync(path.join(tmp, '.ota-cleanup.json'), 'utf-8'))
    assert(marker3.deleteExes.includes('NEW-server.exe'),
      'legacy-flow marker lists the now-orphaned previous server exe (NEW-server.exe)')

    rmrf(path.join(tmp, '.ota-cleanup.json'))
    rmrf(path.join(tmp, 'BLAST-server.exe'))

    // ---- Edge case: case-only manifest exeName must NOT trigger a marker ----
    fs.mkdirSync(pendingDir)
    fs.writeFileSync(path.join(pendingDir, 'payload.zip'), makeMinimalZip([
      { name: 'NEW-server.exe', data: Buffer.from('new-server-binary-v5') },
    ]))
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify({
      version: '5.0.0', channel: 'rebrand-test-server', exeName: 'new-SERVER.exe',
    }, null, 2))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())

    const applied4 = updater.applyPendingUpdateOnStartup(tmp)
    assert(applied4 === true, 'case-only exeName difference still applies cleanly')
    assert(!fs.existsSync(path.join(tmp, '.ota-cleanup.json')),
      'case-only exeName difference does NOT write a cleanup marker (would otherwise self-delete on Windows)')

    // ---- Edge case: malformed cleanup marker is removed gracefully ----
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), '{ malformed json')
    updater.sweepCleanupMarker(tmp)
    assert(!fs.existsSync(path.join(tmp, '.ota-cleanup.json')),
      'malformed cleanup marker is deleted by sweepCleanupMarker')

    // ---- Defense-in-depth: tampered marker with traversal entries ----
    const sentinel = path.join(os.tmpdir(), 'ota-srv-sentinel-' + process.pid + '.dat')
    fs.writeFileSync(sentinel, 'must-not-be-deleted')
    fs.writeFileSync(path.join(tmp, 'unrelated-server.exe'), 'orphan-from-traversal-test')
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), JSON.stringify({
      writtenAt: new Date().toISOString(),
      deleteExes: [
        '../../' + path.basename(sentinel),
        '/tmp/' + path.basename(sentinel),
        'unrelated-server.exe',
      ],
    }))
    updater.sweepCleanupMarker(tmp)
    assert(fs.existsSync(sentinel),
      'sweep does NOT follow ../ in marker entries — sentinel survives')
    assert(!fs.existsSync(path.join(tmp, 'unrelated-server.exe')),
      'sweep still deletes the legitimate orphan listed alongside traversal attempts')
    try { fs.unlinkSync(sentinel) } catch (_) {}

    // ---- Direct unit check: removeShortcutsTo() honors install-dir safety ----
    // Re-arm both shortcuts; ask the helper to remove only one orphan.
    fs.writeFileSync(ourShortcutPath, makeFakeLnk(path.join(tmp, 'OLD-server.exe')))
    fs.writeFileSync(unrelatedShortcut,
      makeFakeLnk(path.join(os.tmpdir(), 'some-other-app', 'OLD-server.exe')))
    const removed = updater.removeShortcutsTo(tmp, ['OLD-server.exe'])
    assert(Array.isArray(removed) && removed.includes(ourShortcutPath),
      'removeShortcutsTo reports our in-tree shortcut as removed')
    assert(!fs.existsSync(ourShortcutPath),
      'our in-tree shortcut for OLD-server.exe was deleted')
    assert(fs.existsSync(unrelatedShortcut),
      'unrelated shortcut with a foreign-install-dir target was preserved')

    // ---- Regression: partial-extract failure must clean up the new server
    //      exe AND preserve READY for retry (mirrors the launcher test).
    //      Without this fix, the partially-dropped DENFING-server.exe sits
    //      on disk with stale resources/app.asar, and double-clicking it
    //      shows "Application Integrity Error" — exactly the bug the field
    //      reported on the per-customer rebrand. ----
    {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-srv-partial-fail-'))
      try {
        fs.writeFileSync(path.join(tmp2, 'OLD-server.exe'), 'old-server-binary')
        fs.writeFileSync(path.join(tmp2, 'app.asar'), 'OLD server asar v1')
        // Replaced unlocked file must be restored to OLD content via rollback.
        fs.writeFileSync(path.join(tmp2, 'chrome.pak'), 'OLD chrome pak v1')
        fs.writeFileSync(path.join(tmp2, 'ota-config.json'), JSON.stringify({
          enabled: true, channel: 'rebrand-test-server', version: '1.0.0',
          updateServer: 'http://example.test',
        }, null, 2))

        const pd = path.join(tmp2, '.ota-pending')
        fs.mkdirSync(pd)
        fs.writeFileSync(path.join(pd, 'payload.zip'), makeMinimalZip([
          { name: 'NEW-server.exe', data: Buffer.from('new-server-binary-v2') },
          { name: 'chrome.pak', data: Buffer.from('NEW chrome pak v2') },
          { name: 'app.asar', data: Buffer.from('NEW server asar v2') },
        ]))
        fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({
          version: '2.0.0', channel: 'rebrand-test-server', exeName: 'NEW-server.exe',
        }, null, 2))
        const readyPath = path.join(pd, 'READY')
        fs.writeFileSync(readyPath, new Date().toISOString())

        process.env.OTA_TEST_CURRENT_EXE = 'OLD-server.exe'
        delete require.cache[require.resolve('../server/electron/updater.js')]
        delete require.cache[require.resolve('../server/electron/ota-live.js')]
        const srvUpdater = require('../server/electron/updater.js')

        // Patch fs.writeFileSync to fail just the asar tmp write — simulates
        // the running server holding resources/app.asar mmap'd on Windows.
        const origWFS = fs.writeFileSync
        fs.writeFileSync = function (p, data, opts) {
          if (typeof p === 'string' && p.endsWith('app.asar.ota-tmp')) {
            const err = new Error('SIMULATED: server app.asar tmp write failed (mimicking Windows asar file lock)')
            err.code = 'EBUSY'
            throw err
          }
          return origWFS(p, data, opts)
        }
        let appliedFail
        try {
          appliedFail = srvUpdater.applyPendingUpdateOnStartup(tmp2)
        } finally {
          fs.writeFileSync = origWFS
        }

        assert(appliedFail === false,
          'server partial-extract failure: applyPendingUpdateOnStartup returns false')
        assert(fs.existsSync(readyPath),
          'server partial-extract failure: READY is preserved for retry on the next launch')
        assert(!fs.existsSync(path.join(tmp2, 'NEW-server.exe')),
          'server partial-extract failure: the partially-dropped NEW-server.exe was swept (would otherwise show "Application Integrity Error" on double-click)')
        assert(fs.existsSync(path.join(tmp2, 'OLD-server.exe')),
          'server partial-extract failure: pre-existing OLD-server.exe is preserved')
        assert(
          fs.readFileSync(path.join(tmp2, 'app.asar'), 'utf-8') === 'OLD server asar v1',
          'server partial-extract failure: app.asar was NOT replaced',
        )
        // CRITICAL: chrome.pak gets RESTORED to OLD content via rollback.
        assert(
          fs.readFileSync(path.join(tmp2, 'chrome.pak'), 'utf-8') === 'OLD chrome pak v1',
          'server partial-extract failure: chrome.pak was RESTORED to OLD content via rollback (not left at NEW content -> would cause black-screen mismatch)',
        )
        const leftoverTmp = fs.readdirSync(tmp2).filter(n => n.endsWith('.ota-tmp') || n.endsWith('.ota-bak'))
        assert(leftoverTmp.length === 0,
          'server partial-extract failure: no .ota-tmp / .ota-bak scratch files left in the install dir after rollback')

        const failedMarkerPath = path.join(pd, 'FAILED')
        assert(fs.existsSync(failedMarkerPath),
          'server partial-extract failure: FAILED diagnostics marker written')
        const failedDoc = JSON.parse(fs.readFileSync(failedMarkerPath, 'utf-8'))
        assert(failedDoc.consecutiveFailures === 1,
          'server partial-extract failure: consecutiveFailures = 1 on first attempt')
        assert(failedDoc.gaveUp === false,
          'server partial-extract failure: gaveUp = false on first attempt')
        assert(failedDoc.rolledBack && typeof failedDoc.rolledBack.removed === 'number'
          && typeof failedDoc.rolledBack.restored === 'number',
          'server partial-extract failure: FAILED diagnostics records rollback counts')
        assert(failedDoc.rolledBack.removed >= 1 && failedDoc.rolledBack.restored >= 1,
          'server partial-extract failure: rollback removed at least 1 new file (NEW-server.exe) AND restored at least 1 replaced file (chrome.pak)')

        // Runaway-retry guard: 5 consecutive failures must drop READY.
        for (let i = 2; i <= 5; i++) {
          fs.writeFileSync(readyPath, new Date().toISOString())
          fs.writeFileSync = function (p, data, opts) {
            if (typeof p === 'string' && p.endsWith('app.asar.ota-tmp')) {
              const err = new Error('SIMULATED locked asar')
              err.code = 'EBUSY'
              throw err
            }
            return origWFS(p, data, opts)
          }
          try {
            srvUpdater.applyPendingUpdateOnStartup(tmp2)
          } finally {
            fs.writeFileSync = origWFS
          }
        }
        const finalFailed = JSON.parse(fs.readFileSync(failedMarkerPath, 'utf-8'))
        assert(finalFailed.consecutiveFailures === 5,
          'server runaway-retry guard: consecutiveFailures climbs to 5')
        assert(finalFailed.gaveUp === true,
          'server runaway-retry guard: gaveUp = true once the cap is hit')
        assert(!fs.existsSync(readyPath),
          'server runaway-retry guard: READY is dropped after MAX_CONSECUTIVE_APPLY_FAILURES')
      } finally {
        rmrf(tmp2)
      }
    }

    // ---- Regression (architect nit): hard throw MID-extract on the server
    //      side must also sweep the partially-dropped server exe via the
    //      outer catch. ----
    {
      const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-srv-mid-throw-'))
      try {
        fs.writeFileSync(path.join(tmp3, 'OLD-server.exe'), 'old-server-binary')
        fs.writeFileSync(path.join(tmp3, 'app.asar'), 'OLD server asar v1')
        fs.writeFileSync(path.join(tmp3, 'ota-config.json'), JSON.stringify({
          enabled: true, channel: 'rebrand-test-server', version: '1.0.0',
          updateServer: 'http://example.test',
        }, null, 2))

        const pd = path.join(tmp3, '.ota-pending')
        fs.mkdirSync(pd)
        const validZip = makeMinimalZip([
          { name: 'NEW-server.exe', data: Buffer.from('new-server-binary-mid-throw') },
        ])
        const truncatedTail = Buffer.from([0x50, 0x4B, 0x03, 0x04])
        fs.writeFileSync(path.join(pd, 'payload.zip'), Buffer.concat([validZip, truncatedTail]))
        fs.writeFileSync(path.join(pd, 'manifest.json'), JSON.stringify({
          version: '2.0.0', channel: 'rebrand-test-server', exeName: 'NEW-server.exe',
        }, null, 2))
        const readyPath = path.join(pd, 'READY')
        fs.writeFileSync(readyPath, new Date().toISOString())

        process.env.OTA_TEST_CURRENT_EXE = 'OLD-server.exe'
        delete require.cache[require.resolve('../server/electron/updater.js')]
        delete require.cache[require.resolve('../server/electron/ota-live.js')]
        const srvUpdater3 = require('../server/electron/updater.js')

        const appliedThrow = srvUpdater3.applyPendingUpdateOnStartup(tmp3)

        assert(appliedThrow === false,
          'server mid-extract throw: applyPendingUpdateOnStartup returns false')
        assert(fs.existsSync(readyPath),
          'server mid-extract throw: READY preserved')
        assert(!fs.existsSync(path.join(tmp3, 'NEW-server.exe')),
          'server mid-extract throw: outer-catch sweep removed partial NEW-server.exe')
        assert(fs.existsSync(path.join(tmp3, 'OLD-server.exe')),
          'server mid-extract throw: pre-existing OLD-server.exe preserved')

        const failedMarker = path.join(pd, 'FAILED')
        assert(fs.existsSync(failedMarker),
          'server mid-extract throw: FAILED marker written by outer catch')
        const failedDoc = JSON.parse(fs.readFileSync(failedMarker, 'utf-8'))
        assert(failedDoc.consecutiveFailures === 1,
          'server mid-extract throw: consecutiveFailures = 1')
        assert(failedDoc.rolledBack && typeof failedDoc.rolledBack.removed === 'number',
          'server mid-extract throw: outer-catch FAILED records rollback counts')
        assert(failedDoc.rolledBack.removed >= 1,
          'server mid-extract throw: rollback removed at least 1 new file (NEW-server.exe) before the throw was handled')
      } finally {
        rmrf(tmp3)
      }
    }
  } finally {
    rmrf(tmp)
    rmrf(desktopDir)
    rmrf(startMenuDir)
    delete process.env.OTA_TEST_CURRENT_EXE
    delete process.env.OTA_TEST_SHORTCUT_DIRS
  }

  console.log('\n=== ' + pass + ' pass / ' + fail + ' fail ===')
  process.exit(fail === 0 ? 0 : 1)
}

main()
