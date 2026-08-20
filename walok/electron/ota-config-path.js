'use strict'

const path = require('path')

/**
 * Returns the same OTA configuration location that electron-builder packages.
 * Development reads branding/ directly; packaged Windows builds place the file
 * at resources/ota-config.json through package.json's extraResources entry.
 */
function resolveOtaConfigPath({ isPackaged, resourcesPath, sourceDir }) {
  if (isPackaged) return path.join(resourcesPath, 'ota-config.json')
  return path.join(sourceDir, '..', 'branding', 'ota-config.json')
}

module.exports = { resolveOtaConfigPath }