/**
 * IPC wiring for the main process.
 *
 * {@link registerIpc} installs one `ipcMain.handle` per request channel in the
 * shared {@link IPC} contract, delegating to the focused modules (windows,
 * capture, training-store, cloud-*). It is the single seam between the typed
 * preload bridge and main-process behaviour, so every channel the renderer can
 * call is accounted for here.
 *
 * Main -> renderer push events use the `evt:<name>` channel convention (matching
 * the preload's `on`); {@link pushEvent} centralises that send.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain, Notification, shell } from 'electron'
import { IPC } from '@shared/ipc-contract'
import type { IpcEventMap } from '@shared/ipc-contract'
import {
  closeWindow,
  dispatchHotkey,
  getMainWindow,
  hideWindow,
  minimizeWindow,
  setAlwaysOnTop,
  toggleDevtools
} from './windows'
import { listDisplays, listWindows, resolveWindowSource, startRegionSelect } from './capture'
import { getResourcePaths } from './paths'
import { registerGlobalHotkeys } from './hotkeys'
import { listPendingSamples, savePendingSample, saveTrainingSample } from './training-store'
import { cloudRollbackTraineddata, cloudWriteTraineddata } from './cloud-write'
import { cloudLoginPopup } from './cloud-login'

/** Send a typed push event to the main window's renderer. */
export function pushEvent<K extends keyof IpcEventMap>(
  event: K,
  ...args: Parameters<IpcEventMap[K]>
): void {
  const win = getMainWindow()
  win?.webContents.send(`evt:${String(event)}`, ...args)
}

/** Compact-mode bookkeeping: remembers the pre-compact height for restore. */
let compactPrev: { width: number; height: number } | null = null

function setCompact(on: boolean): void {
  const win = getMainWindow()
  if (!win) return
  if (on) {
    if (!compactPrev) {
      const [width, height] = win.getSize()
      compactPrev = { width, height }
    }
    win.setMinimumSize(320, 120)
    win.setSize(win.getSize()[0], 190)
  } else {
    win.setMinimumSize(360, 480)
    if (compactPrev) {
      win.setSize(compactPrev.width, compactPrev.height)
      compactPrev = null
    }
  }
}

function notifyComplete(payload: { title: string; body: string }): void {
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: payload.title || 'MP 충전 완료',
        body: payload.body || '리니지 MP가 가득 찼습니다.',
        urgency: 'critical'
      }).show()
    }
  } catch {
    /* notifications are best-effort */
  }
  const win = getMainWindow()
  if (win) {
    try {
      win.flashFrame(true)
      setTimeout(() => {
        if (!win.isDestroyed()) win.flashFrame(false)
      }, 4000)
    } catch {
      /* ignore */
    }
  }
}

async function saveDiagnosticReport(json: string): Promise<{ ok: boolean; path?: string }> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dir = join(app.getPath('userData'), 'diagnostic', stamp)
    await mkdir(dir, { recursive: true })
    const reportPath = join(dir, 'report.json')
    await writeFile(reportPath, json, 'utf8')
    try {
      void shell.openPath(dir)
    } catch {
      /* opening the folder is best-effort */
    }
    return { ok: true, path: reportPath }
  } catch {
    return { ok: false }
  }
}

/**
 * Register every request handler in the IPC contract.
 *
 * Idempotent per channel via prior `removeHandler`, so it is safe to call once at
 * startup. The overlay's fire-and-forget channels
 * ({@link IPC.overlayRegionSelected} / {@link IPC.overlayCancel}) are intentionally
 * not handled here — they are one-shot `ipcMain.on` events owned by
 * `startRegionSelect`.
 */
export function registerIpc(): void {
  const handle = <T>(
    channel: string,
    fn: (...args: never[]) => T | Promise<T>
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_e, ...args) => (fn as (...a: unknown[]) => T | Promise<T>)(...args))
  }

  // --- displays & capture ---
  handle(IPC.listDisplays, () => listDisplays())
  handle(IPC.startRegionSelect, (displayId?: string) => startRegionSelect(displayId))
  handle(IPC.getResourcePaths, () => getResourcePaths())
  handle(IPC.listWindows, () => listWindows())
  handle(IPC.resolveWindowSource, (title: string) => resolveWindowSource(title))

  // --- window controls ---
  handle(IPC.setAlwaysOnTop, (on: boolean) => setAlwaysOnTop(on))
  handle(IPC.minimizeWindow, () => minimizeWindow())
  handle(IPC.hideWindow, () => hideWindow())
  handle(IPC.closeWindow, () => closeWindow())
  handle(IPC.toggleDevtools, () => toggleDevtools())
  handle(IPC.setCompact, (on: boolean) => setCompact(on))

  // --- notifications & hotkeys ---
  handle(IPC.notifyComplete, (payload: { title: string; body: string }) =>
    notifyComplete(payload)
  )
  // Re-registered global hotkeys dispatch main-side (same as the startup
  // registration). The renderer does not subscribe to a 'hotkey' event — these
  // are main-window behaviours (always-on-top / hide) — so routing through
  // pushEvent here previously made re-registered F1/F2 no-ops.
  handle(IPC.setGlobalHotkeys, (map: Record<string, string>) =>
    registerGlobalHotkeys(map, dispatchHotkey)
  )

  // --- training data ---
  handle(IPC.saveTrainingSample, (sample: Parameters<typeof saveTrainingSample>[0]) =>
    saveTrainingSample(sample, Date.now())
  )
  handle(IPC.savePendingSample, (sample: Parameters<typeof savePendingSample>[0]) =>
    savePendingSample(sample, Date.now())
  )
  handle(IPC.listPendingSamples, (opts?: Parameters<typeof listPendingSamples>[0]) =>
    listPendingSamples(opts)
  )

  // --- cloud sync ---
  handle(IPC.cloudLoginPopup, () => cloudLoginPopup())
  handle(IPC.cloudWriteTraineddata, (bytes: ArrayBuffer) => cloudWriteTraineddata(bytes))
  handle(IPC.cloudRollbackTraineddata, () => cloudRollbackTraineddata())

  // --- diagnostics ---
  handle(IPC.saveDiagnosticReport, (json: string) => saveDiagnosticReport(json))
}
