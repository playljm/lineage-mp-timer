import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-contract'
import type { OverlayApi, Rect } from '../shared/ipc-contract'

/** Params are passed from main via process.argv (additionalArguments: --params=<base64 json>). */
function readParams(): OverlayApi['getParams'] extends () => infer R ? R : never {
  const arg = process.argv.find((a) => a.startsWith('--params='))
  const fallback = {
    sourceId: '',
    expectedWidth: 0,
    expectedHeight: 0,
    displayX: 0,
    displayY: 0,
    scaleFactor: 1,
    sources: [] as { id: string; label: string }[]
  }
  if (!arg) return fallback
  try {
    const json = Buffer.from(arg.slice('--params='.length), 'base64').toString('utf8')
    return { ...fallback, ...JSON.parse(json) }
  } catch {
    return fallback
  }
}

const overlayApi: OverlayApi = {
  confirm: (region: Rect) => ipcRenderer.send(IPC.overlayRegionSelected, region),
  cancel: () => ipcRenderer.send(IPC.overlayCancel),
  getParams: readParams
}

contextBridge.exposeInMainWorld('overlayApi', overlayApi)
