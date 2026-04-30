// Pure-JS regression tests for Task #3 (orphan-exe cleanup +
// server.exe auto-restart on OTA). Mirrors the style of
// walok/tests/test-rebrand-update.js: stubs the install layout and drives
// the SAME functions production code calls, with no real Electron runtime.
//
// Why this lives in walok/electron/ instead of walok/tests/: Task #3
// asked for `node walok/electron/test-updater.js` as the canonical
// entrypoint matching walok/update-server/test-job-runner.js. The
// existing tests/test-rebrand-update.js already covers the rebrand
// happy-path; this file covers the four NEW behaviors:
//   1. listTopLevelExesInZip identifies *.exe entries from a payload
//   2. scanForOrphanExes adds extras (not running, not new, not in payload)
//   3. self-defense at init: marked-as-orphan triggers spawn-and-exit
//   4. scheduleSelfRelaunch is a no-op on non-Windows
//   5. gracefulQuitForUpdate schedules a quit (does not exit immediately)
//   6. scheduleAutoQuitAfterStage respects OTA_DISABLE_AUTO_QUIT

const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const childProcess = require('child_process')

let pass = 0, fail = 0
function ok(msg) { pass++; console.log('  PASS  ' + msg) }
function bad(msg) { fail++; console.log('  FAIL  ' + msg) }
function assert(cond, msg) { cond ? ok(msg) : bad(msg) }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch (_) {} }

// Same minimal-zip helper as test-rebrand-update.js — a bare LFH stream is
// enough for the updater's hand-rolled extractZip to walk.
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

function freshRequire(modPath) {
  delete require.cache[require.resolve(modPath)]
  return require(modPath)
}

function testListTopLevelExesInZip(updater) {
  console.log('\n--- listTopLevelExesInZip ---')
  // Mixed: top-level .exe (kept), nested .exe (skipped), non-exe top-level (skipped),
  // path-traversal name (skipped), backslash-prefixed (skipped).
  const buf = makeMinimalZip([
    { name: 'BLAST.exe',          data: Buffer.from('top-level-keep') },
    { name: 'server.exe',         data: Buffer.from('top-level-keep-2') },
    { name: 'resources/help.exe', data: Buffer.from('nested-skip') },
    { name: 'subdir\\nested.exe', data: Buffer.from('nested-backslash-skip') },
    { name: 'app.asar',           data: Buffer.from('not-exe-skip') },
    { name: '../escape.exe',      data: Buffer.from('traversal-skip') },
  ])
  const got = updater.listTopLevelExesInZip(buf).sort()
  const want = ['BLAST.exe', 'server.exe'].sort()
  assert(JSON.stringify(got) === JSON.stringify(want),
    'returns top-level *.exe basenames only (got=' + JSON.stringify(got) + ')')
  assert(updater.listTopLevelExesInZip(Buffer.alloc(0)).length === 0,
    'empty buffer returns []')
  assert(updater.listTopLevelExesInZip(Buffer.from('not a zip at all')).length === 0,
    'garbage buffer returns [] (no LFH signature)')
}

function testScanForOrphanExes(updater) {
  console.log('\n--- scanForOrphanExes ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-orphan-scan-'))
  try {
    fs.writeFileSync(path.join(tmp, 'BLAST.exe'),     'running')
    fs.writeFileSync(path.join(tmp, 'BLASTING.exe'),  'new-from-payload')
    fs.writeFileSync(path.join(tmp, 'OLD-NAME.exe'),  'stale-from-previous-rebrand')
    fs.writeFileSync(path.join(tmp, 'app.asar'),      'not-an-exe')

    const orphans = updater.scanForOrphanExes(
      tmp,
      ['BLASTING.exe'],   // payload's top-level exes
      'BLAST.exe',        // current running exe
      'BLASTING.exe',     // resolved new exe
    )
    assert(orphans.length === 1 && orphans[0] === 'OLD-NAME.exe',
      'scan finds OLD-NAME.exe (got=' + JSON.stringify(orphans) + ')')

    // Case-insensitive: payload entry "BLASTING.exe" must exclude "blasting.EXE"
    fs.writeFileSync(path.join(tmp, 'mixed.EXE'), 'mixed-case-stale')
    const mixed = updater.scanForOrphanExes(
      tmp, ['blasting.EXE'], 'BLAST.exe', 'BLASTING.exe',
    ).sort()
    assert(mixed.includes('OLD-NAME.exe') && mixed.includes('mixed.EXE'),
      'case-insensitive: still finds mixed.EXE alongside OLD-NAME.exe (got=' + JSON.stringify(mixed) + ')')
    assert(!mixed.some(n => n.toLowerCase() === 'blasting.exe'),
      'case-insensitive: payload exe BLASTING.exe excluded under any casing')

    // Empty payload list (legacy manifest) — only running + newExeName protect.
    rmrf(path.join(tmp, 'mixed.EXE'))
    const legacy = updater.scanForOrphanExes(tmp, [], 'BLAST.exe', 'BLASTING.exe').sort()
    assert(legacy.length === 1 && legacy[0] === 'OLD-NAME.exe',
      'legacy (no payload exe list): still finds OLD-NAME.exe')

    // Non-existent appRoot — must not throw.
    let threw = false
    try { updater.scanForOrphanExes('/no/such/dir/should/not/exist', [], 'x.exe', 'y.exe') }
    catch (_) { threw = true }
    assert(!threw, 'missing appRoot does not throw')
  } finally {
    rmrf(tmp)
  }
}

function testOrphanScanInsideApply(updater) {
  console.log('\n--- orphan scan integrated into applyPendingUpdateOnStartup ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-orphan-apply-'))
  try {
    // Pre-existing install: BLAST.exe (running), OLD-NAME.exe (stale orphan
    // from a previous failed rebrand). app.asar v1.
    fs.writeFileSync(path.join(tmp, 'BLAST.exe'), 'running-binary')
    fs.writeFileSync(path.join(tmp, 'OLD-NAME.exe'), 'stale-orphan-from-old-rebrand')
    fs.writeFileSync(path.join(tmp, 'app.asar'), 'v1 asar')
    fs.writeFileSync(path.join(tmp, 'ota-config.json'), JSON.stringify({
      enabled: true, channel: 'orphan-test', version: '1.0.0', updateServer: 'http://example.test',
    }))

    // New payload renames BLAST -> BLASTING. Manifest declares the rename.
    const pendingDir = path.join(tmp, '.ota-pending')
    fs.mkdirSync(pendingDir)
    fs.writeFileSync(path.join(pendingDir, 'payload.zip'), makeMinimalZip([
      { name: 'BLASTING.exe', data: Buffer.from('new-binary-v2') },
      { name: 'app.asar',     data: Buffer.from('v2 asar') },
    ]))
    fs.writeFileSync(path.join(pendingDir, 'manifest.json'), JSON.stringify({
      version: '2.0.0', channel: 'orphan-test', exeName: 'BLASTING.exe',
    }))
    fs.writeFileSync(path.join(pendingDir, 'READY'), new Date().toISOString())

    process.env.OTA_TEST_CURRENT_EXE = 'BLAST.exe'
    const applied = updater.applyPendingUpdateOnStartup(tmp)
    assert(applied === true, 'apply returns true')

    const marker = JSON.parse(fs.readFileSync(path.join(tmp, '.ota-cleanup.json'), 'utf-8'))
    assert(marker.deleteExes.includes('BLAST.exe'),
      'cleanup marker lists the running OLD exe (rebrand-aware step)')
    assert(marker.deleteExes.includes('OLD-NAME.exe'),
      'cleanup marker ALSO lists OLD-NAME.exe (orphan scan caught it)')
    assert(!marker.deleteExes.includes('BLASTING.exe'),
      'cleanup marker does NOT list the new exe from the payload')
  } finally {
    rmrf(tmp)
    delete process.env.OTA_TEST_CURRENT_EXE
  }
}

