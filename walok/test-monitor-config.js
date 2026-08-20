'use strict'

const assert = require('assert')
const path = require('path')
const { resolveOtaConfigPath } = require('./electron/ota-config-path')

assert.strictEqual(
  resolveOtaConfigPath({
    isPackaged: true,
    resourcesPath: 'C:\\Program Files\\Walok\\resources',
    sourceDir: __dirname,
  }),
  path.join('C:\\Program Files\\Walok\\resources', 'ota-config.json'),
  'packaged monitor must read the extraResources ota-config.json location'
)

assert.strictEqual(
  resolveOtaConfigPath({ isPackaged: false, resourcesPath: '', sourceDir: path.join(__dirname, 'electron') }),
  path.join(__dirname, 'branding', 'ota-config.json'),
  'development monitor must read branding/ota-config.json'
)

console.log('PASS: monitor OTA configuration paths resolve correctly')