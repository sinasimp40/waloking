const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

exports.default = async function (context) {
  if (context.electronPlatformName && context.electronPlatformName !== 'win32') {
    console.log('[integrity-before] Skipping (non-Windows platform: ' + context.electronPlatformName + ')')
    return
  }

  const appDir = context.appDir || (context.packager && context.packager.info && context.packager.info.appDir) || process.cwd()
  const electronDir = path.join(appDir, 'electron')
  if (!fs.existsSync(electronDir)) {
    throw new Error('[integrity-before] FATAL: ' + electronDir + ' does not exist; cannot inject integrity secret. Aborting build.')
  }

  if (!process.env.INTEGRITY_BUILD_SECRET) {
    process.env.INTEGRITY_BUILD_SECRET = crypto.randomBytes(32).toString('hex')
  }
  const secret = process.env.INTEGRITY_BUILD_SECRET

  const secretFile = path.join(electronDir, '_integrity_secret.json')
  fs.writeFileSync(secretFile, JSON.stringify({ k: secret }))
  console.log('[integrity-before] Embedded fresh integrity secret at ' + path.relative(process.cwd(), secretFile))
  console.log('[integrity-before] (will be packed into app.asar by electron-builder)')
}
