// =====================================================================
// BALOK BRAND CONFIG — mirrors walok/electron/brand.js.
// Only the OTA User-Agent and the data-folder names are derived here;
// the customer-visible brand name/subtitle come from ota-config.json,
// which the OTA payload replaces on every update.
// =====================================================================
const BRAND_SLUG = 'balok'
const DISPLAY_NAME = 'BALOK'

// Folder/file names at the install root that MUST survive an OTA wipe.
// Balok's portable layout puts everything under <install>/data.
const PORTABLE_DATA_DIR = 'data'
const SETTINGS_FILE = BRAND_SLUG + '-settings.json'

const OTA_USER_AGENT = BRAND_SLUG + '-OTA-Client/1.0'

module.exports = {
  BRAND_SLUG,
  DISPLAY_NAME,
  PORTABLE_DATA_DIR,
  SETTINGS_FILE,
  OTA_USER_AGENT,
}
