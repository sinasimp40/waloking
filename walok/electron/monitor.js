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
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8')
        let payload = null
        try { payload = JSON.parse(responseBody) } catch (_) {}

        if (response.statusCode >= 200 && response.statusCode < 300 && payload?.ok !== false) {
          resolve({ success: true })
          return
        }

        reject(new Error(
          payload?.description ||
          `Telegram rejected the request (HTTP ${response.statusCode || 'unknown'}).`
        ))
      })
    })
    request.on('error', reject)
    request.on('timeout', () => { request.destroy(new Error('Telegram request timed out')) })
    request.write(body)
    request.end()
  })
}

function getTelegramSettings(settingsPath) {
  const settings = readSettings(settingsPath)
  const botToken = String(settings.telegramBotToken || '').trim()
  const chatId = String(settings.telegramChatId || '').trim()
  if (!botToken) throw new Error('Enter a Telegram bot token first.')
  if (!chatId) throw new Error('Enter a Telegram channel ID first.')
  return { settings, botToken, chatId }
}

function buildAlertText(settings, otaConfigPath, gameName, variation) {
  const config = readOtaConfig(otaConfigPath)
  const computer = resolvePc(settings, getLocalIps())
  const game = [gameName || 'Unknown Game', variation].filter(Boolean).join(' — ')
  const brand = config.launcherName || config.brand || 'Game Launcher'
  const lines = [
    '🎮 <b>' + escapeHtml(brand) + '</b>',
    '<b>' + escapeHtml(computer.name) + '</b> opened <b>' + escapeHtml(game) + '</b>',
  ]
  if (computer.ip) lines.push('IP: <code>' + escapeHtml(computer.ip) + '</code>')
  lines.push('Time: ' + new Date().toLocaleString())
  return lines.join('\n')
}

function reportGameLaunch(settingsPath, otaConfigPath, gameInfo = {}) {
  try {
    const { settings, botToken, chatId } = getTelegramSettings(settingsPath)
    if (settings.notificationEnabled === false || settings.notifyGameLaunches === false) return
    return sendTelegram(
      botToken,
      chatId,
      buildAlertText(settings, otaConfigPath, gameInfo.gameName, gameInfo.variation)
    ).catch(error => {
      console.warn('[telegram] game-launch notification failed:', error.message)
      return { success: false, error: error.message }
    })
  } catch (error) {
    console.warn('[telegram] could not report game launch:', error.message)
    return Promise.resolve({ success: false, error: error.message })
  }
}

function sendTestAlert(settingsPath, otaConfigPath) {
  const { settings, botToken, chatId } = getTelegramSettings(settingsPath)
  return sendTelegram(
    botToken,
    chatId,
    buildAlertText(settings, otaConfigPath, 'Telegram test alert', null)
  )
}

module.exports = { reportGameLaunch, resolvePc, sendTestAlert }