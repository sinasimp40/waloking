const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const RUN_TIMEOUT_MS = 60000
const ALLOW_MISSING = process.argv.indexOf('--allow-missing') !== -1

function makeMarkerPath() {
  return path.join(os.tmpdir(), 'integrity-test-marker-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.json')
}

function runExe(exePath, markerPath) {
  const env = Object.assign({}, process.env, {
    INTEGRITY_TEST_ONLY: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    ELECTRON_DISABLE_SANDBOX: '1',
  })
  if (markerPath) {
    env.INTEGRITY_TEST_MARKER_FILE = markerPath
  } else {
    delete env.INTEGRITY_TEST_MARKER_FILE
  }
  const res = spawnSync(exePath, [], {
    env: env,
    timeout: RUN_TIMEOUT_MS,
    windowsHide: true,
    stdio: 'pipe',
  })
  let marker = null
  if (markerPath && fs.existsSync(markerPath)) {
    try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) } catch (e) { marker = { _parseError: e.message } }
    try { fs.unlinkSync(markerPath) } catch (e) {}
  }
  return {
    code: res.status,
    signal: res.signal,
    stdout: res.stdout ? res.stdout.toString() : '',
    stderr: res.stderr ? res.stderr.toString() : '',
    error: res.error,
    marker: marker,
  }
}

function readByte(filePath, offset) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(1)
    fs.readSync(fd, buf, 0, 1, offset)
    return buf[0]
  } finally {
    fs.closeSync(fd)
  }
}

function writeByte(filePath, offset, value) {
  const fd = fs.openSync(filePath, 'r+')
  try {
    const buf = Buffer.from([value])
    fs.writeSync(fd, buf, 0, 1, offset)
  } finally {
    fs.closeSync(fd)
  }
}

function pickTamperOffset(filePath) {
  const stat = fs.statSync(filePath)
  if (stat.size < 4096) {
    throw new Error('exe is too small to safely tamper-test: ' + filePath)
  }
  return Math.floor(stat.size / 2)
}

function describe(result) {
  const parts = ['code=' + result.code]
  if (result.signal) parts.push('signal=' + result.signal)
  if (result.error) parts.push('spawn-error=' + result.error.message)
  const tail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | ')
  if (tail) parts.push('output="' + tail + '"')
  return parts.join(' ')
}

function testApp(unpackedDir, exeName, label) {
  const exePath = path.join(unpackedDir, exeName)
  if (!fs.existsSync(exePath)) {
    throw new Error('[tamper-test] ' + label + ': EXE not found at ' + exePath)
  }
  console.log('\n[tamper-test] ' + label + ': testing ' + exeName)

  console.log('  [1/3] Clean launch (expect exit 0)...')
  const clean = runExe(exePath, null)
  if (clean.error) {
    throw new Error(label + ': clean launch failed to spawn: ' + clean.error.message)
  }
  if (clean.signal) {
    throw new Error(label + ': clean launch killed by signal ' + clean.signal +
      ' (likely timeout). The integrity-check did not honor INTEGRITY_TEST_ONLY=1 and self-exit. ' + describe(clean))
  }
  if (clean.code !== 0) {
    throw new Error(label + ': clean launch exited with ' + clean.code + ' (expected 0). ' + describe(clean))
  }
  console.log('    OK: clean exe exited 0')

  console.log('  [2/3] Flipping one byte and re-launching (expect exit 1)...')
  const offset = pickTamperOffset(exePath)
  const original = readByte(exePath, offset)
  const flipped = original ^ 0xff
  writeByte(exePath, offset, flipped)

  const markerPath = makeMarkerPath()
  let tampered
  let restoreError = null
  try {
    tampered = runExe(exePath, markerPath)
  } finally {
    try {
      writeByte(exePath, offset, original)
      const verify = readByte(exePath, offset)
      if (verify !== original) {
        restoreError = new Error('byte at offset ' + offset + ' not restored (expected ' + original + ', got ' + verify + ')')
      }
    } catch (e) {
      restoreError = e
    }
  }
  if (restoreError) {
    throw new Error(label + ': CRITICAL — could not restore tampered exe: ' + restoreError.message +
      '. The build artifact at ' + exePath + ' is now corrupt and must be rebuilt.')
  }
  if (tampered.error) {
    throw new Error(label + ': tampered launch failed to spawn: ' + tampered.error.message)
  }
  if (tampered.signal) {
    throw new Error(label + ': TAMPER PROTECTION FAILURE — modified exe was killed by signal ' + tampered.signal +
      ' (timeout) instead of self-exiting with code 1. The integrity check is not detecting tampering. ' + describe(tampered))
  }
  if (tampered.code !== 1) {
    throw new Error(label + ': TAMPER PROTECTION FAILURE — modified exe exited with code ' + tampered.code +
      ', expected 1. The integrity check did not detect the byte flip. ' + describe(tampered))
  }
  if (!tampered.marker) {
    throw new Error(label + ': TAMPER PROTECTION FAILURE — modified exe exited 1 but did not write the ' +
      'integrity-error dialog marker. The fail() code path that shows the user-facing dialog was not reached. ' +
      describe(tampered))
  }
  if (tampered.marker.dialogShown !== true) {
    throw new Error(label + ': TAMPER PROTECTION FAILURE — integrity-error dialog was NOT shown to the user. ' +
      'Marker reported dialogShown=' + tampered.marker.dialogShown + ' (dialogError=' +
      (tampered.marker.dialogError || 'none') + '). Reason: ' + tampered.marker.reason)
  }
  if (tampered.marker.title !== 'Application Integrity Error') {
    throw new Error(label + ': dialog marker has unexpected title "' + tampered.marker.title +
      '" — the dialog content may have regressed.')
  }
  console.log('    OK: tampered exe exited 1, integrity-error dialog path confirmed (reason: ' +
    tampered.marker.reason + ')')

  console.log('  [3/3] Re-verifying restored exe still launches cleanly (expect exit 0)...')
  const post = runExe(exePath, null)
  if (post.code !== 0) {
    throw new Error(label + ': restored exe exited with ' + post.code + ' (expected 0). ' +
      'Restore step may have left the file corrupt. ' + describe(post))
  }
  console.log('    OK: restored exe exits 0')
  console.log('  [PASS] ' + label + ' tamper protection verified')
}

