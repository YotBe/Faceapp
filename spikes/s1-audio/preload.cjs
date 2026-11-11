const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  env: () => ipcRenderer.invoke('env'),
  saveWav: (name, bytes) => ipcRenderer.invoke('save-wav', name, bytes),
});
