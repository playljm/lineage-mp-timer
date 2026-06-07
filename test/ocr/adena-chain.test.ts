/**
 * Unit tests for the P5 adena preprocessing chain (diagnosis rank 6, RC-D):
 *
 *  1. junk-glyph filter (segmentGlyphs junkFilter option, adena default) —
 *     median-relative removal of edge-touching narrow UI fragments, flat noise
 *     blobs and sparse speckle, while real digits survive.
 *
 *  2. 2-pass text-band pre-crop (prepareRegionMask, adena only) — a tall crop
 *     where digits occupy a fraction of the rows re-crops to the text band so
 *     the digits fill the working height instead of eroding to ~13px
 *     (measured fixture failure: 33151 -> "7777").
 *
 *  3. confidence-guarded end-gap trim (recognizeMask, adena only) — an end
 *     glyph separated by > 3x the median gap is dropped ONLY when it matches
 *     weakly; a strong far digit survives (the measured 28491 -> "2849"
 *     over-trim trap that forbids an unconditional trim).
 *
 *  4. learn path parity (learnFromCapture) — the same chain runs at learn
 *     time, so a junk-polluted adena capture that recognition reads cleanly
 *     also LEARNS cleanly instead of failing the count==label guard
 *     (fixture-measured train usage 12/55 -> 27/55).
 */
import { describe, it, expect } from 'vitest'
import type { BinaryMask, RgbaImage } from '@core/ocr/types'
import { segmentGlyphs } from '@core/ocr/segmentation'
import { prepareRegionMask, recognizeMask } from '@core/ocr/text-recognizer'
import { learnFromCapture, emptyTemplateSet } from '@core/ocr/learn'
import { TemplateBuilder } from '@core/ocr/template-matcher'

function emptyMask(width: number, height: number): BinaryMask {
  return { width, height, data: new Uint8Array(width * height) }
}

function rect(mask: BinaryMask, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) mask.data[y * mask.width + x] = 1
}

/** 1px-thick rectangle outline (a sparse, low-ink blob that still has digit stature). */
function hollowRect(mask: BinaryMask, x0: number, y0: number, x1: number, y1: number): void {
  for (let x = x0; x < x1; x++) {
    mask.data[y0 * mask.width + x] = 1
    mask.data[(y1 - 1) * mask.width + x] = 1
  }
  for (let y = y0; y < y1; y++) {
    mask.data[y * mask.width + x0] = 1
    mask.data[y * mask.width + (x1 - 1)] = 1
  }
}

/** Opaque black image with white solid bars: [x0, x0+w) x [y0, y1) each. */
function barsImage(
  width: number,
  height: number,
  bars: { x0: number; w: number; y0: number; y1: number }[]
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) data[i * 4 + 3] = 255
  for (const b of bars) {
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x0 + b.w; x++) {
        const i = (y * width + x) * 4
        data[i] = data[i + 1] = data[i + 2] = 255
      }
    }
  }
  return { width, height, data }
}

describe('segmentGlyphs — junkFilter (adena chain step 2)', () => {
  it('removes an edge-touching fragment narrower than the median glyph width', () => {
    // 4 digit-like 8x26 bars + a 6px-wide fragment touching the RIGHT edge
    // (the inventory-UI fragment geometry: too wide for edgeSliver=3, but
    // narrower than the digit median 8 -> junk under edgeWidthRatio 1.0).
    const mask = emptyMask(80, 48)
    rect(mask, 4, 11, 12, 37)
    rect(mask, 18, 11, 26, 37)
    rect(mask, 32, 11, 40, 37)
    rect(mask, 46, 11, 54, 37)
    rect(mask, 74, 8, 80, 40) // fragment, box.x1 === mask.width
    expect(segmentGlyphs(mask).length).toBe(5) // without the filter it stays
    expect(segmentGlyphs(mask, { junkFilter: true }).length).toBe(4)
  })

  it('removes a blob shorter than half the median glyph height (noise blob)', () => {
    const mask = emptyMask(80, 48)
    rect(mask, 4, 11, 12, 37) // h=26
    rect(mask, 18, 11, 26, 37)
    rect(mask, 32, 11, 40, 37)
    rect(mask, 50, 14, 56, 23) // 6x9 blob, 9 < 0.5*26 (the 5x9 corner noise)
    expect(segmentGlyphs(mask, { junkFilter: true }).length).toBe(3)
  })

  it('removes a sparse blob with ink below a quarter of the median', () => {
    const mask = emptyMask(90, 48)
    rect(mask, 4, 11, 12, 37) // ink 208
    rect(mask, 18, 11, 26, 37)
    rect(mask, 32, 11, 40, 37)
    // L-shaped 1px stroke: box 6x20 (stature 20 >= 0.5*26 passes the height
    // rule, width 6 is not edge-touching) but ink 25 < 0.25*208 = 52 — only
    // the ink rule catches it.
    rect(mask, 50, 14, 51, 34)
    rect(mask, 51, 33, 56, 34)
    expect(segmentGlyphs(mask, { junkFilter: true }).length).toBe(3)
  })

  it('keeps a legitimate edge-touching glyph of full digit width', () => {
    // First digit flush against the left crop edge (tight crop) — width equals
    // the median, so the composite condition does NOT remove it.
    const mask = emptyMask(60, 48)
    rect(mask, 0, 11, 8, 37)
    rect(mask, 14, 11, 22, 37)
    rect(mask, 28, 11, 36, 37)
    expect(segmentGlyphs(mask, { junkFilter: true }).length).toBe(3)
  })
})

