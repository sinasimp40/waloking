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

// Map<channel, Map<id, ClientEntry>> where id = role + ':' + instance
const REGISTRY = new Map()
const ALL_LISTENERS = new Set()

function makeId(role, instance) { return role + ':' + instance }

function addClient({ channel, role, instance, version, ip, userAgent, send, close }) {
  if (!REGISTRY.has(channel)) REGISTRY.set(channel, new Map())
  const id = makeId(role, instance)
  const entry = {
    channel, role, instance, version: version || null,
    ip: ip || null, userAgent: userAgent || null,
    connectedAt: Date.now(), lastSeen: Date.now(),
    send, close,
  }
  REGISTRY.get(channel).set(id, entry)
  notifyChange()
  return entry
}

function removeClient(channel, role, instance) {
  const m = REGISTRY.get(channel)
  if (!m) return false
  const removed = m.delete(makeId(role, instance))
  if (m.size === 0) REGISTRY.delete(channel)
  if (removed) notifyChange()
  return removed
}

function touchClient(channel, role, instance, patch) {
  const m = REGISTRY.get(channel)
  if (!m) return false
  const e = m.get(makeId(role, instance))
  if (!e) return false
  e.lastSeen = Date.now()
  if (patch && patch.version) e.version = patch.version
  notifyChange()
  return true
}

function broadcast(channel, payload) {
  const m = REGISTRY.get(channel)
  if (!m) return 0
  let n = 0
  for (const e of m.values()) {
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
    for (const e of m.values()) {
      const age = now - e.lastSeen
      const obj = {
        instance: e.instance,
        version: e.version,
        ip: e.ip,
        connectedAt: e.connectedAt,
        lastSeen: e.lastSeen,
        ageMs: age,
      }
      if (e.role === 'server') servers.push(obj)
      else launchers.push(obj)
    }
    out[channel] = { launchers, servers, total: launchers.length + servers.length }
  }
  return out
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
      }
    }
    if (m.size === 0) REGISTRY.delete(channel)
  }
  if (removed > 0) notifyChange()
}, 30_000).unref()

module.exports = {
  HEARTBEAT_MS,
  addClient,
  removeClient,
  touchClient,
  broadcast,
  snapshot,
  onChange,
}
