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

function requestTelegram(botToken, method, body, contentType, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + botToken + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': body.length },
      timeout: timeoutMs,
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
  if (/^data:image\//i.test(raw)) {
    try {
      // Admin/backup imports can persist artwork as a browser data URL.
      // Decode it here instead of treating it as a nonexistent filesystem path.
      if (raw.length > 8 * 1024 * 1024) return null
      const commaIndex = raw.indexOf(',')
      if (commaIndex < 0) return null
      const header = raw.slice(0, commaIndex)
      const payload = raw.slice(commaIndex + 1)
      const value = /;base64(?:;|$)/i.test(header)
        ? Buffer.from(payload.replace(/\s/g, ''), 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8')
      return value.length > 0 && value.length <= 6 * 1024 * 1024
        ? { kind: 'buffer', value }
        : null
    } catch (_) {
      return null
    }
  }
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', value: raw }

  let localPath = raw
  if (/^file:\/\//i.test(raw)) {
    try { localPath = fileURLToPath(raw) } catch (_) {
      localPath = raw.replace(/^file:\/\/\/?/i, '')
    }
  }
  return fs.existsSync(localPath) ? { kind: 'file', value: localPath } : null
}

function sendTelegramMessage(botToken, chatId, text, previewUrl = '') {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' }
  if (/^https?:\/\//i.test(String(previewUrl || '').trim())) {
    payload.link_preview_options = {
      url: String(previewUrl).trim(),
      prefer_small_media: true,
      show_above_text: false,
    }
  }
  const body = Buffer.from(JSON.stringify(payload))
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
    `multipart/form-data; boundary=${boundary}`,
    25000
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

const BRAND_ICON_SVGS = {
  youtube: `<svg width="350" height="456" viewBox="0 0 350 456" xmlns="http://www.w3.org/2000/svg"><rect x="35" y="136" width="280" height="184" rx="48" fill="#ff0033"/><path d="M145 184 145 272 232 228Z" fill="#fff"/></svg>`,
  facebook: `<svg width="350" height="456" viewBox="0 0 350 456" xmlns="http://www.w3.org/2000/svg"><circle cx="175" cy="228" r="105" fill="#1877f2"/><path d="M194 326v-87h29l4-34h-33v-22c0-10 3-17 17-17h18v-30c-4-1-16-2-29-2-29 0-49 18-49 50v21h-29v34h29v87Z" fill="#fff"/></svg>`,
  x: `<svg width="350" height="456" viewBox="0 0 350 456" xmlns="http://www.w3.org/2000/svg"><path d="M93 124h48l41 57 48-57h28l-63 75 69 101h-48l-48-67-57 67H83l70-83Z" fill="#f7fbff"/></svg>`,
  instagram: `<svg width="350" height="456" viewBox="0 0 350 456" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="ig" x1="0" y1="456" x2="350" y2="0"><stop stop-color="#ffd600"/><stop offset=".48" stop-color="#ff0069"/><stop offset="1" stop-color="#7638fa"/></linearGradient></defs><rect x="58" y="111" width="234" height="234" rx="68" fill="url(#ig)"/><rect x="111" y="164" width="128" height="128" rx="42" fill="none" stroke="#fff" stroke-width="17"/><circle cx="175" cy="228" r="30" fill="none" stroke="#fff" stroke-width="17"/><circle cx="245" cy="160" r="12" fill="#fff"/></svg>`,
  discord: `<svg width="350" height="456" viewBox="0 0 350 456" xmlns="http://www.w3.org/2000/svg"><path d="M68 151c34-25 66-30 107-30s73 5 107 30c14 36 20 76 16 121-29 24-59 38-92 45l-16-22c9-3 18-7 26-12-49 22-105 22-154 0 8 5 17 9 26 12l-16 22c-33-7-63-21-92-45-4-45 2-85 16-121Zm76 100c11 0 20-11 20-25s-9-25-20-25-20 11-20 25 9 25 20 25Zm62 0c11 0 20-11 20-25s-9-25-20-25-20 11-20 25 9 25 20 25Z" fill="#5865f2"/></svg>`,
  tiktok: `<svg width="350" height="456" viewBox="0 0 350 456" xmlns="http://www.w3.org/2000/svg"><path d="M213 114v118c0 48-31 78-74 78-35 0-63-25-63-61 0-39 32-68 73-61v39c-17-7-36 5-36 24 0 17 13 28 28 28 20 0 35-15 35-42V114Z" fill="#25f4ee"/><path d="M226 114v118c0 48-31 78-74 78-35 0-63-25-63-61 0-39 32-68 73-61v39c-17-7-36 5-36 24 0 17 13 28 28 28 20 0 35-15 35-42V114Z" fill="#fe2c55" fill-opacity=".8"/><path d="M219 114v118c0 48-31 78-74 78-35 0-63-25-63-61 0-39 32-68 73-61v39c-17-7-36 5-36 24 0 17 13 28 28 28 20 0 35-15 35-42V114Z" fill="#fff"/></svg>`,
  twitch: `<svg width="350" height="456" viewBox="0 0 350 456" xmlns="http://www.w3.org/2000/svg"><path d="M75 119h222v149l-59 59h-46l-34 34h-42v-34H75Zm37 36v79h43l26 26 26-26h43v-79Zm64 16h19v48h-19Zm38 0h19v48h-19Z" fill="#9146ff"/></svg>`,
  telegram: `<svg width="350" height="456" viewBox="0 0 350 456" xmlns="http://www.w3.org/2000/svg"><circle cx="175" cy="228" r="109" fill="#29a9ea"/><path d="m94 216 160-62c7-3 13 2 11 10l-27 139c-2 10-12 12-19 7l-45-33-24 23c-3 3-6 3-6-2l2-46 85-77c4-4-1-6-6-3l-106 67-46-14c-10-3-10-10 1-14Z" fill="#fff"/></svg>`,
}

function createTextIconSvg(iconText) {
  const text = String(iconText || '').trim()
  if (!text) return null
  const brandIcon = BRAND_ICON_SVGS[text.toLowerCase()]
  if (brandIcon) return Buffer.from(brandIcon)
  return Buffer.from(`<svg width="350" height="456" xmlns="http://www.w3.org/2000/svg">
    <text x="175" y="275" text-anchor="middle" fill="#f7fbff" font-family="Arial, sans-serif" font-size="180" font-weight="700">${escapeHtml(text.slice(0, 3))}</text>
  </svg>`)
}

function createCardSvg({ pcName, gameName, itemName, alertType, timestamp, transparentIcon = false }) {
  const displayName = itemName || gameName || 'Unknown item'
  const itemLines = wrapCardText(displayName)
  const itemText = itemLines.map((line, index) =>
    `<text x="58" y="${263 + (index * 43)}" fill="#f7fbff" font-family="Arial, sans-serif" font-size="34" font-weight="700">${escapeHtml(line)}</text>`
  ).join('')
  const badgeLabel = String(alertType || 'GAME LAUNCH').trim().toUpperCase().slice(0, 24)
  const artworkFrame = transparentIcon
    ? ''
    : `
      <rect x="646" y="28" width="350" height="456" rx="22" fill="#04070d"/>
      <rect x="646" y="28" width="350" height="456" rx="22" fill="#080706"/>
      <rect x="646" y="28" width="350" height="456" rx="22" fill="none" stroke="#d4af37" stroke-opacity=".66"/>`
  const facebookCredit = `
    <circle cx="68" cy="400" r="11" fill="#1877F2"/>
    <path d="M13.45 19v-6.05h2.03l.3-2.35h-2.33V9.1c0-.68.19-1.14 1.17-1.14h1.25V5.86c-.22-.03-.96-.09-1.83-.09-1.81 0-3.05 1.1-3.05 3.14v1.69H9v2.35h1.99V19h2.46Z" transform="translate(59 389) scale(.75)" fill="#fff"/>
    <text x="88" y="407" fill="#e5c477" font-family="Arial, sans-serif" font-size="18" font-weight="700">Developed by: Rap Rap Thurston</text>`

  return `<svg width="1024" height="512" viewBox="0 0 1024 512" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="cardBg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#241a0d"/>
        <stop offset="46%" stop-color="#100e0b"/>
        <stop offset="100%" stop-color="#050505"/>
      </linearGradient>
      <linearGradient id="artGlow" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#d4a437" stop-opacity=".58"/>
        <stop offset="100%" stop-color="#d4a437" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <!-- Keep the entire PNG opaque so Telegram cannot show white through the
         rounded outer edges. -->
    <rect width="1024" height="512" fill="#050505"/>
    <rect width="1024" height="512" fill="url(#cardBg)"/>
    <rect x="24" y="24" width="976" height="464" rx="20" fill="none" stroke="#d4af37" stroke-opacity=".34"/>
    <rect x="58" y="58" width="238" height="36" rx="18" fill="#d4af37" fill-opacity=".18" stroke="#e4c15a" stroke-opacity=".72"/>
    <circle cx="80" cy="76" r="7" fill="#f5d47a"/>
    <text x="98" y="81" fill="#f5d47a" font-family="Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="1.45">${escapeHtml(badgeLabel)}</text>
    <text x="58" y="148" fill="#f8f0d0" font-family="Arial, sans-serif" font-size="42" font-weight="700">${escapeHtml(pcName)}</text>
    <rect x="58" y="176" width="542" height="1" fill="#d4af37" fill-opacity=".28"/>
    <text x="58" y="221" fill="#d4af37" font-family="Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="2.4">OPENED</text>
    ${itemText}
    <circle cx="66" cy="462" r="6" fill="#e4b94b"/>
    <text x="82" y="469" fill="#d8c58f" font-family="Arial, sans-serif" font-size="20">${escapeHtml(timestamp)}</text>
    ${facebookCredit}
    <path d="M482 484 L650 316 L650 484 Z" fill="url(#artGlow)" opacity=".44"/>
    ${artworkFrame}
  </svg>`
}

async function createAlertCard(imagePath, cardDetails) {
  const sharp = require('sharp')
  const image = resolvePhoto(imagePath)
  let source = null
  if (image) {
    source = image.kind === 'url'
      ? await downloadImage(image.value)
      : image.kind === 'buffer'
        ? image.value
        : await fs.promises.readFile(image.value)
  } else {
    source = createTextIconSvg(cardDetails.iconText)
  }

  // A launch without usable artwork still gets the same VIP card layout.
  if (!source) {
    return sharp(Buffer.from(createCardSvg(cardDetails))).png().toBuffer()
  }

  const normalizedSource = await sharp(source).rotate().png().toBuffer()
  const sourceMetadata = await sharp(normalizedSource).metadata()
  const sourceStats = sourceMetadata.hasAlpha ? await sharp(normalizedSource).stats() : null
  const transparentIcon = Boolean(sourceStats?.channels?.[3]?.min < 255)
  const artWidth = 350
  const artHeight = 456
  const artMask = Buffer.from(
    `<svg width="${artWidth}" height="${artHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="${artWidth}" height="${artHeight}" rx="22" fill="#fff"/></svg>`
  )
  const artwork = await sharp(normalizedSource)
    .resize(
      transparentIcon ? 310 : artWidth,
      transparentIcon ? 390 : artHeight,
      {
        fit: transparentIcon ? 'contain' : 'cover',
        position: 'attention',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      }
    )
    .composite(transparentIcon ? [] : [{ input: artMask, blend: 'dest-in' }])
    .png()
    .toBuffer()

  return sharp(Buffer.from(createCardSvg({ ...cardDetails, transparentIcon })))
    .composite([{
      input: artwork,
      left: transparentIcon ? 666 : 646,
      top: transparentIcon ? 61 : 28,
    }])
    .png()
    .toBuffer()
}

async function sendTelegramGameAlert(botToken, chatId, imagePath, cardDetails) {
  try {
    let card
    try {
      card = await createAlertCard(imagePath, cardDetails)
    } catch (error) {
      console.warn('[telegram] artwork could not be loaded; using icon fallback:', error.message)
      try { card = await createAlertCard(null, cardDetails) } catch (_) {}
    }
    if (!card) {
      console.warn('[telegram] card could not be rendered; notification skipped')
      return { success: false, error: 'card render failed' }
    }
    return await sendTelegramPhoto(botToken, chatId, '', {
      kind: 'buffer',
      value: card,
      filename: 'game-launch-alert.png',
    })
  } catch (error) {
    console.warn('[telegram] card could not be delivered; notification skipped:', error.message)
    return { success: false, error: error.message }
  }
}

function getTelegramSettings(settingsPath, settingsOverride = null) {
  const settings = settingsOverride && typeof settingsOverride === 'object'
    ? settingsOverride
    : readSettings(settingsPath)
  const botToken = String(settings.telegramBotToken || '').trim()
  const chatId = String(settings.telegramChatId || '').trim()
  if (!botToken) throw new Error('Enter a Telegram bot token first.')
  if (!chatId) throw new Error('Enter a Telegram channel ID first.')
  return { settings, botToken, chatId }
}

function buildAlertDetails(settings, gameInfo = {}) {
  const computer = resolvePc(settings, getLocalIps())
  const itemName = [gameInfo.gameName || 'Unknown item', gameInfo.variation].filter(Boolean).join(' — ')
  return {
    pcName: computer.name,
    gameName: itemName,
    itemName,
    iconText: gameInfo.iconText || null,
    alertType: String(gameInfo.alertType || 'Game Launch').trim() || 'Game Launch',
    timestamp: new Date().toLocaleString(),
  }
}

function buildAlertText(details) {
  const type = String(details.alertType || 'Game Launch').toUpperCase()
  const icon = type === 'SOCIAL LINK' ? '🔗' : type === 'TOP APP' ? '📱' : '🎮'
  const lines = [
    icon + ' <b>' + escapeHtml(details.pcName) + '</b>',
    'Opened <b>' + escapeHtml(details.itemName || details.gameName) + '</b>',
    '🕒 ' + escapeHtml(details.timestamp),
  ]
  return lines.join('\n')
}

function reportGameLaunch(settingsPath, otaConfigPath, gameInfo = {}, settingsOverride = null) {
  try {
    const { settings, botToken, chatId } = getTelegramSettings(settingsPath, settingsOverride)
    if (settings.notificationEnabled === false || settings.notifyGameLaunches === false) return
    const details = buildAlertDetails(settings, gameInfo)
    return sendTelegramGameAlert(
      botToken,
      chatId,
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
  return sendTelegramMessage(
    botToken,
    chatId,
    buildAlertText(buildAlertDetails(settings, { gameName: 'Telegram test alert' }))
  )
}

module.exports = { reportGameLaunch, resolvePc, sendTestAlert, createAlertCard, createTextIconSvg }