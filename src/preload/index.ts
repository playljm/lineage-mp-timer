import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-contract'
import type { IpcApi, IpcEventMap } from '../shared/ipc-contract'

/**
 * Single typed bridge. The renderer never touches ipcRenderer directly — it only
 * sees `window.api` shaped exactly like `IpcApi`.
 */
const api: IpcApi = {
  listDisplays: () => ipcRenderer.invoke(IPC.listDisplays),
  startRegionSelect: (displayId) => ipcRenderer.invoke(IPC.startRegionSelect, displayId),
  getResourcePaths: () => ipcRenderer.invoke(IPC.getResourcePaths),

  setAlwaysOnTop: (on) => ipcRenderer.invoke(IPC.setAlwaysOnTop, on),
  minimizeWindow: () => ipcRenderer.invoke(IPC.minimizeWindow),
  hideWindow: () => ipcRenderer.invoke(IPC.hideWindow),
  closeWindow: () => ipcRenderer.invoke(IPC.closeWindow),
  toggleDevtools: () => ipcRenderer.invoke(IPC.toggleDevtools),
  setCompact: (on) => ipcRenderer.invoke(IPC.setCompact, on),

  notifyComplete: (payload) => ipcRenderer.invoke(IPC.notifyComplete, payload),
  setGlobalHotkeys: (map) => ipcRenderer.invoke(IPC.setGlobalHotkeys, map),

  saveTrainingSample: (sample) => ipcRenderer.invoke(IPC.saveTrainingSample, sample),
  savePendingSample: (sample) => ipcRenderer.invoke(IPC.savePendingSample, sample),
  listPendingSamples: (opts) => ipcRenderer.invoke(IPC.listPendingSamples, opts),

  cloudLoginPopup: (opts) => ipcRenderer.invoke(IPC.cloudLoginPopup, opts),
  cloudWriteTraineddata: (bytes) => ipcRenderer.invoke(IPC.cloudWriteTraineddata, bytes),
  cloudRollbackTraineddata: () => ipcRenderer.invoke(IPC.cloudRollbackTraineddata),

  saveDiagnosticReport: (json) => ipcRenderer.invoke(IPC.saveDiagnosticReport, json),

  on: <K extends keyof IpcEventMap>(event: K, listener: IpcEventMap[K]): (() => void) => {
    const channel = `evt:${String(event)}`
    const wrapped = (_e: unknown, ...args: unknown[]): void => {
      ;(listener as (...a: unknown[]) => void)(...args)
    }
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.off(channel, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