function testPeekAndSelfMarkedOrphan(updater) {
  console.log('\n--- peekCleanupMarker + isSelfMarkedAsOrphan ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-self-marked-'))
  try {
    process.env.OTA_TEST_CURRENT_EXE = 'OLD.exe'
    assert(!updater.isSelfMarkedAsOrphan(tmp),
      'no marker present -> not self-marked')

    // Marker with someone else's name -> not self-marked.
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), JSON.stringify({
      writtenAt: new Date().toISOString(), deleteExes: ['SOMEONE-ELSE.exe'],
    }))
    assert(!updater.isSelfMarkedAsOrphan(tmp),
      'marker without our basename -> not self-marked')

    // Marker that includes our basename -> self-marked.
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), JSON.stringify({
      writtenAt: new Date().toISOString(), deleteExes: ['SOMEONE-ELSE.exe', 'OLD.exe'],
    }))
    assert(updater.isSelfMarkedAsOrphan(tmp),
      'marker including our basename -> self-marked')

    // Case-only difference -> still self-marked (Windows is case-insensitive).
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), JSON.stringify({
      writtenAt: new Date().toISOString(), deleteExes: ['old.EXE'],
    }))
    assert(updater.isSelfMarkedAsOrphan(tmp),
      'case-only difference (old.EXE vs OLD.exe) -> still self-marked')

    // peekCleanupMarker must NOT delete the marker.
    assert(fs.existsSync(path.join(tmp, '.ota-cleanup.json')),
      'peekCleanupMarker did not delete the marker (it must persist for sweepCleanupMarker)')

    // Path-traversal entry collapses to basename — no escape.
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), JSON.stringify({
      writtenAt: new Date().toISOString(), deleteExes: ['../../etc/OLD.exe'],
    }))
    assert(updater.isSelfMarkedAsOrphan(tmp),
      'tampered path-traversal entry still resolves by basename to OLD.exe')

    // Malformed JSON -> graceful empty list.
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), '{ not valid')
    assert(!updater.isSelfMarkedAsOrphan(tmp),
      'malformed marker -> not self-marked (graceful)')
    assert(updater.peekCleanupMarker(tmp).length === 0,
      'malformed marker -> peek returns []')
  } finally {
    rmrf(tmp)
    delete process.env.OTA_TEST_CURRENT_EXE
  }
}

function testServerScheduleSelfRelaunchNonWindows(serverUpdater) {
  console.log('\n--- scheduleSelfRelaunch non-Windows behavior ---')
  // Without the OTA_TEST_FORCE_RELAUNCH override, this is a no-op on Linux.
  delete process.env.OTA_TEST_FORCE_RELAUNCH
  const got = serverUpdater.scheduleSelfRelaunch('/tmp/server.exe', 5)
  assert(got === false, 'returns false on non-Windows (no spawn attempt)')
}

// Verify the spawn payload by patching child_process.spawn BEFORE the
// updater is required (the updater destructures `spawn` at require-time, so
// post-load monkey-patching won't reach it). We get a fresh module instance
// scoped to this test only — the rest of the suite continues to use the
// "outer" updater module loaded with the real spawn.
//
// scheduleSelfRelaunch is idempotent (defense against architect finding 3),
// so each invocation we want to verify needs a freshly-required module.
function withPatchedSpawn(fn) {
  const realSpawn = childProcess.spawn
  let spawnCall = null
  childProcess.spawn = function (cmd, args, opts) {
    spawnCall = { cmd, args, opts }
    return { unref() {}, on() {} }
  }
  delete require.cache[require.resolve('../server/electron/updater.js')]
  try {
    const scoped = require('../server/electron/updater.js')
    return fn(scoped, () => spawnCall)
  } finally {
    childProcess.spawn = realSpawn
    delete require.cache[require.resolve('../server/electron/updater.js')]
  }
}

function testServerScheduleSelfRelaunchSpawnPayload() {
  console.log('\n--- scheduleSelfRelaunch spawn payload (Windows-mocked) ---')
  process.env.OTA_TEST_FORCE_RELAUNCH = '1'
  try {
    // 1. Default delaySec=5 + spawn shape.
    withPatchedSpawn((scoped, getCall) => {
      const ok = scoped.scheduleSelfRelaunch('C:\\Program Files\\App\\server.exe', 5)
      const c = getCall()
      assert(ok === true, 'returns true once spawn is reachable')
      assert(c && c.cmd === 'cmd.exe',
        'spawned cmd.exe (got=' + (c && c.cmd) + ')')
      assert(c && Array.isArray(c.args) && c.args[0] === '/c',
        'first arg is /c')
      const cmdLine = (c && c.args && c.args[1]) || ''
      assert(cmdLine.includes('ping 127.0.0.1 -n 6'),
        'ping count is delaySec+1 (5+1=6); got=' + JSON.stringify(cmdLine))
      assert(cmdLine.includes('start "" "C:\\Program Files\\App\\server.exe"'),
        'start "" "<exe>" is in the cmd line; got=' + JSON.stringify(cmdLine))
      assert(c.opts && c.opts.detached === true, 'spawn used detached:true')
      assert(c.opts && c.opts.stdio === 'ignore', 'spawn used stdio:ignore')

      // Idempotency guard (architect finding 3): a second call in the
      // same module instance must NOT spawn again.
      const firstCallSnapshot = JSON.stringify(c)
      const second = scoped.scheduleSelfRelaunch('C:\\app\\other.exe', 9)
      const after = getCall()
      assert(second === false, 'second call returns false (already scheduled)')
      assert(JSON.stringify(after) === firstCallSnapshot,
        'second call did not re-spawn (no second cmd.exe invocation)')
    })

    // 2. Default fallback: invalid delaySec -> 5 (parseInt(x,10) || 5).
    withPatchedSpawn((scoped, getCall) => {
      scoped.scheduleSelfRelaunch('C:\\app\\server.exe', 'not-a-number')
      const c = getCall()
      assert(c && c.args[1].includes('ping 127.0.0.1 -n 6'),
        'invalid delaySec falls back to default 5 -> ping count 6')
    })

    // 3. Ceiling clamp: 999 -> 60.
    withPatchedSpawn((scoped, getCall) => {
      scoped.scheduleSelfRelaunch('C:\\app\\server.exe', 999)
      const c = getCall()
      assert(c && c.args[1].includes('ping 127.0.0.1 -n 61'),
        'delaySec=999 clamps to 60 -> ping count 61')
    })

    // 4. Floor clamp: 1 -> 2.
    withPatchedSpawn((scoped, getCall) => {
      scoped.scheduleSelfRelaunch('C:\\app\\server.exe', 1)
      const c = getCall()
      assert(c && c.args[1].includes('ping 127.0.0.1 -n 3'),
        'delaySec=1 clamps up to floor 2 -> ping count 3')
    })
  } finally {
    delete process.env.OTA_TEST_FORCE_RELAUNCH
  }
}

