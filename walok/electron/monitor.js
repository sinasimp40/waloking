/**
 * balok/electron/monitor.js
 *
 * Background PC-monitor heartbeat helper.
 *
 * Can be run in two ways:
 *   1. Required by main.js: monitorModule.start(settingsPath, otaConfigPath)
 *   2. Spawned as a standalone detached Node process:
 *        node monitor.js <settingsPath> <otaConfigPath>
 *
 * Telegram credentials are read from this launcher's local settings and are
 * sent only with monitor events. The update server never persists them.
 *
 * Payload fields (no secrets):
 *   { type, deviceId, deviceName, channel, timestamp, brand }
 *
 * Safe on non-Windows and in development: logs a note and no-ops when
 * the update server URL is missing or the server is unreachable.
 */

'use strict'

const fs   = require('fs')
const os   = require('os')
const http  = require('http')
const https = require('https')
const path  = require('path')
const crypto = require('crypto')

// ── Stable device ID ─────────────────────────────────────────────────────────
// Generated once from machine identifiers; stable across restarts.
// Written to a small sidecar file next to the settings file so a new device
// never generates a new ID just because the user cleared their settings.
function getOrCreateDeviceId(dataDir) {
  const idFile = path.join(dataDir, '.device-id')
  try {
    if (fs.existsSync(idFile)) {
      const id = fs.readFileSync(idFile, 'utf-8').trim()
      if (id && id.length > 8) return id
    }
  } catch (_) {}
  // Generate from hardware fingerprint (hostname + MAC of first non-internal
  // interface). Not cryptographically secret — just needs to be stable.
  const ifaces = os.networkInterfaces()
  let mac = ''
  for (const list of Object.values(ifaces)) {
    for (const iface of (list || [])) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        mac = iface.mac
        break
      }
    }
    if (mac) break
  }
  const seed = os.hostname() + '-' + mac
  const id = 'dev-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)
  try { fs.writeFileSync(idFile, id, 'utf-8') } catch (_) {}
  return id
}

// ── Read settings (best-effort) ──────────────────────────────────────────────
function readSettings(settingsPath) {
  try {
    if (!fs.existsSync(settingsPath)) return {}
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    // Zustand wraps persisted state in { state: { settings } }
    return (raw && raw.state && raw.state.settings) ? raw.state.settings
         : (raw && raw.settings) ? raw.settings
         : {}
  } catch (_) { return {} }
}

// ── Read baked OTA config ────────────────────────────────────────────────────
function readOtaConfig(otaConfigPath) {
  try {
    if (!fs.existsSync(otaConfigPath)) return {}
    return JSON.parse(fs.readFileSync(otaConfigPath, 'utf-8'))
  } catch (_) { return {} }
}

// ── HTTP(S) POST helper ───────────────────────────────────────────────────────
function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const u   = new URL(url)
      const body = JSON.stringify(payload)
      const mod  = u.protocol === 'https:' ? https : http
      const req  = mod.request({
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'https:' ? 443 : 80),
        path:     u.pathname + u.search,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout:  timeoutMs || 8000,
      }, (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')) })
      req.write(body)
      req.end()
    } catch (e) { reject(e) }
  })
}

// ── Monitor loop ──────────────────────────────────────────────────────────────
let _timer     = null
let _running   = false

function start(settingsPath, otaConfigPath) {
  if (_running) return
  _running = true

  function tick() {
    try {
      const settings  = readSettings(settingsPath)
      const otaCfg    = readOtaConfig(otaConfigPath)

      // Respect the monitor-enabled toggle (default: off)
      const monitorEnabled = settings.monitorEnabled === true
      if (!monitorEnabled) {
        // Check again after the standard interval in case the user enables it
        const intervalMs = Math.min(60, Math.max(30, Number(settings.monitorIntervalSeconds) || 30)) * 1000
        _timer = setTimeout(tick, intervalMs)
        return
      }

      // The server marks a PC stale after 90 seconds, so never use a legacy
      // interval that could cause false offline/online transitions.
      const intervalMs   = Math.min(60, Math.max(30, Number(settings.monitorIntervalSeconds) || 30)) * 1000
      const updateServer = (settings.updateServerUrl || otaCfg.updateServer || otaCfg.updateServerUrl || '').trim().replace(/\/$/, '')
      const channel      = otaCfg.channel || 'example-cafe'
      const brand        = otaCfg.brandName || otaCfg.brand || 'EXAMPLE CAFE'

      if (!updateServer) {
        // No server configured — nothing to do, retry later
        _timer = setTimeout(tick, intervalMs)
        return
      }

      const dataDir  = path.dirname(settingsPath)
      const deviceId = getOrCreateDeviceId(dataDir)
      const pcName   = (settings.pcName || os.hostname() || 'Unknown PC').trim()

      const payload = {
        type:       'heartbeat',
        deviceId,
        deviceName: pcName,
        channel,
        brand,
        timestamp:  new Date().toISOString(),
        platform:   process.platform,
        notificationEnabled: settings.notificationEnabled !== false,
        notifyPcMonitoring: settings.notifyPcMonitoring !== false,
        telegram: {
          botToken: String(settings.telegramBotToken || '').trim(),
          chatId: String(settings.telegramChatId || '').trim(),
        },
      }

      const endpoint = updateServer + '/api/live/' + encodeURIComponent(channel) + '/monitor/' + encodeURIComponent(deviceId) + '/heartbeat'
      postJson(endpoint, payload, 8000)
        .then(r => {
          if (r.status < 200 || r.status >= 300) {
            console.warn('[monitor] heartbeat HTTP', r.status)
          }
        })
        .catch(e => console.warn('[monitor] heartbeat error:', e.message))
        .finally(() => {
          _timer = setTimeout(tick, intervalMs)
        })
    } catch (e) {
      console.warn('[monitor] tick error:', e.message)
      _timer = setTimeout(tick, 30000)
    }
  }

  // First tick after a small delay so main process settles
  _timer = setTimeout(tick, 5000)
  console.log('[monitor] started, settings:', settingsPath)
}

