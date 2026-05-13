const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, screen } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')

let mainWindow = null
// Module-scoped runtime kiosk state, mutated by applyKiosk() below.
// Lives outside createWindow so window-recreate (macOS activate path)
// can read the previous state if needed.
const kioskState = { enabled: false, suppressRefocusUntil: 0, explorerKilled: false }

// ---------------------------------------------------------------------
// Explorer.exe lifecycle (Option C — Windows kiosk hardening)
// ---------------------------------------------------------------------
// Killing explorer.exe removes the Windows shell entirely: no taskbar,
// no Start menu, no system tray, no Alt+Tab visual switcher. This is
// what classic Windows kiosk apps (and the MSFT-built Assigned Access
// itself) do under the hood. The launcher becomes the only visible
// surface. Caveats:
//   - System tray icons (volume, network, etc.) disappear while shell
//     is dead — acceptable for a cafe lockdown.
//   - If the launcher hard-crashes, the cashier needs Ctrl+Shift+Esc
//     → File → Run → "explorer.exe" to get the shell back. We wire
//     up uncaughtException + process.on('exit') as belt-and-suspenders
//     so a graceful Node crash still respawns the shell.
//   - We track `explorerKilled` so we never double-kill or accidentally
//     respawn explorer if we never killed it (e.g. user toggled kiosk
//     off without ever turning it on).
// All operations are no-ops on non-Windows.
function killExplorer() {
  if (process.platform !== 'win32') return
  if (kioskState.explorerKilled) return
  try {
    const r = require('child_process').spawnSync('taskkill', ['/F', '/IM', 'explorer.exe'], { windowsHide: true })
    // taskkill returns 128 if the process wasn't running — that's fine,
    // it just means the shell was already down. Anything else logs.
    if (r.status !== 0 && r.status !== 128) {
      console.warn('[kiosk] taskkill explorer.exe exited with code', r.status, r.stderr && r.stderr.toString())
    }
    kioskState.explorerKilled = true
    console.log('[kiosk] explorer.exe killed — shell is down')
  } catch (e) {
    console.error('[kiosk] killExplorer failed:', e.message)
  }
}