function testGracefulQuitSchedulesNotExitsImmediately(serverUpdater) {
  console.log('\n--- gracefulQuitForUpdate schedules an exit ---')
  // gracefulQuitForUpdate uses setTimeout(...,250) -> app.quit/process.exit.
  // We can't let it actually exit in the test, so monkey-patch process.exit
  // for the duration of this check and verify the timer fires.
  const realExit = process.exit
  let exitCalled = false
  process.exit = (code) => { exitCalled = true; /* swallow */ }

  try {
    const t0 = Date.now()
    serverUpdater.gracefulQuitForUpdate('test-driven quit')
    // Synchronously: must NOT have exited yet.
    assert(!exitCalled, 'process.exit not called synchronously (deferred via setTimeout)')

    // Wait long enough for the 250ms timer to fire.
    return new Promise((resolve) => setTimeout(() => {
      const elapsed = Date.now() - t0
      assert(exitCalled, 'process.exit was called after timer fired')
      assert(elapsed >= 200, 'elapsed >= ~250ms (got=' + elapsed + 'ms)')
      process.exit = realExit
      resolve()
    }, 400))
  } catch (e) {
    process.exit = realExit
    throw e
  }
}

function testScheduleAutoQuitDisabled(serverUpdater) {
  console.log('\n--- scheduleAutoQuitAfterStage respects OTA_DISABLE_AUTO_QUIT ---')
  // With the env flag set, the function should return without scheduling
  // any timer (verified by the absence of a process.exit call after the
  // would-be 7-second delay). We just verify it doesn't throw and doesn't
  // attempt to monkey with process.exit.
  process.env.OTA_DISABLE_AUTO_QUIT = '1'
  const realExit = process.exit
  let exitCalled = false
  process.exit = () => { exitCalled = true }
  try {
    serverUpdater.scheduleAutoQuitAfterStage('test')
    // Yield once to drain microtasks; the function must NOT have queued
    // any 7-second timer that would later trip our stub.
    return new Promise((resolve) => setImmediate(() => {
      assert(!exitCalled, 'no exit attempted when OTA_DISABLE_AUTO_QUIT=1')
      process.exit = realExit
      delete process.env.OTA_DISABLE_AUTO_QUIT
      resolve()
    }))
  } catch (e) {
    process.exit = realExit
    delete process.env.OTA_DISABLE_AUTO_QUIT
    throw e
  }
}

// === Architect-review hardening tests (Task #3 round 2) ===
//
// Defend the four findings from the code review:
//   1. Orphan scan must respect manifest.keepExes + .ota-keep-exes.json
//      sidecar so unrelated tools (ffmpeg.exe etc.) are NEVER queued.
//   2. (covered by drain test below)
//   3. scheduleAutoQuitAfterStage must be idempotent.
//   A. Self-defense at init must prefer the recorded nextExe in the
//      cleanup marker over a heuristic discoverNewExe scan.

function testOrphanScanRespectsKeepExes(updater) {
  console.log('\n--- orphan scan respects manifest.keepExes + sidecar ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-keep-exes-'))
  try {
    fs.writeFileSync(path.join(tmp, 'BLAST.exe'),    'running')
    fs.writeFileSync(path.join(tmp, 'BLASTING.exe'), 'new')
    fs.writeFileSync(path.join(tmp, 'ffmpeg.exe'),   'bundled-tool')
    fs.writeFileSync(path.join(tmp, 'helper.exe'),   'sidecar-allowlisted')
    fs.writeFileSync(path.join(tmp, 'OLD-NAME.exe'), 'real-orphan')

    // 1. Manifest-only allowlist: ffmpeg.exe declared in payload manifest.
    let orphans = updater.scanForOrphanExes(
      tmp, ['BLASTING.exe'], 'BLAST.exe', 'BLASTING.exe', ['ffmpeg.exe']
    ).sort()
    assert(orphans.includes('OLD-NAME.exe'),
      'manifest-only: real orphan still queued (got=' + JSON.stringify(orphans) + ')')
    assert(!orphans.includes('ffmpeg.exe'),
      'manifest-only: ffmpeg.exe protected via manifest.keepExes')
    assert(orphans.includes('helper.exe'),
      'manifest-only: helper.exe NOT yet protected (no sidecar)')

    // 2. Add the sidecar — operator-controlled allowlist for tools that
    // aren't in the payload (e.g. third-party drops users keep around).
    fs.writeFileSync(path.join(tmp, '.ota-keep-exes.json'), JSON.stringify({
      keep: ['helper.exe', 'someOther.EXE'],
    }))
    orphans = updater.scanForOrphanExes(
      tmp, ['BLASTING.exe'], 'BLAST.exe', 'BLASTING.exe', ['ffmpeg.exe']
    ).sort()
    assert(orphans.length === 1 && orphans[0] === 'OLD-NAME.exe',
      'sidecar+manifest: only the real orphan remains (got=' + JSON.stringify(orphans) + ')')

    // 3. Sidecar entries are case-insensitive.
    fs.writeFileSync(path.join(tmp, '.ota-keep-exes.json'), JSON.stringify({
      keep: ['HELPER.exe'],
    }))
    fs.writeFileSync(path.join(tmp, 'helper.EXE'), 'mixed-case')
    orphans = updater.scanForOrphanExes(
      tmp, ['BLASTING.exe'], 'BLAST.exe', 'BLASTING.exe', ['FFMPEG.EXE']
    ).sort()
    assert(!orphans.some(n => n.toLowerCase() === 'helper.exe'),
      'case-insensitive: HELPER.exe in sidecar protects helper.EXE on disk')
    assert(!orphans.some(n => n.toLowerCase() === 'ffmpeg.exe'),
      'case-insensitive: FFMPEG.EXE in manifest protects ffmpeg.exe on disk')

    // 4. Malformed sidecar -> graceful empty allowlist (don't crash apply).
    fs.writeFileSync(path.join(tmp, '.ota-keep-exes.json'), '{ not json')
    orphans = updater.scanForOrphanExes(
      tmp, ['BLASTING.exe'], 'BLAST.exe', 'BLASTING.exe', []
    ).sort()
    assert(orphans.includes('OLD-NAME.exe'),
      'malformed sidecar: still finds the real orphan, no throw')

    // 5. readKeepExesSidecar honors string-array shorthand too.
    fs.writeFileSync(path.join(tmp, '.ota-keep-exes.json'), JSON.stringify(['plainArr.exe']))
    const list = updater.readKeepExesSidecar(tmp)
    assert(Array.isArray(list) && list.includes('plainArr.exe'),
      'sidecar accepts plain string-array form too')
  } finally {
    rmrf(tmp)
  }
}

