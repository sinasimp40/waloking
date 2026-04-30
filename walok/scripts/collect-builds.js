const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..')
const launcherDir = path.join(repoRoot, 'dist-electron')
const serverDir = path.join(repoRoot, 'server', 'dist-electron')

function readBrandTitleHyphen() {
  try {
    const cfgPath = path.join(repoRoot, 'branding', 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
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
const outputDir = path.join(repoRoot, brandTitle + '-Release')

function tryRequireAsar() {
  try { return require('@electron/asar') } catch (e) {}
  try { return require('asar') } catch (e2) {}
  return null
}

function verifyIntegrity(unpackedDir, label) {
  const resourcesDir = path.join(unpackedDir, 'resources')
  const manifestPath = path.join(resourcesDir, 'integrity.dat')
  const asarPath = path.join(resourcesDir, 'app.asar')

  if (!fs.existsSync(unpackedDir)) {
    return { ok: false, reason: label + ' unpacked dir not found at ' + unpackedDir }
  }
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: label + ' is missing tamper-protection manifest at ' + manifestPath + ' (integrity hook did not run)' }
  }
  if (!fs.existsSync(asarPath)) {
    return { ok: false, reason: label + ' is missing app.asar at ' + asarPath }
  }

  const asar = tryRequireAsar()
  if (!asar) {
    return { ok: false, reason: 'neither @electron/asar nor asar is installed; cannot verify embedded secret in ' + label }
  }

  let hasSecret = false
  try {
    const buf = asar.extractFile(asarPath, 'electron/_integrity_secret.json')
    hasSecret = !!(buf && buf.length > 0)
  } catch (e) {
    hasSecret = false
  }

  if (!hasSecret) {
    return { ok: false, reason: label + ' app.asar does not contain electron/_integrity_secret.json (tamper protection not embedded)' }
  }

  return { ok: true }
}

function copyExeFiles(srcDir, label) {
  if (!fs.existsSync(srcDir)) {
    console.log('  [SKIP] ' + label + ' directory not found: ' + srcDir)
    return 0
  }
  let n = 0
  const files = fs.readdirSync(srcDir)
  for (const file of files) {
    if (file.endsWith('.exe')) {
      const src = path.join(srcDir, file)
      const dest = path.join(outputDir, file)
      fs.copyFileSync(src, dest)
      const sizeMB = (fs.statSync(dest).size / (1024 * 1024)).toFixed(1)
      console.log('  [OK] ' + file + ' (' + sizeMB + ' MB)')
      n++
    }
  }
  return n
}

console.log('\n=== ' + brandTitle + ' Build Collector ===\n')
console.log('Output folder: ' + path.basename(outputDir))

if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, { recursive: true })
}
fs.mkdirSync(outputDir, { recursive: true })

let copied = 0
console.log('\nCollecting launcher builds...')
copied += copyExeFiles(launcherDir, 'Launcher')
console.log('Collecting server builds...')
copied += copyExeFiles(serverDir, 'Server')

console.log('')
console.log('Verifying tamper protection in built artifacts (non-fatal)...')
const warnings = []
const launcherUnpacked = path.join(launcherDir, 'win-unpacked')
if (fs.existsSync(launcherDir)) {
  const r = verifyIntegrity(launcherUnpacked, 'Launcher')
  if (r.ok) console.log('  [VERIFIED] Launcher tamper protection present')
  else { console.log('  [WARN] ' + r.reason); warnings.push(r.reason) }
} else {
  console.log('  [SKIP] Launcher build not found')
}
const serverUnpacked = path.join(serverDir, 'win-unpacked')
if (fs.existsSync(serverDir)) {
  const r = verifyIntegrity(serverUnpacked, 'Server')
  if (r.ok) console.log('  [VERIFIED] Server tamper protection present')
  else { console.log('  [WARN] ' + r.reason); warnings.push(r.reason) }
} else {
  console.log('  [SKIP] Server build not found')
}

console.log('')
if (copied > 0) {
  console.log('Done! ' + copied + ' file(s) copied to: ' + path.basename(outputDir) + '/')
} else {
  try { fs.rmSync(outputDir, { recursive: true, force: true }) } catch (e) {}
  console.log('ERROR: No .exe files found in dist-electron/ or server/dist-electron/.')
  console.log('       Make sure both builds completed successfully.')
  process.exit(1)
}

if (warnings.length > 0) {
  console.log('')
  console.log('  Tamper-protection verification produced ' + warnings.length + ' warning(s) above.')
  console.log('  Installers were collected, but you may want to investigate before shipping.')
  process.exit(2)
}

process.exit(0)
