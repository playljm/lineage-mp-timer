/**
 * Electron main entry point.
 *
 * Owns the app lifecycle and bootstraps the modular main process: it creates the
 * main window and tray, wires the IPC contract ({@link registerIpc}), and
 * registers the default global hotkeys (F1 always-on-top, F2 hide/show), routing
 * hotkey actions to the matching window behaviour.
 *
 * Keep this file thin — all real behaviour lives in the focused modules under
 * `src/main/`.
 */

import { app, BrowserWindow } from 'electron'
import {
  createMainWindow,
  createTray,
  DEFAULT_HOTKEYS,
  setQuitting,
  toggleAlwaysOnTop,
  toggleHide
} from './windows'
import { registerIpc } from './ipc'
import { registerGlobalHotkeys, unregisterAllHotkeys } from './hotkeys'

// Preserve the existing userData folder name so v2.x users keep their settings
// and captured training data (%APPDATA%/LineageMPTimer).
app.setName('LineageMPTimer')

/** Map a global-hotkey action name onto its window behaviour. */
function dispatchHotkey(action: string): void {
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

void app.whenReady().then(() => {
  createMainWindow()
  createTray()
  registerIpc()
  registerGlobalHotkeys(DEFAULT_HOTKEYS, dispatchHotkey)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('before-quit', () => setQuitting(true))
app.on('will-quit', () => unregisterAllHotkeys())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