function testManifestKeepExesPathStripped(updater) {
  console.log('\n--- manifest.keepExes basename-normalization (architect round-2 fix) ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-keep-pathstrip-'))
  try {
    fs.writeFileSync(path.join(tmp, 'BLAST.exe'),    'running')
    fs.writeFileSync(path.join(tmp, 'BLASTING.exe'), 'new')
    fs.writeFileSync(path.join(tmp, 'ffmpeg.exe'),   'bundled-tool')
    fs.writeFileSync(path.join(tmp, 'OLD-NAME.exe'), 'real-orphan')

    // Manifest authored as "tools/ffmpeg.exe" (a path, not a basename) —
    // common operator mistake. Implementation must basename-normalize so
    // ffmpeg.exe on disk is still protected.
    let orphans = updater.scanForOrphanExes(
      tmp, ['BLASTING.exe'], 'BLAST.exe', 'BLASTING.exe',
      ['tools/ffmpeg.exe', 'C:\\extras\\OTHER.EXE']
    ).sort()
    assert(!orphans.some(n => n.toLowerCase() === 'ffmpeg.exe'),
      'manifest entry "tools/ffmpeg.exe" still protects ffmpeg.exe (got=' + JSON.stringify(orphans) + ')')
    assert(orphans.includes('OLD-NAME.exe'),
      'real orphan still queued')

    // Falsy entries in manifest array are ignored, no throw.
    orphans = updater.scanForOrphanExes(
      tmp, ['BLASTING.exe'], 'BLAST.exe', 'BLASTING.exe',
      ['ffmpeg.exe', null, '', undefined]
    ).sort()
    assert(orphans.length === 1 && orphans[0] === 'OLD-NAME.exe',
      'falsy manifest entries skipped (got=' + JSON.stringify(orphans) + ')')
  } finally {
    rmrf(tmp)
  }
}

function testSweepPreservesNextExe(updater) {
  console.log('\n--- sweepCleanupMarker preserves nextExe across partial-sweep retry ---')
  // We need to force the marker REWRITE branch (not the unlink branch).
  // The sweep treats missing files as already-deleted (clears them from
  // remaining), so we set up a real subdirectory with our exes inside it
  // and chmod the dir to 0o500 — fs.unlinkSync of files within fails
  // with EACCES, leaving entries in `remaining` so the sweep rewrites.
  // Skip on Windows where chmod-based deny-write doesn't work the same.
  if (process.platform === 'win32') {
    console.log('  SKIP (win32): rely on Windows file-locking instead in production')
    return
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-sweep-nextexe-'))
  const tmp = path.join(parent, 'app')
  fs.mkdirSync(tmp)
  try {
    process.env.OTA_TEST_CURRENT_EXE = 'BLASTING.exe'
    fs.writeFileSync(path.join(tmp, 'BLASTING.exe'), 'running-binary')
    fs.writeFileSync(path.join(tmp, 'STUCK1.exe'),   'stuck-orphan-1')
    fs.writeFileSync(path.join(tmp, 'STUCK2.exe'),   'stuck-orphan-2')

    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), JSON.stringify({
      writtenAt: new Date().toISOString(),
      deleteExes: ['STUCK1.exe', 'STUCK2.exe'],
      nextExe: 'BLASTING.exe',
    }))

    // Lock the directory: deny writes so unlink of children fails.
    // Marker file lives inside it too — the sweep's final write to the
    // marker will fail silently (caught by try/catch in sweep), so we
    // re-open perms and verify by reading back AFTER restoring write.
    // To keep the test simple, we instead chmod individual stuck files
    // to 0o000 — fs.unlinkSync on a file in a writable dir succeeds
    // regardless of file mode on POSIX, so that doesn't work either.
    //
    // Cleanest cross-runtime approach: replace fs.unlinkSync temporarily
    // to throw EACCES for the two stuck entries, then restore it.
    const realUnlink = fs.unlinkSync
    fs.unlinkSync = function (p) {
      const base = path.basename(String(p))
      if (base === 'STUCK1.exe' || base === 'STUCK2.exe') {
        const err = new Error("EACCES: permission denied, unlink '" + p + "'")
        err.code = 'EACCES'
        throw err
      }
      return realUnlink(p)
    }
    try {
      updater.sweepCleanupMarker(tmp)
    } finally {
      fs.unlinkSync = realUnlink
    }

    const after = fs.readFileSync(path.join(tmp, '.ota-cleanup.json'), 'utf-8')
    const parsed = JSON.parse(after)
    assert(Array.isArray(parsed.deleteExes) && parsed.deleteExes.length === 2,
      'partial-sweep marker still lists both stuck entries (got=' + JSON.stringify(parsed.deleteExes) + ')')
    assert(parsed.nextExe === 'BLASTING.exe',
      'partial-sweep marker preserved nextExe (got=' + parsed.nextExe + ')')

    // Sanity: peekCleanupMarkerWithMeta sees it on the rewritten marker.
    const meta = updater.peekCleanupMarkerWithMeta(tmp)
    assert(meta.nextExe === 'BLASTING.exe',
      'peekWithMeta still sees nextExe after partial sweep')

    // Path-traversal hardening: a tampered nextExe field collapses to its
    // basename on the way back to disk so the marker can never inject a
    // path the next launch would dereference.
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), JSON.stringify({
      writtenAt: new Date().toISOString(),
      deleteExes: ['STUCK1.exe'],
      nextExe: '../../etc/EVIL.exe',
    }))
    fs.unlinkSync = function (p) {
      const base = path.basename(String(p))
      if (base === 'STUCK1.exe') {
        const err = new Error('EACCES'); err.code = 'EACCES'; throw err
      }
      return realUnlink(p)
    }
    try {
      updater.sweepCleanupMarker(tmp)
    } finally {
      fs.unlinkSync = realUnlink
    }
    const after2 = JSON.parse(fs.readFileSync(path.join(tmp, '.ota-cleanup.json'), 'utf-8'))
    assert(after2.nextExe === 'EVIL.exe',
      'tampered traversal nextExe collapsed to basename on rewrite (got=' + after2.nextExe + ')')
  } finally {
    delete process.env.OTA_TEST_CURRENT_EXE
    rmrf(parent)
  }
}

