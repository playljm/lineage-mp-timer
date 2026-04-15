const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  setAlwaysOnTop: (value) => ipcRenderer.invoke('app:set-always-on-top', value),
  getAlwaysOnTop: () => ipcRenderer.invoke('app:get-always-on-top'),
  minimizeToTray: () => ipcRenderer.invoke('app:minimize-to-tray'),
  setMinimizeOnClose: (value) => ipcRenderer.invoke('app:set-minimize-on-close', value),
  notifyComplete: (payload) => ipcRenderer.invoke('app:show-notification', payload || {}),
  quit: () => ipcRenderer.invoke('app:quit'),
  onAlwaysOnTopChanged: (cb) => {
    ipcRenderer.on('always-on-top-changed', (_, value) => {
      try { cb(value); } catch (_) { /* ignore */ }
    });
  }
});
