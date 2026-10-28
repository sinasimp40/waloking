import assert from 'node:assert/strict'
import { connectSaveServer } from '../src/lib/saveServerDiscovery.js'

function fixture(url = '') {
  const settings = { saveLoadServerUrl: url }
  const writes = []
  return {
    settings, writes,
    getState: () => ({
      settings,
      updateSettings(patch) { writes.push(patch); Object.assign(settings, patch) },
    }),
  }
}

const found = { success: true, url: 'http://192.168.1.20:3456' }
{
  const f = fixture()
  let calls = 0
  const discover = async () => { calls++; return found }
  await Promise.all([
    connectSaveServer({ ...f, discover, isActive: () => false }),
    connectSaveServer({ ...f, discover }),
  ])
  assert.equal(calls, 1, 'Overlapping startup scans share one UDP listener')
  assert.equal(f.settings.saveLoadServerUrl, found.url)
}
{
  const f = fixture()
  let timeout
  const result = await connectSaveServer({ ...f, discover: async ms => { timeout = ms; return found } })
  assert.equal(result.success, true)
  assert.equal(timeout, 8000)
  assert.equal(f.settings.saveLoadServerUrl, found.url)
}
{
  const f = fixture('http://manual-server:3456')
  let called = false
  await connectSaveServer({ ...f, discover: async () => { called = true; return found } })
  assert.equal(called, false, 'Startup preserves manually configured servers')
  assert.equal(f.writes.length, 0)
  await connectSaveServer({ ...f, discover: async () => found, replaceExisting: true })
  assert.equal(f.settings.saveLoadServerUrl, found.url, 'Explicit Auto-detect can change the server')
}
{
  const f = fixture()
  const result = await connectSaveServer({ ...f, discover: async () => {
    f.settings.saveLoadServerUrl = 'http://new-manual-server:3456'
    return found
  } })
  assert.equal(result.cancelled, true)
  assert.equal(f.writes.length, 0, 'An in-flight scan cannot overwrite user input')
}
{
  const f = fixture()
  await connectSaveServer({ ...f, discover: async () => found, isActive: () => false })
  assert.equal(f.writes.length, 0, 'Unmounted launchers cannot write settings')
}
for (const discover of [
  undefined,
  async () => null,
  async () => ({ success: false, error: 'No server found' }),
  async () => ({ success: true }),
  async () => { throw new Error('Network unavailable') },
]) {
  const f = fixture()
  assert.equal((await connectSaveServer({ ...f, discover })).success, false)
  assert.equal(f.writes.length, 0)
}
{
  const f = fixture()
  const failed = await connectSaveServer({ ...f, discover: async () => null })
  assert.equal(failed.success, false)
  await connectSaveServer({ ...f, discover: async () => found })
  assert.equal(f.settings.saveLoadServerUrl, found.url, 'A later scan finds a server started after the launcher')
}
console.log('PASS: discovery connection, manual override safety, cancellations, desktop-only fallback, failures and retry')
