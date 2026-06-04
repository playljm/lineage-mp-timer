/**
 * Typed IPC contract shared by main, preload and renderer.
 *
 * `IpcApi` is the request/response surface exposed on `window.api`.
 * `IpcEventMap` is the set of main -> renderer push events.
 *
 * Keeping this in one place lets the preload bridge, the main handlers and the
 * renderer facade all reference the same types, so a channel rename is a compile
 * error rather than a silent runtime mismatch.
 */

import type { RegionKind } from '../core/ocr/types'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: string
  label: string
  bounds: Rect
  scaleFactor: number
  sourceId: string
  thumbnailDataUrl?: string
}

export interface RegionSelectResult {
  region: Rect
  displayId: string
  displayBounds: Rect
  scaleFactor: number
  sourceId: string
}

export interface ResourcePaths {
  workerPath: string | null
  corePath: string | null
  langPath: string | null
}

export type HotkeyMap = Record<string, string>

export interface TrainingSample {
  region: RegionKind
  /** PNG data URL of the captured ROI. */
  dataUrl: string
  /** Ground-truth label (e.g. "121/235", "58.6840"). */
  label: string
  /** What OCR proposed, for accept/reject bookkeeping. */
  ocr?: string
  confidence?: number
}

export interface PendingSample {
  region: RegionKind
  file: string
  ocr?: string
  imageDataUrl?: string
}

export interface HotkeyRegisterResult {
  ok: boolean
  failures: string[]
}

export interface CloudLoginResult {
  token: string | null
  email: string | null
}

/** Request/response surface exposed on `window.api`. */
export interface IpcApi {
  // --- displays & capture ---
  listDisplays(): Promise<DisplayInfo[]>
  startRegionSelect(displayId?: string): Promise<RegionSelectResult | null>
  getResourcePaths(): Promise<ResourcePaths>

  // --- window controls ---
  setAlwaysOnTop(on: boolean): Promise<boolean>
  minimizeWindow(): Promise<void>
  hideWindow(): Promise<void>
  closeWindow(): Promise<void>
  toggleDevtools(): Promise<void>
  setCompact(on: boolean): Promise<void>

  // --- notifications & hotkeys ---
  notifyComplete(payload: { title: string; body: string }): Promise<void>
  setGlobalHotkeys(map: HotkeyMap): Promise<HotkeyRegisterResult>

  // --- training data ---
  saveTrainingSample(sample: TrainingSample): Promise<{ ok: boolean; path?: string }>
  savePendingSample(sample: TrainingSample): Promise<{ ok: boolean; path?: string }>
  listPendingSamples(opts?: {
    region?: RegionKind
    includeImage?: boolean
    limit?: number
  }): Promise<PendingSample[]>

  // --- cloud sync ---
  cloudLoginPopup(opts?: { loginUrl?: string }): Promise<CloudLoginResult>
  cloudWriteTraineddata(bytes: ArrayBuffer): Promise<{ ok: boolean; error?: string }>
  cloudRollbackTraineddata(): Promise<{ ok: boolean }>

  // --- diagnostics ---
  saveDiagnosticReport(json: string): Promise<{ ok: boolean; path?: string }>

  // --- events (renderer subscribes) ---
  on<K extends keyof IpcEventMap>(event: K, listener: IpcEventMap[K]): () => void
}

/** Main -> renderer push events. */
export interface IpcEventMap {
  'always-on-top-changed': (on: boolean) => void
  hotkey: (action: string) => void
}

/** Overlay (region picker) bridge exposed on `window.overlayApi`. */
export interface OverlayApi {
  confirm(region: Rect): void
  cancel(): void
  getParams(): {
    sourceId: string
    expectedWidth: number
    expectedHeight: number
    displayX: number
    displayY: number
    scaleFactor: number
    sources: { id: string; label: string }[]
  }
}

/** Canonical channel names (single source of truth). */
export const IPC = {
  listDisplays: 'app:list-displays',
  startRegionSelect: 'app:start-region-select',
  getResourcePaths: 'app:get-resource-paths',
  setAlwaysOnTop: 'win:set-always-on-top',
  minimizeWindow: 'win:minimize',
  hideWindow: 'win:hide',
  closeWindow: 'win:close',
  toggleDevtools: 'win:toggle-devtools',
  setCompact: 'win:set-compact',
  notifyComplete: 'app:notify-complete',
  setGlobalHotkeys: 'app:set-global-hotkeys',
  saveTrainingSample: 'train:save-sample',
  savePendingSample: 'train:save-pending',
  listPendingSamples: 'train:list-pending',
  cloudLoginPopup: 'cloud:login-popup',
  cloudWriteTraineddata: 'cloud:write-traineddata',
  cloudRollbackTraineddata: 'cloud:rollback-traineddata',
  saveDiagnosticReport: 'app:save-diagnostic',
  overlayRegionSelected: 'overlay:region-selected',
  overlayCancel: 'overlay:cancel'
} as const

declare global {
  interface Window {
    api: IpcApi
    overlayApi: OverlayApi
  }
}
