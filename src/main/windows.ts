/**
 * BrowserWindow factories and window-state helpers for the main process.
 *
 * Two windows live here:
 * - the main app window (frameless, always-on-top toggle, tray restore), and
 * - the region-select overlay (frameless/transparent, sized to one display,
 *   handed its capture params via `additionalArguments`).
 *
 * The module keeps a single reference to the live main window so window-control
 * IPC and global hotkeys operate on one consistent target. `createTray` wires the
 * tray restore/always-on-top/quit menu. Bounds persistence and the system-saver
 * always-on-top level mirror the proven v2.x behaviour.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import type { Rect } from '@shared/ipc-contract'

/** Default global hotkeys: F1 toggles always-on-top, F2 toggles hide. */
export const DEFAULT_HOTKEYS: Record<string, string> = {
  alwaysOnTop: 'F1',
  toggleHide: 'F2'
}

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

/** The live main window, or null if it has been destroyed. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

/** Mark the app as quitting so close handlers stop intercepting. */
export function setQuitting(value: boolean): void {
  isQuitting = value
}

function preloadPath(): string {
  // electron-vite emits the preload as an ESM `.mjs` next to the main bundle.
  return join(import.meta.dirname, '../preload/index.mjs')
}

function overlayPreloadPath(): string {
  return join(import.meta.dirname, '../preload/overlay.mjs')
}

function resolveIcon(): Electron.NativeImage {
  const root = app.getAppPath()
  for (const candidate of [join(root, 'build', 'icon.ico'), join(root, 'build', 'icon.png')]) {
    try {
      if (existsSync(candidate)) {
        const img = nativeImage.createFromPath(candidate)
        if (!img.isEmpty()) return img
      }
    } catch {
      /* try next */
    }
  }
  return nativeImage.createEmpty()
}

function boundsFile(): string {
  return join(app.getPath('userData'), 'window-bounds.json')
}

async function loadBounds(): Promise<Partial<Rect> | null> {
  try {
    const raw = await readFile(boundsFile(), 'utf8')
    const b = JSON.parse(raw) as Partial<Rect>
    if (Number.isFinite(b.width) && Number.isFinite(b.height)) return b
  } catch {
    /* no/invalid saved bounds */
  }
  return null
}

async function saveBounds(): Promise<void> {
  const win = getMainWindow()
  if (!win) return
  try {
    await writeFile(boundsFile(), JSON.stringify(win.getBounds()), 'utf8')
  } catch {
    /* ignore */
  }
}

/**
 * Create (or recreate) the main application window.
 *
 * Restores the last saved bounds when present, loads the dev server URL in
 * development and the built `index.html` otherwise, and persists bounds on
 * move/resize.
 *
 * @returns The created window.
 */
