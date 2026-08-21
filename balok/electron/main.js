const { app, BrowserWindow, ipcMain, dialog, shell, screen, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const zlib = require('zlib')
const { execFile, spawn } = require('child_process')

/* ── Single instance — prevent multiple open launchers ─────────────────────
   If another Balok process already holds the lock, quit immediately.
   The first instance receives 'second-instance' and refocuses itself. */
if (!app.requestSingleInstanceLock()) {
  app.quit()
  return
}

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  }
})

/* ── Startup integrity protection (packaged builds only) ── */
const { verifyIntegrity } = require('./integrity-check')
verifyIntegrity({ app, dialog })

const isDev = !app.isPackaged

/* ── Portable data layout (walok-proven) ────────────────────────────────────
   In packaged builds keep ALL app data — settings, uploaded assets,
   localStorage (games/settings store), staged OTA updates, cache, logs —
   in a `data` folder NEXT TO the exe, not the hidden %APPDATA% location.
   Copy the install folder and everything travels with it; delete it and
   nothing is left behind. Must run before app 'ready' for setPath to work. */
function getAppRoot() {
  if (isDev) return path.join(__dirname, '..')
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR
  return path.dirname(process.execPath)
}
const appRoot = getAppRoot()
let userDataDir = app.getPath('userData') // default %APPDATA%\<name>
if (!isDev) {
  const portableData = path.join(appRoot, 'data')
  try {
    // One-time migration: installs that ran before this change have their
    // settings/games in %APPDATA% — adopt them so nothing is lost. Only the
    // pieces that matter (skip Chromium caches).
    if (!fs.existsSync(portableData) && fs.existsSync(userDataDir)) {
      fs.mkdirSync(portableData, { recursive: true })
      for (const item of ['balok-settings.json', 'assets', 'balok-update', 'Local Storage', 'Session Storage', 'IndexedDB', 'Preferences']) {
        const from = path.join(userDataDir, item)
        if (fs.existsSync(from)) {
          try { fs.cpSync(from, path.join(portableData, item), { recursive: true }) } catch (_) {}
        }
      }
      // Preserve already-branded settings created by older releases too.
      // The previous fixed list only carried balok-settings.json and could
      // leave <brand>-settings.json behind in %APPDATA%.
      try {
        for (const item of fs.readdirSync(userDataDir)) {
          if (!/^[a-z0-9-]+-settings\.json$/i.test(item)) continue
          const from = path.join(userDataDir, item)
          const to = path.join(portableData, item)
          if (!fs.existsSync(to)) fs.copyFileSync(from, to)
        }
      } catch (_) {}
      console.log('[data] migrated settings from', userDataDir, '->', portableData)
    }
    if (!fs.existsSync(portableData)) fs.mkdirSync(portableData, { recursive: true })
    app.setPath('userData', portableData)
    app.setPath('appData', appRoot)
    app.setPath('cache', path.join(portableData, 'cache'))
    app.setPath('temp', path.join(portableData, 'temp'))
    app.setPath('logs', path.join(portableData, 'logs'))
    userDataDir = portableData
  } catch (e) {
    console.error('[data] portable redirect failed, using default location:', e.message)
  }
}
/* Settings file is named after the customer's BRAND, not the product:
   "BALOK LOUNGE" → balok-lounge-settings.json. Falls back to the legacy
   balok-settings.json (and migrates it) so existing installs keep their data. */
function brandSlugEarly() {
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'ota-config.json')
      : path.join(__dirname, '..', 'branding', 'ota-config.json')
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
    const slug = String(cfg.brandName || cfg.channel || '')
      .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return slug || 'balok'
  } catch (_) { return 'balok' }
}
const BRAND_SLUG = brandSlugEarly()
process.env.APP_BRAND_SLUG = BRAND_SLUG // Export for environment visibility
const settingsPath = path.join(userDataDir, BRAND_SLUG + '-settings.json')
/* Adopt-and-retire ANY previously branded settings file.
   Rebranding an install over OTA (e.g. "ASDQEW" -> "DENFI") changes the
   settings filename. Only migrating the hardcoded legacy `balok-settings.json`
   left the previous brand's file orphaned in the data folder forever, and the
   user started from empty settings. Now: if the current brand's file is
   missing, promote the most recently modified stale one; then delete every
   other `*-settings.json` so exactly one remains. */
try {
  const stale = fs.readdirSync(userDataDir)
    .filter(f => /^[a-z0-9-]+-settings\.json$/i.test(f))
    .map(f => path.join(userDataDir, f))
    .filter(p => p !== settingsPath && fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  if (stale.length) {
    if (!fs.existsSync(settingsPath)) {
      fs.renameSync(stale[0], settingsPath)
      console.log('[data] migrated', stale[0], '->', settingsPath)
      stale.shift()
    }
    for (const p of stale) {
      try { fs.rmSync(p, { force: true }); console.log('[data] removed retired settings file', p) } catch (_) {}
    }
  }
} catch (_) {}


const assetsDir = path.join(userDataDir, 'assets')
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })

/* ── OTA engine (walok parity) ─────────────────────────────────────────────
   init() applies any payload staged by the previous session BEFORE the first
   window is created, then registers the ota:* IPC handlers and starts the
   poll + SSE live-push loop. */
const otaUpdater = require('./updater')
try {
  otaUpdater.init({ appRoot, dataRoot: userDataDir, isDev, ipcMain })
} catch (e) {
  console.error('[OTA] init failed:', e.message)
}

/* ── Direct Telegram game-launch notifier ─────────────────────────────────── */
const telegramNotifier = require('./monitor')
function getOtaConfigPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ota-config.json')
    : path.join(__dirname, '..', 'branding', 'ota-config.json')
}

