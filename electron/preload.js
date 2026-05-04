const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  setAlwaysOnTop: (value) => ipcRenderer.invoke('app:set-always-on-top', value),
  getAlwaysOnTop: () => ipcRenderer.invoke('app:get-always-on-top'),
  minimizeToTray: () => ipcRenderer.invoke('app:minimize-to-tray'),
  setMinimizeOnClose: (value) => ipcRenderer.invoke('app:set-minimize-on-close', value),
  notifyComplete: (payload) => ipcRenderer.invoke('app:show-notification', payload || {}),
  setGlobalHotkeys: (map) => ipcRenderer.invoke('app:set-global-hotkeys', map),
  getGlobalHotkeys: () => ipcRenderer.invoke('app:get-global-hotkeys'),
  resetWindowSize: () => ipcRenderer.invoke('app:reset-window-size'),
  setCompactMode: (enabled) => ipcRenderer.invoke('app:set-compact-mode', !!enabled),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  listDisplays: () => ipcRenderer.invoke('app:list-displays'),
  startRegionSelect: (displayId) => ipcRenderer.invoke('app:start-region-select', displayId),
  openDevTools: () => ipcRenderer.invoke('app:open-devtools'),
  getResourcePaths: () => ipcRenderer.invoke('app:get-resource-paths'),
  saveTrainingSample: (payload) => ipcRenderer.invoke('app:save-training-sample', payload),
  getTrainingStats: () => ipcRenderer.invoke('app:get-training-stats'),
  openTrainingFolder: () => ipcRenderer.invoke('app:open-training-folder'),
  savePendingSample: (payload) => ipcRenderer.invoke('app:save-pending-sample', payload),
  listPendingSamples: (opts) => ipcRenderer.invoke('app:list-pending-samples', opts),
  confirmPendingSample: (payload) => ipcRenderer.invoke('app:confirm-pending-sample', payload),
  deletePendingSample: (payload) => ipcRenderer.invoke('app:delete-pending-sample', payload),
  clearAllPending: () => ipcRenderer.invoke('app:clear-all-pending'),
  saveDiagnosticReport: (payload) => ipcRenderer.invoke('app:save-diagnostic-report', payload),
  quit: () => ipcRenderer.invoke('app:quit'),
  onAlwaysOnTopChanged: (cb) => {
    ipcRenderer.on('always-on-top-changed', (_, value) => {
      try { cb(value); } catch (_) { /* ignore */ }
    });
  }
});
