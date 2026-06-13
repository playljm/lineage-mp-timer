/**
 * Segmented-gauge + text-overlay regression (v3.1.10).
 *
 * Field bug: actual MP 30 read as 17, 50 as 31 (severe at low MP), while high MP was
 * fine (263→257). Frame analysis (test/debug/dbg-mp-frontedge) showed the Lineage MP
 * gauge is rendered as SEGMENTS — bright highlights rgb(200,206,255) and near-black
 * dividers rgb(16,26,41) interleave the average fill rgb(121,124,150). Both are far
 * (>70) from the average colour, so the distance-only classifier counted ~60% of a
 * filled column's pixels. At low MP the white "cur/max" text overlay punched extra
 * holes exactly where the fill front sits, dropping local density below the boundary
 * threshold so the scan truncated BEFORE the text → big undercount.
 *
 * Fix: also count any blue-dominant pixel (b > max(r,g)+8) as fill. Every gauge pixel
 * (main/highlight/divider) is blue-dominant; the gray track and white text are not.
 */
import { describe, it, expect } from 'vitest'
import { computeBarFill, type Rgb } from '@core/ocr/bar-fill'
import type { RgbaImage } from '@core/ocr/types'

const MAIN: Rgb = { r: 121, g: 124, b: 150 }
const HILITE: Rgb = { r: 200, g: 206, b: 255 }
const DIVIDER: Rgb = { r: 16, g: 26, b: 41 }
const TRACK: Rgb = { r: 200, g: 195, b: 196 } // gray, not blue-dominant
const TEXT: Rgb = { r: 250, g: 250, b: 250 } // white "cur/max" overlay

function img(width: number, height: number, bg: Rgb): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bg.r
    data[i * 4 + 1] = bg.g
    data[i * 4 + 2] = bg.b
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}
function px(im: RgbaImage, x: number, y: number, c: Rgb): void {
  const p = (y * im.width + x) * 4
  im.data[p] = c.r
  im.data[p + 1] = c.g
  im.data[p + 2] = c.b
}
/** Paint a segmented (highlight/divider/main) blue fill over columns [0, frontX). */
function paintSegmentedFill(im: RgbaImage, frontX: number): void {
  for (let x = 0; x < frontX; x++) {
    const c = x % 5 === 2 ? HILITE : x % 5 === 4 ? DIVIDER : MAIN
    for (let y = 0; y < im.height; y++) px(im, x, y, c)
  }
}

describe('bar-fill segmented gauge + text overlay (v3.1.10)', () => {
  it('counts bright-highlight columns as fill (distance gate alone would drop them)', () => {
    // A fill made ENTIRELY of the bright highlight colour — far (>70) from the average
    // calibrated colour, so without blue-dominance it would measure 0.
    const im = img(120, 7, TRACK)
    for (let x = 0; x < 40; x++) for (let y = 0; y < 7; y++) px(im, x, y, HILITE)
    const res = computeBarFill(im, { refColor: MAIN })
    expect(res.filledColumns).toBeGreaterThanOrEqual(38)
    expect(res.filledColumns).toBeLessThanOrEqual(41)
  })

  it('measures the true front of a SEGMENTED fill (highlights+dividers included)', () => {
    const im = img(200, 7, TRACK)
    paintSegmentedFill(im, 50) // true front at column 50
    const res = computeBarFill(im, { refColor: MAIN })
    expect(res.filledColumns).toBeGreaterThanOrEqual(48)
    expect(res.filledColumns).toBeLessThanOrEqual(51)
  })

  it('white "cur/max" text overlay at the front does NOT truncate the measurement', () => {
    const im = img(200, 7, TRACK)
    paintSegmentedFill(im, 50) // true front at 50
    // White digits overlay the fill front and spill onto the track (cols 40..72),
    // covering the middle rows — the field failure mode at low MP.
    for (let x = 40; x <= 72; x++) for (let y = 2; y <= 4; y++) px(im, x, y, TEXT)
    const res = computeBarFill(im, { refColor: MAIN })
    // Must still find the front near 50, not truncate back toward ~40 (before the text).
    expect(res.filledColumns).toBeGreaterThanOrEqual(47)
    expect(res.filledColumns).toBeLessThanOrEqual(52)
  })

  it('does not bleed past the front into the gray empty track', () => {
    const im = img(200, 7, TRACK)
    paintSegmentedFill(im, 50)
    const res = computeBarFill(im, { refColor: MAIN })
    // The track (cols 50..199) is gray (not blue-dominant) → must stay empty.
    expect(res.filledColumns).toBeLessThan(60)
  })
})