describe('prepareRegionMask — adena 2-pass text-band pre-crop', () => {
  /** Tall 240x144 capture: digits only in rows [12, 42) — scaleToHeight(48)
   *  alone shrinks them to 10px; the band pre-crop must restore them. */
  function tallImage(): RgbaImage {
    return barsImage(240, 144, [
      { x0: 20, w: 16, y0: 12, y1: 42 },
      { x0: 60, w: 16, y0: 12, y1: 42 },
      { x0: 100, w: 16, y0: 12, y1: 42 },
      { x0: 140, w: 16, y0: 12, y1: 42 }
    ])
  }

  it('adena digits fill most of the working height; exp (single-pass) stays eroded', () => {
    const img = tallImage()
    const expGlyphs = segmentGlyphs(prepareRegionMask(img, 'exp'))
    const adenaGlyphs = segmentGlyphs(prepareRegionMask(img, 'adena'))
    expect(expGlyphs.length).toBe(4)
    expect(adenaGlyphs.length).toBe(4)
    const maxH = (g: { mask: { height: number } }[]) => Math.max(...g.map((x) => x.mask.height))
    expect(maxH(expGlyphs)).toBeLessThanOrEqual(12) // 30 rows / 3 = 10px
    expect(maxH(adenaGlyphs)).toBeGreaterThanOrEqual(28) // band-cropped, near-native
  })

  it('is a no-op when the text already spans the crop (band crop covers everything)', () => {
    const img = barsImage(60, 40, [
      { x0: 8, w: 6, y0: 2, y1: 38 },
      { x0: 24, w: 6, y0: 2, y1: 38 },
      { x0: 40, w: 6, y0: 2, y1: 38 }
    ])
    const mask = prepareRegionMask(img, 'adena')
    expect(mask.height).toBe(40)
    expect(segmentGlyphs(mask).length).toBe(3)
  })
})

describe('recognizeMask — adena confidence-guarded end-gap trim', () => {
  // Template: a solid bar '1' — normalizes to an all-ink canon grid, so a solid
  // bar matches with ~1.0 confidence and a sparse outline matches weakly.
  function barSet() {
    const builder = new TemplateBuilder()
    const tpl = emptyMask(8, 26)
    rect(tpl, 0, 0, 8, 26)
    builder.add('1', tpl)
    return builder.finalize()
  }

  it('drops a far low-confidence end glyph (junk fragment past the row pitch)', () => {
    const mask = emptyMask(120, 48)
    rect(mask, 4, 11, 12, 37) // gaps: 6, 6
    rect(mask, 18, 11, 26, 37)
    rect(mask, 32, 11, 40, 37)
    hollowRect(mask, 90, 11, 104, 37) // gap 50 > 3x6; sparse -> low confidence
    // NOTE: ink 76 > 0.25*208 and full stature — the junkFilter does NOT remove
    // it; only the gap trim can (this is the right-side fragment failure mode).
    const r = recognizeMask(mask, barSet(), 'adena')
    expect(r.text).toBe('111')
  })

  it('keeps a far HIGH-confidence end glyph (the 28491 over-trim trap)', () => {
    const mask = emptyMask(120, 48)
    rect(mask, 4, 11, 12, 37)
    rect(mask, 18, 11, 26, 37)
    rect(mask, 32, 11, 40, 37)
    rect(mask, 90, 11, 98, 37) // same gap outlier, but a solid real digit
    const r = recognizeMask(mask, barSet(), 'adena')
    expect(r.text).toBe('1111')
  })

  it('non-adena regions never gap-trim', () => {
    const mask = emptyMask(120, 48)
    rect(mask, 4, 11, 12, 37)
    rect(mask, 18, 11, 26, 37)
    rect(mask, 32, 11, 40, 37)
    hollowRect(mask, 90, 11, 104, 37)
    const r = recognizeMask(mask, barSet(), 'level')
    expect(r.text.length).toBe(4)
  })
})

describe('learnFromCapture — adena learn-path parity', () => {
  it('learns a junk-polluted adena capture the count guard used to reject', () => {
    const img = barsImage(80, 40, [
      { x0: 6, w: 5, y0: 8, y1: 32 },
      { x0: 20, w: 5, y0: 8, y1: 32 },
      { x0: 34, w: 5, y0: 8, y1: 32 },
      { x0: 48, w: 5, y0: 8, y1: 32 },
      { x0: 76, w: 4, y0: 5, y1: 35 } // UI fragment flush at the right edge
    ])
    const res = learnFromCapture('adena', img, '1234', emptyTemplateSet())
    expect(res.ok).toBe(true)
    expect(res.learned).toBe(4)
  })

  it('still rejects when the junk cannot be told apart (mid-row extra blob)', () => {
    const img = barsImage(80, 40, [
      { x0: 6, w: 5, y0: 8, y1: 32 },
      { x0: 20, w: 5, y0: 8, y1: 32 },
      { x0: 34, w: 5, y0: 8, y1: 32 },
      { x0: 48, w: 5, y0: 8, y1: 32 },
      { x0: 62, w: 5, y0: 8, y1: 32 } // full digit stature, mid-row -> not junk
    ])
    const res = learnFromCapture('adena', img, '1234', emptyTemplateSet())
    expect(res.ok).toBe(false)
    expect(res.note).toMatch(/분할/)
  })
})