// An auto-closing launcher must not terminate the launch request or its first
// cold Telegram alert. Keep the main process alive until both settle.
let pendingTelegramNotifications = 0
let pendingGameLaunches = 0
let quitAfterTelegramNotifications = false
const recentLaunchNotifications = new Map()
const DUPLICATE_LAUNCH_NOTIFICATION_WINDOW_MS = 8_000

function quitWhenLaunchWorkSettles() {
  if (
    quitAfterTelegramNotifications &&
    pendingGameLaunches === 0 &&
    pendingTelegramNotifications === 0
  ) {
    app.quit()
  }
}

function reserveLaunchNotification(gameInfo = {}) {
  const gameName = String(gameInfo.gameName || '').trim().toLowerCase()
  const variation = String(gameInfo.variation || '').trim().toLowerCase()
  const alertType = String(gameInfo.alertType || 'Game Launch').trim().toLowerCase()
  const key = `${alertType}\u0000${gameName}\u0000${variation}`
  const now = Date.now()

  for (const [existingKey, timestamp] of recentLaunchNotifications) {
    if (now - timestamp >= DUPLICATE_LAUNCH_NOTIFICATION_WINDOW_MS) {
      recentLaunchNotifications.delete(existingKey)
    }
  }

  if (recentLaunchNotifications.has(key)) return null
  recentLaunchNotifications.set(key, now)
  return { key, timestamp: now }
}

function reportTelegramGameLaunch(gameInfo, settingsOverride) {
  const reservation = reserveLaunchNotification(gameInfo)
  if (!reservation) {
    console.warn('[telegram] duplicate game-launch notification ignored')
    return Promise.resolve({ success: true, skipped: true })
  }

  let delivery
  try {
    delivery = Promise.resolve(telegramNotifier.reportGameLaunch(
      settingsPath,
      getOtaConfigPath(),
      gameInfo,
      settingsOverride
    ))
  } catch (error) {
    console.warn('[telegram] could not start game-launch notification:', error.message)
    return Promise.resolve({ success: false, error: error.message })
  }

  pendingTelegramNotifications += 1
  delivery
    .then(result => {
      // reportGameLaunch returns nothing when alerts are disabled; release the
      // dedup key so a later real launch of the same item is not suppressed.
      if (result === undefined && recentLaunchNotifications.get(reservation.key) === reservation.timestamp) {
        recentLaunchNotifications.delete(reservation.key)
      }
      return result
    })
    .catch(error => console.warn('[telegram] game-launch notification failed:', error.message))
    .finally(() => {
      pendingTelegramNotifications = Math.max(0, pendingTelegramNotifications - 1)
      quitWhenLaunchWorkSettles()
    })

  return delivery
}

let win = null


/* ── Kiosk state + Windows taskbar hide (ported from walok) ────────────────
   Hides Shell_TrayWnd/Shell_SecondaryTrayWnd via ShowWindow instead of
   killing explorer.exe, so tray icons keep working and hidden background
   apps stay hidden. `taskbarHidden` is only flipped on PS success so a
   failed restore keeps retrying on every exit path. No-op off Windows. */
const kioskState = { enabled: false, suppressRefocusUntil: 0, taskbarHidden: false }