function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null }
  _running = false
}

// ── Game-launch event reporter ────────────────────────────────────────────────
function reportGameLaunch(settingsPath, otaConfigPath, gameInfo) {
  try {
    const settings     = readSettings(settingsPath)
    const otaCfg       = readOtaConfig(otaConfigPath)
    const notifyLaunches = settings.notifyGameLaunches !== false && settings.notificationEnabled !== false
    if (!notifyLaunches) return

    const updateServer = (settings.updateServerUrl || otaCfg.updateServer || otaCfg.updateServerUrl || '').trim().replace(/\/$/, '')
    if (!updateServer) return

    const dataDir  = path.dirname(settingsPath)
    const deviceId = getOrCreateDeviceId(dataDir)
    const pcName   = (settings.pcName || os.hostname() || 'Unknown PC').trim()
    const channel  = otaCfg.channel || 'example-cafe'
    const brand    = otaCfg.brandName || otaCfg.brand || 'EXAMPLE CAFE'

    const payload = {
      type:       'game_launch',
      deviceId,
      deviceName: pcName,
      channel,
      brand,
      gameName:   gameInfo.gameName   || 'Unknown Game',
      variation:  gameInfo.variation  || null,
      timestamp:  new Date().toISOString(),
    }

    postJson(updateServer + '/api/monitor/' + encodeURIComponent(channel) + '/game-launch', {
      instance: deviceId,
      deviceName: pcName,
      game: [payload.gameName, payload.variation].filter(Boolean).join(' — '),
      notificationEnabled: settings.notificationEnabled !== false,
      notifyGameLaunches: settings.notifyGameLaunches !== false,
      telegram: {
        botToken: String(settings.telegramBotToken || '').trim(),
        chatId: String(settings.telegramChatId || '').trim(),
      },
    }, 8000)
      .catch(e => console.warn('[monitor] game-launch report error:', e.message))
  } catch (e) {
    console.warn('[monitor] reportGameLaunch error:', e.message)
  }
}

module.exports = { start, stop, reportGameLaunch, getOrCreateDeviceId }

// ── Standalone mode (spawned as detached Node process) ──────────────────────
// argv: node monitor.js <settingsPath> <otaConfigPath>
if (require.main === module) {
  const [,, settingsPathArg, otaConfigPathArg] = process.argv
  if (!settingsPathArg || !otaConfigPathArg) {
    console.error('[monitor] Usage: node monitor.js <settingsPath> <otaConfigPath>')
    process.exit(1)
  }
  const lockPath = path.join(path.dirname(settingsPathArg), '.pc-monitor.lock')
  try {
    const existingPid = Number(fs.readFileSync(lockPath, 'utf-8'))
    if (existingPid > 0) {
      process.kill(existingPid, 0)
      process.exit(0)
    }
  } catch (_) {}
  try { fs.writeFileSync(lockPath, String(process.pid), 'utf-8') } catch (_) {}
  const releaseLock = () => {
    try {
      if (Number(fs.readFileSync(lockPath, 'utf-8')) === process.pid) fs.unlinkSync(lockPath)
    } catch (_) {}
  }
  process.on('exit', releaseLock)
  process.on('SIGTERM', () => { releaseLock(); process.exit(0) })
  process.on('SIGINT', () => { releaseLock(); process.exit(0) })
  start(settingsPathArg, otaConfigPathArg)
  // Keep the process alive
  process.stdin.resume()
}
