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
import { computeBarFill, barFillToMp, solveLeftOffsetFrac, type Rgb } from '@core/ocr/bar-fill'
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

  it('left-offset affine correction: exact at full, removes low-MP over-read (field 110)', () => {
    // A bar whose gauge fill region starts ~9px in from the ROI left (a static bevel that
    // is always blue): fill 0..90 full-height blue, rest gray track. Without correction the
    // raw ratio over-reads at low MP; the affine offset fixes it and stays exact at full.
    const im = img(260, 7, TRACK)
    for (let x = 0; x < 91; x++) for (let y = 0; y < 7; y++) px(im, x, y, MAIN)
    const filled = computeBarFill(im, { refColor: MAIN }).filledColumns
    expect(filled).toBe(91)

    const FULL = 252
    const MAX = 327
    // Naive (no offset) over-reads: 327*91/252 ≈ 118 (field saw this kind of +error at low MP)
    expect(barFillToMp(im, MAX, { fullColumns: FULL, fillColor: MAIN })).toBe(118)

    // Solve the offset from the known truth (game MP 110) and apply → exact.
    const frac = solveLeftOffsetFrac(91, 110, FULL, MAX)
    expect(frac).toBeGreaterThan(0.03)
    expect(frac).toBeLessThan(0.045)
    expect(barFillToMp(im, MAX, { fullColumns: FULL, fillColor: MAIN, leftOffsetFrac: frac })).toBe(110)

    // The offset is EXACT at 100% regardless: a full bar still reads max.
    const full = img(260, 7, TRACK)
    for (let x = 0; x < FULL; x++) for (let y = 0; y < 7; y++) px(full, x, y, MAIN)
    expect(barFillToMp(full, MAX, { fullColumns: FULL, fillColor: MAIN, leftOffsetFrac: frac })).toBe(MAX)
  })

  it('solveLeftOffsetFrac is safe at degenerate inputs (full / zero / invalid)', () => {
    expect(solveLeftOffsetFrac(91, 327, 252, 327)).toBe(0) // trueMp == max → 0 (no div blowup)
    expect(solveLeftOffsetFrac(91, 110, 0, 327)).toBe(0) // no fullColumns
    expect(solveLeftOffsetFrac(91, -5, 252, 327)).toBe(0) // negative true
  })

  it('excludes the partial-height fill-front GLOW (field over-read: 110→135)', () => {
    // Solid fill 0..49 (full height), then a fill-front GLOW 50..85: blue in the middle
    // rows but GRAY at the top/bottom (the glow fades at the band edges), then gray track.
    // The glow must NOT be counted (it caused the v3.1.10 over-read); the front stays ~50.
    const im = img(200, 7, TRACK)
    paintSegmentedFill(im, 50)
    for (let x = 50; x < 86; x++) {
      for (let y = 1; y <= 5; y++) px(im, x, y, MAIN) // blue middle rows only (rows 0,6 stay gray track)
    }
    const res = computeBarFill(im, { refColor: MAIN })
    expect(res.filledColumns).toBeGreaterThanOrEqual(48)
    expect(res.filledColumns).toBeLessThanOrEqual(52) // glow (50..85) excluded, NOT counted to ~86
  })
})
