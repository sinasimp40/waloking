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
const { fileURLToPath } = require('url')

function readSettings(settingsPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    return raw?.state?.settings || raw?.settings || {}
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

function handleTelegramResponse(response, resolve, reject) {
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
}

function requestTelegram(botToken, method, body, contentType) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + botToken + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': body.length },
      timeout: 8000,
    }, response => handleTelegramResponse(response, resolve, reject))
    request.on('error', reject)
    request.on('timeout', () => { request.destroy(new Error('Telegram request timed out')) })
    request.write(body)
    request.end()
  })
}

function resolvePhoto(imagePath) {
  const raw = String(imagePath || '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', value: raw }

  let localPath = raw
  if (/^file:\/\//i.test(raw)) {
    try { localPath = fileURLToPath(raw) } catch (_) {
      localPath = raw.replace(/^file:\/\/\/?/i, '')
    }
  }
  return fs.existsSync(localPath) ? { kind: 'file', value: localPath } : null
}

function sendTelegramMessage(botToken, chatId, text) {
  const body = Buffer.from(JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }))
  return requestTelegram(botToken, 'sendMessage', body, 'application/json')
}

function sendTelegramPhoto(botToken, chatId, caption, image) {
  const boundary = '----WalokTelegram' + Date.now().toString(36)
  const parts = []
  const field = (name, value) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ))
  }

  field('chat_id', chatId)
  field('caption', caption)
  field('parse_mode', 'HTML')
  if (image.kind === 'url') {
    field('photo', image.value)
  } else {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="game-icon"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ))
    parts.push(fs.readFileSync(image.value))
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))

  return requestTelegram(
    botToken,
    'sendPhoto',
    Buffer.concat(parts),
    `multipart/form-data; boundary=${boundary}`
  )
}

function sendTelegram(botToken, chatId, text, imagePath = '') {
  const image = resolvePhoto(imagePath)
  if (!image) return sendTelegramMessage(botToken, chatId, text)
  return sendTelegramPhoto(botToken, chatId, text, image).catch(error => {
    console.warn('[telegram] game icon could not be embedded; sending text fallback:', error.message)
    return sendTelegramMessage(botToken, chatId, text)
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

function buildAlertText(settings, gameName, variation) {
  const computer = resolvePc(settings, getLocalIps())
  const game = [gameName || 'Unknown Game', variation].filter(Boolean).join(' — ')
  const lines = [
    '🎮 <b>' + escapeHtml(computer.name) + '</b>',
    'Opened <b>' + escapeHtml(game) + '</b>',
    '🕒 ' + escapeHtml(new Date().toLocaleString()),
  ]
  return lines.join('\n')
}

function reportGameLaunch(settingsPath, otaConfigPath, gameInfo = {}) {
  try {
    const { settings, botToken, chatId } = getTelegramSettings(settingsPath)
    if (settings.notificationEnabled === false || settings.notifyGameLaunches === false) return
    return sendTelegram(
      botToken,
      chatId,
      buildAlertText(settings, gameInfo.gameName, gameInfo.variation),
      gameInfo.iconPath
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
    buildAlertText(settings, 'Telegram test alert', null)
  )
}

module.exports = { reportGameLaunch, resolvePc, sendTestAlert }