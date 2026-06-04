import { describe, it, expect } from 'vitest'
import { computeBarFill, calibrateBar, barFillToMp, type Rgb } from '@core/ocr/bar-fill'
import type { RgbaImage } from '@core/ocr/types'

function makeBar(
  width: number,
  height: number,
  fillCols: number,
  fill: Rgb = { r: 40, g: 120, b: 230 },
  bg: Rgb = { r: 12, g: 14, b: 20 }
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      const c = x < fillCols ? fill : bg
      data[p] = c.r
      data[p + 1] = c.g
      data[p + 2] = c.b
      data[p + 3] = 255
    }
  }
  return { width, height, data }
}

describe('MP bar fill measurement', () => {
  it.each([
    [0, 0],
    [50, 0.25],
    [100, 0.5],
    [150, 0.75],
    [200, 1.0]
  ])('fillCols=%i -> ratio≈%f', (fillCols, expectedRatio) => {
    const img = makeBar(200, 24, fillCols)
    const res = computeBarFill(img)
    expect(Math.abs(res.ratio - expectedRatio)).toBeLessThan(0.04)
  })

  it('calibrates at 100% and converts fill -> MP value', () => {
    const full = makeBar(200, 24, 200)
    const cal = calibrateBar(full)
    expect(cal).not.toBeNull()
    expect(cal!.fullColumns).toBeGreaterThanOrEqual(198)

    // 235 max MP, bar ~52% filled -> ~122
    const half = makeBar(200, 24, 104)
    const cur = barFillToMp(half, 235, cal!)
    expect(cur).toBeGreaterThan(118)
    expect(cur).toBeLessThan(126)
  })

  it('reports zero on an empty bar', () => {
    const empty = makeBar(200, 24, 0)
    const res = computeBarFill(empty)
    expect(res.filledColumns).toBe(0)
    expect(res.ratio).toBe(0)
  })
})
