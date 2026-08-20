// Focused syntax/unit tests for the notification + monitor features.
// Run with: node test-notifications.js
// No external test framework — plain assertions with a simple harness.

'use strict'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log('  ✓', msg) }
  else { failed++; console.error('  ✗ FAIL:', msg) }
}

function assertEq(a, b, msg) {
  if (a === b) { passed++; console.log('  ✓', msg) }
  else { failed++; console.error('  ✗ FAIL:', msg, '| got:', a, 'expected:', b) }
}

function assertDeepIncludes(obj, keys, msg) {
  const missing = keys.filter(k => !(k in obj))
  if (missing.length === 0) { passed++; console.log('  ✓', msg) }
  else { failed++; console.error('  ✗ FAIL:', msg, '| missing keys:', missing) }
}

// ── monitor route security ───────────────────────────────────────────────────
console.log('\n[monitor route security]')
{
  const { _internal } = require('./server')
  assertEq(
    _internal.getObservedRequestIp({
      ip: '203.0.113.40',
      socket: { remoteAddress: '203.0.113.40' },
      body: { ip: '10.10.10.5' },
    }),
    '203.0.113.40',
    'game alerts use the server-observed IP, not a spoofed body.ip'
  )
  assertEq(
    _internal.getObservedRequestIp({ ip: '::ffff:10.10.10.5' }),
    '10.10.10.5',
    'server-observed IPv4-mapped addresses are normalized before roster lookup'
  )
}

// ── live.js ───────────────────────────────────────────────────────────────────
console.log('\n[live.js]')
{
  const live = require('./live')

  assert(live.VALID_ROLES.has('launcher'),  'VALID_ROLES contains launcher')
  assert(live.VALID_ROLES.has('server'),    'VALID_ROLES contains server')
  assert(live.VALID_ROLES.has('monitor'),   'VALID_ROLES contains monitor')
  assert(!live.VALID_ROLES.has('unknown'),  'VALID_ROLES rejects unknown')

  // monitorSnapshot on empty channel
  const ms = live.monitorSnapshot('no-such-channel')
  assert(Array.isArray(ms) && ms.length === 0, 'monitorSnapshot returns [] for unknown channel')

  // Monitor hook fires on addClient
  let hookFired = false
  let hookEvent = null
  const unsubGlobal = live.onAnyMonitorEvent((ch, event, entry) => {
    hookFired = true
    hookEvent = event
  })

  live.addClient({
    channel: 'test-ch', role: 'monitor', instance: 'pc1',
    ip: '10.0.0.1', send: () => {}, close: () => {},
  })
  assert(hookFired,  'global monitor hook fires on first addClient(monitor)')
  assertEq(hookEvent, 'online', 'event is "online" for addClient')

  // monitorSnapshot now shows pc1
  const snap = live.monitorSnapshot('test-ch')
  assert(snap.length === 1, 'monitorSnapshot shows 1 online monitor')
  assertEq(snap[0].instance, 'pc1', 'monitorSnapshot instance correct')

  // snapshot() includes monitors
  const full = live.snapshot()
  assert(full['test-ch'], 'snapshot() has test-ch entry')
  assert(Array.isArray(full['test-ch'].monitors), 'snapshot().monitors is array')
  assertEq(full['test-ch'].monitors.length, 1, 'snapshot shows 1 monitor')

  // Hook fires on close
  let closeEvent = null
  const unsubClose = live.onAnyMonitorEvent((ch, ev) => { closeEvent = ev })
  live.removeClient('test-ch', 'monitor', 'pc1')
  assertEq(closeEvent, 'close', 'monitor hook fires "close" on removeClient')

  // monitorSnapshot now empty
  const snapAfter = live.monitorSnapshot('test-ch')
  assertEq(snapAfter.length, 0, 'monitorSnapshot empty after remove')

  // Second addClient for same id does NOT fire hook (re-connect of existing)
  let secondFire = false
  const unsubSecond = live.onAnyMonitorEvent(() => { secondFire = true })
  live.addClient({ channel: 'test-ch', role: 'monitor', instance: 'pc2', ip: '10.0.0.2', send: () => {}, close: () => {} })
  assert(secondFire, 'hook fires for pc2 first connect')
  secondFire = false
  // Adding pc2 again (same channel+id) is a replace, should NOT fire hook
  live.addClient({ channel: 'test-ch', role: 'monitor', instance: 'pc2', ip: '10.0.0.2', send: () => {}, close: () => {} })
  assert(!secondFire, 'hook does NOT fire when same id already registered (re-add)')

  // broadcast skips monitor role
  let broadcastCount = 0
  // Add a launcher + a monitor both in 'test-ch2'
  live.addClient({ channel: 'test-ch2', role: 'launcher', instance: 'l1', send: () => { broadcastCount++ }, close: () => {} })
  live.addClient({ channel: 'test-ch2', role: 'monitor',  instance: 'm1', send: () => { broadcastCount++ }, close: () => {} })
  live.broadcast('test-ch2', { type: 'update', version: '1.0.0' })
  assertEq(broadcastCount, 1, 'broadcast only reaches launcher, not monitor')

  // Per-channel hook
  let perChanFired = false
  const unsubChan = live.onMonitorEvent('test-ch', (ch, ev) => { perChanFired = true })
  live.addClient({ channel: 'test-ch', role: 'monitor', instance: 'pc3', ip: '10.0.0.3', send: () => {}, close: () => {} })
  assert(perChanFired, 'per-channel onMonitorEvent hook fires')

  // Cleanup
  unsubGlobal()
  unsubClose()
  unsubSecond()
  unsubChan()
}

