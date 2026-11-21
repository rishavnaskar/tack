const { contextBridge } = require('electron');

// Lets the web UI make room for the macOS traffic lights over its hidden inset title bar.
contextBridge.exposeInMainWorld('tackDesktop', {
  platform: process.platform,
  titleBar: process.platform === 'darwin' ? 'hiddenInset' : 'default',
});
