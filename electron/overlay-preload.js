const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  confirm: (region) => ipcRenderer.send('overlay:region-selected', region),
  cancel: () => ipcRenderer.send('overlay:cancelled')
});
