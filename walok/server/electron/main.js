const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

let mainWindow = null

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

const { initDatabase } = require('./db')
const { createApi } = require('./api')
const {
  BRAND_SLUG,
  LEGACY_BRAND_SLUGS,
  BRAND_SUFFIXES,
  SERVER_CONFIG_FILE,
  SERVER_DISPLAY_NAME,
} = require('./brand')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

app.name = SERVER_DISPLAY_NAME
// NOTE: BRAND_SLUG / LEGACY_BRAND_SLUGS / BRAND_SUFFIXES /
// SERVER_CONFIG_FILE come from ./brand.js (single source of truth,
// also imported by ./db.js so the data dir + db filename can never
// drift from the config filename).

function getAppRoot() {
  if (isDev) return path.join(__dirname, '..')
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR
  return path.dirname(process.execPath)
}

const appRoot = getAppRoot()

// Rename leftover server folders/files from any previous brand to the
// current BRAND_SLUG. Skips current-slug self-rename and won't clobber
// an existing target — safe on every startup.
function migrateLegacyPaths() {
  for (const oldSlug of LEGACY_BRAND_SLUGS) {
    if (oldSlug === BRAND_SLUG) continue
    for (const sfx of BRAND_SUFFIXES) {
      const oldPath = path.join(appRoot, oldSlug + sfx)
      const newPath = path.join(appRoot, BRAND_SLUG + sfx)
      try {
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
          fs.renameSync(oldPath, newPath)
        }
      } catch (e) {}
    }
  }
}

migrateLegacyPaths()

try {
  otaUpdater.init({ appRoot, isDev, ipcMain })
} catch (e) {
  console.error('[OTA-Server] init failed:', e.message)
}

function getConfig() {
  const configPath = path.join(appRoot, SERVER_CONFIG_FILE)
  const defaults = { host: '0.0.0.0', port: 3456 }
  try {
    if (fs.existsSync(configPath)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) }
    }
  } catch (e) {}
  fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), 'utf-8')
  return defaults
}

