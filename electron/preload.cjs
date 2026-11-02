const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('obsManager', {
  getDashboard: () => ipcRenderer.invoke('dashboard:get'),
  saveProfile: (input) => ipcRenderer.invoke('profile:save', input),
  deleteProfile: (id) => ipcRenderer.invoke('profile:delete', id),
  connect: (id) => ipcRenderer.invoke('obs:connect', id),
  start: (id, durationSeconds) => ipcRenderer.invoke('obs:start', id, durationSeconds),
  stop: (id) => ipcRenderer.invoke('obs:stop', id),
  setScene: (id, sceneName) => ipcRenderer.invoke('obs:set-scene', id, sceneName),
  chooseObsExecutable: () => ipcRenderer.invoke('dialog:obs-executable'),
  getUpdateState: () => ipcRenderer.invoke('updater:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdate: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('dashboard:update', listener)
    return () => ipcRenderer.removeListener('dashboard:update', listener)
  },
  onUpdaterUpdate: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('updater:update', listener)
    return () => ipcRenderer.removeListener('updater:update', listener)
  },
})
