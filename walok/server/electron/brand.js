// =====================================================================
// SERVER BRAND CONFIG — single source of truth for the server side.
// Required by both walok/server/electron/main.js (config + migration)
// and walok/server/electron/db.js (data dir + sqlite filename + legacy
// db migration). Never hardcode "<slug>-server-..." strings outside
// this file.
//
// To rebrand the SERVER to e.g. DENFI:
//   1. Set BRAND_SLUG = 'denfi' below (must match the launcher's
//      BRAND_SLUG in walok/electron/brand.js).  (drives data dir,
//      sqlite filename, OTA User-Agent strings, /api/status server
//      label, tray tooltip, dashboard window title)
//   2. Set DISPLAY_NAME = 'DENFI' below (SERVER_DISPLAY_NAME =
//      DISPLAY_NAME + ' Server' is used as app.name and window title).
//   3. Add the previous slug to LEGACY_BRAND_SLUGS (newest first) so
//      existing customer DBs and data dirs auto-migrate on first run.
//
// HAND-EDIT (these CANNOT be derived from BRAND_SLUG):
//   * walok/server/package.json — name + productName + description
//   * walok/server/src/dashboard.html — <title>, .titlebar-brand label,
//     .footer-brand label (server admin web UI, loaded before any JS)
//
// REACT APP DEFAULTS — N/A on the server side. The server has no React
// frontend (the dashboard is plain static HTML). All React-app defaults
// for launcherName + poweredBy live in the LAUNCHER's brand.js header.
//
// DO NOT CHANGE without a migration:
//   * walok/server/electron/auth.js — JWT_SECRET env-var name
//     (EXAMPLE_CAFE_JWT_SECRET; renaming logs out every existing user)
//
// Run walok/scripts/check-brand-literals.sh to see the full residue
// list across both launcher and server source trees.
//
// IMPORTANT — LEGACY ORDER:
//   On the rare case a customer has folders/DBs from MULTIPLE old
//   brands at once (shouldn't happen in normal use), the FIRST entry
//   in LEGACY_BRAND_SLUGS that has data wins — later entries are
//   skipped because the migration only renames when the target does
//   not yet exist. List newest → oldest so the most recent prior
//   brand's data is preferred.
// =====================================================================
const BRAND_SLUG = 'example-cafe'
const DISPLAY_NAME = 'EXAMPLE CAFE'

const LEGACY_BRAND_SLUGS = [
  'xyberzone',
  'denfi',
  'pikakz',
  'gamerzspot',
  'jahel-gamers',
  'nextreme-gaming-hub',
  'walok',
  'example-cafe'
]

// Suffixes appended to BRAND_SLUG to form folder/file names at the
// server install root. MUST stay in sync with the OTA keep-list rules
// in walok/server/electron/updater.js: anything ending in '-data',
// '-assets', '-server-config.json', or '-server-config.json' (= still
// '-config.json') survives the per-update wipe.
const BRAND_SUFFIXES = ['-server-config.json', '-server-data']

// Derived public names — every other server file should import these
// (or the helpers below) instead of constructing strings locally.
const SERVER_CONFIG_FILE = BRAND_SLUG + '-server-config.json'
const SERVER_DATA_DIR = BRAND_SLUG + '-server-data'
const SERVER_DB_FILE = BRAND_SLUG + '-server.db'
const SERVER_DISPLAY_NAME = DISPLAY_NAME + ' Server'

// User-Agent the server's OTA polling client sends to the OTA update
// server. The OTA server may use this for per-brand telemetry, so it
// should change with the brand.
const OTA_USER_AGENT = BRAND_SLUG + '-OTA-Server-Client/1.0'

// Legacy DB filenames inside <data-dir>/, e.g. denfi-server.db. Built
// dynamically from LEGACY_BRAND_SLUGS so it stays in sync. Skips the
// current slug so we never try to "rename" the live DB onto itself.
const LEGACY_DB_FILES = LEGACY_BRAND_SLUGS
  .filter(s => s !== BRAND_SLUG)
  .map(s => s + '-server.db')

module.exports = {
  BRAND_SLUG,
  DISPLAY_NAME,
  LEGACY_BRAND_SLUGS,
  BRAND_SUFFIXES,
  SERVER_CONFIG_FILE,
  SERVER_DATA_DIR,
  SERVER_DB_FILE,
  SERVER_DISPLAY_NAME,
  OTA_USER_AGENT,
  LEGACY_DB_FILES,
}
