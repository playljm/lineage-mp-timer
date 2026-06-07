/**
 * Unit tests for the P4 segmentation corrections:
 *
 *  1. Flat horizontal sliver filter — UI-chrome bands (level-box borders,
 *     underlines, gauge bands) are dropped BEFORE x-overlap merging so they can
 *     no longer chain-merge real digits into a mega-glyph. Legitimate glyph
 *     shapes ('.' small square, '/' taller-than-wide, '1' vertical bar) must
 *     NOT be caught by the rule (h <= max(2, 0.08*maskH) && w > 3h).
 *
 *  2. Wide-split trigger uses the boxes' median INK height (not mask.height,
 *     which carries ~46% vertical padding and inflated the estimate 1.85x,
 *     letting touching '4X' digit pairs escape), while the PART COUNT uses the
 *     median box width when >= 3 boxes exist (the trigger estimate over-splits
 *     a 2-digit blob into 3).
 *
 *  3. prepareRegionMask applies a per-region removeSolidBands rowFrac:
 *     level=0.6 (its crop contains chrome bands at ~0.74-0.76 of full width
 *     that survive 0.8), all other regions stay 0.8 (a global 0.6 collapses
 *     exp/adena — measured in the fixture diagnosis).
 */
import { describe, it, expect } from 'vitest'
import type { BinaryMask, RgbaImage } from '@core/ocr/types'
import { segmentGlyphs } from '@core/ocr/segmentation'
import { prepareRegionMask } from '@core/ocr/text-recognizer'

function emptyMask(width: number, height: number): BinaryMask {
  return { width, height, data: new Uint8Array(width * height) }
}

/** Fill a solid rectangle of ink ([x0,x1) x [y0,y1)). */
function rect(mask: BinaryMask, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) mask.data[y * mask.width + x] = 1
}

describe('segmentGlyphs — flat-sliver chrome filter', () => {
  it('drops a flat horizontal band that would otherwise chain-merge digits', () => {
    // 46x48 level-like mask: two digits + an underline sliver bridging their
    // x-range (the measured level failure: underline merges 2 and 8 chrome).
    const mask = emptyMask(46, 48)
    rect(mask, 6, 11, 23, 31) // '2'-like digit blob 17x20
    rect(mask, 25, 11, 42, 31) // '8'-like digit blob 17x20
    rect(mask, 3, 33, 23, 34) // 20x1 underline sliver (h=1 <= 3.84, w=20 > 3)
    const glyphs = segmentGlyphs(mask)
    expect(glyphs.length).toBe(2)
    expect(glyphs[0]!.box.x0).toBe(6)
    expect(glyphs[1]!.box.x0).toBe(25)
  })

  it("keeps a '.'-like small square (w ≈ h fails the w > 3h test)", () => {
    const mask = emptyMask(60, 48)
    rect(mask, 5, 11, 25, 37) // digit
    rect(mask, 30, 33, 34, 37) // 4x4 dot — h=4 > sliverMaxH 3.84, and w !> 3h
    const glyphs = segmentGlyphs(mask)
    expect(glyphs.length).toBe(2)
  })

  it("keeps a '/'-like taller-than-wide stroke and a '1'-like vertical bar", () => {
    const mask = emptyMask(60, 48)
    rect(mask, 5, 11, 11, 37) // '1'-like vertical bar 6x26
    // '/'-like slanted stroke: 2px-wide diagonal, net box 10x20
    for (let i = 0; i < 20; i++) rect(mask, 20 + (i >> 1), 36 - i, 22 + (i >> 1), 37 - i)
    const glyphs = segmentGlyphs(mask)
    expect(glyphs.length).toBe(2)
  })
})