function runTaskbarPS(action) {
  if (process.platform !== 'win32') return false
  const state = action === 'hide' ? 0 : 5 // SW_HIDE / SW_SHOW
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -MemberDefinition @"
[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string c, string n);
[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
"@ -Name TB -Namespace KX -ErrorAction SilentlyContinue
$state = ${state}
$tray = [KX.TB]::FindWindow("Shell_TrayWnd", $null)
if ($tray -ne [IntPtr]::Zero) { [KX.TB]::ShowWindow($tray, $state) | Out-Null }
$start = [KX.TB]::FindWindow("Windows.UI.Core.CoreWindow", "Start")
if ($start -ne [IntPtr]::Zero) { [KX.TB]::ShowWindow($start, $state) | Out-Null }
$prev = [IntPtr]::Zero
while ($true) {
    $h = [KX.TB]::FindWindowEx([IntPtr]::Zero, $prev, "Shell_SecondaryTrayWnd", $null)
    if ($h -eq [IntPtr]::Zero) { break }
    [KX.TB]::ShowWindow($h, $state) | Out-Null
    $prev = $h
}
`.trim()

  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-Command', ps
    ], { windowsHide: true, shell: false, timeout: 5000 });
    
    if (r.status !== 0) {
      console.warn('[kiosk] runTaskbarPS(' + action + ') exit', r.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[kiosk] runTaskbarPS(' + action + ') failed:', e.message);
    return false;
  }
}


function hideTaskbar() {
  if (process.platform !== 'win32' || kioskState.taskbarHidden) return
  if (runTaskbarPS('hide')) kioskState.taskbarHidden = true
}

function restoreTaskbar() {
  if (process.platform !== 'win32' || !kioskState.taskbarHidden) return
  if (runTaskbarPS('show')) kioskState.taskbarHidden = false
  else console.warn('[kiosk] taskbar restore FAILED — flag kept set for retry')
}

/* Read persisted settings BEFORE window creation so kiosk mode can be a
   CONSTRUCTOR option — toggling fullscreen on a frameless window after
   creation is unreliable on Win11 (taskbar stays until user clicks). */
let cachedSettings = null
try {
  if (fs.existsSync(settingsPath)) cachedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
} catch (_) {}

const beforeInputListener = (event, input) => {
  if (!kioskState.enabled) return
  if (input.type !== 'keyDown') return
  const k = (input.key || '').toLowerCase()
  // Block app-switch/close chords. Win key + Ctrl+Alt+Del are OS-reserved
  // and cannot be intercepted from userspace — a Windows limitation.
  if (input.alt && (k === 'tab' || k === 'f4' || k === 'escape')) return event.preventDefault()
  if (input.control && k === 'escape') return event.preventDefault()
  if (k === 'f11') event.preventDefault()
}

// Re-assert kiosk flags whenever we regain focus — Windows can drop the
// window behind the taskbar after an Alt+Tab away-and-back.
const onKioskFocus = () => {
  if (!kioskState.enabled || !win || win.isDestroyed()) return
  try {
    if (!win.isFullScreen()) {
      try { if (win.isMaximized()) win.unmaximize() } catch (_) {}
      try { win.setFullScreen(true) } catch (_) {}
    }
    win.setKiosk(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setSkipTaskbar(true)
    try { win.setBounds(screen.getPrimaryDisplay().bounds) } catch (_) {}
    win.moveTop()
  } catch (_) {}
}

function applyKiosk(enabled) {
  if (!win || win.isDestroyed()) return
  const next = !!enabled
  if (next === kioskState.enabled) return
  kioskState.enabled = next
  try {
    if (next) {
      // Focus FIRST — setFullScreen on an unfocused window is a silent
      // no-op on Windows.
      try { win.show() } catch (_) {}
      try { win.focus() } catch (_) {}
      try { win.moveTop() } catch (_) {}
      try { if (win.isMaximized()) win.unmaximize() } catch (_) {}
      try { win.setFullScreen(true) } catch (_) {}
      win.setKiosk(true)
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setSkipTaskbar(true)
      try { win.setBounds(screen.getPrimaryDisplay().bounds) } catch (_) {}
      win.webContents.on('before-input-event', beforeInputListener)
      win.on('focus', onKioskFocus)
      hideTaskbar()
      // Emergency exit chord — registered only while kiosk is ON.
      try {
        globalShortcut.register('Control+Shift+Alt+K', () => {
          try { applyKiosk(false) } catch (_) {}
          try { win.webContents.send('kiosk:emergency-triggered') } catch (_) {}
        })
      } catch (e) { console.error('[kiosk] emergency chord registration failed:', e.message) }
    } else {
      try { win.setKiosk(false) } catch (_) {}
      try { if (win.isFullScreen()) win.setFullScreen(false) } catch (_) {}
      win.setAlwaysOnTop(false)
      win.setSkipTaskbar(false)
      try { win.webContents.removeListener('before-input-event', beforeInputListener) } catch (_) {}
      try { win.removeListener('focus', onKioskFocus) } catch (_) {}
      try { globalShortcut.unregisterAll() } catch (_) {}
      restoreTaskbar()
      try { if (!win.isMaximized()) win.maximize() } catch (_) {}
    }
  } catch (e) {
    console.error('[kiosk] applyKiosk failed:', e.message)
  }
}

function createWindow() {
  quitAfterTelegramNotifications = false
  // Persisted kiosk intent → constructor options (see cachedSettings note).
  let bootKiosk = false
  try {
    bootKiosk = !!(cachedSettings?.state?.settings?.kioskMode || cachedSettings?.settings?.kioskMode)
  } catch (_) {}

  win = new BrowserWindow({
    width: 1360,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0a0a0a',
    fullscreen: bootKiosk,
    kiosk: bootKiosk,
    simpleFullscreen: false,
    alwaysOnTop: bootKiosk,
    skipTaskbar: bootKiosk,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => {
    // Start maximized (walok parity) unless kiosk already made us fullscreen.
    if (!bootKiosk) win.maximize()
    win.show()
    if (bootKiosk) {
      try { win.focus() } catch (_) {}
      try { win.moveTop() } catch (_) {}
      try { applyKiosk(true) } catch (_) {}
    }
  })

  // Always-maximized launcher: dragging the top bar or hitting restore must
  // never leave the window in a small floating state.
  win.on('unmaximize', () => {
    if (win.isDestroyed() || win.isFullScreen()) return
    setTimeout(() => { try { if (!win.isDestroyed() && !win.isFullScreen()) win.maximize() } catch (_) {} }, 0)
  })


  if (isDev) {
    win.loadURL('http://localhost:5174')
  } else {
    // updater.js already applied any staged payload before app-ready, so this
    // resolves to the newest dist (staged update if present, else bundled).
    win.loadFile(otaUpdater.getActiveDistIndex())
  }


  win.on('closed', () => { win = null })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  if (pendingTelegramNotifications > 0 || pendingGameLaunches > 0) {
    quitAfterTelegramNotifications = true
    return
  }
  app.quit()
})

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll() } catch (_) {}
  try { restoreTaskbar() } catch (_) {}
})
process.on('uncaughtException', (err) => {
  try { restoreTaskbar() } catch (_) {}
  console.error('[uncaughtException]', err)
})
process.on('exit', () => {
  try { restoreTaskbar() } catch (_) {}
})



/* ── Kiosk IPC ── */
ipcMain.handle('kiosk:set', (_e, enabled) => {
  const wasEnabled = kioskState.enabled
  const isEnabling = !!enabled
  
  if (isEnabling !== wasEnabled) {
    applyKiosk(isEnabling)
  }
  return { success: true, enabled: kioskState.enabled }
})

ipcMain.handle('kiosk:get-status', () => ({ enabled: kioskState.enabled }))
ipcMain.handle('kiosk:emergency-exit', () => {
  applyKiosk(false)
  return { success: true }
})
ipcMain.handle('app:restart', () => {
  try {
    if (kioskState.enabled) applyKiosk(false)
    app.relaunch()
    app.exit(0)
  } catch (e) {
    console.error('[app:restart] failed:', e.message)
  }
  return { success: true }
})

/* ── Window controls ── */
ipcMain.on('minimize-window', () => win?.minimize())
ipcMain.on('maximize-window', () => {
  // Launcher stays maximized by design — restore-down is disabled.
  if (!win) return
  if (!win.isMaximized()) win.maximize()
})

ipcMain.on('close-window', () => {
  if (!win) return
  // Tear kiosk down FIRST (walok-proven order): closing while the window is
  // still kiosk + fullscreen + always-on-top is unreliable on Windows, and
  // it would also leave the OS taskbar hidden after the launcher exits.
  if (kioskState.enabled) { try { applyKiosk(false) } catch (_) {} }
  win.close()
})

/* ── Game launching ── */
// launch-game accepts either a plain exePath string (legacy) or an object
// { exePath, gameName, variation, iconPath } for notification-aware launches.
ipcMain.handle('launch-game', async (_e, exePathOrInfo, gameInfoExtra) => {
  pendingGameLaunches += 1
  try {
  let exePath, gameName, variation, iconPath, iconText, alertType, notificationSettings
  if (exePathOrInfo && typeof exePathOrInfo === 'object') {
    exePath   = exePathOrInfo.exePath
    gameName  = exePathOrInfo.gameName  || ''
    variation = exePathOrInfo.variation || null
    iconPath  = exePathOrInfo.iconPath  || null
    iconText  = exePathOrInfo.iconText  || null
    alertType = exePathOrInfo.alertType || 'Game Launch'
    notificationSettings = exePathOrInfo.notificationSettings || null
  } else {
    exePath   = exePathOrInfo
    gameName  = (gameInfoExtra && gameInfoExtra.gameName)  || ''
    variation = (gameInfoExtra && gameInfoExtra.variation) || null
    iconPath  = (gameInfoExtra && gameInfoExtra.iconPath)  || null
    iconText  = (gameInfoExtra && gameInfoExtra.iconText)  || null
    alertType = (gameInfoExtra && gameInfoExtra.alertType) || 'Game Launch'
    notificationSettings = (gameInfoExtra && gameInfoExtra.notificationSettings) || null
  }
  if (!exePath) return { success: false, error: 'No path provided' }
  try {
    if (!fs.existsSync(exePath)) return { success: false, error: 'File not found: ' + exePath }
    // Kiosk grace window — don't yank focus back from the game that is
    // starting (safety net even though kiosk auto-closes on launch).
    kioskState.suppressRefocusUntil = Date.now() + 8000

    const dir = path.dirname(exePath)
    const ext = path.extname(exePath).toLowerCase()

    // All executables (.exe, .bat, .cmd) are launched via `cmd /c start ""`
    // which is identical to what a .bat file does when it calls `start "" "game.exe"`.
    // This uses Windows ShellExecute semantics: the OS reads the app manifest,
    // applies UAC elevation, respects DPI/compatibility flags, and most importantly
    // does NOT inherit the Electron process environment — so anti-cheat systems
    // (Vanguard, EAC, BattlEye) and protected launchers (Valorant, CS2, etc.)
    // start in the correct security context instead of being blocked or broken.
    const spawnOptions = {
      detached: true,
      stdio: 'ignore',
      cwd: dir,
      shell: false,
      windowsVerbatimArguments: true,
    }

    if (ext === '.bat' || ext === '.cmd' || ext === '.exe') {
      spawn('cmd.exe', ['/c', `start "" "${exePath}"`], spawnOptions).unref()
    } else {
      // .lnk shortcuts, .url, documents, etc.
      const err = await shell.openPath(exePath)
      if (err) return { success: false, error: err }
    }

    // Prefer live renderer settings over a file that could still be settling
    // immediately after an OTA update.
    reportTelegramGameLaunch({
      gameName:  gameName  || path.basename(exePath, path.extname(exePath)),
      variation: variation || null,
      iconPath:  iconPath  || null,
      iconText:  iconText  || null,
      alertType,
    }, notificationSettings)

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
  } finally {
    pendingGameLaunches = Math.max(0, pendingGameLaunches - 1)
    quitWhenLaunchWorkSettles()
  }
})

ipcMain.handle('report-launch', async (_e, launchInfo = {}) => {
  pendingGameLaunches += 1
  try {
    await reportTelegramGameLaunch({
      gameName: launchInfo.gameName || '',
      variation: launchInfo.variation || null,
      iconPath: launchInfo.iconPath || null,
      iconText: launchInfo.iconText || null,
      alertType: launchInfo.alertType || 'Game Launch',
    }, launchInfo.notificationSettings || null)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    pendingGameLaunches = Math.max(0, pendingGameLaunches - 1)
    quitWhenLaunchWorkSettles()
  }
})

ipcMain.handle('test-telegram-alert', async () => {
  try {
    await telegramNotifier.sendTestAlert(settingsPath, getOtaConfigPath())
    return { success: true }
  } catch (error) {
    console.warn('[telegram] test alert failed:', error.message)
    return { success: false, error: error.message }
  }
})


/* ── File / folder / image pickers ── */
ipcMain.handle('select-file', async (_e, filters) => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
})

ipcMain.handle('select-folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
})

ipcMain.handle('select-image', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const srcPath = res.filePaths[0]
  try {
    // Copy into our own assets dir (walok-style) so the image keeps working
    // even if the user later deletes/moves the original, and normalize
    // backslashes — raw Windows paths break CSS url("file:///C:\...")
    // because \ is an escape character in CSS strings.
    const ext = path.extname(srcPath) || '.png'
    const dest = path.join(assetsDir, `${path.basename(srcPath, ext)}_${Date.now()}${ext}`)
    fs.copyFileSync(srcPath, dest)
    return dest.replace(/\\/g, '/')
  } catch (e) {
    return srcPath.replace(/\\/g, '/')
  }
})

ipcMain.handle('download-image', async (_e, url, filename) => {
  try {
    const dest = path.join(assetsDir, filename || `img_${Date.now()}.jpg`)
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest)
      https.get(url, (response) => {
        response.pipe(file)
        file.on('finish', () => file.close(resolve))
      }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err) })
    })
    return { success: true, path: dest }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

/* ── External links ── */
ipcMain.handle('open-external', async (_e, url, browserExePath) => {
  try {
    if (browserExePath) execFile(browserExePath, [url])
    else await shell.openExternal(url)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

/* ── Save & Load sync (zip → upload, download → extract) ── */
const { registerSaveSync } = require('./save-sync')
registerSaveSync(ipcMain)

/* ── Settings persistence (mirrors the renderer's zustand-persisted store) ── */

ipcMain.handle('load-settings', () => {
  try {
    if (fs.existsSync(settingsPath)) return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
  } catch (err) { console.error('load-settings error:', err.message) }
  return null
})

ipcMain.handle('save-settings', (_e, data) => {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2))
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

/* ── Local network info ── */
// LAN auto-discovery of the Save & Load server (UDP beacon broadcast by the
// walok save server). Returns { success, ip, port, url } or { success:false }.
// UDP beacons are spoofable, so before trusting a candidate we verify it
// actually answers like a save server on GET /api/status.
function verifySaveServer(url) {
  return new Promise((resolve) => {
    try {
      const http = require('http')
      const req = http.get(url + '/api/status', { timeout: 3000 }, (res) => {
        res.resume() // drain
        resolve(res.statusCode === 200)
      })
      req.on('timeout', () => { req.destroy(); resolve(false) })
      req.on('error', () => resolve(false))
    } catch (e) { resolve(false) }
  })
}

ipcMain.handle('discover-server', async (_e, timeoutMs) => {
  try {
    const { discoverServer } = require('./discovery')
    const result = await discoverServer(timeoutMs || 8000)
    if (result) {
      const ok = await verifySaveServer(result.url)
      if (ok) return { success: true, ...result }
      return { success: false, error: 'Found a beacon but the server did not respond' }
    }
    return { success: false, error: 'No server found on this network' }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('get-app-version', () => app.getVersion())

ipcMain.handle('get-local-ip', () => {
  const interfaces = os.networkInterfaces()
  const ips = []
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
    }
  }
  return { success: true, ips, hostname: os.hostname() }
})

/* ── IGDB search (used by Admin Panel's cover-art importer) ── */
let igdbToken = null, igdbTokenExpiry = 0, igdbTokenClientId = null

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: options.method || 'GET', headers: options.headers || {}, timeout: 10000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { reject(new Error('Invalid JSON response')) } })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

function igdbRequest(endpoint, body, token, clientId) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.igdb.com', path: `/v4/${endpoint}`, method: 'POST', headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, timeout: 10000 }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid IGDB response')) } })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
    req.write(body)
    req.end()
  })
}

async function getIgdbToken(clientId, clientSecret) {
  if (igdbToken && Date.now() < igdbTokenExpiry && igdbTokenClientId === clientId) return igdbToken
  const data = await fetchJSON(`https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`, { method: 'POST' })
  if (!data.access_token) throw new Error(data.message || 'Failed to get access token')
  igdbToken = data.access_token
  igdbTokenExpiry = Date.now() + (data.expires_in - 60) * 1000
  igdbTokenClientId = clientId
  return igdbToken
}

ipcMain.handle('igdb-search', async (_e, query, clientId, clientSecret) => {
  try {
    if (!clientId || !clientSecret) return { error: 'IGDB credentials not configured. Go to Admin Panel > Settings to add them.' }
    const token = await getIgdbToken(clientId, clientSecret)
    const games = await igdbRequest('games', `search "${query}"; fields name,cover,artworks,screenshots,genres,game_modes,summary; limit 10;`, token, clientId)
    const coverIds = games.map((g) => g.cover).filter(Boolean)
    let covers = {}
    if (coverIds.length > 0) {
      const coverData = await igdbRequest('covers', `fields game,image_id; where id = (${coverIds.join(',')}); limit 50;`, token, clientId)
      coverData.forEach((c) => { covers[c.game] = c })
    }
    // Artworks are IGDB's widescreen promo art (vs. the portrait box-art
    // cover), used as the Featured Game background so it doesn't crop out
    // heads/feet the way a 2:3 cover forced into a wide banner does. Fall
    // back to a screenshot if a game has no dedicated artwork.
    const artworkIds = games.flatMap((g) => (g.artworks || []).slice(0, 1)).filter(Boolean)
    let artworks = {}
    if (artworkIds.length > 0) {
      const artData = await igdbRequest('artworks', `fields game,image_id; where id = (${artworkIds.join(',')}); limit 50;`, token, clientId)
      artData.forEach((a) => { if (!artworks[a.game]) artworks[a.game] = a })
    }
    const screenshotIds = games.filter((g) => !g.artworks?.length).flatMap((g) => (g.screenshots || []).slice(0, 1)).filter(Boolean)
    let screenshots = {}
    if (screenshotIds.length > 0) {
      const shotData = await igdbRequest('screenshots', `fields game,image_id; where id = (${screenshotIds.join(',')}); limit 50;`, token, clientId)
      shotData.forEach((s) => { if (!screenshots[s.game]) screenshots[s.game] = s })
    }
    const genreIds = [...new Set(games.flatMap((g) => g.genres || []))]
    let genres = {}
    if (genreIds.length > 0) {
      const genreData = await igdbRequest('genres', `fields name; where id = (${genreIds.join(',')}); limit 50;`, token, clientId)
      genreData.forEach((g) => { genres[g.id] = g.name })
    }
    const gameModeIds = [...new Set(games.flatMap((g) => g.game_modes || []))]
    let gameModes = {}
    if (gameModeIds.length > 0) {
      const gmData = await igdbRequest('game_modes', `fields name; where id = (${gameModeIds.join(',')}); limit 50;`, token, clientId)
      gmData.forEach((gm) => { gameModes[gm.id] = gm.name })
    }
    const results = games.map((g) => {
      const cover = covers[g.id]
      const icon = cover ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${cover.image_id}.jpg` : null
      const art = artworks[g.id] || screenshots[g.id]
      const wallpaper = art ? `https://images.igdb.com/igdb/image/upload/t_1080p/${art.image_id}.jpg` : null
      const gModes = (g.game_modes || []).map((id) => gameModes[id]).filter(Boolean)
      const isOnline = gModes.some((m) => /multiplayer|online|co-op|mmo|battle royale/i.test(m))
      return {
        id: g.id, name: g.name, icon, wallpaper, summary: g.summary || '',
        genres: (g.genres || []).map((id) => genres[id]).filter(Boolean),
        category: isOnline ? 'online' : 'offline',
      }
    })
    return { success: true, results }
  } catch (err) {
    return { error: err.message || 'IGDB request failed' }
  }
})

