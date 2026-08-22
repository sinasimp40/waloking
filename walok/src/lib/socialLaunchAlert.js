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
    // Invalid URLs are rejected by the Electron launch handler. Keep the
    // configured icon as a visual fallback in the alert payload.
  }

  return String(item?.icon || item?.name || '').trim().slice(0, 3) || null
}

export function createSocialLaunchAlertPayload(item, settings) {
  return {
    gameName: item?.name || '',
    // Never send a one-character launcher glyph to the image loader as if it
    // were a file path. A configured image wins; otherwise the URL determines
    // the brand vector rendered in the Telegram card.
    iconPath: item?.iconUrl || item?.image || item?.wallpaper || null,
    iconText: getSocialIconText(item),
    alertType: 'Social Link',
    notificationSettings: {
      notificationEnabled: settings?.notificationEnabled,
      notifyGameLaunches: settings?.notifyGameLaunches,
      pcName: settings?.pcName,
      pcMappings: settings?.pcMappings,
      telegramBotToken: settings?.telegramBotToken,
      telegramChatId: settings?.telegramChatId,
    },
  }
}