function restoreExplorer() {
  if (process.platform !== 'win32') return
  if (!kioskState.explorerKilled) return
  try {
    // Spawn detached so explorer.exe outlives this Node process. Using
    // `start` via cmd avoids inheriting the launcher's handles, which
    // would tie explorer's lifetime to ours and immediately kill it
    // when the launcher exits.
    const child = require('child_process').spawn('cmd.exe', ['/c', 'start', '', 'explorer.exe'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.unref()
    kioskState.explorerKilled = false
    console.log('[kiosk] explorer.exe respawned — shell restored')
  } catch (e) {
    console.error('[kiosk] restoreExplorer failed:', e.message)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
  return
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
})

const { verifyIntegrity } = require('./integrity-check')
verifyIntegrity({ app, dialog })

const otaUpdater = require('./updater')

app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// All brand-derived constants (display name, slug, folder/file names,
// legacy slugs, OTA user-agent) live in ./brand.js — single source of
// truth, also imported by ./updater.js so nothing drifts.
const {
  BRAND_SLUG,
  DISPLAY_NAME,
  LEGACY_BRAND_SLUGS,
  BRAND_SUFFIXES,
  SETTINGS_FILE,
  USER_DATA_DIR,
  ASSETS_DIR,
} = require('./brand')

app.name = DISPLAY_NAME

function getAppRoot() {
  if (isDev) {
    return path.join(__dirname, '..')
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR
  }
  return path.dirname(process.execPath)
}

const appRoot = getAppRoot()

// Rename leftover folders/files from any previous brand (or default
// example-cafe) to the current BRAND_SLUG. Only renames when the old
// path exists AND the new path does not — so it's safe to run on every
// startup and won't clobber an existing current-brand folder.
function migrateLegacyPaths() {
  // Loop by SUFFIX (outer) so we only adopt ONE legacy per suffix —
  // newest-first wins. Without this, if both `denfis-data` and
  // `walok-data` exist we'd race them onto the same target.
  for (const sfx of BRAND_SUFFIXES) {
    const newPath = path.join(appRoot, BRAND_SLUG + sfx)
    for (const oldSlug of LEGACY_BRAND_SLUGS) {
      if (oldSlug === BRAND_SLUG) continue
      const oldPath = path.join(appRoot, oldSlug + sfx)
      try {
        if (!fs.existsSync(oldPath)) continue
        if (!fs.existsSync(newPath)) {
          fs.renameSync(oldPath, newPath)
          break
        }
        // Both exist — common when the user rebrands BACK to a previous
        // brand (e.g. DENFI -> DENFIS -> DENFI). The new path may have
        // been auto-created empty by Electron init or left over from the
        // original install, while the user's real data is in the legacy
        // path. Adopt the legacy one when the new is empty/default,
        // backing up the displaced new path so nothing is ever lost.
        if (newPathLooksEmpty(newPath, oldPath)) {
          const backup = newPath + '.bak.' + Date.now()
          fs.renameSync(newPath, backup)
          fs.renameSync(oldPath, newPath)
          break
        }
      } catch (e) {}
    }
  }
  migrateJsonContents()
}

function newPathLooksEmpty(newPath, oldPath) {
  try {
    const newStat = fs.statSync(newPath)
    const oldStat = fs.statSync(oldPath)
    if (newStat.isDirectory() && oldStat.isDirectory()) {
      return fs.readdirSync(newPath).length === 0
    }
    if (newStat.isFile() && oldStat.isFile()) {
      // Default settings.json is ~1-2 KB. If legacy is meaningfully
      // larger, it almost certainly contains the user's games/configs.
      // We only override when the legacy is BIGGER by a noticeable
      // margin to avoid clobbering newer-but-smaller user edits.
      return oldStat.size > newStat.size && (oldStat.size - newStat.size) > 100
    }
  } catch (e) {}
  return false
}

function migrateJsonContents() {
  const settingsPath = path.join(appRoot, SETTINGS_FILE)
  if (!fs.existsSync(settingsPath)) return
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    let changed = false
    const rewriteValue = (v) => {
      if (typeof v !== 'string') return v
      if (!/[/\\]/.test(v) && !v.startsWith('file:')) return v
      let out = v
      for (const oldSlug of LEGACY_BRAND_SLUGS) {
        if (oldSlug === BRAND_SLUG) continue
        for (const sfx of BRAND_SUFFIXES) {
          const oldToken = oldSlug + sfx
          const newToken = BRAND_SLUG + sfx
          if (oldToken !== newToken && out.includes(oldToken)) {
            out = out.split(oldToken).join(newToken)
          }
        }
      }
      if (out !== v) changed = true
      return out
    }
    const walk = (obj) => {
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          if (typeof obj[i] === 'string') obj[i] = rewriteValue(obj[i])
          else if (obj[i] && typeof obj[i] === 'object') walk(obj[i])
        }
      } else if (obj && typeof obj === 'object') {
        for (const k of Object.keys(obj)) {
          if (typeof obj[k] === 'string') obj[k] = rewriteValue(obj[k])
          else if (obj[k] && typeof obj[k] === 'object') walk(obj[k])
        }
      }
    }
    walk(data)
    if (changed) {
      const tmp = settingsPath + '.mig.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
      fs.renameSync(tmp, settingsPath)
    }
  } catch (e) {}
}

migrateLegacyPaths()

try {
  otaUpdater.init({ appRoot, isDev, ipcMain })
} catch (e) {
  console.error('[OTA] init failed:', e.message)
}

function getSettingsPath() {
  return path.join(appRoot, SETTINGS_FILE)
}

if (!isDev) {
  const userDataPath = path.join(appRoot, USER_DATA_DIR)
  try {
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true })
    }
  } catch (e) {}
  try {
    app.setPath('userData', userDataPath)
    app.setPath('appData', appRoot)
    app.setPath('cache', path.join(userDataPath, 'cache'))
    app.setPath('temp', path.join(userDataPath, 'temp'))
    app.setPath('logs', path.join(userDataPath, 'logs'))
  } catch (e) {
    console.error('Failed to redirect paths:', e.message)
  }
}

let cachedSettings = null
try {
  const sp = getSettingsPath()
  if (fs.existsSync(sp)) {
    cachedSettings = JSON.parse(fs.readFileSync(sp, 'utf-8'))
  }
} catch (e) {}

function getSplashImage() {
  try {
    if (cachedSettings?.state?.settings?.splashImage) return cachedSettings.state.settings.splashImage
    if (cachedSettings?.settings?.splashImage) return cachedSettings.settings.splashImage
  } catch (e) {}
  return null
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    center: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
    icon: path.join(__dirname, '../public/icon.ico'),
  })

  let splashImg = getSplashImage()
  if (splashImg && splashImg.startsWith('file:///')) {
    splashImg = splashImg.replace('file:///', '')
  } else if (splashImg && splashImg.startsWith('file://')) {
    splashImg = splashImg.replace('file://', '')
  }

  const splashHtml = path.join(__dirname, 'splash.html')
  const imgParam = splashImg ? `?img=${encodeURIComponent(splashImg)}` : ''
  splash.loadURL(`file://${splashHtml}${imgParam}`)
  splash.show()

  return splash
}

