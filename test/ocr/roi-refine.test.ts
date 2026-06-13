/**
 * Regression tests for the LEVEL/ADENA ROI refinements (v3.1.2).
 *
 * Field cause (2026-06-13, real LC frame): auto-derived ROIs mis-captured —
 *  - LEVEL ROI grabbed the whole "LEV:33" label+value → OCR "660233" → parseLevel null
 *  - ADENA ROI bled the yellow coin icon + cell border → "16476" read as "115476"
 * These unit-test the two pure helpers that fix it, on synthetic pixel layouts that
 * reproduce the failure (no 1MB frame needed).
 */
import { describe, it, expect } from 'vitest'
import {
  refineLevelRoiToValue,
  tightenToTextBBox,
  DEFAULT_ROI_CONFIG,
  type TextRoi
} from '@core/ocr/roi-detector'
import type { RgbaImage } from '@core/ocr/types'

type Rgb = [number, number, number]

function makeImage(w: number, h: number, bg: Rgb): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0]
    data[i * 4 + 1] = bg[1]
    data[i * 4 + 2] = bg[2]
    data[i * 4 + 3] = 255
  }
  return { width: w, height: h, data }
}

function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, [r, g, b]: Rgb): void {
  for (let yy = y; yy < y + h; yy++) {
    if (yy < 0 || yy >= img.height) continue
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || xx >= img.width) continue
      const i = (yy * img.width + xx) * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
    }
  }
}

const WHITE: Rgb = [235, 235, 235]
const DARK: Rgb = [16, 16, 20]
const YELLOW: Rgb = [230, 200, 30] // coin icon (high saturation)
const cfg = DEFAULT_ROI_CONFIG

/** Draw "glyph" blocks at given x-runs (white), spanning rows [y, y+gh). */
function drawGlyphs(img: RgbaImage, runs: Array<[number, number]>, y: number, gh: number): void {
  for (const [xs, xe] of runs) fillRect(img, xs, y, xe - xs + 1, gh, WHITE)
}

describe('refineLevelRoiToValue — strip the "LEV:" label, keep the value digits', () => {
  it('isolates "33" from a "LEV:33" glyph layout (label↔value gap 6 vs inter-digit 3)', () => {
    // L E V : 3 3  — matching the real frame run positions / gaps.
    const img = makeImage(90, 20, DARK)
    drawGlyphs(img, [[12, 18], [22, 29], [32, 39], [45, 46], [52, 59], [62, 69]], 5, 12)
    const roi: TextRoi = { x0: 0, y0: 0, x1: 90, y1: 20 }
    const out = refineLevelRoiToValue(img, roi, cfg)
    // Keeps only the trailing "33" (runs 52..69, ±pad), drops "LEV:".
    expect(out.x0).toBeGreaterThanOrEqual(46)
    expect(out.x0).toBeLessThanOrEqual(52)
    expect(out.x1).toBeGreaterThanOrEqual(69)
    expect(out.x1).toBeLessThanOrEqual(75)
  })

  it('isolates "100" (3-digit value) from "LEV:100"', () => {
    const img = makeImage(100, 20, DARK)
    // L E V :  1 0 0  (label↔value gap 6, inter-digit 3)
    drawGlyphs(img, [[12, 18], [22, 29], [32, 39], [45, 46], [52, 59], [62, 69], [72, 79]], 5, 12)
    const out = refineLevelRoiToValue(img, { x0: 0, y0: 0, x1: 100, y1: 20 }, cfg)
    expect(out.x0).toBeGreaterThanOrEqual(46)
    expect(out.x0).toBeLessThanOrEqual(52)
    expect(out.x1).toBeGreaterThanOrEqual(79)
  })

  it('leaves a clean "33" crop (no label, uniform gaps) unchanged', () => {
    const img = makeImage(40, 20, DARK)
    drawGlyphs(img, [[6, 13], [16, 23]], 5, 12) // two digits, gap 3
    const roi: TextRoi = { x0: 0, y0: 0, x1: 40, y1: 20 }
    const out = refineLevelRoiToValue(img, roi, cfg)
    expect(out.x0).toBe(roi.x0)
    expect(out.x1).toBe(roi.x1)
  })

  it('leaves a single-glyph crop unchanged', () => {
    const img = makeImage(30, 20, DARK)
    drawGlyphs(img, [[10, 18]], 5, 12)
    const roi: TextRoi = { x0: 0, y0: 0, x1: 30, y1: 20 }
    const out = refineLevelRoiToValue(img, roi, cfg)
    expect(out).toEqual(roi)
  })
})

describe('tightenToTextBBox — drop the yellow coin and dark borders, keep the white number', () => {
  it('excludes a high-sat coin above and dark borders around a white number', () => {
    // 100x40: coin (yellow, high-sat) rows 0..14; white number "164" rows 20..34,
    // x 30..78; dark cell borders left (0..6) and right (92..99).
    const img = makeImage(100, 40, DARK)
    fillRect(img, 28, 0, 40, 15, YELLOW) // coin icon on top
    drawGlyphs(img, [[30, 44], [48, 62], [66, 78]], 22, 12) // white digits below
    const roi: TextRoi = { x0: 0, y0: 0, x1: 100, y1: 40 }
    const out = tightenToTextBBox(img, roi, cfg, 2)
    // Top excludes the coin (digits start at y22 → y0 ~20).
    expect(out.y0).toBeGreaterThanOrEqual(18)
    // Left/right hug the digits, not the cell borders.
    expect(out.x0).toBeGreaterThanOrEqual(26)
    expect(out.x0).toBeLessThanOrEqual(30)
    expect(out.x1).toBeGreaterThanOrEqual(79)
    expect(out.x1).toBeLessThanOrEqual(82)
  })

  it('returns the box unchanged when there is no white text (icon-only region)', () => {
    const img = makeImage(60, 30, DARK)
    fillRect(img, 10, 5, 30, 20, YELLOW) // only a coin, no number
    const roi: TextRoi = { x0: 0, y0: 0, x1: 60, y1: 30 }
    const out = tightenToTextBBox(img, roi, cfg, 2)
    expect(out).toEqual(roi)
  })
})
