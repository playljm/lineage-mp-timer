/**
 * Safe access to the preload-exposed `window.api`. In a plain browser (e.g. a
 * Vite preview without Electron) the bridge is absent, so calls degrade to
 * rejected promises rather than throwing on property access.
 */
import type { IpcApi } from '@shared/ipc-contract'

export const hasNativeApi: boolean = typeof window !== 'undefined' && !!window.api

const missing = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`Electron API unavailable: ${name}`))

const stub: IpcApi = {
  listDisplays: missing('listDisplays'),
  startRegionSelect: missing('startRegionSelect'),
  getResourcePaths: missing('getResourcePaths'),
  listWindows: missing('listWindows'),
  resolveWindowSource: missing('resolveWindowSource'),
  setAlwaysOnTop: missing('setAlwaysOnTop'),
  minimizeWindow: missing('minimizeWindow'),
  hideWindow: missing('hideWindow'),
  closeWindow: missing('closeWindow'),
  toggleDevtools: missing('toggleDevtools'),
  setCompact: missing('setCompact'),
  notifyComplete: missing('notifyComplete'),
  setGlobalHotkeys: missing('setGlobalHotkeys'),
  saveTrainingSample: missing('saveTrainingSample'),
  savePendingSample: missing('savePendingSample'),
  listPendingSamples: missing('listPendingSamples'),
  cloudLoginPopup: missing('cloudLoginPopup'),
  cloudWriteTraineddata: missing('cloudWriteTraineddata'),
  cloudRollbackTraineddata: missing('cloudRollbackTraineddata'),
  saveDiagnosticReport: missing('saveDiagnosticReport'),
  on: () => () => {}
}

export const api: IpcApi = hasNativeApi ? window.api : stub
