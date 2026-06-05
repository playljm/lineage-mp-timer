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

/** Paint a vertical band [x0, x1) of an existing bar with a colour (e.g. an occlusion). */
function paintBand(img: RgbaImage, x0: number, x1: number, c: Rgb): RgbaImage {
  const { width, height } = img
  const data = img.data as Uint8ClampedArray
  for (let y = 0; y < height; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 4
      data[p] = c.r
      data[p + 1] = c.g
      data[p + 2] = c.b
      data[p + 3] = 255
    }
  }
  return img
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

describe('MP bar fill — field robustness (v3.0.1)', () => {
  // Bug B: a muddy-brown fill over a slightly darker brown empty track. A single fixed
  // tolerance counts the track as "filled" and the bar saturates at ~full forever.
  // Relative empty-track classification must keep a half-drained bar reading ~half.
  const brownFill: Rgb = { r: 110, g: 91, b: 80 }
  const brownTrack: Rgb = { r: 74, g: 60, b: 53 } // ~euclidean 59 from fill (< old tol 70!)

  it('does NOT saturate when the empty track is a similar colour to the fill', () => {
    const half = makeBar(200, 24, 100, brownFill, brownTrack)
    const res = computeBarFill(half, { refColor: brownFill })
    // Old code (absolute tol 70) would read ~full (~1.0); relative mode reads ~0.5.
    expect(res.ratio).toBeGreaterThan(0.45)
    expect(res.ratio).toBeLessThan(0.6)
    expect(res.emptyColor).not.toBeNull()
  })

  it('tracks a drained bar across levels with a similar-coloured track', () => {
    for (const [cols, expected] of [
      [40, 0.2],
      [100, 0.5],
      [160, 0.8]
    ] as const) {
      const bar = makeBar(200, 24, cols, brownFill, brownTrack)
      const res = computeBarFill(bar, { refColor: brownFill })
      expect(Math.abs(res.ratio - expected)).toBeLessThan(0.06)
    }
  })

  // Bug A: a transient occlusion (skill effect / floating combat text / a mob) punches
  // a hole in an otherwise full bar. The old left-to-right "stop at first gap" scan
  // truncated at the hole and reported a false near-empty value (the "26/320" blip).
  it('ignores an interior occlusion hole on an otherwise full bar', () => {
    const full = makeBar(200, 24, 200, brownFill, brownTrack)
    // Punch a wide hole near the left (far bigger than the old maxGap=4).
    paintBand(full, 20, 40, { r: 255, g: 255, b: 255 }) // bright occlusion
    const res = computeBarFill(full, { refColor: brownFill })
    expect(res.ratio).toBeGreaterThan(0.9) // still reads ~full, not ~0.1
  })

  it('a real MP drop still reads low even with an interior occlusion above the fill', () => {
    const half = makeBar(200, 24, 100, brownFill, brownTrack)
    paintBand(half, 30, 45, { r: 255, g: 255, b: 255 }) // occlusion inside the fill
    const res = computeBarFill(half, { refColor: brownFill })
    expect(res.ratio).toBeGreaterThan(0.45)
    expect(res.ratio).toBeLessThan(0.6)
  })

  it('does not count an isolated stray fill column on an empty bar', () => {
    const empty = makeBar(200, 24, 0, brownFill, brownTrack)
    paintBand(empty, 150, 152, brownFill) // 2px of noise far right
    const res = computeBarFill(empty, { refColor: brownFill })
    expect(res.filledColumns).toBeLessThan(10)
  })
})
