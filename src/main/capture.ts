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
import type { DisplayInfo, Rect, RegionSelectResult, WindowInfo } from '@shared/ipc-contract'
import { closeOverlayWindow, createOverlayWindow } from './windows'

/** Our own window title — excluded from the game-window picker. */
const SELF_WINDOW_TITLE = 'Lineage MP Timer'
/** Auto-match pattern for the Lineage game window (EN + KO). */
const LINEAGE_TITLE_RE = /lineage|리니지/i

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
 * Enumerate capturable top-level windows for the game-window picker.
 *
 * Excludes our own window and untitled/system windows. The returned `id` is the
 * volatile `window:HWND:0` capture source id; persist the `title` (stable key)
 * and re-resolve the id via {@link resolveWindowSource} on each detection start.
 *
 * @returns One {@link WindowInfo} per eligible window, largest-thumbnail first.
 */
export async function listWindows(): Promise<WindowInfo[]> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: PREVIEW_THUMB
    })
    const out: Array<WindowInfo & { _area: number }> = []
    for (const s of sources) {
      const title = (s.name || '').trim()
      if (!title || title === SELF_WINDOW_TITLE) continue
      const sz = thumbSize(s)
      let thumbnailDataUrl: string | undefined
      try {
        thumbnailDataUrl = s.thumbnail.toDataURL()
      } catch {
        /* leave undefined */
      }
      out.push({ id: s.id, title, thumbnailDataUrl, _area: sz.width * sz.height })
    }
    // Lineage-matching windows first, then by descending thumbnail area (the main
    // game window beats tooltips/child windows of the same title).
    out.sort((a, b) => {
      const am = LINEAGE_TITLE_RE.test(a.title) ? 1 : 0
      const bm = LINEAGE_TITLE_RE.test(b.title) ? 1 : 0
      if (am !== bm) return bm - am
      return b._area - a._area
    })
    return out.map(({ _area, ...w }) => {
      void _area
      return w
    })
  } catch {
    return []
  }
}

/**
 * Re-resolve a window's CURRENT capture source id by matching its title.
 *
 * Window `window:HWND:0` ids are bound to the OS handle and change every time the
 * game is closed/reopened, so a persisted id is useless — this re-enumerates and
 * matches by title on each detection start. Match order: exact title, then
 * case-insensitive substring either way, then the `lineage|리니지` auto-match.
 * Ties break on largest thumbnail (the real game window, not a child/tooltip).
 *
 * @param title Saved game-window title; empty falls straight to auto-match.
 * @returns The fresh `{ sourceId, title }`, or null when no window matches.
 */
export async function resolveWindowSource(
  title: string
): Promise<{ sourceId: string; title: string } | null> {
  let sources: Source[] = []
  try {
    sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: PREVIEW_THUMB })
  } catch {
    return null
  }
  const eligible = sources.filter((s) => {
    const n = (s.name || '').trim()
    return n && n !== SELF_WINDOW_TITLE
  })
  if (eligible.length === 0) return null

  const area = (s: Source): number => {
    const sz = thumbSize(s)
    return sz.width * sz.height
  }
  const byAreaDesc = (a: Source, b: Source): number => area(b) - area(a)
  const want = title.trim()

  const tiers: Array<(s: Source) => boolean> = []
  if (want) {
    const lc = want.toLowerCase()
    tiers.push((s) => (s.name || '').trim() === want)
    tiers.push((s) => {
      const n = (s.name || '').trim().toLowerCase()
      return n.length > 0 && (n.includes(lc) || lc.includes(n))
    })
  }
  tiers.push((s) => LINEAGE_TITLE_RE.test(s.name || ''))

  for (const match of tiers) {
    const hits = eligible.filter(match).sort(byAreaDesc)
    const best = hits[0]
    if (best) return { sourceId: best.id, title: (best.name || '').trim() }
  }
  return null
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
