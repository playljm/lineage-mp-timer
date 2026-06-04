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

  /** Open (or reuse) a desktop-capture stream for a sourceId. */
  async open(sourceId: string): Promise<void> {
    if (!sourceId || this.streams.has(sourceId)) return
    const constraints: DesktopConstraints = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 4096,
        maxHeight: 2160
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

  /** Crop a region (logical coords + scaleFactor) to a fresh RgbaImage, or null. */
  captureRegion(region: CaptureRegion): RgbaImage | null {
    const sourceId = region.sourceId
    if (!sourceId) return null
    const entry = this.streams.get(sourceId)
    if (!entry || entry.video.videoWidth === 0) return null

    const sf = region.scaleFactor && region.scaleFactor > 0 ? region.scaleFactor : 1
    const sx = region.x * sf
    const sy = region.y * sf
    const sw = Math.max(1, Math.round(region.width * sf))
    const sh = Math.max(1, Math.round(region.height * sf))
    this.canvas.width = sw
    this.canvas.height = sh
    this.ctx.drawImage(entry.video, sx, sy, sw, sh, 0, 0, sw, sh)
    try {
      return imageDataToRgba(this.ctx.getImageData(0, 0, sw, sh))
    } catch {
      return null
    }
  }

  /** PNG data URL of a region (for training capture / preview). */
  captureDataUrl(region: CaptureRegion): string | null {
    if (!this.captureRegion(region)) return null
    return this.canvas.toDataURL('image/png')
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
