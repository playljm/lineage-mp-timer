/**
 * Pure image-processing primitives operating on RgbaImage / GrayImage / BinaryMask.
 * No canvas, no DOM, no Node — fully unit-testable.
 *
 * Convention: in a BinaryMask, 1 = ink (text), 0 = background. Lineage renders
 * bright text over a dark UI, so by default "ink" = sufficiently bright pixels
 * ("white extraction"), which is the most reliable polarity for this game.
 */
import type { RgbaImage, GrayImage, BinaryMask, GlyphBox } from './types'

export function luminance(r: number, g: number, b: number): number {
  // Rec. 601 luma — matches what the human eye and the old pipeline used.
  return 0.299 * r + 0.587 * g + 0.114 * b
}

export function toGray(img: RgbaImage): GrayImage {
  const { width, height, data } = img
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = luminance(data[p]!, data[p + 1]!, data[p + 2]!) | 0
  }
  return { width, height, data: out }
}

/** Otsu's method: the gray threshold maximizing inter-class variance. */
export function otsuThreshold(gray: GrayImage): number {
  const hist = new Array<number>(256).fill(0)
  for (let i = 0; i < gray.data.length; i++) hist[gray.data[i]!]++
  const total = gray.data.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]!
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let threshold = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]!
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) {
      maxVar = between
      threshold = t
    }
  }
  return threshold
}

export interface BinarizeOptions {
  /** 'bright' (default): ink = bright pixels (Lineage). 'dark': ink = dark pixels. */
  polarity?: 'bright' | 'dark'
  /** Fixed threshold; if omitted, Otsu is used (with a `floor` lower bound). */
  threshold?: number
  /** Minimum threshold for 'bright' polarity to avoid picking up dim noise. */
  floor?: number
  /** Kill MP-gauge blue background: force pixels where B > R + blueMargin to background. */
  blueMargin?: number
}

export function binarize(img: RgbaImage, opts: BinarizeOptions = {}): BinaryMask {
  const { width, height, data } = img
  const polarity = opts.polarity ?? 'bright'
  const gray = toGray(img)
  let t = opts.threshold ?? otsuThreshold(gray)
  if (polarity === 'bright' && opts.floor != null) t = Math.max(t, opts.floor)
  const blueMargin = opts.blueMargin
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = data[p]!
    const g = data[p + 1]!
    const b = data[p + 2]!
    if (blueMargin != null && b > r + blueMargin && b > g) {
      out[i] = 0
      continue
    }
    const lum = gray.data[i]!
    out[i] = polarity === 'bright' ? (lum >= t ? 1 : 0) : lum < t ? 1 : 0
  }
  return { width, height, data: out }
}

/**
 * Area-average downscale to a target height (keeps aspect). Captured training
 * PNGs are ~10x upscaled with anti-aliasing; normalizing the working resolution
 * back toward native makes glyph gaps crisp again so segmentation is reliable.
 * If the image is already at/below the target height it is returned unchanged.
 */
export function scaleToHeight(img: RgbaImage, targetH: number): RgbaImage {
  if (img.height <= targetH) return img
  const scale = targetH / img.height
  const w = Math.max(1, Math.round(img.width * scale))
  const h = targetH
  const out = new Uint8ClampedArray(w * h * 4)
  const sx = img.width / w
  const sy = img.height / h
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.min(img.height, Math.floor((y + 1) * sy) || y0 + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.min(img.width, Math.floor((x + 1) * sx) || x0 + 1)
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * img.width + x0) * 4
        for (let xx = x0; xx < x1; xx++, p += 4) {
          r += img.data[p]!
          g += img.data[p + 1]!
          b += img.data[p + 2]!
          a += img.data[p + 3]!
          n++
        }
      }
      n = n || 1
      const o = (y * w + x) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = a / n
    }
  }
  return { width: w, height: h, data: out }
}

/** Mean luminance of the 1px-thick border ring — a robust background estimate. */
export function borderMeanLuma(img: RgbaImage): number {
  const gray = toGray(img)
  const { width, height, data } = gray
  let sum = 0
  let n = 0
  for (let x = 0; x < width; x++) {
    sum += data[x]! + data[(height - 1) * width + x]!
    n += 2
  }
  for (let y = 1; y < height - 1; y++) {
    sum += data[y * width]! + data[y * width + width - 1]!
    n += 2
  }
  return n ? sum / n : 128
}

export interface AutoBinarizeOptions {
  /** Dark-text threshold = bg * darkRatio. Default 0.80. */
  darkRatio?: number
  /** Bright-text threshold = bg + (255-bg) * brightRatio. Default 0.5. */
  brightRatio?: number
  /** Force a polarity instead of auto-detecting from the border. */
  polarity?: 'bright' | 'dark'
  /** Kill MP-gauge blue background: pixels with B > R + blueMargin -> background. */
  blueMargin?: number
}