/* ── Real hardware stats for the "My Rig" widget ──
   CPU: sampled by comparing os.cpus() idle/total ticks over a short window
   (works cross-platform). RAM: os.total/freemem (accurate everywhere).
   Storage: platform disk-usage command for the drive the app runs from.
   GPU: nvidia-smi if present; otherwise omitted (unsupported for most
   integrated/AMD GPUs without a vendor-specific tool). */
function sampleCpuUsage() {
  return new Promise((resolve) => {
    const start = os.cpus()
    setTimeout(() => {
      const end = os.cpus()
      let idleDiff = 0, totalDiff = 0
      for (let i = 0; i < start.length; i++) {
        const s = start[i].times, e = end[i].times
        const idle = e.idle - s.idle
        const total = (e.user - s.user) + (e.nice - s.nice) + (e.sys - s.sys) + (e.irq - s.irq) + idle
        idleDiff += idle
        totalDiff += total
      }
      resolve(totalDiff > 0 ? Math.round(100 * (1 - idleDiff / totalDiff)) : null)
    }, 200)
  })
}

function getDiskUsage() {
  return new Promise((resolve) => {
    const targetPath = process.platform === 'win32' ? path.parse(app.getPath('exe')).root : '/'
    if (process.platform === 'win32') {
      const drive = targetPath.replace(/\\$/, '')
      execFile('wmic', ['logicaldisk', 'where', `Caption="${drive}"`, 'get', 'Size,FreeSpace', '/format:value'], (err, stdout) => {
        if (err) return resolve(null)
        const free = Number((stdout.match(/FreeSpace=(\d+)/) || [])[1])
        const size = Number((stdout.match(/Size=(\d+)/) || [])[1])
        if (!size) return resolve(null)
        resolve(Math.round(100 * (1 - free / size)))
      })
    } else {
      try {
        const stat = fs.statfsSync(targetPath)
        const total = stat.blocks * stat.bsize
        const free = stat.bfree * stat.bsize
        resolve(total > 0 ? Math.round(100 * (1 - free / total)) : null)
      } catch { resolve(null) }
    }
  })
}

