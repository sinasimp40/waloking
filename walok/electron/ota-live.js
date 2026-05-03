// Tiny SSE client + heartbeat for the OTA live-push channel. Used by both
// electron/updater.js (launcher) and server/electron/updater.js (server.exe)
// to receive an instant "new version available" notification from the update
// server without waiting for the next 2-minute poll. Falls back to polling
// + HTTP heartbeat when SSE can't connect.
//
// Stays in a single file with **zero** external deps so it works inside the
// asar bundle without any electron-builder configuration changes.

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { BRAND_SLUG } = require('./brand')

const HEARTBEAT_USER_AGENT = BRAND_SLUG + '-OTA-Heartbeat/1.0'
const SSE_USER_AGENT = BRAND_SLUG + '-OTA-Live/1.0'

function log(prefix, msg) { console.log('[OTA-Live ' + prefix + '] ' + msg) }

function loadOrCreateInstanceId(appRoot) {
  const file = path.join(appRoot, '.ota-instance-id')
  try {
    if (fs.existsSync(file)) {
      const v = fs.readFileSync(file, 'utf-8').trim()
      if (/^[A-Za-z0-9_-]{8,128}$/.test(v)) return v
    }
  } catch (e) {}
  const id = crypto.randomBytes(16).toString('hex')
  try { fs.writeFileSync(file, id) } catch (e) {}
  return id
}

function postJson(rawUrl, body) {
  return new Promise((resolve, reject) => {
    let parsed
    try { parsed = new URL(rawUrl) } catch (e) { return reject(e) }
    const mod = parsed.protocol === 'https:' ? https : http
    const data = Buffer.from(JSON.stringify(body || {}))
    const req = mod.request({
      method: 'POST',
      hostname: parsed.hostname, port: parsed.port,
      path: parsed.pathname + parsed.search,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'User-Agent': HEARTBEAT_USER_AGENT,
      },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)) } catch (e) { resolve({ ok: true }) }
        } else {
          reject(new Error('HTTP ' + res.statusCode + ' ' + body.slice(0, 200)))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('heartbeat timeout')) })
    req.write(data); req.end()
  })
}

// Open a long-lived SSE connection. Calls onMessage(payload) for every
// JSON event received from the server. Returns { close() }.
function openSseStream(rawUrl, { onOpen, onMessage, onError }) {
  let parsed
  try { parsed = new URL(rawUrl) } catch (e) { onError && onError(e); return { close() {} } }
  const mod = parsed.protocol === 'https:' ? https : http
  let req
  let closed = false
  let buffer = ''
  try {
    req = mod.get({
      hostname: parsed.hostname, port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: {
        'Accept': 'text/event-stream',
        'User-Agent': SSE_USER_AGENT,
        'Cache-Control': 'no-cache',
      },
      timeout: 0,
    }, (res) => {
      if (res.statusCode !== 200) {
        onError && onError(new Error('SSE HTTP ' + res.statusCode))
        try { res.destroy() } catch (e) {}
        return
      }
      onOpen && onOpen()
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          // Each block can be multiple "data: ..." lines plus comment lines.
          const dataLines = block.split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trimStart())
          if (dataLines.length === 0) continue
          const raw = dataLines.join('\n')
          try {
            const payload = JSON.parse(raw)
            onMessage && onMessage(payload)
          } catch (e) {}
        }
      })
      res.on('end', () => { if (!closed) onError && onError(new Error('stream ended')) })
      res.on('error', (e) => { if (!closed) onError && onError(e) })
    })
    req.on('error', (e) => { if (!closed) onError && onError(e) })
  } catch (e) {
    onError && onError(e)
  }
  return {
    close() {
      closed = true
      try { req && req.destroy() } catch (e) {}
    },
  }
}

// Higher-level helper that wires up SSE + reconnect-with-backoff + periodic
// HTTP heartbeat (so the admin panel still sees "online" even if SSE is being
// blocked by a corporate proxy).
//
//   start({ baseUrl, channel, role, instanceId, currentVersion, onUpdate })
//     -> { close() }
function startLive({
  appRoot, baseUrl, channel, role, currentVersion, onUpdate, logPrefix,
}) {
  const instanceId = loadOrCreateInstanceId(appRoot)
  const tag = logPrefix || role
  const base = baseUrl.replace(/\/$/, '')
  // Capped at 480 chars before URL-encoding to leave headroom under the
  // server's 512-char ceiling once Windows backslashes inflate the encoded
  // form. Real installs are nowhere near that long.
  const installPath = (typeof appRoot === 'string' ? appRoot : '').slice(0, 480)
  const sseUrl = base + '/api/live/' + encodeURIComponent(channel) + '/' + role + '/' + instanceId
    + '?v=' + encodeURIComponent(currentVersion || '')
    + '&p=' + encodeURIComponent(installPath)
  const hbUrl = base + '/api/live/' + encodeURIComponent(channel) + '/' + role + '/' + instanceId + '/heartbeat'

  let stream = null
  let reconnectTimer = null
  let backoff = 5000 // start at 5s, max 60s
  let stopped = false

  function scheduleReconnect() {
    if (stopped) return
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff)
    backoff = Math.min(backoff * 2, 60000)
  }
  function connect() {
    if (stopped) return
    log(tag, 'connecting live channel ' + sseUrl)
    stream = openSseStream(sseUrl, {
      onOpen: () => {
        log(tag, 'live channel OPEN (channel=' + channel + ' instance=' + instanceId.slice(0, 8) + '..)')
        backoff = 5000
      },
      onMessage: (payload) => {
        if (!payload) return
        if (payload.type === 'hello') {
          log(tag, 'hello: serverV=' + payload.serverVersion + ' publishedV=' + payload.publishedVersion)
          // If a build landed while we were offline, trigger an immediate
          // check so we don't wait for the next poll.
          if (payload.publishedVersion && payload.publishedVersion !== currentVersion) {
            try { onUpdate && onUpdate({ trigger: 'replay', version: payload.publishedVersion }) } catch (e) {}
          }
          return
        }
        if (payload.type === 'update') {
          log(tag, 'PUSH: new version v' + payload.version + ' available')
          try { onUpdate && onUpdate({ trigger: 'push', version: payload.version }) } catch (e) {}
        }
      },
      onError: (e) => {
        log(tag, 'live channel error: ' + (e.message || e))
        try { stream && stream.close() } catch (_) {}
        scheduleReconnect()
      },
    })
  }

  // HTTP heartbeat fallback in case SSE pings get coalesced/dropped.
  const heartbeatTimer = setInterval(() => {
    if (stopped) return
    postJson(hbUrl, { version: currentVersion, path: installPath }).catch(() => {})
  }, 60_000)

  connect()

  return {
    instanceId,
    close() {
      stopped = true
      try { stream && stream.close() } catch (e) {}
      clearInterval(heartbeatTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
    },
  }
}

module.exports = { startLive, loadOrCreateInstanceId }
