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

// Builds the notification-aware game payload expected by Electron's
// `launch-game` IPC handler. Keeping this in one place prevents secondary
// launch surfaces (featured, shelves, events) from falling back to a plain
// text Telegram alert because they only supplied an executable path.
export function createGameLaunchPayload(game, exePath, settings, variation = null, alertType = 'Game Launch') {
  return {
    exePath,
    gameName: game?.name || '',
    variation: variation || null,
    iconPath: game?.image || game?.icon || game?.wallpaper || null,
    iconText: alertType === 'Game Launch' ? null : (game?.icon || null),
    alertType,
    notificationSettings: createNotificationSettings(settings),
  }
}

export function createLaunchAlertPayload(item, settings, alertType = 'Social Link') {
  return {
    gameName: item?.name || '',
    iconPath: item?.image || item?.icon || item?.wallpaper || null,
    iconText: item?.icon || null,
    alertType,
    notificationSettings: createNotificationSettings(settings),
  }
}