function getGpuUsage() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], (err, stdout) => {
      if (err) return resolve(null)
      const pct = parseInt(String(stdout).trim().split('\n')[0], 10)
      resolve(Number.isFinite(pct) ? pct : null)
    })
  })
}

/* ── Real OS master volume (pinned volume slider in the right panel) ── */
const sysVolume = require('./system-volume')
ipcMain.handle('sysvol:get', async () => { try { return await sysVolume.getVolume() } catch { return null } })
ipcMain.handle('sysvol:set', (_e, percent) => { try { return sysVolume.setVolume(percent) } catch { return false } })
ipcMain.handle('sysvol:mute', (_e, muted) => { try { return sysVolume.setMute(muted) } catch { return false } })
app.on('will-quit', () => { try { sysVolume.dispose() } catch {} })

ipcMain.handle('get-system-stats', async () => {
  const [cpu, gpu, storage] = await Promise.all([sampleCpuUsage(), getGpuUsage(), getDiskUsage()])
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const ram = totalMem > 0 ? Math.round(100 * (1 - freeMem / totalMem)) : null
  return { cpu, gpu, ram, storage }
})

/* ── OTA updates ────────────────────────────────────────────────────────────
   All update logic now lives in ./updater.js (walok-parity engine):
   check → notify → user confirms → download → verify → stage → apply on next
   launch. The renderer talks to it through the window.electronAPI.ota bridge. */

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/* ── Branding: expose ota-config (brand name, subtitle, logo) to renderer ── */
ipcMain.handle('get-ota-config', () => {
  const cfg = otaUpdater.getEffectiveConfig()
  if (!cfg) return null
  return {
    channel: cfg.channel || '',
    brandName: cfg.brand || cfg.brandName || '',
    subtitle: cfg.subtitle || '',
    logoFile: cfg.logoFile || null,
    updateServerUrl: cfg.updateServer || '',
    version: cfg.version || app.getVersion(),
    buildId: cfg.buildId || '',
  }
})