export function createMainWindow(): BrowserWindow {
  const icon = resolveIcon()

  const win = new BrowserWindow({
    width: 480,
    height: 780,
    minWidth: 360,
    minHeight: 480,
    title: 'Lineage MP Timer',
    frame: false,
    backgroundColor: '#05080a',
    icon: icon.isEmpty() ? undefined : icon,
    autoHideMenuBar: true,
    show: false,
    useContentSize: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setMenu(null)
  mainWindow = win

  // Restore last bounds asynchronously; ready-to-show still fires regardless.
  void loadBounds().then((b) => {
    if (!b || win.isDestroyed()) return
    const cur = win.getBounds()
    win.setBounds({
      x: Number.isFinite(b.x) ? (b.x as number) : cur.x,
      y: Number.isFinite(b.y) ? (b.y as number) : cur.y,
      width: Number.isFinite(b.width) ? Math.max(360, b.width as number) : cur.width,
      height: Number.isFinite(b.height) ? Math.max(480, b.height as number) : cur.height
    })
  })

  win.once('ready-to-show', () => win.show())

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const debouncedSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void saveBounds(), 400)
  }
  win.on('resize', debouncedSave)
  win.on('move', debouncedSave)

  win.on('close', () => {
    void saveBounds()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}

/**
 * Set always-on-top using the highest (`screen-saver`) level so the window
 * floats above borderless/fullscreen games. When enabling we also raise+focus.
 *
 * @returns The resulting always-on-top state (false if no window).
 */
export function setAlwaysOnTop(on: boolean): boolean {
  const win = getMainWindow()
  if (!win) return false
  win.setAlwaysOnTop(on, 'screen-saver')
  if (on) {
    try {
      win.moveTop()
      win.focus()
    } catch {
      /* ignore */
    }
  }
  rebuildTrayMenu()
  return win.isAlwaysOnTop()
}

/** Toggle always-on-top and notify the renderer. Used by the F1 hotkey. */
export function toggleAlwaysOnTop(): boolean {
  const win = getMainWindow()
  if (!win) return false
  const next = setAlwaysOnTop(!win.isAlwaysOnTop())
  win.webContents.send('evt:always-on-top-changed', next)
  return next
}

/**
 * Map a global-hotkey action name onto its main-side window behaviour. Shared by
 * the startup registration and the IPC `setGlobalHotkeys` re-registration so a
 * re-registered hotkey keeps working (the renderer does not handle these — they
 * are main-window behaviours).
 */
export function dispatchHotkey(action: string): void {
  switch (action) {
    case 'alwaysOnTop':
      toggleAlwaysOnTop()
      break
    case 'toggleHide':
      toggleHide()
      break
    default:
      break
  }
}

/** Toggle window visibility. Used by the F2 hotkey. */
export function toggleHide(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isVisible()) {
    win.hide()
  } else {
    win.show()
    win.focus()
  }
}

/** Hide the window to the tray. */
export function hideWindow(): void {
  getMainWindow()?.hide()
}

/** Minimize the window to the taskbar. */
export function minimizeWindow(): void {
  getMainWindow()?.minimize()
}

/** Close the window. */
export function closeWindow(): void {
  getMainWindow()?.close()
}

/** Toggle detached DevTools on the main window. */
export function toggleDevtools(): void {
  const win = getMainWindow()
  if (!win) return
  const wc = win.webContents
  if (wc.isDevToolsOpened()) wc.closeDevTools()
  else wc.openDevTools({ mode: 'detach' })
}

/** Bring the window back from the tray. */
function restoreWindow(): void {
  const win = getMainWindow()
  if (!win) return
  win.show()
  win.focus()
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const win = getMainWindow()
  const alwaysOnTop = !!win && win.isAlwaysOnTop()
  const menu = Menu.buildFromTemplate([
    { label: '창 복원', click: () => restoreWindow() },
    {
      label: alwaysOnTop ? '✓ 항상 위' : '항상 위',
      click: () => toggleAlwaysOnTop()
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        setQuitting(true)
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

/** Create the system tray with restore / always-on-top / quit. */
export function createTray(): Tray {
  tray = new Tray(resolveIcon())
  tray.setToolTip('Lineage MP Timer')
  rebuildTrayMenu()
  tray.on('double-click', () => restoreWindow())
  return tray
}

/** Params handed to the overlay window via base64 `--params=`. */
export interface OverlayParams {
  sourceId: string
  expectedWidth: number
  expectedHeight: number
  displayX: number
  displayY: number
  scaleFactor: number
  sources: { id: string; label: string }[]
}

/**
 * Open the frameless/transparent region-select overlay on `bounds`.
 *
 * The overlay is sized to exactly cover the target display and receives its
 * capture params as a single base64-encoded JSON `--params=` argument, matching
 * the overlay preload's reader.
 *
 * Any existing overlay is closed first (only one at a time).
 *
 * @returns The created overlay window.
 */
export function createOverlayWindow(bounds: Rect, params: OverlayParams): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.close()
    } catch {
      /* ignore */
    }
  }

  const encoded = Buffer.from(JSON.stringify(params), 'utf8').toString('base64')

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: overlayPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--params=${encoded}`]
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(false)
  overlayWindow = win

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    if (overlayWindow === win) overlayWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl.replace(/\/$/, '')}/overlay.html`)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/overlay.html'))
  }

  return win
}

/** Close the overlay window if one is open. */
export function closeOverlayWindow(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.close()
    } catch {
      /* ignore */
    }
  }
  overlayWindow = null
}
