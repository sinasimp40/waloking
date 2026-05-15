const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('minimize-window'),
  maximize: () => ipcRenderer.send('maximize-window'),
  close: () => ipcRenderer.send('close-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  fullscreen: () => ipcRenderer.send('fullscreen-window'),
  launchGame: (exePath) => ipcRenderer.invoke('launch-game', exePath),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectImage: () => ipcRenderer.invoke('select-image'),
  openExternal: (url, browserExePath) => ipcRenderer.invoke('open-external', url, browserExePath),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  igdbSearch: (query, clientId, clientSecret) => ipcRenderer.invoke('igdb-search', query, clientId, clientSecret),
  downloadImage: (url, filename) => ipcRenderer.invoke('download-image', url, filename),
  deleteAsset: (filePath) => ipcRenderer.invoke('delete-asset', filePath),
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),
  discoverServer: (timeoutMs) => ipcRenderer.invoke('discover-server', timeoutMs),
  zipAndUploadSave: (savePath, gameName, serverUrl, token) => ipcRenderer.invoke('zip-and-upload-save', savePath, gameName, serverUrl, token),
  downloadAndExtractSave: (saveId, savePath, serverUrl, token) => ipcRenderer.invoke('download-and-extract-save', saveId, savePath, serverUrl, token),

  // Kiosk mode controls. The renderer flips kioskMode in the persisted
  // settings store and then calls kiosk.set() so the main process can
  // mirror the live BrowserWindow state. emergencyExit is wired to the
  // global Ctrl+Shift+Alt+K shortcut on the main side; this method exists
  // as a renderer-callable fallback (e.g. an admin "Exit kiosk" button).
  kiosk: {
    set: (enabled) => ipcRenderer.invoke('kiosk:set', !!enabled),
    getStatus: () => ipcRenderer.invoke('kiosk:get-status'),
    emergencyExit: () => ipcRenderer.invoke('kiosk:emergency-exit'),
  },
  // app.restart relaunches the Electron app cleanly. Used by the kiosk
  // toggle's enable path so the new window boots directly into
  // fullscreen with no taskbar artifacts.
  app: {
    restart: () => ipcRenderer.invoke('app:restart'),
  },

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
    }
  }
})
