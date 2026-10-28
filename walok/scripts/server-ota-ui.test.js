const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Run the real dashboard OTA controller with an isolated DOM/IPC fixture.
// No update downloads, installation, customer configuration, or release writes.
const html = fs.readFileSync(path.join(__dirname, '../server/src/dashboard.html'), 'utf8')
const start = html.indexOf('if (window.serverAPI && window.serverAPI.ota)')
assert.ok(start >= 0)
const controller = html.slice(start, html.indexOf('</script>', start))
const elements = new Map()
function element(id) {
  if (!elements.has(id)) {
    const classes = new Set()
    elements.set(id, {
      textContent: '', style: {}, listeners: {},
      classList: {
        add: value => classes.add(value),
        remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value) },
      },
      addEventListener(event, callback) { this.listeners[event] = callback },
    })
  }
  return elements.get(id)
}
const handlers = {}
let proceeded = 0
let dismissed = 0
vm.runInNewContext(controller, {
  document: { getElementById: element },
  window: { serverAPI: { ota: {
    getStatus: () => Promise.resolve({ currentVersion: '1.2.2' }),
    on: (event, handler) => { handlers[event] = handler },
    proceed: () => { proceeded++ },
    dismiss: () => { dismissed++ },
    restart: () => { throw new Error('Unexpected restart') },
  } } },
  console: { warn() {} },
  setInterval() { return 1 },
  clearInterval() {},
})
const visible = () => element('otaOverlay').classList.contains('visible')

handlers['ota:error']({ stage: 'check', error: 'HTTP 404' })
assert.equal(visible(), false, 'Missing manifest must not open an update failure popup')
handlers['ota:error']({ stage: 'check', error: 'ECONNREFUSED' })
assert.equal(visible(), false, 'Unreachable OTA must not interrupt the server')
assert.equal(proceeded, 0, 'Background checks never start a download')

handlers['ota:update-available']({ currentVersion: '1.2.2', latestVersion: '1.2.3' })
assert.equal(visible(), true)
assert.equal(element('otaTitle').textContent, 'Update available')
assert.equal(element('otaLaterBtn').textContent, 'Later')
assert.equal(proceeded, 0, 'Available updates still require confirmation')
handlers['ota:error']({ stage: 'check', error: 'timeout' })
assert.equal(element('otaTitle').textContent, 'Update available', 'Check errors preserve existing update state')
element('otaProceedBtn').listeners.click()
assert.equal(proceeded, 1)
handlers['ota:download-start']({ totalSize: 100 })
handlers['ota:error']({ stage: 'check', error: 'timeout' })
assert.equal(element('otaTitle').textContent, 'Downloading update')
handlers['ota:error']({ stage: 'download', error: 'SHA-256 mismatch' })
assert.equal(element('otaTitle').textContent, 'Update failed')
assert.equal(element('otaStatusText').textContent, 'SHA-256 mismatch')
assert.equal(element('otaLaterBtn').textContent, 'Close')
assert.equal(element('otaActions').classList.contains('visible'), true)
element('otaLaterBtn').listeners.click()
assert.equal(visible(), false)
assert.equal(dismissed, 1)
handlers['ota:error']({ stage: 'apply', message: 'Files are locked' })
assert.equal(element('otaStatusText').textContent, 'Files are locked')
handlers['ota:error']({ stage: 'download' })
assert.ok(!element('otaStatusText').textContent.includes('Unknown error'))
console.log('PASS: background checks stay silent, updates require confirmation, real failures show details and can close')