function createWindow(splash) {
  // Compute persisted kiosk intent BEFORE constructing the BrowserWindow
  // so we can pass fullscreen + kiosk as CONSTRUCTOR options. On Win11,
  // toggling fullscreen on a frameless window AFTER creation is unreliable
  // — the taskbar stays visible until the user clicks the window. Creating
  // the window with fullscreen/kiosk from the start makes Windows enter
  // real exclusive-fullscreen at construction, before the first paint, so
  // the taskbar can never appear.
  let bootKiosk = false
  try {
    bootKiosk = !!(cachedSettings?.state?.settings?.kioskMode || cachedSettings?.settings?.kioskMode)
  } catch (_) {}

  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1280,
    minHeight: 720,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#050510',
    fullscreen: bootKiosk,
    kiosk: bootKiosk,
    simpleFullscreen: false,
    alwaysOnTop: bootKiosk,
    skipTaskbar: bootKiosk,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
    icon: path.join(__dirname, '../public/icon.ico'),
    show: false,
  })

  mainWindow = win
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })

  win.once('ready-to-show', () => {
    // The window was constructed with fullscreen/kiosk already baked in
    // when bootKiosk is true, so all we do here is show it and (for the
    // kiosk path) wire up the focus/blur handlers and global-shortcut
    // swallowers via applyKiosk. applyKiosk's setFullScreen/setKiosk
    // calls are idempotent on an already-fullscreen window.
    if (!bootKiosk) win.maximize()
    win.show()
    if (splash && !splash.isDestroyed()) {
      splash.close()
    }
    if (bootKiosk) {
      try { win.focus() } catch (_) {}
      try { win.moveTop() } catch (_) {}
      try { applyKiosk(true) } catch (_) {}
    }
  })

  if (isDev) {
    win.loadURL('http://localhost:5000')
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  ipcMain.on('minimize-window', () => { if (kioskState.enabled) return; win.minimize() })
  ipcMain.on('maximize-window', () => {
    // Disabled while kiosk is on — minimize/maximize would let the user
    // (or a stray click) leave the locked fullscreen surface.
    if (kioskState.enabled) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('close-window', () => {
    // Always tear kiosk down before close so the next launch starts in
    // the normal frameless-maximized window even if the close path was
    // triggered while kiosk was still active.
    if (kioskState.enabled) applyKiosk(false)
    win.close()
  })
  ipcMain.on('fullscreen-window', () => {
    if (kioskState.enabled) return
    win.setFullScreen(!win.isFullScreen())
  })

  // ===== KIOSK MODE =====
  // Single source of truth for the runtime kiosk state. The persisted
  // setting (settings.kioskMode in the renderer store) is the canonical
  // intent; this object tracks what's actually been applied to the
  // BrowserWindow so we never double-toggle or leak state.
  const beforeInputListener = (event, input) => {
    if (!kioskState.enabled) return
    if (input.type !== 'keyDown') return
    const k = (input.key || '').toLowerCase()
    // Block common app-switch / close shortcuts. Win key + Ctrl+Alt+Del
    // are OS-reserved on Windows and CANNOT be intercepted from a
    // userspace Electron app — that's a Windows limitation, not a bug.
    if (input.alt && (k === 'tab' || k === 'f4' || k === 'escape')) {
      event.preventDefault()
      return
    }
    if (input.control && k === 'escape') {
      event.preventDefault()
      return
    }
    // F11 also escapes fullscreen on some configurations.
    if (k === 'f11') event.preventDefault()
  }

  // Re-assert kiosk on focus events. Even with setKiosk(true) +
  // alwaysOnTop, Windows can drop the launcher behind the taskbar after
  // an Alt+Tab away-and-back. On every focus regain we re-apply kiosk
  // window flags so the taskbar disappears again. On blur during kiosk,
  // we immediately call focus() to yank attention back to the launcher.
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
      // Belt-and-suspenders: force window bounds to cover the entire
      // display (including the taskbar strip) in case the fullscreen
      // transition was rejected and we're still clipped to work area.
      try {
        const d = screen.getPrimaryDisplay()
        win.setBounds(d.bounds)
      } catch (_) {}
      win.moveTop()
    } catch (_) {}
  }
  // Kiosk OS-chord blocking has been intentionally removed. Neither the
  // focus-snap blur handler (Option A) nor the native WH_KEYBOARD_LL
  // hook + taskbar-hide (Option B) reliably stopped Alt+Tab spam on
  // Windows 11. Real Alt+Tab lockdown requires either killing
  // explorer.exe while kiosk runs, or using Windows' built-in Assigned
  // Access kiosk mode. See replit.md → Kiosk Mode for the next step.

  function applyKiosk(enabled) {
    if (!win || win.isDestroyed()) return
    const next = !!enabled
    if (next === kioskState.enabled) return
    kioskState.enabled = next
    try {
      if (next) {
        // Hiding the Windows taskbar from a frameless launcher requires
        // ALL of the following — any single mechanism alone leaves the
        // taskbar peeking out at the bottom on at least one Win10/11
        // configuration the user has tested:
        //   1. unmaximize()  — ensures setFullScreen sees a real
        //      geometry change to transition into.
        //   2. setFullScreen(true) — exclusive fullscreen on Win10/11
        //      hides the taskbar.
        //   3. setKiosk(true) — additional fullscreen flag.
        //   4. alwaysOnTop('screen-saver') — keeps us above the taskbar
        //      Z-order even if the taskbar tries to repaint over us.
        //   5. setSkipTaskbar(true) — removes our own taskbar entry.
        //   6. setBounds(primaryDisplay.bounds) — last-ditch guarantee:
        //      forces the window to physically cover the taskbar strip
        //      even if the fullscreen transition was rejected.
        // Force focus FIRST — setFullScreen on an unfocused window is a
        // silent no-op on Windows, which is why the user reported
        // having to click the taskbar to "wake up" kiosk on first boot.
        try { win.show() } catch (_) {}
        try { win.focus() } catch (_) {}
        try { win.moveTop() } catch (_) {}
        try { if (win.isMaximized()) win.unmaximize() } catch (_) {}
        try { win.setFullScreen(true) } catch (_) {}
        win.setKiosk(true)
        win.setAlwaysOnTop(true, 'screen-saver')
        win.setSkipTaskbar(true)
        try {
          const d = screen.getPrimaryDisplay()
          win.setBounds(d.bounds)
        } catch (_) {}
        win.webContents.on('before-input-event', beforeInputListener)
        win.on('focus', onKioskFocus)
        // Kill the Windows shell so there's no taskbar, no Start menu,
        // and Alt+Tab has nothing useful to switch to. Restored on
        // applyKiosk(false) / will-quit / crash.
        killExplorer()
        // Emergency exit chord — registered only while kiosk is ON so we
        // don't permanently steal it. Registration failure is logged
        // but non-fatal (the admin toggle still works).
        try {
          globalShortcut.register('Control+Shift+Alt+K', () => {
            try { applyKiosk(false) } catch (_) {}
            try { win.webContents.send('kiosk:emergency-triggered') } catch (_) {}
          })
        } catch (e) { console.error('[kiosk] failed to register emergency chord:', e.message) }
      } else {
        // Tear down in reverse order: drop kiosk + fullscreen FIRST so
        // the window returns to a normal frameless-maximized state with
        // the taskbar visible again.
        try { win.setKiosk(false) } catch (_) {}
        try { if (win.isFullScreen()) win.setFullScreen(false) } catch (_) {}
        win.setAlwaysOnTop(false)
        win.setSkipTaskbar(false)
        try { win.webContents.removeListener('before-input-event', beforeInputListener) } catch (_) {}
        try { win.removeListener('focus', onKioskFocus) } catch (_) {}
        // Release the emergency chord (and any stray registrations).
        try { globalShortcut.unregisterAll() } catch (_) {}
        // Bring the Windows shell back so the user has a taskbar +
        // Start menu again outside of kiosk.
        restoreExplorer()
        // Restore the normal frameless-maximized state. setKiosk(false)
        // can leave the window in an in-between size on some Windows
        // builds, so explicitly maximize.
        try { if (!win.isMaximized()) win.maximize() } catch (_) {}
      }
    } catch (e) {
      console.error('[kiosk] applyKiosk failed:', e.message)
    }
  }

  // (Boot-time kiosk apply now happens inside the primary ready-to-show
  // handler above so it runs before win.show() — no frame flash.)

  ipcMain.handle('kiosk:set', (_e, enabled) => {
    applyKiosk(!!enabled)
    return { success: true, enabled: kioskState.enabled }
  })
  ipcMain.handle('kiosk:get-status', () => ({ enabled: kioskState.enabled }))
  ipcMain.handle('kiosk:emergency-exit', () => {
    applyKiosk(false)
    return { success: true }
  })

  // Clean app restart — used by the kiosk-enable flow so the new window
  // boots directly into kiosk fullscreen with a fresh window state.
  ipcMain.handle('app:restart', () => {
    try {
      // Tear kiosk down first so the relaunched process re-applies it
      // fresh (and globalShortcut releases cleanly via will-quit).
      if (kioskState.enabled) applyKiosk(false)
      app.relaunch()
      app.exit(0)
    } catch (e) {
      console.error('[app:restart] failed:', e.message)
    }
    return { success: true }
  })

  ipcMain.handle('launch-game', async (event, filePath) => {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File not found' }
      }
      // Kiosk grace window — when a game launches while kiosk is on we
      // must NOT yank focus back from the game (kept as a safety net
      // even though kiosk now auto-closes the launcher on launch).
      kioskState.suppressRefocusUntil = Date.now() + 8000
      const ext = path.extname(filePath).toLowerCase()
      if (ext === '.bat' || ext === '.cmd') {
        const dir = path.dirname(filePath)
        spawn('cmd.exe', ['/c', `"${filePath}"`], { detached: true, stdio: 'ignore', cwd: dir, shell: false, windowsVerbatimArguments: true }).unref()
      } else if (ext === '.exe') {
        const dir = path.dirname(filePath)
        spawn(filePath, [], { detached: true, stdio: 'ignore', cwd: dir }).unref()
      } else {
        const { shell } = require('electron')
        const err = await shell.openPath(filePath)
        if (err) return { success: false, error: err }
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('select-file', async (event, filters) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: filters || [{ name: 'All Files', extensions: ['*'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('open-external', async (event, url) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { success: false, error: 'Only HTTP/HTTPS URLs are allowed' }
      }
      await shell.openExternal(url)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('select-image', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'] }]
    })
    if (result.canceled) return null
    const srcPath = result.filePaths[0]
    try {
      const assetsDir = path.join(appRoot, ASSETS_DIR)
      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true })
      }
      const ext = path.extname(srcPath)
      const baseName = path.basename(srcPath, ext)
      const uniqueName = `${baseName}_${Date.now()}${ext}`
      const destPath = path.join(assetsDir, uniqueName)
      fs.copyFileSync(srcPath, destPath)
      const normalizedPath = destPath.replace(/\\/g, '/')
      return normalizedPath
    } catch (e) {
      return srcPath
    }
  })

  let igdbTokenCache = { token: null, expiry: 0, clientId: null }

  function igdbHttpsRequest(options, body) {
    const https = require('https')
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
      if (body) req.write(body)
      req.end()
    })
  }

  async function getIgdbToken(clientId, clientSecret) {
    if (igdbTokenCache.token && Date.now() < igdbTokenCache.expiry && igdbTokenCache.clientId === clientId) {
      return igdbTokenCache.token
    }
    const https = require('https')
    const url = new URL(`https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`)
    const data = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST', timeout: 10000 }, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Token request timeout')) })
      req.end()
    })
    if (data.access_token) {
      igdbTokenCache = { token: data.access_token, expiry: Date.now() + (data.expires_in - 60) * 1000, clientId }
      return data.access_token
    }
    throw new Error(data.message || 'Failed to get IGDB access token')
  }

  function igdbApiCall(endpoint, body, token, clientId) {
    return igdbHttpsRequest({
      hostname: 'api.igdb.com',
      path: `/v4/${endpoint}`,
      method: 'POST',
      headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
      timeout: 10000,
    }, body)
  }

  ipcMain.handle('igdb-search', async (event, query, clientId, clientSecret) => {
    try {
      if (!clientId || !clientSecret) return { success: false, error: 'IGDB credentials not configured' }
      const token = await getIgdbToken(clientId, clientSecret)
      const games = await igdbApiCall('games', `search "${query}"; fields name,cover,genres,keywords,summary,category,game_modes,themes,url; limit 10;`, token, clientId)

      const coverIds = games.map(g => g.cover).filter(Boolean)
      let covers = {}
      if (coverIds.length > 0) {
        const coverData = await igdbApiCall('covers', `fields game,image_id,url; where id = (${coverIds.join(',')}); limit 50;`, token, clientId)
        coverData.forEach(c => { covers[c.game] = c })
      }

      const genreIds = [...new Set(games.flatMap(g => g.genres || []))]
      let genres = {}
      if (genreIds.length > 0) {
        const genreData = await igdbApiCall('genres', `fields name; where id = (${genreIds.join(',')}); limit 50;`, token, clientId)
        genreData.forEach(g => { genres[g.id] = g.name })
      }

      const keywordIds = [...new Set(games.flatMap(g => g.keywords || []))]
      let keywords = {}
      if (keywordIds.length > 0) {
        const keywordData = await igdbApiCall('keywords', `fields name; where id = (${keywordIds.join(',')}); limit 100;`, token, clientId)
        keywordData.forEach(k => { keywords[k.id] = k.name })
      }

      const gameModeIds = [...new Set(games.flatMap(g => g.game_modes || []))]
      let gameModes = {}
      if (gameModeIds.length > 0) {
        const gmData = await igdbApiCall('game_modes', `fields name; where id = (${gameModeIds.join(',')}); limit 50;`, token, clientId)
        gmData.forEach(gm => { gameModes[gm.id] = gm.name })
      }

      const results = games.map(g => {
        const cover = covers[g.id]
        const coverUrl = cover ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${cover.image_id}.jpg` : null
        const headerUrl = cover ? `https://images.igdb.com/igdb/image/upload/t_screenshot_big/${cover.image_id}.jpg` : null
        const gameGenres = (g.genres || []).map(id => genres[id]).filter(Boolean)
        const gameKeywords = (g.keywords || []).map(id => keywords[id]).filter(Boolean)
        const gameGameModes = (g.game_modes || []).map(id => gameModes[id]).filter(Boolean)
        const isOnline = gameGameModes.some(m =>
          m.toLowerCase().includes('multiplayer') ||
          m.toLowerCase().includes('multi-player') ||
          m.toLowerCase().includes('online') ||
          m.toLowerCase().includes('co-op') ||
          m.toLowerCase().includes('mmo') ||
          m.toLowerCase().includes('battle royale')
        )
        return {
          id: g.id, name: g.name, icon: coverUrl, header: headerUrl,
          summary: g.summary || '', genres: gameGenres,
          keywords: gameKeywords.slice(0, 10), category: isOnline ? 'online' : 'offline', url: g.url,
        }
      })
      return { success: true, results }
    } catch (err) {
      return { success: false, error: err.message, results: [] }
    }
  })

  ipcMain.handle('download-image', async (event, url, filename) => {
    try {
      const https = require('https')
      const http = require('http')
      const assetsDir = path.join(appRoot, ASSETS_DIR)
      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true })
      }
      const destPath = path.join(assetsDir, filename)
      const mod = url.startsWith('https') ? https : http
      await new Promise((resolve, reject) => {
        mod.get(url, { timeout: 15000 }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            mod.get(res.headers.location, { timeout: 15000 }, (res2) => {
              const ws = fs.createWriteStream(destPath)
              res2.pipe(ws)
              ws.on('finish', resolve)
              ws.on('error', reject)
            }).on('error', reject)
            return
          }
          const ws = fs.createWriteStream(destPath)
          res.pipe(ws)
          ws.on('finish', resolve)
          ws.on('error', reject)
        }).on('error', reject)
      })
      return { success: true, path: destPath.replace(/\\/g, '/') }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('discover-server', async (event, timeoutMs) => {
    try {
      const { discoverServer } = require('./discovery')
      const { BRAND_SLUG } = require('./brand')
      const result = await discoverServer(BRAND_SLUG, timeoutMs || 8000)
      if (result) {
        return { success: true, ...result }
      }
      return { success: false, error: 'No server found on this network' }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-local-ip', () => {
    try {
      const interfaces = os.networkInterfaces()
      const ips = []
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            ips.push(iface.address)
          }
        }
      }
      return { success: true, ips, hostname: os.hostname() }
    } catch (err) {
      return { success: false, error: err.message, ips: [], hostname: '' }
    }
  })

  ipcMain.handle('delete-asset', async (event, filePath) => {
    try {
      const assetsDir = path.resolve(path.join(appRoot, ASSETS_DIR))
      const resolved = path.resolve(filePath.replace(/\\/g, '/'))
      if (!resolved.startsWith(assetsDir)) {
        return { success: false, error: 'Only files in ' + ASSETS_DIR + ' can be deleted' }
      }
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved)
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  function expandEnvVars(p) {
    if (!p) return p
    return p.replace(/%([^%]+)%/g, (_, varName) => {
      return process.env[varName] || process.env[varName.toUpperCase()] || `%${varName}%`
    })
  }

  function collectFiles(dir, baseDir, fileList) {
    if (!fileList) fileList = []
    const items = fs.readdirSync(dir)
    for (const item of items) {
      const fullPath = path.join(dir, item)
      const relativePath = path.relative(baseDir, fullPath)
      try {
        const stat = fs.statSync(fullPath)
        if (stat.isDirectory()) {
          collectFiles(fullPath, baseDir, fileList)
        } else {
          fileList.push({ fullPath, relativePath, size: stat.size })
        }
      } catch (e) {}
    }
    return fileList
  }

  function buildZipBuffer(files) {
    const zlib = require('zlib')
    const localHeaders = []
    const centralHeaders = []
    let offset = 0

    for (const file of files) {
      const content = fs.readFileSync(file.fullPath)
      const compressed = zlib.deflateRawSync(content)
      const nameBuffer = Buffer.from(file.relativePath.replace(/\\/g, '/'), 'utf8')

      let crc = crc32(content)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0, 6)
      local.writeUInt16LE(8, 8)
      local.writeUInt16LE(0, 10)
      local.writeUInt16LE(0, 12)
      local.writeUInt32LE(crc >>> 0, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(content.length, 22)
      local.writeUInt16LE(nameBuffer.length, 26)
      local.writeUInt16LE(0, 28)

      localHeaders.push(Buffer.concat([local, nameBuffer, compressed]))

      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(20, 4)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(0, 8)
      central.writeUInt16LE(8, 10)
      central.writeUInt16LE(0, 12)
      central.writeUInt16LE(0, 14)
      central.writeUInt32LE(crc >>> 0, 16)
      central.writeUInt32LE(compressed.length, 20)
      central.writeUInt32LE(content.length, 24)
      central.writeUInt16LE(nameBuffer.length, 28)
      central.writeUInt16LE(0, 30)
      central.writeUInt16LE(0, 32)
      central.writeUInt16LE(0, 34)
      central.writeUInt16LE(0, 36)
      central.writeUInt32LE(0, 38)
      central.writeUInt32LE(offset, 42)

      centralHeaders.push(Buffer.concat([central, nameBuffer]))
      offset += 30 + nameBuffer.length + compressed.length
    }

    const centralDirOffset = offset
    const centralDir = Buffer.concat(centralHeaders)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(files.length, 8)
    eocd.writeUInt16LE(files.length, 10)
    eocd.writeUInt32LE(centralDir.length, 12)
    eocd.writeUInt32LE(centralDirOffset, 16)
    eocd.writeUInt16LE(0, 20)

    return Buffer.concat([...localHeaders, centralDir, eocd])
  }

  function crc32(buf) {
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i]
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
      }
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  function extractZip(zipBuffer, destDir) {
    const zlib = require('zlib')
    let pos = 0

    while (pos + 4 <= zipBuffer.length) {
      const sig = zipBuffer.readUInt32LE(pos)
      if (sig !== 0x04034b50) break

      const method = zipBuffer.readUInt16LE(pos + 8)
      const compSize = zipBuffer.readUInt32LE(pos + 18)
      const uncompSize = zipBuffer.readUInt32LE(pos + 22)
      const nameLen = zipBuffer.readUInt16LE(pos + 26)
      const extraLen = zipBuffer.readUInt16LE(pos + 28)

      const nameRaw = zipBuffer.slice(pos + 30, pos + 30 + nameLen).toString('utf8')
      const entryName = nameRaw.replace(/\//g, path.sep)
      const dataStart = pos + 30 + nameLen + extraLen
      const compData = zipBuffer.slice(dataStart, dataStart + compSize)

      pos = dataStart + compSize

      const targetPath = path.resolve(destDir, entryName)
      const normalizedDest = path.resolve(destDir) + path.sep
      if (!targetPath.startsWith(normalizedDest) && targetPath !== path.resolve(destDir)) continue

      if (entryName.endsWith('/') || entryName.endsWith('\\')) {
        fs.mkdirSync(targetPath, { recursive: true })
        continue
      }

      const parentDir = path.dirname(targetPath)
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true })

      let content
      if (method === 0) {
        content = compData
      } else if (method === 8) {
        content = zlib.inflateRawSync(compData)
      } else {
        continue
      }

      fs.writeFileSync(targetPath, content)
    }
  }

  ipcMain.handle('zip-and-upload-save', async (event, savePath, gameName, serverUrl, token) => {
    try {
      const expandedPath = expandEnvVars(savePath)
      const resolvedPath = path.resolve(expandedPath)

      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: 'Save path does not exist: ' + expandedPath }
      }

      let zipBuffer
      const stat = fs.statSync(resolvedPath)
      if (stat.isDirectory()) {
        const files = collectFiles(resolvedPath, resolvedPath)
        if (files.length === 0) {
          return { success: false, error: 'Save folder is empty: ' + expandedPath }
        }
        const totalSize = files.reduce((sum, f) => sum + f.size, 0)
        if (totalSize > 200 * 1024 * 1024) {
          return { success: false, error: 'Save folder too large (' + Math.round(totalSize / 1024 / 1024) + ' MB). Max 200 MB.' }
        }
        zipBuffer = buildZipBuffer(files)
      } else {
        const content = fs.readFileSync(resolvedPath)
        const fileName = path.basename(resolvedPath)
        const zlib = require('zlib')
        const compressed = zlib.deflateRawSync(content)
        const crc = crc32(content)
        const nameBuffer = Buffer.from(fileName, 'utf8')

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(8, 8)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(compressed.length, 18)
        local.writeUInt32LE(content.length, 22)
        local.writeUInt16LE(nameBuffer.length, 26)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(8, 10)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(compressed.length, 20)
        central.writeUInt32LE(content.length, 24)
        central.writeUInt16LE(nameBuffer.length, 28)

        const eocd = Buffer.alloc(22)
        eocd.writeUInt32LE(0x06054b50, 0)
        eocd.writeUInt16LE(1, 8)
        eocd.writeUInt16LE(1, 10)
        const centralLen = 46 + nameBuffer.length
        const centralOff = 30 + nameBuffer.length + compressed.length
        eocd.writeUInt32LE(centralLen, 12)
        eocd.writeUInt32LE(centralOff, 16)

        zipBuffer = Buffer.concat([local, nameBuffer, compressed, central, nameBuffer, eocd])
      }

      const http = require('http')
      const https = require('https')
      const urlModule = require('url')

      const boundary = '----Example-CafeBoundary' + Date.now()
      const sanitizedGameName = (gameName || '').trim().slice(0, 200)

      const preamble = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="gameName"\r\n\r\n${sanitizedGameName}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="saveName"\r\n\r\ndefault\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="save.zip"\r\nContent-Type: application/zip\r\n\r\n`
      )
      const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`)
      const body = Buffer.concat([preamble, zipBuffer, epilogue])

      const parsed = urlModule.parse(serverUrl + '/api/saves')
      const mod = parsed.protocol === 'https:' ? https : http

      const result = await new Promise((resolve, reject) => {
        const req = mod.request({
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.path,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
            'Authorization': `Bearer ${token}`
          },
          timeout: 120000
        }, (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => {
            try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid response from server')) }
          })
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('Upload timeout')) })
        req.write(body)
        req.end()
      })

      if (result.success) {
        return { success: true }
      }
      return { success: false, error: result.error || 'Upload failed' }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-and-extract-save', async (event, saveId, savePath, serverUrl, token) => {
    try {
      const http = require('http')
      const https = require('https')
      const urlModule = require('url')

      const sanitizedId = String(saveId).replace(/[^0-9]/g, '')
      if (!sanitizedId) return { success: false, error: 'Invalid save ID' }

      const parsed = urlModule.parse(`${serverUrl}/api/saves/${sanitizedId}/download`)
      const mod = parsed.protocol === 'https:' ? https : http

      const zipBuffer = await new Promise((resolve, reject) => {
        const req = mod.request({
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.path,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 120000
        }, (res) => {
          if (res.statusCode !== 200) {
            let body = ''
            res.on('data', chunk => body += chunk)
            res.on('end', () => {
              try {
                const err = JSON.parse(body)
                reject(new Error(err.error || 'Download failed'))
              } catch {
                reject(new Error('Download failed: ' + res.statusCode))
              }
            })
            return
          }
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => resolve(Buffer.concat(chunks)))
          res.on('error', reject)
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')) })
        req.end()
      })

      const expandedPath = expandEnvVars(savePath)
      const resolvedSavePath = path.resolve(expandedPath)
      if (!fs.existsSync(resolvedSavePath)) {
        fs.mkdirSync(resolvedSavePath, { recursive: true })
      }

      extractZip(zipBuffer, resolvedSavePath)

      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('load-settings', () => {
    try {
      const sp = getSettingsPath()
      if (fs.existsSync(sp)) {
        cachedSettings = JSON.parse(fs.readFileSync(sp, 'utf-8'))
      }
    } catch (e) {}
    return cachedSettings
  })

  ipcMain.handle('save-settings', (event, data) => {
    try {
      const settingsPath = getSettingsPath()
      const tmpPath = settingsPath + '.tmp'
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
      fs.renameSync(tmpPath, settingsPath)
      cachedSettings = data
      return { success: true }
    } catch (err) {
      console.error('Failed to save settings:', err.message)
      return { success: false, error: err.message }
    }
  })
}

app.whenReady().then(() => {
  const splash = createSplashWindow()
  createWindow(splash)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const s = createSplashWindow()
      createWindow(s)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Always release any kiosk-time globalShortcut registration on quit so
// Ctrl+Shift+Alt+K doesn't linger after the launcher exits.
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll() } catch (_) {}
  // CRITICAL: if kiosk killed explorer.exe, we MUST respawn it on every
  // exit path. Without this the cafe's machine boots into a black
  // wallpaper with no shell after the launcher closes.
  try { restoreExplorer() } catch (_) {}
})

// Belt-and-suspenders: an uncaughtException can skip will-quit on some
// Electron exit paths. Force-restore the shell then log.
process.on('uncaughtException', (err) => {
  try { restoreExplorer() } catch (_) {}
  console.error('[uncaughtException]', err)
})
process.on('exit', () => {
  try { restoreExplorer() } catch (_) {}
})
