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
const http = require('http')
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
  if (caption) {
    field('caption', caption)
    field('parse_mode', 'HTML')
  }
  if (image.kind === 'url') {
    field('photo', image.value)
  } else {
    const fileName = image.filename || 'game-icon.png'
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`
    ))
    parts.push(image.kind === 'buffer' ? image.value : fs.readFileSync(image.value))
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

function downloadImage(url, redirects = 0) {
  if (redirects > 3) return Promise.reject(new Error('Game artwork redirected too many times.'))
  return new Promise((resolve, reject) => {
    const client = /^https:/i.test(url) ? https : http
    const request = client.get(url, { timeout: 8000 }, response => {
      const status = response.statusCode || 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        const nextUrl = new URL(response.headers.location, url).toString()
        resolve(downloadImage(nextUrl, redirects + 1))
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new Error(`Could not download game artwork (HTTP ${status || 'unknown'}).`))
        return
      }

      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > 6 * 1024 * 1024) {
          request.destroy(new Error('Game artwork is too large to use in an alert.'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('Game artwork download timed out.')))
  })
}

function wrapCardText(value, maxLength = 28, maxLines = 2) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return ['Unknown Game']
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= maxLength || !line) {
      line = next
      continue
    }
    lines.push(line)
    line = word
    if (lines.length === maxLines - 1) break
  }
  if (line) lines.push(line)
  const joined = words.join(' ')
  const visible = lines.join(' ')
  if (visible.length < joined.length && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, Math.max(1, maxLength - 1)).trimEnd() + '…'
  }
  return lines.slice(0, maxLines)
}

function createCardSvg({ pcName, gameName, timestamp }) {
  const gameLines = wrapCardText(gameName)
  const gameText = gameLines.map((line, index) =>
    `<text x="58" y="${263 + (index * 43)}" fill="#f7fbff" font-family="Arial, sans-serif" font-size="34" font-weight="700">${escapeHtml(line)}</text>`
  ).join('')

  return `<svg width="1024" height="512" viewBox="0 0 1024 512" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="cardBg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#14223a"/>
        <stop offset="56%" stop-color="#0d1422"/>
        <stop offset="100%" stop-color="#080c14"/>
      </linearGradient>
      <linearGradient id="artGlow" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#1d4ed8" stop-opacity=".64"/>
        <stop offset="100%" stop-color="#1d4ed8" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="1024" height="512" rx="30" fill="url(#cardBg)"/>
    <rect x="28" y="28" width="968" height="456" rx="22" fill="none" stroke="#8cb6ff" stroke-opacity=".17"/>
    <rect x="58" y="58" width="150" height="34" rx="17" fill="#2563eb" fill-opacity=".20" stroke="#7db2ff" stroke-opacity=".38"/>
    <circle cx="79" cy="75" r="7" fill="#8cc8ff"/>
    <text x="96" y="80" fill="#b9d8ff" font-family="Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="1.6">GAME LAUNCH</text>
    <text x="58" y="148" fill="#dce9fb" font-family="Arial, sans-serif" font-size="42" font-weight="700">${escapeHtml(pcName)}</text>
    <rect x="58" y="176" width="542" height="1" fill="#b9d8ff" fill-opacity=".18"/>
    <text x="58" y="221" fill="#8cb6ff" font-family="Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="2.4">OPENED</text>
    ${gameText}
    <circle cx="66" cy="433" r="6" fill="#78a8ed"/>
    <text x="82" y="439" fill="#adc0da" font-family="Arial, sans-serif" font-size="20">${escapeHtml(timestamp)}</text>
    <path d="M482 484 L650 316 L650 484 Z" fill="url(#artGlow)" opacity=".44"/>
    <rect x="646" y="28" width="350" height="456" rx="22" fill="#04070d"/>
    <rect x="646" y="28" width="350" height="456" rx="22" fill="none" stroke="#b8d6ff" stroke-opacity=".23"/>
  </svg>`
}

async function createAlertCard(imagePath, cardDetails) {
  const image = resolvePhoto(imagePath)
  if (!image) return null

  const source = image.kind === 'url'
    ? await downloadImage(image.value)
    : await fs.promises.readFile(image.value)
  const sharp = require('sharp')
  const artWidth = 350
  const artHeight = 456
  const artMask = Buffer.from(
    `<svg width="${artWidth}" height="${artHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="${artWidth}" height="${artHeight}" rx="22" fill="#fff"/></svg>`
  )
  const artwork = await sharp(source)
    .rotate()
    .resize(artWidth, artHeight, { fit: 'cover', position: 'attention' })
    .composite([{ input: artMask, blend: 'dest-in' }])
    .png()
    .toBuffer()

  return sharp(Buffer.from(createCardSvg(cardDetails)))
    .composite([{ input: artwork, left: 646, top: 28 }])
    .png()
    .toBuffer()
}

async function sendTelegramGameAlert(botToken, chatId, text, imagePath, cardDetails) {
  try {
    const card = await createAlertCard(imagePath, cardDetails)
    if (!card) return sendTelegramMessage(botToken, chatId, text)
    return await sendTelegramPhoto(botToken, chatId, '', {
      kind: 'buffer',
      value: card,
      filename: 'game-launch-alert.png',
    })
  } catch (error) {
    console.warn('[telegram] alert card could not be rendered or delivered; sending text fallback:', error.message)
    return sendTelegramMessage(botToken, chatId, text)
  }
}

function getTelegramSettings(settingsPath) {
  const settings = readSettings(settingsPath)
  const botToken = String(settings.telegramBotToken || '').trim()
  const chatId = String(settings.telegramChatId || '').trim()
  if (!botToken) throw new Error('Enter a Telegram bot token first.')
  if (!chatId) throw new Error('Enter a Telegram channel ID first.')
  return { settings, botToken, chatId }
}

function buildAlertDetails(settings, gameName, variation) {
  const computer = resolvePc(settings, getLocalIps())
  const game = [gameName || 'Unknown Game', variation].filter(Boolean).join(' — ')
  return {
    pcName: computer.name,
    gameName: game,
    timestamp: new Date().toLocaleString(),
  }
}

function buildAlertText(details) {
  const lines = [
    '🎮 <b>' + escapeHtml(details.pcName) + '</b>',
    'Opened <b>' + escapeHtml(details.gameName) + '</b>',
    '🕒 ' + escapeHtml(details.timestamp),
  ]
  return lines.join('\n')
}

function reportGameLaunch(settingsPath, otaConfigPath, gameInfo = {}) {
  try {
    const { settings, botToken, chatId } = getTelegramSettings(settingsPath)
    if (settings.notificationEnabled === false || settings.notifyGameLaunches === false) return
    const details = buildAlertDetails(settings, gameInfo.gameName, gameInfo.variation)
    return sendTelegramGameAlert(
      botToken,
      chatId,
      buildAlertText(details),
      gameInfo.iconPath,
      details
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
  return sendTelegramMessage(botToken, chatId, buildAlertText(buildAlertDetails(settings, 'Telegram test alert', null)))
}

module.exports = { reportGameLaunch, resolvePc, sendTestAlert, createAlertCard }