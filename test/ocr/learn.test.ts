/**
 * learnFromCapture tests — focus on the EXP over-segmentation tolerance.
 *
 * EXP is rendered "DD.DDDD%"; the trailing "%" segments into extra blobs the
 * recognizer misreads as digits. learnFromCapture therefore, for region 'exp'
 * ONLY, learns the leftmost `label.length` glyphs (digits are left-aligned) and
 * drops the trailing pieces. All other regions stay strict so a mis-drawn ROI
 * cannot silently contaminate their templates.
 *
 * We synthesize a deterministic mask: N separated bright vertical bars on a dark
 * background (height 40 ≤ WORK_HEIGHT 48, so prepareRegionMask does NOT rescale),
 * which segment into exactly N glyphs.
 */
import { describe, it, expect } from 'vitest'
import { learnFromCapture, emptyTemplateSet } from '@core/ocr/learn'
import type { RgbaImage } from '@core/ocr/types'

/** N opaque white bars (width 5, gap 5, inset from edges) on opaque black → N glyphs. */
function barsImage(n: number): RgbaImage {
  const width = 6 + n * 10
  const height = 40
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) data[i * 4 + 3] = 255 // opaque black bg
  for (let b = 0; b < n; b++) {
    const x0 = 3 + b * 10
    for (let y = 8; y < 32; y++) {
      for (let x = x0; x < x0 + 5; x++) {
        const i = (y * width + x) * 4
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
        data[i + 3] = 255
      }
    }
  }
  return { width, height, data }
}

describe('learnFromCapture', () => {
  it('sanity: a clean N-bar mask segments into exactly N learnable glyphs', () => {
    const res = learnFromCapture('exp', barsImage(7), '1234567', emptyTemplateSet())
    expect(res.ok).toBe(true)
    expect(res.learned).toBe(7)
  })

  it('EXP: learns the leftmost N glyphs when over-segmented by a trailing "%"', () => {
    // 10 glyphs captured (7 digits + 3 "%" blobs), label is the 7 real chars.
    const res = learnFromCapture('exp', barsImage(10), '1234567', emptyTemplateSet())
    expect(res.ok).toBe(true)
    expect(res.learned).toBe(7) // sliced to label length, trailing blobs dropped
  })

  it('EXP: still rejects an UNDER-segmented ROI (missing leading digit)', () => {
    const res = learnFromCapture('exp', barsImage(5), '1234567', emptyTemplateSet())
    expect(res.ok).toBe(false)
    expect(res.learned).toBe(0)
  })

  it('non-EXP regions stay STRICT: over-segmentation is rejected (no silent slice)', () => {
    const res = learnFromCapture('adena', barsImage(10), '1234', emptyTemplateSet())
    expect(res.ok).toBe(false)
    expect(res.note).toMatch(/분할/)
  })
})
