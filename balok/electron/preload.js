const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  toggleMaximize: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),

  launchGame: (exePath) => ipcRenderer.invoke('launch-game', exePath),
  testTelegramAlert: () => ipcRenderer.invoke('test-telegram-alert'),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectImage: () => ipcRenderer.invoke('select-image'),
  downloadImage: (url, filename) => ipcRenderer.invoke('download-image', url, filename),
  openExternal: (url, browserExePath) => ipcRenderer.invoke('open-external', url, browserExePath),

  loadSettings: () => ipcRenderer.invoke('load-settings'),

  // Backup & restore — brand-named .zip with settings.json + assets/.
  backupExport: () => ipcRenderer.invoke('backup:export'),
  backupImport: () => ipcRenderer.invoke('backup:import'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),

  // Real OS master volume control for the pinned volume slider.
  sysVolume: {
    get: () => ipcRenderer.invoke('sysvol:get'),
    set: (percent) => ipcRenderer.invoke('sysvol:set', percent),
    setMute: (muted) => ipcRenderer.invoke('sysvol:mute', muted),
  },

  getLocalIPs: () => ipcRenderer.invoke('get-local-ip'),
  appVersion: () => ipcRenderer.invoke('get-app-version'),
  // LAN auto-discovery of the Save & Load server (UDP beacon).
  discoverServer: (timeoutMs) => ipcRenderer.invoke('discover-server', timeoutMs),
  igdbSearch: (query, clientId, clientSecret) => ipcRenderer.invoke('igdb-search', query, clientId, clientSecret),

  // Real hardware stats for the "My Rig" sidebar widget.
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),

  // OTA update hooks — wired to main.js for live update detection and install.
  onUpdateAvailable: (cb) => {
    const handler = (_e, info) => cb(info)
    ipcRenderer.on('update-available', handler)
    return () => ipcRenderer.removeListener('update-available', handler)
  },
  // Progress events come as IPC messages (callbacks can't cross the IPC bridge).
  onUpdateProgress: (cb) => {
    const handler = (_e, pct) => cb(pct)
    ipcRenderer.on('update-download-progress', handler)
    return () => ipcRenderer.removeListener('update-download-progress', handler)
  },
  restartApp: () => ipcRenderer.send('restart-app'),

  // Walok-parity OTA bridge. The updater broadcasts these events; the modal
  // drives proceed / dismiss / restart.
  ota: {
    getStatus: () => ipcRenderer.invoke('ota:get-status'),
    checkNow: () => ipcRenderer.invoke('ota:check-now'),
    restart: () => ipcRenderer.invoke('ota:restart'),
    proceed: () => ipcRenderer.invoke('ota:proceed'),
    dismiss: () => ipcRenderer.invoke('ota:dismiss'),
    on: (event, handler) => {
      const valid = ['ota:update-available', 'ota:download-start', 'ota:download-progress', 'ota:verifying', 'ota:applying', 'ota:ready-to-restart', 'ota:error']
      if (!valid.includes(event)) return () => {}
      const listener = (_e, data) => handler(data)
      ipcRenderer.on(event, listener)
      return () => ipcRenderer.removeListener(event, listener)
    },
  },
  appRestart: () => ipcRenderer.invoke('app:restart'),

  // Branding baked into the customer build (brand name, subtitle, logo).
  getOtaConfig: () => ipcRenderer.invoke('get-ota-config'),

  // Kiosk mode — applied live by the main process; enable flow restarts
  // the app so the window is constructed already-fullscreen.
  setKiosk: (enabled) => ipcRenderer.invoke('kiosk:set', enabled),
  getKioskStatus: () => ipcRenderer.invoke('kiosk:get-status'),
  kioskEmergencyExit: () => ipcRenderer.invoke('kiosk:emergency-exit'),
  onKioskEmergency: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('kiosk:emergency-triggered', handler)
    return () => ipcRenderer.removeListener('kiosk:emergency-triggered', handler)
  },

  // Cloud save sync — zips the game's save folder, uploads it to the LAN
  // save server, and restores it back on load.
  zipAndUploadSave: (savePath, gameName, serverUrl, token) => ipcRenderer.invoke('zip-and-upload-save', savePath, gameName, serverUrl, token),
  downloadAndExtractSave: (saveId, savePath, serverUrl, token) => ipcRenderer.invoke('download-and-extract-save', saveId, savePath, serverUrl, token),

})
