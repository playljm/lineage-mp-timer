/**
 * Screen capture adapter — the bridge between the browser's desktop-capture
 * MediaStream and the canvas-free OCR core. One hidden <video> per source; each
 * tick crops a region onto a reused offscreen canvas and hands the OCR core a
 * plain RgbaImage (no canvas/DOM leaks past this boundary).
 *
 * Capture still runs in the renderer (the renewal keeps this to limit risk), but
 * everything downstream operates on RgbaImage and is unit-tested without a DOM.
 */
import type { RgbaImage } from '@core/ocr/types'
import type { CaptureRegion } from '@core/domain/storage-schema'

interface DesktopConstraints {
  mandatory: {
    chromeMediaSource: 'desktop'
    chromeMediaSourceId: string
    maxWidth: number
    maxHeight: number
  }
}

export function imageDataToRgba(d: ImageData): RgbaImage {
  return { width: d.width, height: d.height, data: d.data }
}

interface StreamEntry {
  stream: MediaStream
  video: HTMLVideoElement
}

export class ScreenCapture {
  private readonly streams = new Map<string, StreamEntry>()
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D

  constructor() {
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('capture: 2d context unavailable')
    this.ctx = ctx
  }

  /** Open (or reuse) a desktop-capture stream for a sourceId (screen OR window). */
  async open(sourceId: string): Promise<void> {
    if (!sourceId || this.streams.has(sourceId)) return
    const constraints: DesktopConstraints = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        // Caps must exceed the source's NATIVE physical resolution, otherwise the
        // stream is downscaled and the 1:1 physical-pixel crop assumption in
        // captureRegion()/captureFull() breaks (e.g. a >4K monitor at the old
        // 4096 cap). 8K covers dual-4K and ultrawide; it is a ceiling, not a
        // forced size, so smaller sources still capture at native resolution.
        maxWidth: 7680,
        maxHeight: 4320
      }
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: constraints as unknown as MediaTrackConstraints
    })
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    await video.play()
    // Re-acquire if the display configuration changes (RDP, unplug).
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => this.close(sourceId))
    }
    this.streams.set(sourceId, { stream, video })
  }

  hasSource(sourceId: string | null | undefined): boolean {
    return !!sourceId && this.streams.has(sourceId)
  }

  /**
   * Crop a region to a fresh RgbaImage, or null.
   *
   * `region.x/y/width/height` are PHYSICAL pixels relative to the source's own
   * top-left (a screen's top-left in screen mode, the window's top-left in window
   * mode). The desktop-capture video runs at the source's native physical
   * resolution (see the raised caps in {@link open}), so the crop is applied 1:1
   * with NO further scaleFactor multiply — `region.scaleFactor` is retained only
   * as diagnostic metadata. (The overlay already converted logical→physical at
   * pick time via `toDisplayRect`; multiplying again here was the v3.0 double-scale
   * bug that broke capture on any display scaled ≠ 100%.)
   */
  captureRegion(region: CaptureRegion): RgbaImage | null {
    const sourceId = region.sourceId
    if (!sourceId) return null
    const entry = this.streams.get(sourceId)
    if (!entry || entry.video.videoWidth === 0) return null

    const sx = Math.round(region.x)
    const sy = Math.round(region.y)
    const sw = Math.max(1, Math.round(region.width))
    const sh = Math.max(1, Math.round(region.height))
    this.canvas.width = sw
    this.canvas.height = sh
    this.ctx.drawImage(entry.video, sx, sy, sw, sh, 0, 0, sw, sh)
    try {
      return imageDataToRgba(this.ctx.getImageData(0, 0, sw, sh))
    } catch {
      return null
    }
  }

  /**
   * Capture the ENTIRE frame of a source (the whole window in window-capture mode)
   * as a fresh RgbaImage, or null when the stream is not ready. Used to feed the
   * auto-ROI detector (`detectGameUiScaled`) the full game-window image. The frame
   * is the source's native physical resolution, origin at the source top-left.
   */
  captureFull(sourceId: string): RgbaImage | null {
    if (!sourceId) return null
    const entry = this.streams.get(sourceId)
    if (!entry) return null
    const w = entry.video.videoWidth
    const h = entry.video.videoHeight
    if (w === 0 || h === 0) return null
    this.canvas.width = w
    this.canvas.height = h
    this.ctx.drawImage(entry.video, 0, 0, w, h, 0, 0, w, h)
    try {
      return imageDataToRgba(this.ctx.getImageData(0, 0, w, h))
    } catch {
      return null
    }
  }

  /** PNG data URL of a region (for training capture / preview). */
  captureDataUrl(region: CaptureRegion): string | null {
    if (!this.captureRegion(region)) return null
    return this.canvas.toDataURL('image/png')
  }

  /**
   * PNG data URL of a source's ENTIRE frame plus its physical dimensions, for the
   * manual ROI editor (the user draws ROI boxes on this snapshot). null when the
   * stream is not ready.
   */
  captureFullDataUrl(sourceId: string): { dataUrl: string; width: number; height: number } | null {
    if (!sourceId) return null
    const entry = this.streams.get(sourceId)
    if (!entry) return null
    const w = entry.video.videoWidth
    const h = entry.video.videoHeight
    if (w === 0 || h === 0) return null
    this.canvas.width = w
    this.canvas.height = h
    this.ctx.drawImage(entry.video, 0, 0, w, h, 0, 0, w, h)
    try {
      return { dataUrl: this.canvas.toDataURL('image/png'), width: w, height: h }
    } catch {
      return null
    }
  }

  close(sourceId: string): void {
    const entry = this.streams.get(sourceId)
    if (!entry) return
    for (const track of entry.stream.getTracks()) track.stop()
    entry.video.srcObject = null
    this.streams.delete(sourceId)
  }

  closeAll(): void {
    for (const id of [...this.streams.keys()]) this.close(id)
  }
}