/**
 * Polarity-agnostic binarization for high-contrast game text. Detects whether the
 * background (border ring) is bright or dark and extracts the text as ink either
 * way, with a background-relative threshold tuned to keep anti-aliased upscaled
 * strokes solid (so glyphs don't shatter during segmentation).
 */
export function binarizeAuto(img: RgbaImage, opts: AutoBinarizeOptions = {}): BinaryMask {
  const { width, height, data } = img
  const gray = toGray(img)
  const bg = borderMeanLuma(img)
  const darkText = opts.polarity ? opts.polarity === 'dark' : bg > 128
  const T = darkText
    ? Math.max(20, bg * (opts.darkRatio ?? 0.8))
    : Math.min(235, bg + (255 - bg) * (opts.brightRatio ?? 0.5))
  const blueMargin = opts.blueMargin
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    if (blueMargin != null) {
      const r = data[p]!
      const g = data[p + 1]!
      const b = data[p + 2]!
      if (b > r + blueMargin && b > g) {
        out[i] = 0
        continue
      }
    }
    const lum = gray.data[i]!
    out[i] = darkText ? (lum < T ? 1 : 0) : lum > T ? 1 : 0
  }
  return { width, height, data: out }
}

/**
 * Zero out near-full-width horizontal ink rows (UI chrome bands: level-box
 * borders, gauge frames). Text rows never span the full width, so this safely
 * disconnects digits that a band had bridged. Rows only — a full-height column
 * could be a legitimate '1' stroke, so columns are never removed here.
 */
export function removeSolidBands(mask: BinaryMask, rowFrac = 0.8): BinaryMask {
  const { width, height } = mask
  const out = new Uint8Array(mask.data)
  const threshold = width * rowFrac
  for (let y = 0; y < height; y++) {
    let c = 0
    const row = y * width
    for (let x = 0; x < width; x++) if (mask.data[row + x]!) c++
    if (c >= threshold) {
      for (let x = 0; x < width; x++) out[row + x] = 0
    }
  }
  return { width, height, data: out }
}

/** Tight bounding box of all ink in a mask, or null if empty. */
export function inkBounds(mask: BinaryMask): GlyphBox | null {
  const { width, height, data } = mask
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (data[row + x]!) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

/** Per-column ink counts (length = width). */
export function columnInk(mask: BinaryMask): Uint32Array {
  const { width, height, data } = mask
  const cols = new Uint32Array(width)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) if (data[row + x]!) cols[x]++
  }
  return cols
}

/** Per-row ink counts (length = height). */
export function rowInk(mask: BinaryMask): Uint32Array {
  const { width, height, data } = mask
  const rows = new Uint32Array(height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    let c = 0
    for (let x = 0; x < width; x++) if (data[row + x]!) c++
    rows[y] = c
  }
  return rows
}

export function countInk(mask: BinaryMask): number {
  let c = 0
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i]!) c++
  return c
}

/** Crop a sub-rectangle of a mask. Box is clamped to bounds. */
export function cropMask(mask: BinaryMask, box: GlyphBox): BinaryMask {
  const x0 = Math.max(0, Math.min(box.x0, mask.width))
  const y0 = Math.max(0, Math.min(box.y0, mask.height))
  const x1 = Math.max(x0, Math.min(box.x1, mask.width))
  const y1 = Math.max(y0, Math.min(box.y1, mask.height))
  const w = x1 - x0
  const h = y1 - y0
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const src = (y + y0) * mask.width + x0
    const dst = y * w
    for (let x = 0; x < w; x++) out[dst + x] = mask.data[src + x]!
  }
  return { width: w, height: h, data: out }
}

/** Crop a sub-rectangle of an RGBA image. */
export function cropImage(img: RgbaImage, box: GlyphBox): RgbaImage {
  const x0 = Math.max(0, Math.min(box.x0, img.width))
  const y0 = Math.max(0, Math.min(box.y0, img.height))
  const x1 = Math.max(x0, Math.min(box.x1, img.width))
  const y1 = Math.max(y0, Math.min(box.y1, img.height))
  const w = x1 - x0
  const h = y1 - y0
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const src = ((y + y0) * img.width + x0) * 4
    const dst = y * w * 4
    for (let x = 0; x < w * 4; x++) out[dst + x] = img.data[src + x]!
  }
  return { width: w, height: h, data: out }
}

/** Nearest-neighbour resample of a mask to a fixed grid (for normalized matching). */
export function resampleMask(mask: BinaryMask, w: number, h: number): BinaryMask {
  const out = new Uint8Array(w * h)
  if (mask.width === 0 || mask.height === 0) return { width: w, height: h, data: out }
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mask.height - 1, (y * mask.height / h) | 0)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mask.width - 1, (x * mask.width / w) | 0)
      out[y * w + x] = mask.data[sy * mask.width + sx]!
    }
  }
  return { width: w, height: h, data: out }
}
