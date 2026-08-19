const dgram = require('dgram')
const os = require('os')
const { BRAND_SLUG } = require('./brand')

const DISCOVERY_PORT = 19777
const BEACON_INTERVAL_MS = 3000
const BEACON_SERVICE = BRAND_SLUG + '-server'

let beaconTimer = null
let beaconSocket = null

function getLocalIp() {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}

function isLoopback(host) {
  return !host || host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function startBeacon(serverPort, serverHost) {
  stopBeacon()
  if (serverHost && isLoopback(serverHost)) {
    console.log('[Discovery] server bound to loopback — skipping beacon')
    return
  }
  try {
    beaconSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    beaconSocket.on('error', (err) => {
      console.error('[Discovery] beacon socket error:', err.message)
      stopBeacon()
    })
    beaconSocket.bind(() => {
      try {
        beaconSocket.setBroadcast(true)
      } catch (e) {
        console.error('[Discovery] setBroadcast failed:', e.message)
        stopBeacon()
        return
      }
      const send = () => {
        const ip = getLocalIp()
        const payload = JSON.stringify({
          service: BEACON_SERVICE,
          ip,
          port: serverPort,
          hostname: os.hostname(),
        })
        const buf = Buffer.from(payload, 'utf-8')
        try {
          beaconSocket.send(buf, 0, buf.length, DISCOVERY_PORT, '255.255.255.255')
        } catch (e) {}
      }
      send()
      beaconTimer = setInterval(send, BEACON_INTERVAL_MS)
      console.log(`[Discovery] beacon started on UDP ${DISCOVERY_PORT} (${getLocalIp()}:${serverPort})`)
    })
  } catch (e) {
    console.error('[Discovery] failed to start beacon:', e.message)
  }
}

function stopBeacon() {
  if (beaconTimer) {
    clearInterval(beaconTimer)
    beaconTimer = null
  }
  if (beaconSocket) {
    try { beaconSocket.close() } catch (e) {}
    beaconSocket = null
  }
}

module.exports = { startBeacon, stopBeacon, getLocalIp, DISCOVERY_PORT }
