/**
 * rebuild-db-from-updates.js
 * --------------------------
 * Rebuilds launcher.db from the existing public/updates/ folder.
 *
 * Run from inside update-server/:
 *   node rebuild-db-from-updates.js
 *
 * What it recovers from each latest.json:
 *   channel        → "channel" field
 *   brand_name     → "exeName" field minus ".exe"  (e.g. "AE.exe" → "AE")
 *   update_server  → "updateServer" field
 *   launcher_version / server_version  → "version" field
 *   launcher_published_at / server_published_at → "releasedAt" field
 *
 * What still needs manual editing in the admin panel after:
 *   subtitle  → defaults to "Gaming Cafe"
 *   logo      → needs re-upload (image files are not stored in updates/)
 */

'use strict'

const fs   = require('fs')
const path = require('path')

// ── resolve paths ─────────────────────────────────────────────────────────────
const SCRIPT_DIR  = __dirname
const UPDATES_DIR = path.join(SCRIPT_DIR, 'public', 'updates')
const DATA_DIR    = path.join(SCRIPT_DIR, 'data')
const DB_PATH     = path.join(DATA_DIR, 'launcher.db')

if (!fs.existsSync(UPDATES_DIR)) {
  console.error('[error] public/updates/ not found — run this script from inside update-server/')
  process.exit(1)
}

fs.mkdirSync(DATA_DIR, { recursive: true })

// ── open DB ───────────────────────────────────────────────────────────────────
let db
try {
  const { DatabaseSync } = require('node:sqlite')
  db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
} catch (_) {
  const Database = require('better-sqlite3')
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
}

// ── ensure schema ─────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  channel                  TEXT PRIMARY KEY,
  brand_name               TEXT NOT NULL,
  subtitle                 TEXT NOT NULL,
  update_server            TEXT NOT NULL,
  logo                     TEXT,
  launcher_version         TEXT,
  server_version           TEXT,
  launcher_published_at    INTEGER,
  server_published_at      INTEGER,
  last_build_at            INTEGER,
  created_at               INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at               INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  launcher_rebuild_count   INTEGER,
  server_rebuild_count     INTEGER,
  launcher_rebuilt_at      INTEGER,
  server_rebuilt_at        INTEGER,
  updates_enabled          INTEGER,
  last_launcher_ip         TEXT,
  last_launcher_seen_at    INTEGER,
  last_server_ip           TEXT,
  last_server_seen_at      INTEGER,
  last_launcher_path       TEXT,
  last_server_path         TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`)

const stmtGet    = db.prepare('SELECT channel FROM customers WHERE channel = ?')
const stmtInsert = db.prepare(`
  INSERT INTO customers (channel, brand_name, subtitle, update_server, logo, updates_enabled)
  VALUES (?, ?, ?, ?, ?, 1)
`)
const stmtUpdate = db.prepare(`
  UPDATE customers
  SET brand_name = ?, subtitle = ?, update_server = ?, logo = COALESCE(?, logo),
      updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE channel = ?
`)
const stmtSetLauncher = db.prepare(`
  UPDATE customers
  SET launcher_version = ?, launcher_published_at = ?,
      updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE channel = ?
`)
const stmtSetServer = db.prepare(`
  UPDATE customers
  SET server_version = ?, server_published_at = ?,
      updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE channel = ?