function testCleanupMarkerCarriesNextExe(updater) {
  console.log('\n--- cleanup marker persists nextExe (architect fix A) ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-marker-nextexe-'))
  try {
    // Modern marker: writeCleanupMarker(appRoot, [oldBasenames], nextExe).
    updater.writeCleanupMarker(tmp, ['BLAST.exe', 'OLD.exe'], 'BLASTING.exe')
    const meta = updater.peekCleanupMarkerWithMeta(tmp)
    assert(Array.isArray(meta.deleteExes) && meta.deleteExes.includes('BLAST.exe'),
      'meta.deleteExes carries the orphan list')
    assert(meta.nextExe === 'BLASTING.exe',
      'meta.nextExe carries the recorded successor (got=' + meta.nextExe + ')')

    // Backward-compat: peekCleanupMarker still returns just the array.
    const arr = updater.peekCleanupMarker(tmp)
    assert(Array.isArray(arr) && arr.includes('OLD.exe'),
      'legacy peekCleanupMarker still returns the basename array')

    // Legacy marker (no nextExe field) -> meta.nextExe is null/undefined.
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), JSON.stringify({
      writtenAt: new Date().toISOString(), deleteExes: ['LEGACY.exe'],
    }))
    const legacyMeta = updater.peekCleanupMarkerWithMeta(tmp)
    assert(legacyMeta.deleteExes.includes('LEGACY.exe'),
      'legacy marker still parses')
    assert(!legacyMeta.nextExe,
      'legacy marker has no nextExe (falsy) -> falls back to discoverNewExe')

    // Malformed JSON -> graceful empty meta, no throw.
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'), '{ not valid')
    const bad = updater.peekCleanupMarkerWithMeta(tmp)
    assert(Array.isArray(bad.deleteExes) && bad.deleteExes.length === 0,
      'malformed marker -> empty deleteExes (no throw)')
  } finally {
    rmrf(tmp)
  }
}

async function testRequestTrackerAndDrain() {
  console.log('\n--- request tracker + waitForActiveRequestsToDrain ---')
  // Fresh module instance so STATE.activeRequests starts at 0.
  const fresh = freshRequire('../server/electron/updater.js')

  assert(fresh.getActiveRequestCount() === 0, 'starts at zero')

  fresh.trackRequestStart()
  fresh.trackRequestStart()
  assert(fresh.getActiveRequestCount() === 2, 'two starts -> count=2')

  fresh.trackRequestEnd()
  assert(fresh.getActiveRequestCount() === 1, 'one end -> count=1')

  // Underflow guard: extra ends never go negative.
  fresh.trackRequestEnd()
  fresh.trackRequestEnd()
  assert(fresh.getActiveRequestCount() === 0, 'underflow clamped at 0')

  // Drain resolves immediately when count is already 0.
  const t0 = Date.now()
  const okFast = await fresh.waitForActiveRequestsToDrain(5000)
  assert(okFast === true, 'drain returns true when already empty')
  assert(Date.now() - t0 < 200, 'drain returned immediately (<200ms)')

  // Drain waits, then resolves true once trackRequestEnd brings count to 0.
  fresh.trackRequestStart()
  setTimeout(() => fresh.trackRequestEnd(), 250)
  const t1 = Date.now()
  const okWait = await fresh.waitForActiveRequestsToDrain(5000)
  const elapsed = Date.now() - t1
  assert(okWait === true, 'drain returns true after request ends')
  assert(elapsed >= 200 && elapsed < 2000,
    'drain waited ~250ms for the in-flight request (got=' + elapsed + 'ms)')

  // Drain hits the cap and returns false if the request never ends.
  fresh.trackRequestStart()
  const t2 = Date.now()
  const okCap = await fresh.waitForActiveRequestsToDrain(300)
  const cap = Date.now() - t2
  assert(okCap === false, 'drain returns false when cap elapses with traffic still in flight')
  assert(cap >= 250 && cap < 1500,
    'drain waited ~300ms then gave up (got=' + cap + 'ms)')
  // Clean up so we don't leak a phantom in-flight count to other tests.
  fresh.trackRequestEnd()
}

async function testScheduleAutoQuitIdempotent() {
  console.log('\n--- scheduleAutoQuitAfterStage idempotency (architect fix 3) ---')
  // Fresh instance so STATE.autoQuitTimer starts unset.
  const fresh = freshRequire('../server/electron/updater.js')
  const realExit = process.exit
  let exitCalled = false
  process.exit = () => { exitCalled = true }
  // Stub setTimeout to count only the 7s-class timers (the auto-quit
  // schedule), ignoring 100ms drain polls. Returns a real handle so the
  // .unref() call inside scheduleAutoQuitAfterStage succeeds.
  const realSetTimeout = global.setTimeout
  let scheduledCount = 0
  global.setTimeout = function (fn, ms) {
    if (typeof ms === 'number' && ms >= 5000) scheduledCount++
    return realSetTimeout(() => {}, 0)
  }
  try {
    fresh.scheduleAutoQuitAfterStage('first call')
    fresh.scheduleAutoQuitAfterStage('second call (should dedupe)')
    fresh.scheduleAutoQuitAfterStage('third call (should also dedupe)')
    assert(scheduledCount === 1,
      'only ONE 7s auto-quit timer scheduled despite 3 calls (got=' + scheduledCount + ')')
    assert(!exitCalled, 'no exit attempted synchronously')
  } finally {
    global.setTimeout = realSetTimeout
    process.exit = realExit
  }
}

// === Version-mismatch self-defense tests (Task #3 round 2 follow-up) ===
//
// The architect's blocking finding required: even when the cleanup marker
// is missing/already-swept, we must still detect "I am running a stale
// binary" by comparing the bundled version against the on-disk advertised
// version (ota-config.json). These tests drive the four pure-data helpers
// directly, so we don't need to invoke init() or hand off a real process.

function writeOtaConfig(dir, version) {
  fs.writeFileSync(path.join(dir, 'ota-config.json'), JSON.stringify({ version }))
}

