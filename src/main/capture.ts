/**
 * Display enumeration and region-select capture.
 *
 * The hard problem here is mapping an Electron `Display` (from `screen`) to the
 * matching `desktopCapturer` screen source. The two APIs can return monitors in
 * different orders and `display_id` is sometimes empty, which historically caused
 * the wrong monitor to be captured. The v2.x code carried two near-identical
 * copies of this matching; here it lives once in {@link matchSource}, used by both
 * {@link listDisplays} and {@link startRegionSelect}.
 *
 * Matching is 3-tier, in descending trust:
 *   1. `display_id` string equality,
 *   2. physical-resolution match (bounds x scaleFactor vs source thumbnail size),
 *   3. index fallback.
 */

import { desktopCapturer, ipcMain, screen } from 'electron'
import type { Display } from 'electron'
import { IPC } from '@shared/ipc-contract'
import type { DisplayInfo, Rect, RegionSelectResult } from '@shared/ipc-contract'
import { closeOverlayWindow, createOverlayWindow } from './windows'

/** Large thumbnail so `thumbnail.getSize()` reports physical pixel resolution. */
const HIRES_THUMB = { width: 4096, height: 4096 }
/** Lightweight thumbnail for the picker preview. */
const PREVIEW_THUMB = { width: 320, height: 200 }

type Source = Electron.DesktopCapturerSource

function thumbSize(src: Source): { width: number; height: number } {
  try {
    return src.thumbnail.getSize()
  } catch {
    return { width: 0, height: 0 }
  }
}

/**
 * Resolve the capture source for a display via the 3-tier strategy.
 *
 * @param display The Electron display to match.
 * @param sources Hi-res screen sources from `desktopCapturer.getSources`.
 * @param index   The display's index in `screen.getAllDisplays()` (fallback key).
 * @returns The matched source, or null when no source is available at all.
 */
function matchSource(display: Display, sources: Source[], index: number): Source | null {
  // 1) display_id equality (Electron may hand back '' — require truthy).
  const byId = sources.find(
    (s) => s.display_id && String(s.display_id) === String(display.id)
  )
  if (byId) return byId

  // 2) physical-resolution match for dual-monitor index mismatches.
  const sf = display.scaleFactor || 1
  const targetW = Math.round(display.bounds.width * sf)
  const targetH = Math.round(display.bounds.height * sf)
  const byRes = sources.find((s) => {
    const sz = thumbSize(s)
    return Math.abs(sz.width - targetW) <= 2 && Math.abs(sz.height - targetH) <= 2
  })
  if (byRes) return byRes

  // 3) index fallback.
  return sources[index] ?? sources[0] ?? null
}

/**
 * Enumerate displays with their matched capture source and a preview thumbnail.
 *
 * @returns One {@link DisplayInfo} per display. On failure an empty array.
 */
export async function listDisplays(): Promise<DisplayInfo[]> {
  try {
    const displays = screen.getAllDisplays()

    const preview = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: PREVIEW_THUMB
    })
    let hires = preview
    try {
      hires = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: HIRES_THUMB
      })
    } catch {
      /* fall back to preview-sized sources for matching */
    }

    return displays.map((display, i): DisplayInfo => {
      const src = matchSource(display, hires, i)
      const previewSrc = preview.find((p) => p.id === src?.id) ?? preview[i]
      let thumbnailDataUrl: string | undefined
      try {
        if (previewSrc) thumbnailDataUrl = previewSrc.thumbnail.toDataURL()
      } catch {
        /* leave undefined */
      }
      return {
        id: String(display.id),
        label: display.label || `모니터 ${i + 1}`,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor || 1,
        sourceId: src?.id ?? '',
        thumbnailDataUrl
      }
    })
  } catch {
    return []
  }
}

/**
 * Open the region-select overlay on `displayId` and await the user's selection.
 *
 * Resolves when the overlay sends {@link IPC.overlayRegionSelected} (the picked
 * rectangle) or null when it sends {@link IPC.overlayCancel} (or the window is
 * dismissed). Listeners are one-shot and cleaned up on either outcome.
 *
 * @param displayId Target display id; falls back to the primary display.
 * @returns The selection plus the resolved source/display geometry, or null.
 */
export async function startRegionSelect(
  displayId?: string
): Promise<RegionSelectResult | null> {
  const displays = screen.getAllDisplays()
  const index = displayId ? displays.findIndex((d) => String(d.id) === String(displayId)) : -1
  const target = (index >= 0 ? displays[index] : undefined) ?? screen.getPrimaryDisplay()
  const targetIndex = index >= 0 ? index : 0

  // Resolve the source list once: used both for the overlay loupe and the
  // matched source id returned to the renderer.
  let sources: Source[] = []
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: HIRES_THUMB })
  } catch {
    sources = []
  }

  const matched = matchSource(target, sources, targetIndex)
  const sourceId = matched?.id ?? ''
  const sf = target.scaleFactor || 1

  const win = createOverlayWindow(target.bounds, {
    sourceId,
    expectedWidth: Math.round(target.bounds.width * sf),
    expectedHeight: Math.round(target.bounds.height * sf),
    displayX: target.bounds.x,
    displayY: target.bounds.y,
    scaleFactor: sf,
    sources: sources.map((s) => ({ id: s.id, label: s.name || '' }))
  })

  return new Promise<RegionSelectResult | null>((resolve) => {
    let settled = false

    const cleanup = (): void => {
      ipcMain.removeListener(IPC.overlayRegionSelected, onSelected)
      ipcMain.removeListener(IPC.overlayCancel, onCancel)
      win.removeListener('closed', onClosed)
      closeOverlayWindow()
    }

    const settle = (value: RegionSelectResult | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const onSelected = (_e: unknown, region: Rect): void => {
      settle({
        region,
        displayId: String(target.id),
        displayBounds: target.bounds,
        scaleFactor: sf,
        sourceId
      })
    }
    const onCancel = (): void => settle(null)
    const onClosed = (): void => settle(null)

    ipcMain.once(IPC.overlayRegionSelected, onSelected)
    ipcMain.once(IPC.overlayCancel, onCancel)
    win.once('closed', onClosed)
  })
}