function saveConfig(config) {
  const configPath = path.join(appRoot, SERVER_CONFIG_FILE)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

let serverInstance = null
let dbInitialized = false
let tray = null

async function startServer() {
  if (serverInstance) return { success: true, message: 'Server already running' }
  try {
    const config = getConfig()
    if (!dbInitialized) {
      await initDatabase(appRoot)
      dbInitialized = true
    }
    const apiApp = createApi(appRoot)
    serverInstance = apiApp.listen(config.port, config.host, () => {
      console.log(`${SERVER_DISPLAY_NAME} running on ${config.host}:${config.port}`)
    })
    return { success: true, message: `Server started on ${config.host}:${config.port}` }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function createTray() {
  const iconPath = path.join(__dirname, '../src/icon.ico')
  let trayIcon
  try {
    trayIcon = nativeImage.createFromPath(iconPath)
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty()
    }
  } catch (e) {
    trayIcon = nativeImage.createEmpty()
  }

  tray = new Tray(trayIcon)
  tray.setToolTip(SERVER_DISPLAY_NAME)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        if (serverInstance) {
          serverInstance.close()
          serverInstance = null
        }
        app.isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#050510',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, '../src/icon.ico'),
    autoHideMenuBar: true,
    title: SERVER_DISPLAY_NAME
  })

  mainWindow.loadFile(path.join(__dirname, '../src/dashboard.html'))

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  ipcMain.handle('get-config', () => getConfig())

  ipcMain.handle('save-config', (event, config) => {
    try {
      saveConfig(config)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-server-status', () => {
    return { running: !!serverInstance, config: getConfig() }
  })

  ipcMain.handle('start-server', async () => {
    return await startServer()
  })

  ipcMain.handle('stop-server', () => {
    if (!serverInstance) return { success: true, message: 'Server not running' }
    try {
      serverInstance.close()
      serverInstance = null
      return { success: true, message: 'Server stopped' }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-admin-stats', async () => {
    if (!serverInstance) return { success: false, error: 'Server not running' }
    try {
      const { getOne, getAll } = require('./db')
      const userCount = getOne('SELECT COUNT(*) as count FROM users')
      const saveCount = getOne('SELECT COUNT(*) as count FROM saves')
      const totalSize = getOne('SELECT COALESCE(SUM(archive_size), 0) as total FROM saves')
      const users = getAll('SELECT id, username, created_at, last_login_at FROM users ORDER BY created_at DESC')
      const saveCounts = getAll('SELECT user_id, COUNT(*) as count, SUM(archive_size) as total_size FROM saves GROUP BY user_id')
      const countMap = {}
      saveCounts.forEach(s => { countMap[s.user_id] = { count: s.count, totalSize: s.total_size } })

      const usersWithCounts = users.map(u => ({
        ...u,
        saveCount: countMap[u.id]?.count || 0,
        totalSize: countMap[u.id]?.totalSize || 0
      }))

      return {
        success: true,
        stats: { users: userCount.count, saves: saveCount.count, totalSize: totalSize.total },
        users: usersWithCounts
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-user-saves', (event, userId) => {
    if (!serverInstance) return { success: false, error: 'Server not running' }
    try {
      const { getAll } = require('./db')
      const saves = getAll('SELECT id, game_name, save_name, archive_size, created_at, updated_at FROM saves WHERE user_id = ? ORDER BY updated_at DESC', [userId])
      return { success: true, saves }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('delete-user', (event, userId) => {
    if (!serverInstance) return { success: false, error: 'Server not running' }
    try {
      const { getOne, getAll, runQuery, getSavesDir } = require('./db')
      const user = getOne('SELECT id, username FROM users WHERE id = ?', [userId])
      if (!user) return { success: false, error: 'User not found' }

      const userSaves = getAll('SELECT id, archive_filename FROM saves WHERE user_id = ?', [userId])
      const userDir = path.join(getSavesDir(appRoot), user.username.replace(/[^a-zA-Z0-9_\-. ]/g, '').trim())

      userSaves.forEach(save => {
        const filePath = path.join(userDir, save.archive_filename)
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath) } catch {}
        }
      })

      if (fs.existsSync(userDir)) {
        try { fs.rmSync(userDir, { recursive: true, force: true }) } catch {}
      }

      runQuery('DELETE FROM saves WHERE user_id = ?', [userId])
      runQuery('DELETE FROM users WHERE id = ?', [userId])

      return { success: true, message: `User "${user.username}" deleted` }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('delete-save', (event, saveId) => {
    if (!serverInstance) return { success: false, error: 'Server not running' }
    try {
      const { getOne, runQuery, getSavesDir } = require('./db')
      const save = getOne('SELECT * FROM saves WHERE id = ?', [saveId])
      if (!save) return { success: false, error: 'Save not found' }

      const saveUser = getOne('SELECT username FROM users WHERE id = ?', [save.user_id])
      const folderName = saveUser ? saveUser.username.replace(/[^a-zA-Z0-9_\-. ]/g, '').trim() : String(save.user_id)
      const filePath = path.join(getSavesDir(appRoot), folderName, save.archive_filename)
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath) } catch {}
      }

      runQuery('DELETE FROM saves WHERE id = ?', [saveId])
      return { success: true, message: 'Save deleted' }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

app.whenReady().then(async () => {
  createTray()
  createWindow()

  try {
    await startServer()
    console.log(`${SERVER_DISPLAY_NAME} auto-started`)
  } catch (err) {
    console.error('Auto-start failed:', err.message)
  }
})

app.on('window-all-closed', (e) => {
  e?.preventDefault?.()
})

app.on('before-quit', () => {
  app.isQuitting = true
  if (serverInstance) {
    serverInstance.close()
    serverInstance = null
  }
})
