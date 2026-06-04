/**
 * Region-picker overlay (transparent fullscreen crosshair + loupe magnifier).
 *
 * Port of the v2.x electron/overlay.html self-contained picker into strict,
 * DOM-only TypeScript. UX preserved:
 *  - drag to select an OCR capture rectangle
 *  - on mouse-up, enter "adjust mode" for pixel-precise tuning:
 *      Arrow            move the whole rect by 1px
 *      Shift+Arrow      grow/shrink from the bottom-right corner
 *      Alt+Arrow        grow/shrink from the top-left corner
 *  - a 5x desktop-capture loupe follows the cursor; 'L' cycles the capture
 *    source (for multi-monitor / DPI mismatch where the default source maps
 *    to the wrong screen)
 *  - Enter / on-screen Confirm -> overlayApi.confirm(rect)
 *  - Esc / on-screen Cancel    -> overlayApi.cancel()
 *
 * Coordinate model
 * ----------------
 * The overlay window exactly covers a single display and is positioned at the
 * display origin, so cursor client coordinates are already display-local
 * *logical* pixels. The OCR/capture pipeline works in *physical* pixels (the
 * desktop-capture video runs at the native display resolution), so the rect is
 * scaled by `params.scaleFactor` before being handed back via confirm().
 */

import type { OverlayApi, Rect } from '@shared/ipc-contract'

export {}

/** Local logical-pixel rectangle used while editing. */
interface PickRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Non-standard desktop-capture constraints understood by Electron's Chromium.
 * Not present in the standard `MediaTrackConstraints`, so modelled explicitly
 * and applied via a cast.
 */
interface DesktopCaptureConstraints {
  mandatory: {
    chromeMediaSource: 'desktop'
    chromeMediaSourceId: string
    minWidth: number
    maxWidth: number
    minHeight: number
    maxHeight: number
  }
}

const ZOOM = 5

// ---- DOM lookups (overlay.html guarantees these exist) ----
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`overlay: missing #${id}`)
  return el as T
}

const sel = byId<HTMLDivElement>('selection')
const coords = byId<HTMLDivElement>('coords')
const crossH = byId<HTMLDivElement>('cross-h')
const crossV = byId<HTMLDivElement>('cross-v')
const info = byId<HTMLDivElement>('info')
const infoMsg = byId<HTMLSpanElement>('info-msg')
const infoHint = byId<HTMLElement>('info-hint')
const btnConfirm = byId<HTMLButtonElement>('btn-confirm')
const btnCancel = byId<HTMLButtonElement>('btn-cancel')
const loupeContainer = byId<HTMLDivElement>('loupe-container')
const loupeCanvas = byId<HTMLCanvasElement>('loupe-canvas')
const loupeInfo = byId<HTMLDivElement>('loupe-info')
const video = byId<HTMLVideoElement>('loupe-video')

function require2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('overlay: 2d context unavailable')
  return ctx
}
const lctx = require2d(loupeCanvas)

// Source crop size (in physical px) that the loupe magnifies to canvas size.
const SRC_W = Math.round(loupeCanvas.width / ZOOM) // 280/5 = 56
const SRC_H = Math.round(loupeCanvas.height / ZOOM) // 200/5 = 40

// ---- Params from main (display origin, scale, loupe source candidates) ----
const overlayApi: OverlayApi | undefined = window.overlayApi
const params = overlayApi?.getParams()
const sources: ReadonlyArray<{ id: string; label: string }> = params?.sources ?? []
const scaleFactor = params?.scaleFactor && params.scaleFactor > 0 ? params.scaleFactor : 1
const expectedWidth = params?.expectedWidth ?? 0
const expectedHeight = params?.expectedHeight ?? 0

// ---- Mutable picker state ----
let startX = 0
let startY = 0
let isDragging = false
let region: PickRect | null = null
let mouseX = 0
let mouseY = 0

// ---- Loupe state ----
let currentSourceIdx = Math.max(
  0,
  sources.findIndex((s) => s.id === (params?.sourceId ?? ''))
)
let currentStream: MediaStream | null = null
let videoReady = false

// =====================================================================
// Selection rendering
// =====================================================================

function applyRegion(r: PickRect): void {
  sel.style.left = `${r.x}px`
  sel.style.top = `${r.y}px`
  sel.style.width = `${r.width}px`
  sel.style.height = `${r.height}px`
  coords.textContent = `${r.x}, ${r.y} · ${r.width}×${r.height}`
}