/* Legacy renderer bridge kept alive so older staged dists (built before the
   walok-style modal shipped) can still restart the app after an update. */
ipcMain.on('restart-app', () => { otaUpdater.restartApp() })


/* ── Backup & Restore (brand-named .zip with settings + assets) ─────────────
   Export writes a real ZIP containing:
     backup.json   — { version, brand, exportedAt, games, settings } where every
                     file:/// path that lives in the assets dir is rewritten to
                     a portable relative "assets/<name>" path
     assets/*      — the referenced image/logo files themselves
   Import accepts that ZIP (writes assets back into the local assets dir and
   restores absolute file:/// paths) and still accepts a legacy .json backup
   (plain paths and/or embedded base64 data: URLs). */

function brandLabel() {
  try {
    const cfg = otaUpdater.getEffectiveConfig()
    const name = (cfg && (cfg.brand || cfg.brandName)) || ''
    if (name) return name
  } catch (_) {}
  try {
    const cfg = readJsonSafe(path.join(process.resourcesPath || '', 'branding', 'ota-config.json'))
    if (cfg && (cfg.brandName || cfg.brand)) return cfg.brandName || cfg.brand
  } catch (_) {}
  try { return require('./brand').DISPLAY_NAME || 'Launcher' } catch (_) { return 'Launcher' }
}

