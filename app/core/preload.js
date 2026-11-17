const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trimeet', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (id, withAudio) => ipcRenderer.invoke('select-source', id, withAudio),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  soundsLoad: () => ipcRenderer.invoke('sounds-load'),
  soundsSave: (list) => ipcRenderer.invoke('sounds-save', list),
  localIps: () => ipcRenderer.invoke('local-ips'),
  platform: process.platform,
  updateGet: () => ipcRenderer.invoke('update-get'),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdate: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  autotest: process.env.TRIMEET_AUTOTEST || null,
});
