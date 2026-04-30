const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const repoRoot = path.join(__dirname, '..')

function readBrandTitleHyphen() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'branding', 'config.json'), 'utf-8'))
    if (cfg && typeof cfg.titleHyphen === 'string' && cfg.titleHyphen.trim()) {
      return cfg.titleHyphen.trim()
    }
    if (cfg && typeof cfg.brandName === 'string' && cfg.brandName.trim()) {
      return cfg.brandName.trim().split(/\s+/).map(function(w) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      }).join('-')
    }
  } catch (e) {}
  return 'App'
}

const brandTitle = readBrandTitleHyphen()
const releaseDir = path.join(repoRoot, brandTitle + '-Release')

const cscLink = process.env.CSC_LINK && process.env.CSC_LINK.trim().length > 0
const signingExpected = !!cscLink

console.log('\n=== Signed Installer Verification ===\n')
console.log('  CSC_LINK is ' + (signingExpected ? 'SET — installers must be signed.' : 'NOT set — installers are expected to be UNSIGNED.'))

if (!fs.existsSync(releaseDir)) {
  console.error('\n[verify-sign] FATAL: Release folder not found at ' + releaseDir + ' — nothing to verify.')
  process.exit(1)
}

const exeFiles = fs.readdirSync(releaseDir).filter(f => f.toLowerCase().endsWith('.exe'))
if (exeFiles.length === 0) {
  console.error('\n[verify-sign] FATAL: No .exe files found in ' + releaseDir + ' — nothing to verify.')
  process.exit(1)
}

function runSigntool(exePath) {
  const result = spawnSync('signtool', ['verify', '/pa', '/v', exePath], { encoding: 'utf8' })
  return result
}

let failures = 0
let signtoolMissing = false

for (const file of exeFiles) {
  const exePath = path.join(releaseDir, file)
  console.log('\n[verify-sign] Verifying signature: ' + file)
  const result = runSigntool(exePath)

  if (result.error && result.error.code === 'ENOENT') {
    signtoolMissing = true
    if (signingExpected) {
      console.error('  [ERROR] signtool not found in PATH. Install the Windows SDK or add signtool.exe to PATH.')
      failures++
    } else {
      console.warn('  [SKIP] signtool not found in PATH — cannot verify signatures.')
      console.warn('         CSC_LINK is not set, so this build was not expected to be signed;')
      console.warn('         skipping verification instead of failing the build.')
    }
    break
  }

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  if (result.status === 0) {
    console.log('  [OK] ' + file + ' is signed and the signature is valid.')
  } else {
    console.error('  [FAIL] ' + file + ' is NOT validly signed (signtool exit code ' + result.status + ').')
    failures++
  }
}

console.log('')

if (failures === 0) {
  console.log('============================================')
  console.log('  All ' + exeFiles.length + ' installer(s) verified as validly signed.')
  console.log('============================================\n')
  process.exit(0)
}

if (signingExpected) {
  console.error('============================================')
  console.error('  WARNING: SIGNED INSTALLER VERIFICATION FAILED')
  console.error('============================================')
  if (signtoolMissing) {
    console.error('  signtool was not found, so signatures could not be verified.')
    console.error('  Because CSC_LINK is set, signatures are required. Install the Windows SDK')
    console.error('  (which provides signtool.exe) and re-run the build.')
  } else {
    console.error('  CSC_LINK was set, so installers were expected to be signed,')
    console.error('  but ' + failures + ' installer(s) failed signtool verification above.')
    console.error('  Installers are still in ' + brandTitle + '-Release/, but you should')
    console.error('  NOT ship them — they will trigger Unknown-publisher warnings.')
  }
  console.error('')
  process.exit(1)
}

console.warn('============================================')
console.warn('  WARNING: INSTALLERS ARE UNSIGNED')
console.warn('============================================')
console.warn('  CSC_LINK was not set for this build, so the installers in')
console.warn('  ' + brandTitle + '-Release/ are UNSIGNED.')
console.warn('  End users will see a Windows "Unknown publisher" SmartScreen warning.')
console.warn('  To produce signed installers, set CSC_LINK and CSC_KEY_PASSWORD before')
console.warn('  running build.bat and rebuild.')
console.warn('')
process.exit(0)