function brandFileSlug() {
  return String(brandLabel()).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'launcher'
}

function bkCrc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function bkBuildZip(entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const ent of entries) {
    const content = ent.buffer
    const compressed = zlib.deflateRawSync(content)
    const nameBuf = Buffer.from(ent.relativePath, 'utf8')
    const crc = bkCrc32(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(Buffer.concat([local, nameBuf, compressed]))
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    offset += 30 + nameBuf.length + compressed.length
  }
  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralDir, eocd])
}

function bkReadZip(buf) {
  const ents = []
  let pos = 0
  while (pos + 4 <= buf.length) {
    if (buf.readUInt32LE(pos) !== 0x04034b50) break
    const method = buf.readUInt16LE(pos + 8)
    const compSize = buf.readUInt32LE(pos + 18)
    const nameLen = buf.readUInt16LE(pos + 26)
    const extraLen = buf.readUInt16LE(pos + 28)
    const name = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf8')
    const start = pos + 30 + nameLen + extraLen
    const data = buf.slice(start, start + compSize)
    pos = start + compSize
    if (name.endsWith('/')) continue
    if (method === 0) ents.push({ name, data })
    else if (method === 8) { try { ents.push({ name, data: zlib.inflateRawSync(data) }) } catch (_) {} }
  }
  return ents
}

