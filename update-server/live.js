// Live push + online registry. Drives:
//   - Instant SSE notification to launchers/server.exe when an admin builds a new version
//   - Online/offline + running version per customer in the admin panel
//
// Each connected client opens an SSE stream to:
//   GET /api/live/:channel/:role/:instance?v=<currentVersion>
// Server records the connection, broadcasts {type:'update', version} when a
// build for that channel publishes, and evicts the entry when the connection
// closes (or after a 90s heartbeat gap as a safety net).

const HEARTBEAT_MS = 25_000
const STALE_AFTER_MS = 90_000

// Allowed roles. 'launcher' and 'server' drive OTA push. 'monitor' drives
// PC-presence notifications (heartbeat only, no OTA push needed).
const VALID_ROLES = new Set(['launcher', 'server', 'monitor'])

// Map<channel, Map<id, ClientEntry>> where id = role + ':' + instance
const REGISTRY = new Map()
const ALL_LISTENERS = new Set()

// Monitor-specific hooks: called on PC presence transitions.
// Map<channel, Set<fn>> — per-channel so tests/routes can scope listeners.
const MONITOR_HOOKS = new Map()

function makeId(role, instance) { return role + ':' + instance }

function addClient({ channel, role, instance, version, ip, userAgent, send, close, name, preferences, telegram }) {
  if (!REGISTRY.has(channel)) REGISTRY.set(channel, new Map())
  const id = makeId(role, instance)
  const existed = REGISTRY.get(channel).has(id)
  const entry = {
    channel, role, instance, version: version || null,
    ip: ip || null, userAgent: userAgent || null, name: name || null,
    preferences: preferences || null,
    // Runtime-only launcher credentials for the monitor transition event.
    // Never included in snapshots or persisted anywhere.
    telegram: telegram || null,
    connectedAt: Date.now(), lastSeen: Date.now(),
    send, close,
  }
  REGISTRY.get(channel).set(id, entry)
  notifyChange()
  // Fire monitor hook on FIRST online event (not a re-connect replacing
  // a stale entry that was already in the registry).
  if (role === 'monitor' && !existed) {
    _fireMonitorHook(channel, 'online', entry)
  }
  return entry
}

function removeClient(channel, role, instance, reason) {
  const m = REGISTRY.get(channel)
  if (!m) return false
  const entry = m.get(makeId(role, instance))
  const removed = m.delete(makeId(role, instance))
  if (m.size === 0) REGISTRY.delete(channel)
  if (removed) {
    notifyChange()
    if (role === 'monitor' && entry) {
      _fireMonitorHook(channel, reason === 'stale' ? 'stale' : 'close', entry)
    }
  }
  return removed
}

function touchClient(channel, role, instance, patch) {
  const m = REGISTRY.get(channel)
  if (!m) return false
  const e = m.get(makeId(role, instance))
  if (!e) return false
  e.lastSeen = Date.now()
  if (patch && patch.version) e.version = patch.version
  if (patch && typeof patch.name === 'string' && patch.name.trim()) e.name = patch.name.trim()
  if (patch && patch.preferences && typeof patch.preferences === 'object') e.preferences = patch.preferences
  if (patch && patch.telegram && typeof patch.telegram === 'object') e.telegram = patch.telegram
  notifyChange()
  return true
}

function broadcast(channel, payload) {
  const m = REGISTRY.get(channel)
  if (!m) return 0
  let n = 0
  for (const e of m.values()) {
    // Only push OTA events to launcher/server roles; monitors don't need them.
    if (e.role === 'monitor') continue
    try { e.send(payload); n++ } catch (err) {}
  }
  return n
}

// Snapshot for the admin panel. Groups by channel so the UI can show
// "online: 3 (launcher x2 v1.0.4, server x1 v1.0.4)" per customer.
function snapshot() {
  const out = {}
  const now = Date.now()
  for (const [channel, m] of REGISTRY.entries()) {
    const launchers = []
    const servers = []
    const monitors = []
    for (const e of m.values()) {
      const age = now - e.lastSeen
      const obj = {
        instance: e.instance,
        version: e.version,
        ip: e.ip,
        name: e.name,
        connectedAt: e.connectedAt,
        lastSeen: e.lastSeen,
        ageMs: age,
      }
      if (e.role === 'server') servers.push(obj)
      else if (e.role === 'monitor') monitors.push(obj)
      else launchers.push(obj)
    }
    out[channel] = {
      launchers, servers, monitors,
      total: launchers.length + servers.length + monitors.length,
    }
  }
  return out
}