function findExes(dir) {
  return fs.readdirSync(dir).filter(function (f) {
    if (!f.toLowerCase().endsWith('.exe')) return false
    const lower = f.toLowerCase()
    if (lower === 'elevate.exe' || lower === 'uninstall.exe') return false
    if (lower.indexOf('crashpad') !== -1) return false
    return true
  })
}

function main() {
  const repoRoot = path.join(__dirname, '..')
  const targets = [
    { dir: path.join(repoRoot, 'dist-electron', 'win-unpacked'), label: 'Launcher' },
    { dir: path.join(repoRoot, 'server', 'dist-electron', 'win-unpacked'), label: 'Server' },
  ]

  console.log('=== NEXTREME GAMING HUB Tamper Protection Regression Test ===')

  if (process.platform !== 'win32') {
    console.log('[tamper-test] SKIP: not running on Windows (platform=' + process.platform +
      '). The .exe binaries can only be executed on Windows.')
    return
  }

  let tested = 0
  const missing = []
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    if (!fs.existsSync(t.dir)) {
      missing.push(t)
      if (ALLOW_MISSING) {
        console.log('[tamper-test] SKIP ' + t.label + ': ' + t.dir + ' not built (--allow-missing)')
      }
      continue
    }
    const exes = findExes(t.dir)
    if (exes.length === 0) {
      throw new Error('[tamper-test] ' + t.label + ': no testable .exe found in ' + t.dir)
    }
    for (let j = 0; j < exes.length; j++) {
      testApp(t.dir, exes[j], t.label + ' (' + exes[j] + ')')
      tested++
    }
  }

  if (missing.length > 0 && !ALLOW_MISSING) {
    throw new Error('[tamper-test] FATAL: expected unpacked build(s) missing: ' +
      missing.map(function (m) { return m.label + ' at ' + m.dir }).join('; ') +
      '. Run the full build (build.bat / npm run dist + npm run dist:server) first, or pass --allow-missing to test only what is present.')
  }
  if (tested === 0) {
    throw new Error('[tamper-test] FATAL: nothing was tested.')
  }

  console.log('\n[tamper-test] ALL PASSED (' + tested + ' executable(s) verified)')
}

try {
  main()
} catch (err) {
  console.error('\n[tamper-test] FAILURE: ' + (err && err.message ? err.message : err))
  console.error('[tamper-test] Release blocked — tamper protection is not working as expected.')
  process.exit(1)
}
