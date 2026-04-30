const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const FAIL_TITLE = 'Application Integrity Error'
const FAIL_MESSAGE = 'This application has been modified or tampered with.\n\nPlease reinstall from the official source.'

function fail(electronApi, reason) {
  const testMode = process.env.INTEGRITY_TEST_ONLY === '1'
  let dialogShown = false
  let dialogError = null
  if (testMode) {
    if (electronApi && electronApi.dialog && typeof electronApi.dialog.showErrorBox === 'function') {
      dialogShown = true
    } else {
      dialogError = 'dialog.showErrorBox not available'
    }
    try {
      const markerPath = process.env.INTEGRITY_TEST_MARKER_FILE
      if (markerPath) {
        fs.writeFileSync(markerPath, JSON.stringify({
          dialogShown: dialogShown,
          dialogError: dialogError,
          title: FAIL_TITLE,
          message: FAIL_MESSAGE,
          reason: reason,
          ts: Date.now(),
        }))
      }
    } catch (e) {}
    try { console.error('[integrity] TEST_DIALOG_MARKER ' + JSON.stringify({ dialogShown: dialogShown, title: FAIL_TITLE, reason: reason })) } catch (e) {}
  } else {
    try {
      if (electronApi && electronApi.dialog && typeof electronApi.dialog.showErrorBox === 'function') {
        electronApi.dialog.showErrorBox(FAIL_TITLE, FAIL_MESSAGE)
      }
    } catch (e) {}
  }
  try { console.error('[integrity] FAIL:', reason) } catch (e) {}
  try {
    if (electronApi && electronApi.app && typeof electronApi.app.exit === 'function') {
      electronApi.app.exit(1)
    } else {
      process.exit(1)
    }
  } catch (e) {
    process.exit(1)
  }
}

function verifyIntegrity(electronApi) {
  try {
    if (!electronApi || !electronApi.app || !electronApi.app.isPackaged) {
      return
    }

    let secret
    try {
      const secretFile = path.join(__dirname, '_integrity_secret.json')
      const raw = fs.readFileSync(secretFile, 'utf-8')
      secret = JSON.parse(raw).k
    } catch (e) {
      return fail(electronApi, 'integrity key missing or unreadable')
    }
    if (!secret || typeof secret !== 'string' || secret.length < 32) {
      return fail(electronApi, 'integrity key invalid')
    }

    const manifestPath = path.join(process.resourcesPath, 'integrity.dat')
    if (!fs.existsSync(manifestPath)) {
      return fail(electronApi, 'integrity manifest missing')
    }
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (e) {
      return fail(electronApi, 'integrity manifest unreadable')
    }
    if (!manifest || typeof manifest.hash !== 'string' || typeof manifest.sig !== 'string') {
      return fail(electronApi, 'integrity manifest corrupt')
    }

    let expectedSig
    try {
      expectedSig = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(manifest.hash).digest('hex')
    } catch (e) {
      return fail(electronApi, 'integrity signature compute failed')
    }
    let sigOk = false
    try {
      const a = Buffer.from(expectedSig, 'hex')
      const b = Buffer.from(manifest.sig, 'hex')
      sigOk = a.length === b.length && crypto.timingSafeEqual(a, b)
    } catch (e) {
      sigOk = false
    }
    if (!sigOk) {
      return fail(electronApi, 'integrity manifest signature invalid')
    }

    let actualHash
    try {
      const exeBuf = fs.readFileSync(process.execPath)
      actualHash = crypto.createHash('sha256').update(exeBuf).digest('hex')
    } catch (e) {
      return fail(electronApi, 'unable to read own executable')
    }

    if (actualHash !== manifest.hash) {
      return fail(electronApi, 'executable hash mismatch')
    }

    if (process.env.INTEGRITY_TEST_ONLY === '1') {
      try { console.log('[integrity] TEST_ONLY: verification passed, exiting 0') } catch (e) {}
      try {
        if (electronApi && electronApi.app && typeof electronApi.app.exit === 'function') {
          electronApi.app.exit(0)
        } else {
          process.exit(0)
        }
      } catch (e) {
        process.exit(0)
      }
    }
  } catch (e) {
    return fail(electronApi, 'unexpected: ' + (e && e.message))
  }
}

module.exports = { verifyIntegrity }
