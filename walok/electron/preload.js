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
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  igdbSearch: (query, clientId, clientSecret) => ipcRenderer.invoke('igdb-search', query, clientId, clientSecret),
  downloadImage: (url, filename) => ipcRenderer.invoke('download-image', url, filename),
  deleteAsset: (filePath) => ipcRenderer.invoke('delete-asset', filePath),
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),
  discoverServer: (timeoutMs) => ipcRenderer.invoke('discover-server', timeoutMs),
  zipAndUploadSave: (savePath, gameName, serverUrl, token) => ipcRenderer.invoke('zip-and-upload-save', savePath, gameName, serverUrl, token),
  downloadAndExtractSave: (saveId, savePath, serverUrl, token) => ipcRenderer.invoke('download-and-extract-save', saveId, savePath, serverUrl, token),

  ota: {
    getStatus: () => ipcRenderer.invoke('ota:get-status'),
    checkNow: () => ipcRenderer.invoke('ota:check-now'),
    restart: () => ipcRenderer.invoke('ota:restart'),
    on: (event, handler) => {
      const valid = ['ota:update-available', 'ota:download-start', 'ota:download-progress', 'ota:verifying', 'ota:applying', 'ota:ready-to-restart', 'ota:error']
      if (!valid.includes(event)) return () => {}
      const listener = (_e, data) => handler(data)
      ipcRenderer.on(event, listener)
      return () => ipcRenderer.removeListener(event, listener)
    }
  }
})
