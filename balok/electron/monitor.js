/**
 * Direct Telegram game-launch notifier.
 *
 * This module intentionally has no monitor service, heartbeat, or update
 * server dependency. It sends one Telegram message only when a game opens.
 */
'use strict'

const fs = require('fs')
const os = require('os')
const https = require('https')

function readSettings(settingsPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    return raw?.state?.settings || raw?.settings || {}
  } catch (_) {
    return {}
  }
}

function readOtaConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (_) {
    return {}
  }
}

function getLocalIps() {
  const ips = []
  for (const adapters of Object.values(os.networkInterfaces())) {
    for (const adapter of adapters || []) {
      if (adapter.family === 'IPv4' && !adapter.internal && !ips.includes(adapter.address)) {
        ips.push(adapter.address)
      }
    }
  }
  return ips
}

function resolvePc(settings, localIps) {
  const mappings = Array.isArray(settings.pcMappings) ? settings.pcMappings : []
  const matchedIp = localIps.find(localIp => mappings.some(entry => {
    const ip = String(entry?.ip || '').trim()
    return ip === localIp && String(entry?.name || '').trim()
  }))
  const match = mappings.find(entry => String(entry?.ip || '').trim() === matchedIp)
  return {
    name: String(match?.name || settings.pcName || os.hostname()).trim(),
    ip: matchedIp || localIps[0] || '',
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
}

function sendTelegram(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    const request = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + botToken + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000,
    }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject)
    request.on('timeout', () => { request.destroy(new Error('Telegram request timed out')) })
    request.write(body)
    request.end()
  })
}

function reportGameLaunch(settingsPath, otaConfigPath, gameInfo = {}) {
  try {
    const settings = readSettings(settingsPath)
    if (settings.notificationEnabled === false || settings.notifyGameLaunches === false) return

    const botToken = String(settings.telegramBotToken || '').trim()
    const chatId = String(settings.telegramChatId || '').trim()
    if (!botToken || !chatId) return

    const config = readOtaConfig(otaConfigPath)
    const computer = resolvePc(settings, getLocalIps())
    const game = [gameInfo.gameName || 'Unknown Game', gameInfo.variation].filter(Boolean).join(' — ')
    const ip = getLocalIp()
    const brand = config.launcherName || config.brand || 'Game Launcher'
    const lines = [
      '🎮 <b>' + escapeHtml(brand) + '</b>',
      '<b>' + escapeHtml(computer.name) + '</b> opened <b>' + escapeHtml(game) + '</b>',
    ]
    if (computer.ip) lines.push('IP: <code>' + escapeHtml(computer.ip) + '</code>')
    lines.push('Time: ' + new Date().toLocaleString())

    sendTelegram(botToken, chatId, lines.join('\n'))
      .catch(error => console.warn('[telegram] game-launch notification failed:', error.message))
  } catch (error) {
    console.warn('[telegram] could not report game launch:', error.message)
  }
}

module.exports = { reportGameLaunch, resolvePc }