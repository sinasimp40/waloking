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
export function createGameLaunchPayload(game, exePath, settings, variation = null) {
  return {
    exePath,
    gameName: game?.name || '',
    variation: variation || null,
    iconPath: game?.image || game?.icon || game?.wallpaper || null,
    notificationSettings: createNotificationSettings(settings),
  }
}

export function createLaunchAlertPayload(item, settings) {
  return {
    gameName: item?.name || '',
    iconPath: item?.image || item?.icon || item?.wallpaper || null,
    notificationSettings: createNotificationSettings(settings),
  }
}