function testGetBundledVersion(updater) {
  console.log('\n--- getBundledVersion (with test-hook env var) ---')
  const prev = process.env.OTA_TEST_BUNDLED_VERSION
  try {
    process.env.OTA_TEST_BUNDLED_VERSION = '7.7.7'
    assert(updater.getBundledVersion() === '7.7.7', 'OTA_TEST_BUNDLED_VERSION takes precedence')
    delete process.env.OTA_TEST_BUNDLED_VERSION
    const v = updater.getBundledVersion()
    // Without the hook, we read the project's own package.json — must be
    // a non-empty string. The exact value depends on whichever updater
    // module we pass in (launcher reads walok/package.json, server reads
    // walok/server/package.json), but both should be defined.
    assert(typeof v === 'string' && v.length > 0, 'real package.json read returns a non-empty version (' + v + ')')
  } finally {
    if (prev === undefined) delete process.env.OTA_TEST_BUNDLED_VERSION
    else process.env.OTA_TEST_BUNDLED_VERSION = prev
  }
}

function testReadAdvertisedVersion(updater) {
  console.log('\n--- readAdvertisedVersion ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-mismatch-cfg-'))
  try {
    assert(updater.readAdvertisedVersion(tmp) === null, 'returns null when ota-config.json missing')
    writeOtaConfig(tmp, '3.4.5')
    assert(updater.readAdvertisedVersion(tmp) === '3.4.5', 'reads version from valid ota-config.json')
    fs.writeFileSync(path.join(tmp, 'ota-config.json'), '{not-json')
    assert(updater.readAdvertisedVersion(tmp) === null, 'returns null on malformed JSON (no throw)')
    fs.writeFileSync(path.join(tmp, 'ota-config.json'), JSON.stringify({ version: 42 }))
    assert(updater.readAdvertisedVersion(tmp) === null, 'returns null when version is not a string')
    fs.writeFileSync(path.join(tmp, 'ota-config.json'), JSON.stringify({}))
    assert(updater.readAdvertisedVersion(tmp) === null, 'returns null when version key absent')
  } finally {
    rmrf(tmp)
  }
}

function testDetectVersionMismatchDegradesGracefully(updater) {
  console.log('\n--- detectVersionMismatch: degrades when version unknown ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-mismatch-degrade-'))
  const prev = process.env.OTA_TEST_BUNDLED_VERSION
  try {
    delete process.env.OTA_TEST_BUNDLED_VERSION
    // No ota-config.json on disk -> advertised is null -> NEVER stale.
    const r1 = updater.detectVersionMismatch(tmp, 'whatever.exe')
    assert(r1.stale === false, 'no advertised version -> not stale')
    assert(r1.reason === 'unknown-version', 'reason is unknown-version')
    // With ota-config.json but bundled-version hook missing AND we
    // override the function — easiest path: clear env, drop a sentinel
    // that we KNOW is older than this codebase's package.json.
    process.env.OTA_TEST_BUNDLED_VERSION = '99.99.99'
    writeOtaConfig(tmp, '1.0.0')
    const r2 = updater.detectVersionMismatch(tmp, 'whatever.exe')
    assert(r2.stale === false, 'bundled > advertised -> up-to-date, not stale')
    assert(r2.reason === 'up-to-date', 'reason is up-to-date')
    // Equal versions -> also not stale.
    process.env.OTA_TEST_BUNDLED_VERSION = '2.0.0'
    writeOtaConfig(tmp, '2.0.0')
    const r3 = updater.detectVersionMismatch(tmp, 'whatever.exe')
    assert(r3.stale === false, 'bundled == advertised -> not stale')
  } finally {
    if (prev === undefined) delete process.env.OTA_TEST_BUNDLED_VERSION
    else process.env.OTA_TEST_BUNDLED_VERSION = prev
    rmrf(tmp)
  }
}

function testDetectVersionMismatchStaleWithMarker(updater) {
  console.log('\n--- detectVersionMismatch: stale + marker.nextExe successor ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-mismatch-marker-'))
  const prev = process.env.OTA_TEST_BUNDLED_VERSION
  try {
    process.env.OTA_TEST_BUNDLED_VERSION = '1.0.0'
    writeOtaConfig(tmp, '2.0.0')
    const newExe = 'BLAST.exe'
    fs.writeFileSync(path.join(tmp, newExe), 'fake-new-exe-bytes')
    fs.writeFileSync(path.join(tmp, 'OLD.exe'), 'fake-old-exe-bytes')
    // Marker present, NO sidecar — exercises the tier-2 marker.nextExe
    // fallback in pickSuccessorExe (the legacy bundled-vs-advertised
    // tier of detectVersionMismatch).
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'),
      JSON.stringify({ deleteExes: ['OLD.exe'], nextExe: newExe, ts: Date.now() }))
    const r = updater.detectVersionMismatch(tmp, 'OLD.exe')
    assert(r.stale === true, 'stale=true when bundled<advertised (no sidecar tier)')
    assert(r.bundled === '1.0.0', 'bundled echoed back')
    assert(r.advertised === '2.0.0', 'advertised echoed back')
    assert(r.reason === 'older-than-advertised', 'reason=older-than-advertised (degraded tier)')
    assert(r.candidate && r.candidate.basename === newExe,
      'candidate is taken from marker.nextExe (got ' + (r.candidate && r.candidate.basename) + ')')
    assert(r.candidate.source === 'marker.nextExe', 'source=marker.nextExe')
  } finally {
    if (prev === undefined) delete process.env.OTA_TEST_BUNDLED_VERSION
    else process.env.OTA_TEST_BUNDLED_VERSION = prev
    rmrf(tmp)
  }
}

// === Architect round-3 critical: per-exe identity sidecar ===
// These tests prove the PRIMARY (tier-1) path, which does NOT depend on
// the OTA_TEST_BUNDLED_VERSION env hook. They reproduce the architect's
// blocking scenario: an old exe relaunched after an OTA where the asar
// (and therefore package.json) has been overwritten with the NEW
// version, yet the old exe must still detect "I am no longer canonical".
function testCurrentExeRecordReadWrite(updater) {
  console.log('\n--- .ota-current-exe.json read/write helpers ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-curexe-'))
  try {
    assert(updater.readCurrentExeRecord(tmp) === null, 'returns null when sidecar missing')
    const ok1 = updater.writeCurrentExeRecord(tmp, 'BLAST.exe', '2.0.0')
    assert(ok1 === true, 'write returns true on success')
    const r = updater.readCurrentExeRecord(tmp)
    assert(r && r.exe === 'BLAST.exe' && r.version === '2.0.0', 'round-trips exe + version')
    // basename normalization: write a path-y string, expect basename back.
    // Use forward slashes so the test runs identically on Linux + Windows
    // (path.basename on POSIX does not split on '\\').
    updater.writeCurrentExeRecord(tmp, 'inst/NEW.exe', '3.0.0')
    const r2 = updater.readCurrentExeRecord(tmp)
    assert(r2 && r2.exe === 'NEW.exe', 'exe basename is normalized on write (got ' + (r2 && r2.exe) + ')')
    // Malformed JSON returns null (no throw).
    fs.writeFileSync(path.join(tmp, '.ota-current-exe.json'), '{not-json')
    assert(updater.readCurrentExeRecord(tmp) === null, 'malformed sidecar returns null silently')
    // Missing/empty version returns null.
    fs.writeFileSync(path.join(tmp, '.ota-current-exe.json'), JSON.stringify({ exe: 'X.exe' }))
    assert(updater.readCurrentExeRecord(tmp) === null, 'returns null when version absent')
    fs.writeFileSync(path.join(tmp, '.ota-current-exe.json'), JSON.stringify({ exe: 'X.exe', version: 42 }))
    assert(updater.readCurrentExeRecord(tmp) === null, 'returns null when version not a string')
  } finally {
    rmrf(tmp)
  }
}

