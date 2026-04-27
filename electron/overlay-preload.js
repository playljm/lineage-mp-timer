const { contextBridge, ipcRenderer } = require('electron');

// main process가 --loupe-source-id=... 로 전달한 sourceId 추출
const arg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith('--loupe-source-id='));
const loupeSourceId = arg ? arg.split('=').slice(1).join('=') : '';

contextBridge.exposeInMainWorld('overlayApi', {
  confirm: (region) => ipcRenderer.send('overlay:region-selected', region),
  cancel: () => ipcRenderer.send('overlay:cancelled'),
  getLoupeSourceId: () => loupeSourceId
});