// ── notifications.js ──────────────────────────────────────────────────────────
console.log('\n[notifications.js]')
{
  // Ensure no real tokens in env for this test
  const savedToken  = process.env.TELEGRAM_BOT_TOKEN
  const savedChatId = process.env.TELEGRAM_CHAT_ID
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID

  const notif = require('./notifications')

  // configStatus when not set
  const s = notif.configStatus()
  assertEq(s.configured, false, 'configStatus.configured = false without env vars')
  assertEq(s.tokenSet,   false, 'configStatus.tokenSet = false')
  assertEq(s.chatIdSet,  false, 'configStatus.chatIdSet = false')

  // isConfigured
  assertEq(notif.isConfigured(), false, 'isConfigured() = false without env vars')

  // send returns not-configured when no env vars
  notif.send('hello').then(result => {
    assertEq(result.ok, false, 'send() ok=false without credentials')
    assertEq(result.configured, false, 'send() configured=false without credentials')
  }).catch(e => { failed++; console.error('  ✗ FAIL: send() threw unexpectedly', e) })

  // Restore env
  if (savedToken)  process.env.TELEGRAM_BOT_TOKEN  = savedToken
  if (savedChatId) process.env.TELEGRAM_CHAT_ID    = savedChatId

  // resolvePcName
  const roster = [
    { name: 'Station 1', ip: '192.168.1.10' },
    { name: 'Station 2', ip: '192.168.1.11' },
  ]
  assertEq(notif.resolvePcName('192.168.1.10', 'pc1', roster), 'Station 1', 'resolvePcName matches by IP')
  assertEq(notif.resolvePcName('192.168.1.99', 'pc-fallback', roster), 'pc-fallback', 'resolvePcName falls back to instance')
  assertEq(notif.resolvePcName('', 'pc-fallback', roster), 'pc-fallback', 'resolvePcName falls back to instance when ip empty')
  assertEq(notif.resolvePcName('192.168.1.10', 'pc1', null), 'pc1', 'resolvePcName falls back when no roster')
  assertEq(notif.resolvePcName('192.168.1.10', 'pc1', []), 'pc1', 'resolvePcName falls back on empty roster')

  // buildPcMessage
  const onlinePcs = [{ instance: 'pc2', ip: '192.168.1.11' }, { instance: 'pc1', ip: '192.168.1.10' }]
  const msg = notif.buildPcMessage('online', { ip: '192.168.1.10', instance: 'pc1' }, onlinePcs, roster)
  assert(msg.includes('Station 1'), 'buildPcMessage includes PC name for online')
  assert(msg.includes('came online'), 'buildPcMessage includes "came online"')
  assert(msg.includes('Station 2'), 'buildPcMessage lists other online PCs')
  assert(msg.includes('(2)'), 'buildPcMessage shows online count')

  const msgOffline = notif.buildPcMessage('close', { ip: '192.168.1.10', instance: 'pc1' }, [], roster)
  assert(msgOffline.includes('went offline'), 'buildPcMessage shows "went offline" for close')
  assert(msgOffline.includes('none'), 'buildPcMessage shows none when 0 online')

  const msgStale = notif.buildPcMessage('stale', { ip: '192.168.1.11', instance: 'pc2' }, [], roster)
  assert(msgStale.includes('timeout'), 'buildPcMessage shows timeout for stale')

  // buildGameMessage
  const gameMsg = notif.buildGameMessage('walok', 'pc1', '192.168.1.10', 'Fortnite', roster)
  assert(gameMsg.includes('Station 1'), 'buildGameMessage uses roster name')
  assert(gameMsg.includes('Fortnite'), 'buildGameMessage includes game name')
  assert(gameMsg.includes('walok'), 'buildGameMessage includes channel')

  // HTML entity escaping
  const msgXss = notif.buildPcMessage('online', { ip: '10.0.0.1', instance: '<script>alert(1)</script>' }, [], [])
  assert(!msgXss.includes('<script>'), 'buildPcMessage escapes HTML in instance name')
}