function testStaleDetectionViaSidecarOnly(updater) {
  console.log('\n--- ARCHITECT ROUND-3 CRITICAL: sidecar-only stale detection ---')
  console.log('    (no OTA_TEST_BUNDLED_VERSION hook — proves real production scenario)')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-sidecar-only-'))
  const prevHook = process.env.OTA_TEST_BUNDLED_VERSION
  try {
    // CRITICAL: clear the test hook. We are reproducing the EXACT
    // architect-blocking scenario: an OTA stored {exe: NEW, version: 2.0.0}
    // and ALSO bumped ota-config.json to 2.0.0 (so legacy bundled-vs-
    // advertised is "even"). Without the sidecar tier, the OLD exe
    // would see bundled==advertised and skip the handoff.
    delete process.env.OTA_TEST_BUNDLED_VERSION
    fs.writeFileSync(path.join(tmp, 'OLD.exe'), 'fake-old')
    fs.writeFileSync(path.join(tmp, 'NEW.exe'), 'fake-new')
    writeOtaConfig(tmp, '2.0.0')
    updater.writeCurrentExeRecord(tmp, 'NEW.exe', '2.0.0')
    // No cleanup marker (already swept on a prior launch).
    assert(!fs.existsSync(path.join(tmp, '.ota-cleanup.json')), 'precondition: marker is absent')

    const r = updater.detectVersionMismatch(tmp, 'OLD.exe')
    assert(r.stale === true, 'OLD.exe correctly flagged stale via sidecar (no env hook)')
    assert(r.reason === 'sidecar-points-elsewhere', 'reason=sidecar-points-elsewhere (got ' + r.reason + ')')
    assert(r.sidecarExe === 'NEW.exe', 'sidecar.exe surfaced in result')
    assert(r.sidecarVersion === '2.0.0', 'sidecar.version surfaced in result')
    assert(r.candidate && r.candidate.basename === 'NEW.exe',
      'candidate is taken from sidecar (got ' + (r.candidate && r.candidate.basename) + ')')
    assert(r.candidate.source === 'current-exe-record',
      'source=current-exe-record (highest-confidence tier; got ' +
        (r.candidate && r.candidate.source) + ')')

    // And the canonical exe itself, when relaunched, must be marked NOT-stale.
    const r2 = updater.detectVersionMismatch(tmp, 'NEW.exe')
    assert(r2.stale === false, 'NEW.exe (canonical) is NOT stale')
    assert(r2.reason === 'sidecar-matches', 'reason=sidecar-matches')
    assert(r2.candidate === null, 'no candidate when up-to-date')

    // Case-insensitive match (Windows behavior).
    const r3 = updater.detectVersionMismatch(tmp, 'new.EXE')
    assert(r3.stale === false, 'case-insensitive match: new.EXE matches NEW.exe')
  } finally {
    if (prevHook === undefined) delete process.env.OTA_TEST_BUNDLED_VERSION
    else process.env.OTA_TEST_BUNDLED_VERSION = prevHook
    rmrf(tmp)
  }
}

function testSidecarBeatsMarkerAndDiscover(updater) {
  console.log('\n--- pickSuccessorExe: sidecar beats marker beats discoverNewExe ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-tier-priority-'))
  try {
    // Three exes on disk so discoverNewExe is ambiguous (returns null) —
    // proves we are NOT relying on it when sidecar is present.
    fs.writeFileSync(path.join(tmp, 'OLD.exe'), 'fake-old')
    fs.writeFileSync(path.join(tmp, 'NEW.exe'), 'fake-new')
    fs.writeFileSync(path.join(tmp, 'INSTALLER.exe'), 'fake-3rd-party')
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'),
      JSON.stringify({ deleteExes: ['OLD.exe'], nextExe: 'INSTALLER.exe', ts: Date.now() }))
    updater.writeCurrentExeRecord(tmp, 'NEW.exe', '2.0.0')
    const pick = updater.pickSuccessorExe(tmp, 'OLD.exe')
    assert(pick && pick.basename === 'NEW.exe',
      'sidecar wins over marker.nextExe (got ' + (pick && pick.basename) + ')')
    assert(pick.source === 'current-exe-record', 'source=current-exe-record')
  } finally {
    rmrf(tmp)
  }
}

function testDiscoverOnlyWhenNoSidecarAndNoMarker(updater) {
  console.log('\n--- pickSuccessorExe: discoverNewExe gated to "no other signal" ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-discover-gate-'))
  try {
    fs.writeFileSync(path.join(tmp, 'OLD.exe'), 'fake-old')
    fs.writeFileSync(path.join(tmp, 'NEW.exe'), 'fake-new')
    // No sidecar, no marker -> discoverNewExe is allowed.
    let pick = updater.pickSuccessorExe(tmp, 'OLD.exe')
    assert(pick && pick.basename === 'NEW.exe' && pick.source === 'discoverNewExe',
      'discoverNewExe used when no other signal (got ' +
        (pick && pick.source) + ')')
    // Now add a sidecar pointing at OLD itself -> sidecar tier rejects
    // (running == sidecar.exe), AND we must NOT fall through to discover.
    // This is the "architect minor finding #3" defense: never silently
    // pick a lone unrelated exe when we DO have a signal saying we are
    // canonical.
    updater.writeCurrentExeRecord(tmp, 'OLD.exe', '1.0.0')
    pick = updater.pickSuccessorExe(tmp, 'OLD.exe')
    assert(pick === null,
      'discoverNewExe is BLOCKED when a sidecar exists (even if it points at us). got ' + JSON.stringify(pick))
  } finally {
    rmrf(tmp)
  }
}