`)

// ── locate branding dir (mirrors server.js findProjectRoot logic) ─────────────
// update-server/ is a SIBLING of walok/ (new layout), but may also be inside
// walok/ on older installs (legacy layout). Try both.
function findBrandingDir() {
  const candidates = [
    path.join(SCRIPT_DIR, '..', 'walok', 'branding'),  // new: sibling layout
    path.join(SCRIPT_DIR, '..', 'branding'),            // legacy: inside walok
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0] // default to new layout even if not found yet
}
const BRANDING_DIR = findBrandingDir()

// ── helpers ───────────────────────────────────────────────────────────────────
function readManifest(folderName) {
  const p = path.join(UPDATES_DIR, folderName, 'latest.json')
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch (_) { return null }
}

// "AE.exe" → "AE",  "AE Server.exe" → "AE Server",  "18" → "18"
function brandFromExeName(exeName, fallback) {
  if (!exeName) return fallback
  return exeName.replace(/\.exe$/i, '').trim() || fallback
}

// Find logo file for a channel — scans branding/ for any file whose name
// starts with the channel number (e.g. "18-logo.png", "18.png", "18-logo.jpg").
// Only the channel NUMBER is compared — brand name is never used.
function findLogo(channel) {
  if (!fs.existsSync(BRANDING_DIR)) return null
  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
  let files
  try { files = fs.readdirSync(BRANDING_DIR) } catch (_) { return null }
  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    if (!imageExts.has(ext)) continue
    const nameWithoutExt = path.basename(file, ext)
    // Match: filename starts with the channel number followed by - or end-of-name
    // e.g. channel="18" matches "18-logo", "18", "18-anything" but NOT "180-logo"
    if (nameWithoutExt === channel || nameWithoutExt.startsWith(channel + '-')) {
      return 'branding/' + file
    }
  }
  return null
}

// ── scan ──────────────────────────────────────────────────────────────────────
const folders = fs.readdirSync(UPDATES_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name)

const serverFolders   = folders.filter(n => n.endsWith('-server'))
const launcherFolders = folders.filter(n => !n.endsWith('-server'))

let inserted = 0, updated = 0

// ── Step 1: launcher folders → customer rows ──────────────────────────────────
console.log('\n── Launcher channels ────────────────────────────────────────')
for (const folder of launcherFolders) {
  const m = readManifest(folder)

  if (!m) {
    console.log('[!] no latest.json in', folder, '— skipping')
    continue
  }

  const channel      = m.channel     || folder
  const updateServer = m.updateServer || 'http://YOUR-RDP-IP:4231'
  const brandName    = brandFromExeName(m.exeName, channel)
  const releasedAt   = m.releasedAt ? new Date(m.releasedAt).getTime() : null
  const logo         = findLogo(channel)

  if (!stmtGet.get(channel)) {
    stmtInsert.run(channel, brandName, 'Gaming Cafe', updateServer, logo)
    inserted++
    console.log('[+]', channel, '| brand:', brandName, '| server:', updateServer, '| logo:', logo || '(none)')
  } else {
    // Already exists — update brand/server/logo fields so re-runs also fix data
    stmtUpdate.run(brandName, 'Gaming Cafe', updateServer, logo, channel)
    updated++
    console.log('[~]', channel, '| brand:', brandName, '| server:', updateServer, '| logo:', logo || '(none)')
  }

  if (m.version) {
    stmtSetLauncher.run(m.version, releasedAt, channel)
    console.log('    launcher v' + m.version, m.releasedAt ? '(' + m.releasedAt + ')' : '')
  }
}

// ── Step 2: server folders → update server_version on matching row ────────────
console.log('\n── Server channels ──────────────────────────────────────────')
for (const folder of serverFolders) {
  const m = readManifest(folder)
  if (!m) {
    console.log('[!] no latest.json in', folder, '— skipping')
    continue
  }

  // "18-server" → "18"
  const channel    = (m.channel || folder).replace(/-server$/, '')
  const releasedAt = m.releasedAt ? new Date(m.releasedAt).getTime() : null

  if (!stmtGet.get(channel)) {
    console.log('[!]', folder, '— no customer row for "' + channel + '" — skipping')
    continue
  }

  stmtSetServer.run(m.version, releasedAt, channel)
  console.log('[✓]', channel, '| server v' + m.version, m.releasedAt ? '(' + m.releasedAt + ')' : '')
}

// ── Step 3: mark migration done ───────────────────────────────────────────────
db.prepare(`
  INSERT INTO meta (k,v) VALUES ('customers_migrated_v1','1')
  ON CONFLICT(k) DO UPDATE SET v=excluded.v
`).run()

// ── Summary ───────────────────────────────────────────────────────────────────
const total    = db.prepare('SELECT COUNT(*) as c FROM customers').get()
const allRows  = db.prepare('SELECT channel, brand_name, update_server, launcher_version, server_version FROM customers ORDER BY channel').all()

console.log('\n════════════════════════════════════════════════')
console.log(' Done.')
console.log(' Customers inserted :', inserted)
console.log(' Customers updated  :', updated)
console.log(' Total in DB        :', total.c)
console.log('════════════════════════════════════════════════')
console.log('\n Recovered customers:\n')
for (const r of allRows) {
  console.log(
    ' ', r.channel.padEnd(20),
    '| brand:', String(r.brand_name).padEnd(20),
    '| launcher:', r.launcher_version || '-',
    '| server:', r.server_version || '-',
  )
}
console.log('\n Notes:')
console.log('  • Avatar = first letter of Brand Name (logo needs re-upload in admin panel)')
console.log('  • Subtitle defaults to "Gaming Cafe" — edit per customer if needed')
console.log('  • Restart the update server after running this script')
console.log('')
