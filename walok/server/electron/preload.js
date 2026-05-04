const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('serverAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  startServer: () => ipcRenderer.invoke('start-server'),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getAdminStats: () => ipcRenderer.invoke('get-admin-stats'),
  getUserSaves: (userId) => ipcRenderer.invoke('get-user-saves', userId),
  deleteUser: (userId) => ipcRenderer.invoke('delete-user', userId),
  deleteSave: (saveId) => ipcRenderer.invoke('delete-save', saveId),
  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),

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