function testDetectVersionMismatchStaleNoMarkerFallsBackToDiscover(updater) {
  console.log('\n--- detectVersionMismatch: stale + NO marker, falls back to discoverNewExe ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-mismatch-discover-'))
  const prev = process.env.OTA_TEST_BUNDLED_VERSION
  try {
    process.env.OTA_TEST_BUNDLED_VERSION = '1.0.0'
    writeOtaConfig(tmp, '2.0.0')
    // No marker on disk. Drop exactly TWO exes — running + one obvious
    // successor. discoverNewExe should pick the non-running one.
    fs.writeFileSync(path.join(tmp, 'OLD.exe'), 'fake-old')
    fs.writeFileSync(path.join(tmp, 'BLAST.exe'), 'fake-new')
    const r = updater.detectVersionMismatch(tmp, 'OLD.exe')
    assert(r.stale === true, 'stale=true with no marker present')
    assert(r.candidate && r.candidate.basename === 'BLAST.exe',
      'discoverNewExe picks the obvious non-running successor (got ' +
        (r.candidate && r.candidate.basename) + ')')
    assert(r.candidate.source === 'discoverNewExe', 'source=discoverNewExe')
  } finally {
    if (prev === undefined) delete process.env.OTA_TEST_BUNDLED_VERSION
    else process.env.OTA_TEST_BUNDLED_VERSION = prev
    rmrf(tmp)
  }
}

function testDetectVersionMismatchStaleNoSafeSuccessor(updater) {
  console.log('\n--- detectVersionMismatch: stale but NO safe successor ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-mismatch-nosucc-'))
  const prev = process.env.OTA_TEST_BUNDLED_VERSION
  try {
    process.env.OTA_TEST_BUNDLED_VERSION = '1.0.0'
    writeOtaConfig(tmp, '2.0.0')
    // ONLY the running exe on disk -> discoverNewExe finds nothing safe,
    // and there is no marker -> candidate must be null. Init must NOT
    // hand off blindly in this case.
    fs.writeFileSync(path.join(tmp, 'OLD.exe'), 'fake-old')
    const r = updater.detectVersionMismatch(tmp, 'OLD.exe')
    assert(r.stale === true, 'stale=true even when no candidate exists')
    assert(r.candidate === null, 'candidate=null when no safe successor present')
  } finally {
    if (prev === undefined) delete process.env.OTA_TEST_BUNDLED_VERSION
    else process.env.OTA_TEST_BUNDLED_VERSION = prev
    rmrf(tmp)
  }
}

function testPickSuccessorRejectsRunningExe(updater) {
  console.log('\n--- pickSuccessorExe: never picks the running exe ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-mismatch-self-'))
  try {
    fs.writeFileSync(path.join(tmp, 'OLD.exe'), 'fake')
    // Marker points back at OLD.exe -> must be rejected (case-insensitive
    // match against currentBasename via sameExe()).
    fs.writeFileSync(path.join(tmp, '.ota-cleanup.json'),
      JSON.stringify({ deleteExes: [], nextExe: 'old.EXE', ts: Date.now() }))
    const r = updater.pickSuccessorExe(tmp, 'OLD.exe')
    assert(r === null, 'rejects marker.nextExe that resolves to the running exe (case-insensitive)')
  } finally {
    rmrf(tmp)
  }
}

async function main() {
  const launcherUpdater = freshRequire('./updater.js')
  const serverUpdater = freshRequire('../server/electron/updater.js')

  // Synchronous tests
  testListTopLevelExesInZip(launcherUpdater)
  testListTopLevelExesInZip(serverUpdater)
  testScanForOrphanExes(launcherUpdater)
  testScanForOrphanExes(serverUpdater)
  testOrphanScanRespectsKeepExes(launcherUpdater)
  testOrphanScanRespectsKeepExes(serverUpdater)
  testManifestKeepExesPathStripped(launcherUpdater)
  testManifestKeepExesPathStripped(serverUpdater)
  testOrphanScanInsideApply(launcherUpdater)
  testOrphanScanInsideApply(serverUpdater)
  testPeekAndSelfMarkedOrphan(launcherUpdater)
  testPeekAndSelfMarkedOrphan(serverUpdater)
  testCleanupMarkerCarriesNextExe(launcherUpdater)
  testCleanupMarkerCarriesNextExe(serverUpdater)
  testSweepPreservesNextExe(launcherUpdater)
  testSweepPreservesNextExe(serverUpdater)
  testServerScheduleSelfRelaunchNonWindows(serverUpdater)
  testServerScheduleSelfRelaunchSpawnPayload()
  // Version-mismatch self-defense (architect blocking-finding follow-up).
  // Drive both updaters end-to-end through the four pure-data helpers.
  testGetBundledVersion(launcherUpdater)
  testGetBundledVersion(serverUpdater)
  testReadAdvertisedVersion(launcherUpdater)
  testReadAdvertisedVersion(serverUpdater)
  testDetectVersionMismatchDegradesGracefully(launcherUpdater)
  testDetectVersionMismatchDegradesGracefully(serverUpdater)
  testDetectVersionMismatchStaleWithMarker(launcherUpdater)
  testDetectVersionMismatchStaleWithMarker(serverUpdater)
  testDetectVersionMismatchStaleNoMarkerFallsBackToDiscover(launcherUpdater)
  testDetectVersionMismatchStaleNoMarkerFallsBackToDiscover(serverUpdater)
  testDetectVersionMismatchStaleNoSafeSuccessor(launcherUpdater)
  testDetectVersionMismatchStaleNoSafeSuccessor(serverUpdater)
  testPickSuccessorRejectsRunningExe(launcherUpdater)
  testPickSuccessorRejectsRunningExe(serverUpdater)
  // Architect round-3 critical: per-exe identity sidecar (tier-1 path).
  // These DO NOT use OTA_TEST_BUNDLED_VERSION — they reproduce the
  // production scenario the architect flagged as the blocking case.
  testCurrentExeRecordReadWrite(launcherUpdater)
  testCurrentExeRecordReadWrite(serverUpdater)
  testStaleDetectionViaSidecarOnly(launcherUpdater)
  testStaleDetectionViaSidecarOnly(serverUpdater)
  testSidecarBeatsMarkerAndDiscover(launcherUpdater)
  testSidecarBeatsMarkerAndDiscover(serverUpdater)
  testDiscoverOnlyWhenNoSidecarAndNoMarker(launcherUpdater)
  testDiscoverOnlyWhenNoSidecarAndNoMarker(serverUpdater)
  // Re-acquire the server-updater module after the scoped reload above so
  // subsequent async tests use a fresh instance with real spawn.
  const serverUpdater2 = freshRequire('../server/electron/updater.js')

  // Async tests (use timers)
  await testGracefulQuitSchedulesNotExitsImmediately(serverUpdater2)
  await testScheduleAutoQuitDisabled(serverUpdater2)
  await testRequestTrackerAndDrain()
  await testScheduleAutoQuitIdempotent()

  console.log('')
  console.log('=== ' + pass + ' passed, ' + fail + ' failed ===')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('test runner crashed:', e && e.stack || e)
  process.exit(1)
})