// Return only the monitor snapshots for a channel (for notification logic).
function monitorSnapshot(channel) {
  const m = REGISTRY.get(channel)
  if (!m) return []
  const now = Date.now()
  const result = []
  for (const e of m.values()) {
    if (e.role !== 'monitor') continue
    result.push({
      instance: e.instance,
      ip: e.ip,
      name: e.name,
      connectedAt: e.connectedAt,
      lastSeen: e.lastSeen,
      ageMs: now - e.lastSeen,
    })
  }
  return result
}

function onChange(fn) {
  ALL_LISTENERS.add(fn)
  return () => ALL_LISTENERS.delete(fn)
}
function notifyChange() {
  for (const fn of ALL_LISTENERS) {
    try { fn() } catch (e) {}
  }
}

// ── Monitor event hooks ────────────────────────────────────────────────────
// Listeners receive (channel, event, entry) where event is one of:
//   'online'  — first heartbeat / SSE connect for this instance
//   'close'   — explicit SSE disconnect / route close
//   'stale'   — evicted by the staleness sweep
//
// onMonitorEvent returns an unsubscribe function.
function onMonitorEvent(channel, fn) {
  if (!MONITOR_HOOKS.has(channel)) MONITOR_HOOKS.set(channel, new Set())
  MONITOR_HOOKS.get(channel).add(fn)
  return () => {
    const s = MONITOR_HOOKS.get(channel)
    if (s) { s.delete(fn); if (s.size === 0) MONITOR_HOOKS.delete(channel) }
  }
}

// Global monitor hook (fires for any channel).
function onAnyMonitorEvent(fn) {
  // Use a synthetic channel key so we can share the same map infrastructure.
  const GLOBAL = '__global__'
  if (!MONITOR_HOOKS.has(GLOBAL)) MONITOR_HOOKS.set(GLOBAL, new Set())
  MONITOR_HOOKS.get(GLOBAL).add(fn)
  return () => {
    const s = MONITOR_HOOKS.get(GLOBAL)
    if (s) { s.delete(fn); if (s.size === 0) MONITOR_HOOKS.delete(GLOBAL) }
  }
}

function _fireMonitorHook(channel, event, entry) {
  // Per-channel hooks
  const chanSet = MONITOR_HOOKS.get(channel)
  if (chanSet) {
    for (const fn of chanSet) { try { fn(channel, event, entry) } catch (e) {} }
  }
  // Global hooks
  const globalSet = MONITOR_HOOKS.get('__global__')
  if (globalSet) {
    for (const fn of globalSet) { try { fn(channel, event, entry) } catch (e) {} }
  }
}

// Periodically evict clients whose SSE connection died without sending FIN
// (e.g. NAT drops, laptop sleep). The send-fail path normally cleans them up
// but this is the safety net.
setInterval(() => {
  const now = Date.now()
  let removed = 0
  for (const [channel, m] of REGISTRY.entries()) {
    for (const [id, e] of m.entries()) {
      if (now - e.lastSeen > STALE_AFTER_MS) {
        try { e.close && e.close() } catch (err) {}
        m.delete(id)
        removed++
        if (e.role === 'monitor') {
          _fireMonitorHook(channel, 'stale', e)
        }
      }
    }
    if (m.size === 0) REGISTRY.delete(channel)
  }
  if (removed > 0) notifyChange()
}, 30_000).unref()

module.exports = {
  HEARTBEAT_MS,
  VALID_ROLES,
  addClient,
  removeClient,
  touchClient,
  broadcast,
  snapshot,
  monitorSnapshot,
  onChange,
  onMonitorEvent,
  onAnyMonitorEvent,
}