describe('segmentGlyphs — ink-height wide-split', () => {
  it('splits a merged 2-digit blob using the median box width for the part count', () => {
    // Replicates the measured exp "30.4015" geometry: mask height 48 but ink
    // only in rows y=[11,37) (h=26); component widths [5,18,20,20,20,41].
    // Old trigger: estGlyph = max(20*0.7, 48*0.62)=29.8 -> threshold 44.6 > 41
    // => NO split (one glyph lost). New trigger: max(14, 26*0.62=16.1)=16.1 ->
    // threshold 24.2 < 41 => split; parts = round(41/medianWidth 20) = 2.
    const mask = emptyMask(160, 48)
    rect(mask, 2, 11, 7, 37) //  w=5  ('1'-like)
    rect(mask, 12, 11, 30, 37) // w=18
    rect(mask, 35, 11, 55, 37) // w=20
    rect(mask, 60, 11, 80, 37) // w=20
    rect(mask, 85, 11, 105, 37) // w=20
    rect(mask, 110, 11, 151, 37) // w=41 merged '4X' pair
    const glyphs = segmentGlyphs(mask)
    expect(glyphs.length).toBe(7) // 6 components, wide blob split exactly in 2
    // The two split halves cover the blob, cut near its middle (110+20/21).
    const halves = glyphs.filter((g) => g.box.x0 >= 110)
    expect(halves.length).toBe(2)
    const widths = halves.map((g) => g.box.x1 - g.box.x0)
    for (const w of widths) expect(Math.abs(w - 20.5)).toBeLessThanOrEqual(0.5)
  })

  it('does not over-split: 41px blob yields 2 parts, not round(41/16.1)=3', () => {
    const mask = emptyMask(160, 48)
    rect(mask, 2, 11, 7, 37)
    rect(mask, 12, 11, 30, 37)
    rect(mask, 35, 11, 55, 37)
    rect(mask, 110, 11, 151, 37)
    const glyphs = segmentGlyphs(mask)
    expect(glyphs.length).toBe(5) // 3 singles + 2 halves
  })

  it('falls back to the trigger estimate with < 3 boxes (median IS the blob)', () => {
    const mask = emptyMask(100, 48)
    rect(mask, 5, 11, 25, 37) // w=20 single digit
    rect(mask, 40, 11, 81, 37) // w=41 merged pair
    // medW=30.5 -> estGlyph=max(21.35, 16.12)=21.35, threshold 32 < 41 => split,
    // partW = estGlyph (median width is contaminated by the blob itself),
    // parts = round(41/21.35) = 2.
    const glyphs = segmentGlyphs(mask)
    expect(glyphs.length).toBe(3)
  })

  it('leaves normal-width glyphs alone (no split below the threshold)', () => {
    const mask = emptyMask(120, 48)
    rect(mask, 5, 11, 25, 37)
    rect(mask, 30, 11, 50, 37)
    rect(mask, 55, 11, 75, 37)
    const glyphs = segmentGlyphs(mask)
    expect(glyphs.length).toBe(3)
  })
})

describe('prepareRegionMask — per-region removeSolidBands rowFrac', () => {
  /** 46x48 image, black bg (bright-text polarity), with a chrome band spanning
   *  34/46 = 73.9% of the width (the measured level top-border geometry) plus a
   *  small digit blob so the mask is non-trivial. */
  function chromeBandImage(): RgbaImage {
    const width = 46
    const height = 48
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) data[i * 4 + 3] = 255 // opaque black
    const paint = (x: number, y: number) => {
      const i = (y * width + x) * 4
      data[i] = data[i + 1] = data[i + 2] = 255
    }
    for (let y = 2; y < 4; y++) for (let x = 0; x < 34; x++) paint(x, y) // band 34px
    for (let y = 11; y < 31; y++) for (let x = 6; x < 20; x++) paint(x, y) // digit
    return { width, height, data }
  }

  function rowInkAt(mask: BinaryMask, y: number): number {
    let c = 0
    for (let x = 0; x < mask.width; x++) if (mask.data[y * mask.width + x]) c++
    return c
  }

  it('level (rowFrac 0.6) removes a 0.74-width chrome band', () => {
    const mask = prepareRegionMask(chromeBandImage(), 'level')
    expect(rowInkAt(mask, 2)).toBe(0)
    expect(rowInkAt(mask, 3)).toBe(0)
    expect(rowInkAt(mask, 15)).toBeGreaterThan(0) // digit rows survive
  })

  it('exp (rowFrac 0.8) keeps the same band — global 0.6 is forbidden', () => {
    const mask = prepareRegionMask(chromeBandImage(), 'exp')
    expect(rowInkAt(mask, 2)).toBe(34)
  })
})
