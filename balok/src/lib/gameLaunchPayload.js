export function createNotificationSettings(settings) {
  return {
    notificationEnabled: settings?.notificationEnabled,
    notifyGameLaunches: settings?.notifyGameLaunches,
    pcName: settings?.pcName,
    pcMappings: settings?.pcMappings,
    telegramBotToken: settings?.telegramBotToken,
    telegramChatId: settings?.telegramChatId,
  }
}

const SOCIAL_BRANDS = [
  { hosts: ['youtube.com', 'youtu.be'], icon: 'youtube' },
  { hosts: ['facebook.com', 'fb.com'], icon: 'facebook' },
  { hosts: ['x.com', 'twitter.com'], icon: 'x' },
  { hosts: ['instagram.com'], icon: 'instagram' },
  { hosts: ['discord.com', 'discord.gg'], icon: 'discord' },
  { hosts: ['tiktok.com'], icon: 'tiktok' },
  { hosts: ['twitch.tv'], icon: 'twitch' },
  { hosts: ['telegram.me', 't.me'], icon: 'telegram' },
]

export function getSocialIconText(item = {}) {
  try {
    const host = new URL(String(item?.url || '')).hostname.toLowerCase().replace(/^www\./, '')
    const match = SOCIAL_BRANDS.find(brand => brand.hosts.some(domain => host === domain || host.endsWith(`.${domain}`)))
    if (match) return match.icon
  } catch (_) {
    // An invalid custom URL is handled by the launcher; use the configured
    // fallback icon here so an alert payload can still be built safely.
  }

  return String(item?.icon || item?.name || '').trim().slice(0, 3) || null
}

// Builds the notification-aware game payload expected by Electron's
// `launch-game` IPC handler. Keeping this in one place prevents secondary
// launch surfaces (featured, shelves, events) from falling back to a plain
// text Telegram alert because they only supplied an executable path.
export function createGameLaunchPayload(game, exePath, settings, variation = null, alertType = 'Game Launch') {
  return {
    exePath,
    gameName: game?.name || '',
    variation: variation || null,
    // Admin uploads for Top Apps and social links are stored as iconUrl.
    // Keep the older image/icon/wallpaper fields for imported configurations.
    iconPath: game?.iconUrl || game?.image || game?.wallpaper || game?.icon || null,
    iconText: alertType === 'Game Launch' ? null : (game?.icon || null),
    alertType,
    notificationSettings: createNotificationSettings(settings),
  }
}

export function createLaunchAlertPayload(item, settings, alertType = 'Social Link') {
  const isSocialLink = alertType === 'Social Link'
  return {
    gameName: item?.name || '',
    // A one-character UI glyph (such as 𝕏) is not image artwork. Prefer a
    // configured icon image, then let the Telegram renderer use the URL-aware
    // vector fallback below.
    iconPath: item?.iconUrl || item?.image || item?.wallpaper || null,
    iconText: isSocialLink ? getSocialIconText(item) : (item?.icon || null),
    alertType,
    notificationSettings: createNotificationSettings(settings),
  }
}