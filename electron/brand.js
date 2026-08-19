// =====================================================================
// LAUNCHER BRAND CONFIG — single source of truth for the launcher side.
// Required by main.js (paths + migration) and updater.js (User-Agent).
// Never hardcode "<slug>-..." or display-name strings outside this file.
//
// To rebrand the LAUNCHER to e.g. DENFI:
//   1. Set BRAND_SLUG = 'denfi' below.  (drives every file/folder name
//      and every OTA User-Agent string in the Electron + Node layer)
//   2. Set DISPLAY_NAME = 'DENFI' below.
//   3. Add the previous slug to LEGACY_BRAND_SLUGS (newest first) so
//      existing customer data auto-migrates on first run.
//   4. Rebrand the SERVER side too (walok/server/electron/brand.js).
//
// HAND-EDIT — these CANNOT be derived from BRAND_SLUG (loaded before
// any JS module, or shown in static HTML / OS-level packaging metadata):
//   * walok/package.json + walok/server/package.json — name + productName
//   * walok/electron/installer.nsh — NSIS uninstaller script
//   * walok/electron/splash.html — 2 textContent literals (~lines 83,90)
//   * walok/index.html — <title> tag
//   * walok/server/src/dashboard.html — <title>, .titlebar-brand,
//     .footer-brand
//
// REACT APP DEFAULTS — the launcher reads launcherName + poweredBy from
// the operator-configured settings (saved per-customer via the admin UI).
// The 'EXAMPLE CAFE' literals scattered through walok/src/components/*
// + walok/src/store/useStore.js are FALLBACK DEFAULTS shown only until
// the operator sets the customer's launcherName/poweredBy in the admin
// panel. Standard rebrand workflow: leave the React fallbacks alone,
// just set launcherName + poweredBy in the admin UI for each customer.
// (Run walok/scripts/check-brand-literals.sh to see the full list.)
//
// DO NOT CHANGE — these are FUNCTIONAL keys; renaming them mid-flight
// will silently log out users / wipe their saved preferences:
//   * 'example-cafe-storage' (Zustand localStorage key in useStore.js +
//     main.jsx migration code) — wipes all user preferences if changed
//   * 'example-cafe-sl-token' / 'example-cafe-sl-user' (sessionStorage
//     auth token in SaveLoadModal.jsx + TitleBar.jsx) — logs out users
//   * 'example-cafe-zoom-set' (first-launch zoom flag in App.jsx) —
//     re-triggers the one-time zoom set on existing installs
//   * EXAMPLE_CAFE_JWT_SECRET env var name in walok/server/electron/auth.js
//     — invalidates ALL live JWT sessions if renamed
// If a rebrand absolutely requires renaming any of these, write a
// migration that reads the OLD key and copies to the new key on first
// launch BEFORE doing the rename.
//
// IMPORTANT: BRAND_SLUG must match the server's BRAND_SLUG and must be
// lowercase, hyphenated, no spaces. Folder/file names (data, assets,
// settings.json) are derived from it and are matched by the OTA
// keep-list rules in walok/electron/updater.js.
//
// ORDERING: list newest → oldest. Migration only renames when target
// doesn't exist, so the first match wins if multiple legacy data dirs
// somehow coexist on a customer machine. Newest-first means the most
// recent prior brand's data is preferred.
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
const BRAND_SUFFIXES = ['-settings.json', '-data', '-assets']

const SETTINGS_FILE = BRAND_SLUG + '-settings.json'
const USER_DATA_DIR = BRAND_SLUG + '-data'
const ASSETS_DIR = BRAND_SLUG + '-assets'

// User-Agent the launcher sends when polling the OTA update server. The
// OTA server may use this for per-brand telemetry, so it should change
// with the brand.
const OTA_USER_AGENT = BRAND_SLUG + '-OTA-Client/1.0'

module.exports = {
  BRAND_SLUG,
  DISPLAY_NAME,
  LEGACY_BRAND_SLUGS,
  BRAND_SUFFIXES,
  SETTINGS_FILE,
  USER_DATA_DIR,
  ASSETS_DIR,
  OTA_USER_AGENT,
}