// ── db.js notification config ─────────────────────────────────────────────────
console.log('\n[db.js notification config]')
{
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-test-'))
  process.env.OTA_DATA_DIR = tmpDir

  // The source-IP test above imports server.js, which imports db.js before
  // this test switches OTA_DATA_DIR. Clear that module so this block uses the
  // disposable database it just created.
  delete require.cache[require.resolve('./db')]
  const dbMod = require('./db')

  // No config yet — getNotifConfig should return null
  const none = dbMod.getNotifConfig('chan1')
  assert(none === null, 'getNotifConfig returns null for non-existent channel')

  // getOrCreateNotifConfig creates with defaults
  const created = dbMod.getOrCreateNotifConfig('chan1')
  assert(created !== null, 'getOrCreateNotifConfig creates config')
  assertEq(created.channel, 'chan1', 'config.channel correct')
  assertEq(created.enabled, true, 'default enabled = true')
  assertEq(created.gameLaunches, true, 'default gameLaunches = true')
  assertEq(created.pcMonitoring, true, 'default pcMonitoring = true')
  assert(Array.isArray(created.roster), 'default roster is array')
  assertEq(created.roster.length, 0, 'default roster is empty')
  assert(created.lastDeliveryOk === null, 'lastDeliveryOk initially null')
  assert(created.lastDeliveryAt === null, 'lastDeliveryAt initially null')

  // setNotifConfig merges patches
  const updated = dbMod.setNotifConfig('chan1', { enabled: false, gameLaunches: false })
  assertEq(updated.enabled, false, 'setNotifConfig: enabled updated to false')
  assertEq(updated.gameLaunches, false, 'setNotifConfig: gameLaunches updated')
  assertEq(updated.pcMonitoring, true, 'setNotifConfig: pcMonitoring unchanged')

  // roster update
  const withRoster = dbMod.setNotifConfig('chan1', {
    roster: [{ name: 'PC 1', ip: '10.0.0.1' }, { name: 'PC 2', ip: '10.0.0.2' }],
  })
  assertEq(withRoster.roster.length, 2, 'roster updated to 2 entries')
  assertEq(withRoster.roster[0].name, 'PC 1', 'roster[0].name correct')

  // recordNotifDelivery
  dbMod.recordNotifDelivery('chan1', true)
  const afterDelivery = dbMod.getNotifConfig('chan1')
  assertEq(afterDelivery.lastDeliveryOk, true, 'lastDeliveryOk = true after ok delivery')
  assert(afterDelivery.lastDeliveryAt > 0, 'lastDeliveryAt set')

  dbMod.recordNotifDelivery('chan1', false)
  const afterFail = dbMod.getNotifConfig('chan1')
  assertEq(afterFail.lastDeliveryOk, false, 'lastDeliveryOk = false after failed delivery')

  // Cleanup temp dir
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
  delete process.env.OTA_DATA_DIR
}

// ── Summary ───────────────────────────────────────────────────────────────────
setTimeout(() => {
  console.log('\n' + '─'.repeat(50))
  console.log('Passed: ' + passed + '  Failed: ' + failed)
  if (failed > 0) {
    console.error('[FAIL] ' + failed + ' test(s) failed')
    process.exit(1)
  } else {
    console.log('[PASS] All tests passed')
  }
}, 100) // give async send() a moment to resolve
