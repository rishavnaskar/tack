const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tack', {
  status: () => ipcRenderer.invoke('key:status'),
  save: (key) => ipcRenderer.invoke('key:save', key),
  close: () => ipcRenderer.send('key:close'),
});
