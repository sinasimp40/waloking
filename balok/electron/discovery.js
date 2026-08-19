// LAN auto-discovery of the Save & Load server.
//
// The walok save server broadcasts a UDP beacon every few seconds on
// DISCOVERY_PORT with payload { service: '<brand>-server', port, hostname }.
// Balok is multi-customer, so unlike walok (which matches its own brand slug
// exactly) we accept ANY '<something>-server' beacon — whatever save server
// is running on the cafe LAN is the one to use.
const dgram = require('dgram')

const DISCOVERY_PORT = 19777
const DEFAULT_TIMEOUT_MS = 8000

function discoverServer(timeoutMs) {
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    let socket = null
    let timer = null

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null }
      if (socket) { try { socket.close() } catch (e) {} socket = null }
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

      socket.on('error', () => finish(null))

      socket.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString('utf-8'))
          // Strict beacon shape: '<slug>-server' service name + sane port.
          const validService = typeof data.service === 'string' && /^[a-z0-9-]{1,40}-server$/.test(data.service)
          const port = Number(data.port)
          const validPort = Number.isInteger(port) && port > 0 && port < 65536
          if (validService && validPort) {
            const ip = rinfo.address
            finish({
              ip,
              port,
              hostname: typeof data.hostname === 'string' ? data.hostname.slice(0, 64) : '',
              url: 'http://' + ip + ':' + port,
            })
          }
        } catch (e) {}
      })

      socket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
        try { socket.setBroadcast(true) } catch (e) {}
      })

      timer = setTimeout(() => finish(null), timeout)
    } catch (e) {
      finish(null)
    }
  })
}

module.exports = { discoverServer, DISCOVERY_PORT }