function enterAdjustMode(): void {
  if (!region) return
  document.body.classList.add('adjust-mode')
  sel.classList.add('adjust')
  crossH.style.display = 'none'
  crossV.style.display = 'none'
  btnConfirm.disabled = false
  infoMsg.innerHTML = `🟡 <b>미세 조정 모드</b> &nbsp;|&nbsp; 영역: <b id="adjust-size">${region.width}×${region.height}</b>`
  infoHint.innerHTML = `
    <b>화살표</b> 위치 이동 &nbsp;·&nbsp;
    <b>Shift+화살표</b> 우/하 크기 조정 &nbsp;·&nbsp;
    <b>Alt+화살표</b> 좌/상 크기 조정 &nbsp;·&nbsp;
    <b>Enter</b> 확정 &nbsp;·&nbsp;
    <b>Esc</b> 취소 &nbsp;·&nbsp;
    드래그로 다시 그리기
  `
}

function exitAdjustMode(): void {
  document.body.classList.remove('adjust-mode')
  sel.classList.remove('adjust')
  btnConfirm.disabled = true
  region = null
}

/** Update the live size readout inside the adjust-mode hint bar. */
function refreshAdjustSize(): void {
  if (!region) return
  const sizeEl = document.getElementById('adjust-size')
  if (sizeEl) sizeEl.textContent = `${region.width}×${region.height}`
}

// =====================================================================
// Loupe magnifier (5x desktop capture preview around the cursor)
// =====================================================================

function updateSourceIndicator(): void {
  if (sources.length === 0) return
  const cur = sources[currentSourceIdx]
  const label = cur ? cur.label : '?'
  infoMsg.innerHTML =
    '📷 영역을 드래그로 선택하세요 · ' +
    `<span style="color:#ffd84a">루페 source ${currentSourceIdx + 1}/${sources.length} (${label})</span>` +
    ' — 위치 어긋나면 <b>L</b>로 다음 source'
  loupeInfo.textContent = `${ZOOM}x 확대 · ${label}`
}

async function startLoupeWithSource(sourceId: string): Promise<void> {
  if (!sourceId) {
    console.warn('[Loupe] no sourceId, disabled')
    return
  }
  // Tear down any previous stream first.
  if (currentStream) {
    for (const track of currentStream.getTracks()) track.stop()
    currentStream = null
  }
  videoReady = false

  const desktopConstraints: DesktopCaptureConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      minWidth: 1,
      maxWidth: 4096,
      minHeight: 1,
      maxHeight: 2160
    }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // Electron-specific desktop-capture shape, not in the standard typings.
      video: desktopConstraints as unknown as MediaTrackConstraints
    })
    currentStream = stream
    video.srcObject = stream
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = (): void => {
        console.log('[Loupe] metadata', {
          videoSize: { w: video.videoWidth, h: video.videoHeight },
          expected: { w: expectedWidth, h: expectedHeight }
        })
        resolve()
      }
    })
    await video.play()
    videoReady = true
    loupeContainer.style.display = 'block'
    updateSourceIndicator()
    requestAnimationFrame(renderLoupe)
  } catch (err) {
    console.error('[Loupe] start failed:', err)
  }
}

async function cycleLoupeSource(): Promise<void> {
  if (sources.length < 2) return
  currentSourceIdx = (currentSourceIdx + 1) % sources.length
  const next = sources[currentSourceIdx]
  if (next) await startLoupeWithSource(next.id)
}

async function startLoupe(): Promise<void> {
  const sid = sources.length > 0 ? (sources[currentSourceIdx]?.id ?? '') : (params?.sourceId ?? '')
  await startLoupeWithSource(sid)
}

function renderLoupe(): void {
  if (!videoReady || !video.videoWidth || !video.videoHeight) {
    requestAnimationFrame(renderLoupe)
    return
  }
  // Video is physical px; mouse is logical (window) px → convert via ratio so
  // the loupe stays accurate across dual-monitor / DPI differences.
  const vw = video.videoWidth
  const vh = video.videoHeight
  const ww = window.innerWidth || 1
  const wh = window.innerHeight || 1
  const sx = (mouseX / ww) * vw - SRC_W / 2
  const sy = (mouseY / wh) * vh - SRC_H / 2
  const sxClamped = Math.max(0, Math.min(vw - SRC_W, sx))
  const syClamped = Math.max(0, Math.min(vh - SRC_H, sy))

  lctx.imageSmoothingEnabled = false
  lctx.fillStyle = '#000'
  lctx.fillRect(0, 0, loupeCanvas.width, loupeCanvas.height)
  try {
    lctx.drawImage(
      video,
      sxClamped,
      syClamped,
      SRC_W,
      SRC_H,
      0,
      0,
      loupeCanvas.width,
      loupeCanvas.height
    )
  } catch {
    /* video frame not ready yet */
  }

  // Center reticle marks the exact cursor position.
  lctx.strokeStyle = 'rgba(255, 50, 50, 0.7)'
  lctx.lineWidth = 1
  lctx.beginPath()
  lctx.moveTo(loupeCanvas.width / 2, 0)
  lctx.lineTo(loupeCanvas.width / 2, loupeCanvas.height)
  lctx.moveTo(0, loupeCanvas.height / 2)
  lctx.lineTo(loupeCanvas.width, loupeCanvas.height / 2)
  lctx.stroke()

  requestAnimationFrame(renderLoupe)
}

