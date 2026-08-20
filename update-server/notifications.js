// Notification service adapter for Telegram alerts.
//
// Design principles:
//   1. NEVER persist or log Telegram credentials.
//   2. Credentials supplied by a launcher are held only in memory for that
//      monitor session; server environment variables remain a legacy fallback.
//   3. Uses native fetch (Node 18+) with a timeout — no npm dependencies.
//   4. Callers always get a structured result object, never a thrown exception.
//
// Environment variables:
//   TELEGRAM_BOT_TOKEN  — Telegram Bot API token (never stored/logged)
//   TELEGRAM_CHAT_ID    — Destination chat ID (negative for group chats)

const SEND_TIMEOUT_MS = 10_000

// Returns true when Telegram credentials are present in the environment.
function resolveCredentials(credentials) {
  const botToken = typeof credentials?.botToken === 'string' ? credentials.botToken.trim() : ''
  const chatId = typeof credentials?.chatId === 'string' ? credentials.chatId.trim() : ''
  if (botToken || chatId) return botToken && chatId ? { botToken, chatId } : null
  const fallbackToken = typeof process.env.TELEGRAM_BOT_TOKEN === 'string' ? process.env.TELEGRAM_BOT_TOKEN.trim() : ''
  const fallbackChatId = typeof process.env.TELEGRAM_CHAT_ID === 'string' ? process.env.TELEGRAM_CHAT_ID.trim() : ''
  return fallbackToken && fallbackChatId ? { botToken: fallbackToken, chatId: fallbackChatId } : null
}

function isConfigured(credentials) {
  return !!resolveCredentials(credentials)
}

// Returns a sanitized status descriptor safe to include in API responses.
// Never exposes the token or chat ID.
function configStatus() {
  const configured = isConfigured()
  return {
    configured,
    // Report WHICH vars are set (just presence, not values) to help operators
    // diagnose partial configuration without revealing secrets.
    tokenSet: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.length > 0),
    chatIdSet: !!(process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_CHAT_ID.length > 0),
  }
}

// Send a Telegram message. Returns:
//   { ok: true, configured: true }                  on success
//   { ok: false, configured: false, reason: '...' } when not configured
//   { ok: false, configured: true, reason: '...' }  on send failure
//
// Never throws. Caller can call recordNotifDelivery(channel, result.ok).
async function send(text, credentials) {
  const resolved = resolveCredentials(credentials)
  if (!resolved) {
    return { ok: false, configured: false, reason: 'Telegram credentials not configured' }
  }

  // Read credentials at send-time (not at module load) so they can be set
  // after server start in tests. Never store in a variable outside this scope.
  const chatId = resolved.chatId

  // Build the API URL without ever putting the token in a log-friendly string.
  const apiUrl = 'https://api.telegram.org/bot' + resolved.botToken + '/sendMessage'

  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!response.ok) {
      let detail = ''
      try {
        const j = await response.json()
        // Only include the description, not any token-bearing fields.
        detail = j && j.description ? ': ' + j.description : ''
      } catch (_) {}
      return { ok: false, configured: true, reason: 'Telegram API error ' + response.status + detail }
    }

    return { ok: true, configured: true }
  } catch (err) {
    clearTimeout(timeout)
    const reason = err && err.name === 'AbortError'
      ? 'Telegram API request timed out after ' + SEND_TIMEOUT_MS + 'ms'
      : 'Telegram API request failed: ' + (err && err.message ? err.message : String(err))
    return { ok: false, configured: true, reason }
  }
}

// ── PC monitoring notifications ───────────────────────────────────────────────
// Resolve a friendly PC name from a roster by matching the observed IP.
// Falls back to `instance` when no roster match is found.
function resolvePcName(ip, instance, roster, reportedName) {
  if (Array.isArray(roster) && ip) {
    const norm = (s) => String(s || '').trim().toLowerCase()
    const match = roster.find(e => norm(e.ip) === norm(ip))
    if (match && match.name) return String(match.name)
  }
  return reportedName || instance || ip || 'unknown'
}

// Build a PC transition notification message.
// event: 'online' | 'close' | 'stale'
// onlinePcs: array of {instance, ip} currently online AFTER the transition
function buildPcMessage(event, entry, onlinePcs, roster) {
  const pcName = resolvePcName(entry.ip, entry.instance, roster, entry.name)
  const statusEmoji = event === 'online' ? '🟢' : '🔴'
  const statusWord  = event === 'online' ? 'came online' :
    event === 'stale' ? 'went offline (timeout)' : 'went offline'

  const onlineNames = onlinePcs.map(pc => resolvePcName(pc.ip, pc.instance, roster, pc.name))
  const onlineCount = onlineNames.length

  let msg = statusEmoji + ' <b>' + escHtml(pcName) + '</b> ' + statusWord
  if (entry.ip) msg += '\n  IP: ' + escHtml(entry.ip)
  msg += '\n\nOnline PCs (' + onlineCount + '):'
  if (onlineCount === 0) {
    msg += ' <i>none</i>'
  } else {
    msg += '\n' + onlineNames.map(n => '  • ' + escHtml(n)).join('\n')
  }
  return msg
}

// Build a game launch notification message.
function buildGameMessage(channel, instance, ip, gameName, roster, reportedName) {
  const pcName = resolvePcName(ip, instance, roster, reportedName)
  return '🎮 <b>' + escHtml(pcName) + '</b> launched <b>' + escHtml(gameName || 'a game') + '</b>' +
    (ip ? '\n  IP: ' + escHtml(ip) : '') +
    '\n  Channel: ' + escHtml(channel)
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

module.exports = {
  isConfigured,
  configStatus,
  send,
  resolvePcName,
  buildPcMessage,
  buildGameMessage,
}
