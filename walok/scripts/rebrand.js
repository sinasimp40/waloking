const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const BRANDING_DIR = path.join(ROOT, 'branding')
const CONFIG_PATH = path.join(BRANDING_DIR, 'config.json')

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function titleHyphen(name) {
  return name.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('-')
}

function appIdBase(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function jwtEnvVar(prefix) {
  var name = String(prefix || '').toUpperCase()
  name = name.replace(/[^A-Z0-9]+/g, '_')
  name = name.replace(/^_+|_+$/g, '')
  if (!name) name = 'APP'
  return name + '_JWT_SECRET'
}

function sanitizeAuthJsJwtEnv(filePath, newPrefix) {
  if (!fs.existsSync(filePath)) return
  var content = fs.readFileSync(filePath, 'utf-8')
  var correct = jwtEnvVar(newPrefix)
  var fixed = content.replace(
    /process\.env\.[A-Za-z0-9_ ]*_JWT_SECRET/g,
    'process.env.' + correct
  )
  if (fixed !== content) {
    fs.writeFileSync(filePath, fixed)
    console.log('  [HEAL] normalized JWT env var in ' + path.relative(ROOT, filePath) + ' -> ' + correct)
  }
}

function camelCase(prefix) {
  return prefix.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

function buildIcoBuffer(pngBuffers, sizes) {
  const count = pngBuffers.length
  let dataOffset = 6 + 16 * count
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  const parts = [header]
  const offsets = []
  for (let i = 0; i < count; i++) {
    offsets.push(dataOffset)
    dataOffset += pngBuffers[i].length
  }
  for (let i = 0; i < count; i++) {
    const entry = Buffer.alloc(16)
    const s = sizes[i]
    entry.writeUInt8(s >= 256 ? 0 : s, 0)
    entry.writeUInt8(s >= 256 ? 0 : s, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(pngBuffers[i].length, 8)
    entry.writeUInt32LE(offsets[i], 12)
    parts.push(entry)
  }
  parts.push(...pngBuffers)
  return Buffer.concat(parts)
}

function replaceAll(content, search, replace) {
  if (!search) return content
  return content.split(search).join(replace)
}

function processFile(filePath, replacements) {
  if (!fs.existsSync(filePath)) {
    console.log('  [SKIP] ' + path.relative(ROOT, filePath))
    return
  }
  let content = fs.readFileSync(filePath, 'utf-8')
  for (const [search, rep] of replacements) {
    content = replaceAll(content, search, rep)
  }
  fs.writeFileSync(filePath, content)
  console.log('  [OK] ' + path.relative(ROOT, filePath))
}

function rebuildLauncherMigration(legacyPrefixes, newPrefix) {
  const filePath = path.join(ROOT, 'electron/main.js')
  let content = fs.readFileSync(filePath, 'utf-8')
  const entries = []
  for (const legacy of legacyPrefixes) {
    entries.push("    ['" + legacy + "-settings.json', '" + newPrefix + "-settings.json']")
    entries.push("    ['" + legacy + "-data', '" + newPrefix + "-data']")
    entries.push("    ['" + legacy + "-assets', '" + newPrefix + "-assets']")
  }
  const newArray = 'const renames = [\n' + entries.join(',\n') + '\n  ]'
  content = content.replace(/const renames = \[\n[\s\S]*?\n  \]/, newArray)
  fs.writeFileSync(filePath, content)
  console.log('  [OK] electron/main.js (migration array)')
}

function rebuildServerMigration(legacyPrefixes, newPrefix) {
  const filePath = path.join(ROOT, 'server/electron/main.js')
  let content = fs.readFileSync(filePath, 'utf-8')
  const entries = []
  for (const legacy of legacyPrefixes) {
    entries.push("    ['" + legacy + "-server-config.json', '" + newPrefix + "-server-config.json']")
    entries.push("    ['" + legacy + "-server-data', '" + newPrefix + "-server-data']")
  }
  const newArray = 'const renames = [\n' + entries.join(',\n') + '\n  ]'
  content = content.replace(/const renames = \[\n[\s\S]*?\n  \]/, newArray)
  fs.writeFileSync(filePath, content)
  console.log('  [OK] server/electron/main.js (migration array)')
}

function rebuildDbLegacy(legacyPrefixes, newPrefix) {
  const filePath = path.join(ROOT, 'server/electron/db.js')
  let content = fs.readFileSync(filePath, 'utf-8')
  const names = legacyPrefixes.map(function(p) { return "'" + p + "-server.db'" })
  const newArray = 'const legacyDbNames = [' + names.join(', ') + ']'
  content = content.replace(/const legacyDbNames = \[.*?\]/, newArray)
  fs.writeFileSync(filePath, content)
  console.log('  [OK] server/electron/db.js (legacy db names)')
}

// Rewrites the three brand-defining constants in walok/electron/brand.js
// and walok/server/electron/brand.js. These files are the runtime source of
// truth for BRAND_SLUG (drives the per-install <slug>-data / <slug>-assets /
// <slug>-settings.json folder + file names) and DISPLAY_NAME (window title,
// log lines). They are NOT in the global string-replace `files` list because
// LEGACY_BRAND_SLUGS contains literal old slugs (e.g. 'denfi') that must
// survive a rebrand verbatim, and a blind string-replace would mangle them
// or create duplicates. Instead we structurally rewrite just the three
// constants and leave the surrounding documentation comments untouched.
//
// LEGACY_BRAND_SLUGS is rebuilt from `legacyPrefixes` (which already excludes
// newPrefix) with newPrefix appended last as the current slug — the runtime
// migration code skips `oldSlug === BRAND_SLUG` so duplicating it is safe but
// wasteful, and explicit ordering keeps the diff readable.
// Escape a value for use inside a single-quoted JS string literal. Brand
// names like "O'BRIEN CAFE" would otherwise emit broken JS and crash the
// launcher on startup. slugify() strips non-alphanumerics so newPrefix is
// always safe, but we escape it anyway for symmetry.
function escapeSingleQuoted(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function rebuildBrandJs(filePath, newPrefix, newDisplayName, legacyPrefixes) {
  if (!fs.existsSync(filePath)) {
    console.warn('  [WARN] missing ' + path.relative(ROOT, filePath) + ' — runtime BRAND_SLUG will not be updated; data folder names will be wrong')
    return
  }
  let content = fs.readFileSync(filePath, 'utf-8')
  content = content.replace(
    /const BRAND_SLUG = '[^']*'/,
    "const BRAND_SLUG = '" + escapeSingleQuoted(newPrefix) + "'"
  )
  content = content.replace(
    /const DISPLAY_NAME = '[^']*'/,
    "const DISPLAY_NAME = '" + escapeSingleQuoted(newDisplayName) + "'"
  )
  const slugs = legacyPrefixes.concat([newPrefix])
  const entries = slugs.map(function(s) { return "  '" + escapeSingleQuoted(s) + "'" }).join(',\n')
  const newArray = 'const LEGACY_BRAND_SLUGS = [\n' + entries + '\n]'
  content = content.replace(/const LEGACY_BRAND_SLUGS = \[[\s\S]*?\n\]/, newArray)
  fs.writeFileSync(filePath, content)
  console.log('  [OK] ' + path.relative(ROOT, filePath) + ' (BRAND_SLUG, DISPLAY_NAME, LEGACY_BRAND_SLUGS)')
}

function rebuildStorageKeys(legacyPrefixes) {
  const filePath = path.join(ROOT, 'src/main.jsx')
  let content = fs.readFileSync(filePath, 'utf-8')
  const keys = legacyPrefixes.map(function(p) { return "'" + p + "-storage'" })
  const newArray = 'const legacyKeys = [' + keys.join(', ') + ']'
  content = content.replace(/const legacyKeys = \[.*?\]/, newArray)
  fs.writeFileSync(filePath, content)
  console.log('  [OK] src/main.jsx (legacy storage keys)')
}

function bumpStorageVersion(newVersion) {
  const filePath = path.join(ROOT, 'src/store/useStore.js')
  let content = fs.readFileSync(filePath, 'utf-8')
  content = content.replace(/version: \d+,/, 'version: ' + newVersion + ',')
  fs.writeFileSync(filePath, content)
  console.log('  [OK] Storage version -> ' + newVersion)
}

// Deterministic resolution of the ICO source. The build pipeline writes the
// per-customer source to branding/logo.<ext>, so we ALWAYS prefer that name
// over the result of a readdir scan. The old readdir-first behaviour combined
// with the build-customer mass-delete bug to produce builds where every
// customer got whatever logo happened to sort first in the directory listing.
//
// Order:
//   1. branding/logo.<ext> for ext in [png, jpg, jpeg, webp, bmp] (in that order)
//   2. Any other image in branding/ (legacy fallback for ad-hoc rebrands)
function resolveBrandingIcoSource(brandingDir) {
  const preferredExts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp']
  for (const e of preferredExts) {
    const p = path.join(brandingDir, 'logo' + e)
    if (fs.existsSync(p)) {
      return { path: p, name: 'logo' + e, strategy: 'preferred-logo' + e }
    }
  }
  const fallbackExts = ['.png', '.jpg', '.jpeg', '.jfif', '.webp', '.svg', '.bmp']
  let files
  try { files = fs.readdirSync(brandingDir).sort() } catch (e) { return null }
  const fb = files.find(function(f) {
    return fallbackExts.includes(path.extname(f).toLowerCase())
  })
  if (fb) return { path: path.join(brandingDir, fb), name: fb, strategy: 'fallback-readdir' }
  return null
}

async function generateIcoFromBranding() {
  const resolved = resolveBrandingIcoSource(BRANDING_DIR)
  if (!resolved) {
    console.log('\n  [INFO] No image found in branding/ folder. ICO not regenerated.')
    console.log('  Drop a PNG/JPG/WEBP image in branding/ to auto-generate ICO.\n')
    return false
  }

  let sharp
  try { sharp = require('sharp') } catch (e) {
    console.log('\n  [WARN] sharp not installed. Run "npm install" first. ICO not generated.')
    return false
  }

  const imgPath = resolved.path
  const srcBytes = fs.readFileSync(imgPath)
  const sha = require('crypto').createHash('sha256').update(srcBytes).digest('hex').slice(0, 12)
  console.log('\n  [rebrand] ICO source: ' + path.relative(ROOT, imgPath) +
    ' (' + srcBytes.length + ' bytes, sha256=' + sha + ', strategy=' + resolved.strategy + ')')

  const pngBuffer = await sharp(imgPath)
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer()

  const sizes = [256, 128, 64, 48, 32, 16]
  const pngBuffers = await Promise.all(sizes.map(function(s) {
    return sharp(pngBuffer).resize(s, s).png().toBuffer()
  }))

  const icoBuffer = buildIcoBuffer(pngBuffers, sizes)

  fs.writeFileSync(path.join(ROOT, 'public', 'icon.ico'), icoBuffer)
  fs.writeFileSync(path.join(ROOT, 'server', 'src', 'icon.ico'), icoBuffer)
  console.log('  ICO written to public/icon.ico and server/src/icon.ico')
  return true
}

async function updateLogoPng(oldPrefix, newPrefix) {
  const publicDir = path.join(ROOT, 'public')
  const oldLogo = path.join(publicDir, oldPrefix + '-logo.png')
  const newLogo = path.join(publicDir, newPrefix + '-logo.png')

  // Use the SAME deterministic source resolution as generateIcoFromBranding,
  // so the rebranded launcher PNG and the ICO are guaranteed to come from the
  // same file. Previously this used readdir-first selection, which combined
  // with sibling per-channel logos in branding/ could silently pick a logo
  // belonging to a different channel and bake it into <prefix>-logo.png.
  const resolved = resolveBrandingIcoSource(BRANDING_DIR)
  if (resolved) {
    try {
      const sharp = require('sharp')
      await sharp(resolved.path)
        .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toFile(newLogo)
      console.log('  Logo PNG -> ' + newPrefix + '-logo.png (source: ' + path.relative(ROOT, resolved.path) + ')')
    } catch (e) {
      // Don't swallow silently — surface the failure so a broken sharp
      // install or unreadable source file doesn't ship a stale launcher logo.
      console.log('  [WARN] updateLogoPng failed: ' + e.message)
    }
  }

  if (oldLogo !== newLogo && fs.existsSync(oldLogo)) {
    try { fs.unlinkSync(oldLogo) } catch (e) {}
  }
}

module.exports = { resolveBrandingIcoSource, slugify, titleHyphen, appIdBase, jwtEnvVar }

async function main() {
  const newName = process.argv[2]
  const newSubtitle = process.argv[3] || 'Internet Cafe'

  if (!newName) {
    console.error('Usage: node scripts/rebrand.js "BRAND NAME" ["Subtitle"]')
    console.error('Example: node scripts/rebrand.js "NEXTREME GAMING HUB" "Internet Cafe"')
    process.exit(1)
  }

  let config
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  } catch (e) {
    console.error('Error: branding/config.json not found.')
    process.exit(1)
  }

  const oldName = config.brandName
  const oldPrefix = config.filePrefix
  const oldSubtitle = config.subtitle || 'Internet Cafe'
  const oldVersion = config.storageVersion
  const oldTitleH = config.titleHyphen || titleHyphen(oldName)
  const oldAppId = config.appIdBase || appIdBase(oldName)
  const oldSlug = slugify(oldName)

  const newPrefix = slugify(newName)
  const newVersion = oldVersion + 1
  const newTitleH = titleHyphen(newName)
  const newAppIdBase = appIdBase(newName)
  var legacyPrefixes = [].concat(config.legacyPrefixes || [], [oldPrefix])
  if (oldSlug !== oldPrefix && legacyPrefixes.indexOf(oldSlug) === -1) {
    legacyPrefixes.push(oldSlug)
  }
  legacyPrefixes = legacyPrefixes.filter(function(p) { return p !== newPrefix })

  console.log('')
  console.log('=== REBRAND ===')
  console.log('  From: ' + oldName + ' (' + oldPrefix + ')')
  console.log('  To:   ' + newName + ' (' + newPrefix + ')')
  console.log('  Subtitle: ' + oldSubtitle + ' -> ' + newSubtitle)
  console.log('  Version: ' + oldVersion + ' -> ' + newVersion)
  console.log('  App ID: com.' + oldAppId + ' -> com.' + newAppIdBase)
  console.log('  Legacy: ' + legacyPrefixes.join(', '))
  console.log('')

  var replacements = [
    [oldName, newName],
    [oldSubtitle, newSubtitle],
    [oldTitleH, newTitleH],
  ]
  if (oldSlug !== oldPrefix) {
    replacements.push([oldSlug, newPrefix])
  }
  replacements.push([oldPrefix, newPrefix])
  replacements.push(['com.' + oldAppId + '.', 'com.' + newAppIdBase + '.'])
  replacements.push([jwtEnvVar(oldPrefix), jwtEnvVar(newPrefix)])
  replacements.push([oldPrefix + '-server-secret-key-change-me', newPrefix + '-server-secret-key-change-me'])
  replacements.push(['----' + camelCase(oldPrefix) + 'Boundary', '----' + camelCase(newPrefix) + 'Boundary'])

  var files = [
    'electron/main.js',
    'electron/splash.html',
    'electron/installer.nsh',
    'electron/updater.js',
    'electron/ota-live.js',
    'index.html',
    'src/main.jsx',
    'src/App.jsx',
    'src/store/useStore.js',
    'src/components/TitleBar.jsx',
    'src/components/FeaturedBanner.jsx',
    'src/components/AdminPanel.jsx',
    'src/components/SaveLoadModal.jsx',
    'src/components/UpdateModal.jsx',
    'server/electron/main.js',
    'server/electron/api.js',
    'server/electron/auth.js',
    'server/electron/db.js',
    'server/electron/updater.js',
    'server/electron/ota-live.js',
    'server/src/dashboard.html',
    'package.json',
    'server/package.json',
  ]

  console.log('Replacing brand strings...')
  for (const file of files) {
    processFile(path.join(ROOT, file), replacements)
  }

  // Self-healing pass: regardless of what the previous brand state looked
  // like (underscores in name, spaces leaked into identifier, double rebrands,
  // etc.), force the JWT_SECRET env var in auth.js to a valid identifier.
  // This recovers files that were left with `BRAND NAME_JWT_SECRET`
  // (with a space) by older buggy rebrands.
  sanitizeAuthJsJwtEnv(path.join(ROOT, 'server/electron/auth.js'), newPrefix)

  console.log('')
  console.log('Rebuilding migration arrays...')
  rebuildLauncherMigration(legacyPrefixes, newPrefix)
  rebuildServerMigration(legacyPrefixes, newPrefix)
  rebuildDbLegacy(legacyPrefixes, newPrefix)
  rebuildStorageKeys(legacyPrefixes)
  rebuildBrandJs(path.join(ROOT, 'electron/brand.js'), newPrefix, newName, legacyPrefixes)
  rebuildBrandJs(path.join(ROOT, 'server/electron/brand.js'), newPrefix, newName, legacyPrefixes)

  console.log('')
  bumpStorageVersion(newVersion)

  await generateIcoFromBranding()
  await updateLogoPng(oldPrefix, newPrefix)

  var newConfig = {
    brandName: newName,
    titleHyphen: newTitleH,
    subtitle: newSubtitle,
    filePrefix: newPrefix,
    appIdBase: newAppIdBase,
    storageVersion: newVersion,
    legacyPrefixes: legacyPrefixes,
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2))

  console.log('')
  console.log('=== REBRAND COMPLETE ===')
  console.log('"' + oldName + '" -> "' + newName + '"')
  console.log('')
}

if (require.main === module) {
  main().catch(function(e) { console.error('Error:', e.message); process.exit(1) })
}