function placeLoupe(mx: number, my: number): void {
  const margin = 30
  let lx = mx + margin
  let ly = my + margin
  const lw = loupeContainer.offsetWidth || loupeCanvas.width + 8
  const lh = loupeContainer.offsetHeight || loupeCanvas.height + 28
  // Flip to the opposite side near the screen edges.
  if (lx + lw > window.innerWidth) lx = mx - margin - lw
  if (ly + lh > window.innerHeight) ly = my - margin - lh
  if (lx < 0) lx = 0
  if (ly < 0) ly = 0
  loupeContainer.style.left = `${lx}px`
  loupeContainer.style.top = `${ly}px`
}

// =====================================================================
// Confirm / cancel
// =====================================================================

/** Convert the logical-pixel pick rect to display-local physical-pixel Rect. */
function toDisplayRect(r: PickRect): Rect {
  return {
    x: Math.round(r.x * scaleFactor),
    y: Math.round(r.y * scaleFactor),
    width: Math.round(r.width * scaleFactor),
    height: Math.round(r.height * scaleFactor)
  }
}

function confirmRegion(): void {
  if (!region || !overlayApi) return
  overlayApi.confirm(toDisplayRect(region))
}

function cancel(): void {
  overlayApi?.cancel()
}

// =====================================================================
// Pointer interaction
// =====================================================================

document.addEventListener('mousemove', (e) => {
  mouseX = e.clientX
  mouseY = e.clientY
  placeLoupe(mouseX, mouseY)
  if (region) return // do not redraw while in adjust mode

  if (!isDragging) {
    crossH.style.display = 'block'
    crossV.style.display = 'block'
    crossH.style.top = `${e.clientY}px`
    crossV.style.left = `${e.clientX}px`
    return
  }
  const x = Math.min(e.clientX, startX)
  const y = Math.min(e.clientY, startY)
  const w = Math.abs(e.clientX - startX)
  const h = Math.abs(e.clientY - startY)
  applyRegion({ x, y, width: w, height: h })
})

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  if (region) exitAdjustMode()
  startX = e.clientX
  startY = e.clientY
  isDragging = true
  crossH.style.display = 'none'
  crossV.style.display = 'none'
  sel.style.display = 'block'
  applyRegion({ x: startX, y: startY, width: 0, height: 0 })
})

document.addEventListener('mouseup', (e) => {
  if (!isDragging) return
  isDragging = false
  const x = Math.min(e.clientX, startX)
  const y = Math.min(e.clientY, startY)
  const w = Math.abs(e.clientX - startX)
  const h = Math.abs(e.clientY - startY)
  if (w >= 4 && h >= 4) {
    region = { x, y, width: w, height: h }
    applyRegion(region)
    enterAdjustMode()
  } else {
    sel.style.display = 'none'
  }
})

// =====================================================================
// Keyboard: nudge / resize / cycle / confirm / cancel
// =====================================================================

/** Adjust the active region. resizeFromBR/resizeFromTL pick the anchor corner. */
function adjust(dx: number, dy: number, resizeFromBR: boolean, resizeFromTL: boolean): void {
  if (!region) return
  if (resizeFromBR) {
    region.width = Math.max(2, region.width + dx)
    region.height = Math.max(2, region.height + dy)
  } else if (resizeFromTL) {
    region.x += dx
    region.y += dy
    region.width = Math.max(2, region.width - dx)
    region.height = Math.max(2, region.height - dy)
  } else {
    region.x += dx
    region.y += dy
  }
  applyRegion(region)
  refreshAdjustSize()
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    cancel()
    return
  }
  // 'L' cycles the loupe capture source (manual multi-monitor fallback).
  if (e.key === 'l' || e.key === 'L') {
    e.preventDefault()
    void cycleLoupeSource()
    return
  }
  if (!region) return

  if (e.key === 'Enter') {
    e.preventDefault()
    confirmRegion()
    return
  }

  let dx = 0
  let dy = 0
  switch (e.key) {
    case 'ArrowLeft':
      dx = -1
      break
    case 'ArrowRight':
      dx = 1
      break
    case 'ArrowUp':
      dy = -1
      break
    case 'ArrowDown':
      dy = 1
      break
    default:
      return
  }
  e.preventDefault()
  adjust(dx, dy, e.shiftKey, e.altKey)
})

// On-screen buttons mirror the keyboard shortcuts for discoverability.
btnConfirm.addEventListener('click', confirmRegion)
btnCancel.addEventListener('click', cancel)

// =====================================================================
// Boot
// =====================================================================

void startLoupe()