ipcMain.handle('backup:export', async () => {
  try {
    let raw = null
    if (fs.existsSync(settingsPath)) raw = readJsonSafe(settingsPath)
    const state = (raw && raw.state && typeof raw.state === 'object') ? raw.state : (raw || {})
    const games = state.games || []
    const settings = state.settings || {}
    if (!games.length && !Object.keys(settings).length) {
      return { success: false, error: 'Nothing to export yet — save something first.' }
    }

    const absAssets = path.resolve(assetsDir)
    const assetMap = new Map() // absPath -> 'assets/<basename>'

    function fileUrlToAbs(v) {
      if (typeof v !== 'string') return null
      if (!v.startsWith('file://')) return null
      const clean = v.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '')
      return path.resolve(decodeURI(clean).replace(/\//g, path.sep))
    }
    function registerAbs(abs) {
      if (abs && abs.startsWith(absAssets) && fs.existsSync(abs) && !assetMap.has(abs)) {
        assetMap.set(abs, 'assets/' + path.basename(abs))
      }
    }
    function gather(val) {
      if (val === null || val === undefined) return
      if (typeof val === 'string') {
        const direct = fileUrlToAbs(val)
        if (direct) registerAbs(direct)
        else for (const m of val.matchAll(/file:\/\/\/?([^"'\s\[\]<>]+)/g)) registerAbs(path.resolve(decodeURI(m[1]).replace(/\//g, path.sep)))
        return
      }
      if (typeof val !== 'object') return
      if (Array.isArray(val)) { val.forEach(gather); return }
      for (const v of Object.values(val)) gather(v)
    }
    gather({ games, settings })

    function portable(val) {
      if (val === null || val === undefined) return val
      if (typeof val === 'string') {
        const direct = fileUrlToAbs(val)
        if (direct) return assetMap.get(direct) || val
        return val.replace(/file:\/\/\/?([^"'\s\[\]<>]+)/g, (match, rawPath) =>
          assetMap.get(path.resolve(decodeURI(rawPath).replace(/\//g, path.sep))) || match)
      }
      if (typeof val !== 'object') return val
      if (Array.isArray(val)) return val.map(portable)
      const out = {}
      for (const [k, v] of Object.entries(val)) out[k] = portable(v)
      return out
    }

    const payload = {
      version: 2,
      brand: brandLabel(),
      exportedAt: new Date().toISOString(),
      games: portable(games),
      settings: portable(settings),
    }

    const entries = [
      { relativePath: 'backup.json', buffer: Buffer.from(JSON.stringify(payload, null, 2), 'utf-8') },
      // Human-friendly copy of the raw settings store, as shipped on disk.
      { relativePath: 'settings.json', buffer: Buffer.from(JSON.stringify(raw || { state: { games, settings } }, null, 2), 'utf-8') },
    ]
    for (const [absPath, relPath] of assetMap) {
      try { entries.push({ relativePath: relPath, buffer: fs.readFileSync(absPath) }) } catch (_) {}
    }

    const zipBuffer = bkBuildZip(entries)
    const stamp = new Date().toISOString().split('T')[0]
    const result = await dialog.showSaveDialog({
      title: 'Save ' + brandLabel() + ' Backup',
      defaultPath: `${brandFileSlug()}-backup-${stamp}.zip`,
      filters: [{ name: brandLabel() + ' Backup', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return { success: false, canceled: true }
    fs.writeFileSync(result.filePath, zipBuffer)
    return { success: true, filePath: result.filePath, assetCount: assetMap.size, gameCount: games.length, brand: brandLabel() }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('backup:import', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Import ' + brandLabel() + ' Backup',
      filters: [{ name: brandLabel() + ' Backup', extensions: ['zip', 'json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths.length) return { success: false, canceled: true }
    const filePath = result.filePaths[0]
    const ext = path.extname(filePath).toLowerCase()
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })

    let games, settings, exportedAt, assetCount = 0

    if (ext === '.zip') {
      const ents = bkReadZip(fs.readFileSync(filePath))
      const main = ents.find(e => e.name === 'backup.json') || ents.find(e => e.name === 'settings.json')
      if (!main) return { success: false, error: 'Invalid backup zip — backup.json not found inside.' }
      let payload = JSON.parse(main.data.toString('utf-8'))
      if (payload && payload.state && typeof payload.state === 'object') payload = payload.state
      if (!payload.games && !payload.settings) return { success: false, error: 'Invalid backup — missing games or settings.' }

      const assetMap = new Map()
      for (const ent of ents) {
        if (!ent.name.startsWith('assets/')) continue
        const safeName = path.basename(ent.name).replace(/[^a-zA-Z0-9._\-]/g, '_')
        if (!safeName) continue
        const dest = path.join(assetsDir, safeName)
        fs.writeFileSync(dest, ent.data)
        assetMap.set(ent.name, 'file:///' + dest.replace(/\\/g, '/'))
        assetCount++
      }

      const extractedAssets = Array.from(assetMap.entries()).map(([relativePath, fileUrl]) => ({
        relativePath,
        fileName: path.basename(relativePath),
        fileUrl,
      }))

      function findExtractedAsset(value, fieldName) {
        const normalized = String(value).replace(/\\/g, '/')
        const portableMatch = assetMap.get(normalized)
        if (portableMatch) return portableMatch

        const fileName = normalized.split('/').pop()
        const exact = extractedAssets.find(asset => asset.fileName === fileName)
        if (exact) return exact.fileUrl

        // Older backups can store an IGDB endpoint in JSON while the actual
        // image in assets/ is named igdb_<id>_cover_<timestamp>.jpg (or
        // wallpaper). Match by the IGDB id instead of comparing those unlike
        // basenames. Prefer the media type appropriate for the object field.
        let igdbKey = null
        try {
          if (normalized.startsWith('/api/') || /^https?:/i.test(normalized)) {
            const parsed = new URL(normalized, 'http://balok.local')
            igdbKey = parsed.searchParams.get('name')
          }
        } catch (_) {}
        if (!igdbKey) {
          const idMatch = normalized.match(/(?:^|[/_])igdb_(\d+)(?:[_./]|$)/i)
          if (idMatch) igdbKey = idMatch[1]
        }
        if (!igdbKey) return null

        const decodedKey = decodeURIComponent(igdbKey).trim()
        const escapedKey = decodedKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const idPattern = /^\d+$/.test(decodedKey)
          ? new RegExp(`(?:^|_)${escapedKey}(?:_|\\.)`, 'i')
          : null
        let candidates = extractedAssets.filter(asset => {
          if (idPattern) return idPattern.test(asset.fileName)
          return asset.fileName.toLowerCase().includes(decodedKey.toLowerCase())
        })
        if (!candidates.length) return null

        const preferredType = /banner|background|wallpaper/i.test(fieldName || '') ? 'wallpaper' : 'cover'
        candidates = candidates.sort((a, b) => {
          const aPreferred = a.fileName.toLowerCase().includes(`_${preferredType}_`) ? 1 : 0
          const bPreferred = b.fileName.toLowerCase().includes(`_${preferredType}_`) ? 1 : 0
          return bPreferred - aPreferred
        })
        return candidates[0].fileUrl
      }

      function restore(val, fieldName = '') {
        if (val === null || val === undefined) return val
        if (typeof val === 'string') {
          const importedAsset = findExtractedAsset(val, fieldName)
          if (importedAsset) return importedAsset

          const fileName = val.replace(/\\/g, '/').split('/').pop()
          if (fileName && !val.startsWith('http') && !val.startsWith('/api')) {
            const localPath = path.join(assetsDir, fileName)
            if (fs.existsSync(localPath)) return 'file:///' + localPath.replace(/\\/g, '/')
          }
          return val
        }
        if (typeof val !== 'object') return val
        if (Array.isArray(val)) return val.map(item => restore(item, fieldName))
        const out = {}
        for (const [k, v] of Object.entries(val)) out[k] = restore(v, k)
        return out
      }
      games = restore(payload.games || [])
      settings = restore(payload.settings || {})
      exportedAt = payload.exportedAt
    } else {
      let payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      if (payload && payload.state && typeof payload.state === 'object') payload = payload.state
      if (!payload.games && !payload.settings) return { success: false, error: 'Invalid backup — missing games or settings.' }
      // Legacy backups may embed base64 data: URLs — write them to the assets dir.
      function rewrite(val) {
        if (typeof val === 'string') {
          if (val.startsWith('data:image/')) {
            const [header, b64] = val.split(',')
            if (!b64) return val
            const mime = header.replace('data:', '').replace(';base64', '')
            const extPart = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')
            const name = `imported_${Date.now()}_${Math.random().toString(36).slice(2)}.${extPart}`
            const dest = path.join(assetsDir, name)
            fs.writeFileSync(dest, Buffer.from(b64, 'base64'))
            assetCount++
            return 'file:///' + dest.replace(/\\/g, '/')
          }
          return val
        }
        if (!val || typeof val !== 'object') return val
        if (Array.isArray(val)) return val.map(rewrite)
        const out = {}
        for (const [k, v] of Object.entries(val)) out[k] = rewrite(v)
        return out
      }
      games = rewrite(payload.games || [])
      settings = rewrite(payload.settings || {})
      exportedAt = payload.exportedAt
    }

    return { success: true, games, settings, exportedAt, assetCount, gameCount: Array.isArray(games) ? games.length : 0 }
  } catch (err) {
    return { success: false, error: err.message }
  }
})


