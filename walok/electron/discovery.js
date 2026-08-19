const dgram = require('dgram')

const DISCOVERY_PORT = 19777
const DEFAULT_TIMEOUT_MS = 8000

function discoverServer(brandSlug, timeoutMs) {
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS
  const expectedService = brandSlug + '-server'
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

      socket.on('error', () => {
        finish(null)
      })

      socket.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString('utf-8'))
          if (data.service === expectedService && data.port) {
            const ip = rinfo.address
            finish({
              ip,
              port: data.port,
              hostname: data.hostname || '',
              url: 'http://' + ip + ':' + data.port,
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
