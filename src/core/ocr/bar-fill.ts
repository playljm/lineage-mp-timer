/**
 * MP-bar pixel-fill measurement — the primary, OCR-free MP source.
 *
 * The MP gauge fills left-to-right with a known colour. Counting how many columns
 * are "filled" gives the fill ratio directly, with none of the digit-confusion of
 * reading the small "cur/max" text. Calibrated once at 100% MP, then
 *   cur = round(maxMp * filledColumns / calibratedFullColumns).
 *
 * This is the single most reliable signal in the whole system and should be the
 * default for MP whenever a bar ROI is available.
 */
import type { RgbaImage } from './types'

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface BarFillOptions {
  /** Calibrated fill colour. If omitted, it is auto-detected from the left interior. */
  refColor?: Rgb
  /** Max RGB euclidean distance to count a pixel as "fill". Default 70. */
  colorTolerance?: number
  /** Fraction of a column's rows that must be fill for the column to count. Default 0.3. */
  minColumnDensity?: number
  /** Consecutive empty columns tolerated before the fill boundary is final. Default 4. */
  maxGap?: number
}

export interface BarFillResult {
  filledColumns: number
  totalColumns: number
  ratio: number
  fillColor: Rgb | null
}

function dist2(a: Rgb, r: number, g: number, b: number): number {
  const dr = a.r - r
  const dg = a.g - g
  const db = a.b - b
  return dr * dr + dg * dg + db * db
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

/**
 * Auto-detect the fill colour by averaging the most saturated/bright pixels in the
 * left interior of the bar (which is filled whenever MP > 0).
 */
export function detectFillColor(img: RgbaImage): Rgb | null {
  const { width, height, data } = img
  const x1 = Math.max(1, Math.floor(width * 0.25))
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < x1; x++) {
      const p = (y * width + x) * 4
      const pr = data[p]!
      const pg = data[p + 1]!
      const pb = data[p + 2]!
      const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb
      if (lum > 40 && saturation(pr, pg, pb) > 0.25) {
        r += pr
        g += pg
        b += pb
        n++
      }
    }
  }
  if (n < height * 0.5) return null
  return { r: r / n, g: g / n, b: b / n }
}

export function computeBarFill(img: RgbaImage, opts: BarFillOptions = {}): BarFillResult {
  const { width, height, data } = img
  const tolerance = opts.colorTolerance ?? 70
  const minDensity = opts.minColumnDensity ?? 0.3
  const maxGap = opts.maxGap ?? 4
  const refColor = opts.refColor ?? detectFillColor(img)

  if (!refColor || width === 0 || height === 0) {
    return { filledColumns: 0, totalColumns: width, ratio: 0, fillColor: refColor }
  }

  const tol2 = tolerance * tolerance
  const need = Math.max(1, Math.floor(height * minDensity))
  let lastFilled = -1
  let gap = 0
  for (let x = 0; x < width; x++) {
    let cnt = 0
    for (let y = 0; y < height; y++) {
      const p = (y * width + x) * 4
      if (dist2(refColor, data[p]!, data[p + 1]!, data[p + 2]!) <= tol2) cnt++
    }
    if (cnt >= need) {
      lastFilled = x
      gap = 0
    } else if (lastFilled >= 0) {
      gap++
      if (gap > maxGap) break
    }
  }

  const filledColumns = lastFilled + 1
  return {
    filledColumns,
    totalColumns: width,
    ratio: width > 0 ? filledColumns / width : 0,
    fillColor: refColor
  }
}

export interface BarCalibration {
  fullColumns: number
  fillColor: Rgb
}

/** Capture calibration at 100% MP: the fill colour and the full-bar column count. */
export function calibrateBar(img: RgbaImage, opts: BarFillOptions = {}): BarCalibration | null {
  const res = computeBarFill(img, opts)
  if (!res.fillColor || res.filledColumns < img.width * 0.5) return null
  return { fullColumns: res.filledColumns, fillColor: res.fillColor }
}

/** Convert a measured fill to a current MP value using calibration + known max. */
export function barFillToMp(
  img: RgbaImage,
  maxMp: number,
  cal: BarCalibration,
  opts: BarFillOptions = {}
): number {
  const res = computeBarFill(img, { ...opts, refColor: cal.fillColor })
  if (cal.fullColumns <= 0) return 0
  const cur = Math.round((maxMp * res.filledColumns) / cal.fullColumns)
  return Math.max(0, Math.min(maxMp, cur))
}
