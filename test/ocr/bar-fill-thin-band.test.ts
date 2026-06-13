/**
 * Thin-gauge-band measurement regression (v3.1.6).
 *
 * Field bug: the Lineage MP gauge's blue-dominant band is only ~7px tall and
 * calibration shrinks the measure ROI to it. On that thin ROI the old
 * minColumnDensity 0.3 made `need = floor(6*0.3) = 1`, so a 1-2px bright sheen at the
 * top of an EMPTY column counted the whole column as filled — the bar read full
 * forever even as MP drained (field: 260/327 read as 327/327). Raising the default to
 * 0.5 requires a majority of a column's rows to be fill, ignoring the top sheen.
 */
import { describe, it, expect } from 'vitest'
import { computeBarFill, type Rgb } from '@core/ocr/bar-fill'
import type { RgbaImage } from '@core/ocr/types'

const FILL: Rgb = { r: 122, g: 124, b: 149 } // dark blue-gray gauge fill (field refColor)
const SHEEN: Rgb = { r: 150, g: 150, b: 175 } // bright bluish top highlight (fill-ish)
const TRACK: Rgb = { r: 205, g: 196, b: 198 } // light-gray empty track (far from fill)

/** A thin gauge ROI: `fillFrac` filled (left), rest empty track — but EVERY column's
 *  top `sheenRows` rows are a bright bluish sheen (fill-ish), even in the empty part. */
function makeThinBar(w: number, h: number, fillFrac: number, sheenRows: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4)
  const boundary = Math.round(w * fillFrac)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inFill = x < boundary
      const c = y < sheenRows ? SHEEN : inFill ? FILL : TRACK
      const p = (y * w + x) * 4
      data[p] = c.r
      data[p + 1] = c.g
      data[p + 2] = c.b
      data[p + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

describe('computeBarFill on a thin band with top sheen', () => {
  it('measures the real fill (~60%), not full, despite empty-column top sheen', () => {
    const img = makeThinBar(100, 6, 0.6, 2) // 60% filled, 2 sheen rows over empty too
    const res = computeBarFill(img, { refColor: FILL }) // default density (0.5)
    expect(res.ratio).toBeGreaterThan(0.5)
    expect(res.ratio).toBeLessThan(0.7) // NOT ~1.0 (the bug read full)
  })

  it('reads ~full when actually full', () => {
    const img = makeThinBar(100, 6, 1.0, 2)
    const res = computeBarFill(img, { refColor: FILL })
    expect(res.ratio).toBeGreaterThan(0.95)
  })

  it('an EXPLICIT lenient density (0.3) still mismeasures — the default (full-height) is what fixes it', () => {
    const img = makeThinBar(100, 6, 0.6, 2)
    const lenient = computeBarFill(img, { refColor: FILL, minColumnDensity: 0.3 })
    // When the caller explicitly sets the density knob it is honoured (used by the
    // sat-gate diagnostics). At 0.3 the top sheen (2 blue rows ≥ need=1) marks empty
    // columns filled → reads (near) full. The LIVE path passes NO density, so a blue
    // gauge defaults to full-height and the sheen is excluded (cases 1-2 above).
    expect(lenient.ratio).toBeGreaterThan(0.9)
  })
})
