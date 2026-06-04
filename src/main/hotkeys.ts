/**
 * Global hotkey registration.
 *
 * The renderer owns the action <-> accelerator mapping (persisted in its own
 * settings); main just (re)registers whatever map it is handed and reports which
 * bindings failed. A failure is non-fatal — the app stays usable, the UI simply
 * surfaces the conflict.
 *
 * The map is keyed by an opaque action name (e.g. `alwaysOnTop`, `toggleHide`).
 * When a registered accelerator fires we call `emit(action)`, decoupling key
 * dispatch from window behaviour (which lives in windows.ts / ipc.ts).
 */

import { globalShortcut } from 'electron'
import type { HotkeyMap, HotkeyRegisterResult } from '@shared/ipc-contract'

/**
 * Re-register all global hotkeys from `map`.
 *
 * Existing shortcuts are cleared first so this is idempotent. Empty/blank
 * accelerators are treated as "unbound" and skipped. Duplicate accelerators and
 * OS-level registration failures are collected into `failures` (the action name).
 *
 * @param map    Action name -> accelerator string (e.g. `{ alwaysOnTop: 'F1' }`).
 * @param emit   Invoked with the action name when its accelerator fires.
 * @returns `ok` true when every requested binding registered; `failures` lists
 *   the action names that did not.
 */
export function registerGlobalHotkeys(
  map: HotkeyMap,
  emit: (action: string) => void
): HotkeyRegisterResult {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }

  const failures: string[] = []
  const seen = new Set<string>()

  for (const [action, accel] of Object.entries(map)) {
    if (!accel || typeof accel !== 'string' || !accel.trim()) continue
    if (seen.has(accel)) {
      failures.push(action)
      continue
    }
    try {
      const ok = globalShortcut.register(accel, () => emit(action))
      if (ok) {
        seen.add(accel)
      } else {
        failures.push(action)
      }
    } catch {
      failures.push(action)
    }
  }

  return { ok: failures.length === 0, failures }
}

/** Release every global shortcut. Call on `will-quit`. */
export function unregisterAllHotkeys(): void {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }
}
