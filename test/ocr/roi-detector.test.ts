/**
 * Auto-ROI detector tests on SYNTHETIC full-frame images.
 *
 * The existing fixtures are per-region crops (already-localized), so they cannot
 * exercise `detectGameUI` (which localizes ROIs within a whole frame). Instead we
 * build deterministic synthetic HUD frames — coloured HP/MP/EXP/ADENA blobs plus
 * the golden frame between HP and MP — at a known layout, and assert the detector
 * finds anchors/ROIs in the right places. The scaled variant proves
 * `detectGameUiScaled` normalizes a 2× (HiDPI) frame and maps ROIs back to the
 * original pixel space — the coordinate contract window-capture mode relies on.
 */
import { describe, it, expect } from 'vitest'
import { detectGameUI, detectGameUiScaled, DETECTION_REFERENCE_WIDTH } from '@core/ocr/roi-detector'
import type { RgbaImage } from '@core/ocr/types'

type Rgb = [number, number, number]

function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, [r, g, b]: Rgb): void {
  for (let yy = y; yy < y + h; yy++) {
    if (yy < 0 || yy >= img.height) continue
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || xx >= img.width) continue
      const i = (yy * img.width + xx) * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = 255
    }
  }
}

/** Thin-EXP-bar variant: forces the LV-text-line fallback (bar height < 12). */
function makeThinExpFrame(s: number): RgbaImage {
  const img = makeFrame(s)
  // Replace the thick EXP bar with a thin one (height 8 < expThinBarHeight 12).
  fillRect(img, 40 * s, 620 * s, 120 * s, 14 * s, [12, 14, 20]) // clear thick bar
  fillRect(img, 40 * s, 624 * s, 120 * s, 8 * s, [230, 120, 20]) // thin orange bar
  // Bright low-sat "LEVEL  EXP%" text line in the left mini-panel (two clusters,
  // gap > clusterGapMin) so findLevelTextLines/splitLevelExp can localize them.
  fillRect(img, 20 * s, 600 * s, 24 * s, 12 * s, [230, 230, 230]) // LEVEL cluster
  fillRect(img, 80 * s, 600 * s, 70 * s, 12 * s, [230, 230, 230]) // EXP cluster (gap ~36)
  return img
}

/** Build a synthetic Lineage-style HUD frame at integer scale `s` (1 = 1280×720). */
function makeFrame(s: number): RgbaImage {
  const width = 1280 * s
  const height = 720 * s
  const data = new Uint8ClampedArray(width * height * 4)
  // Dark UI background (below every anchor's saturation/value threshold).
  for (let i = 0; i < width * height; i++) {
    const p = i * 4
    data[p] = 12
    data[p + 1] = 14
    data[p + 2] = 20
    data[p + 3] = 255
  }
  const img: RgbaImage = { width, height, data }

  // HP bar (red, lower band).            hue ~0
  fillRect(img, 40 * s, 560 * s, 200 * s, 12 * s, [220, 30, 30])
  // Golden frame in the HP↔MP gap.       hue ~45 (negative-space validation)
  fillRect(img, 240 * s, 560 * s, 60 * s, 12 * s, [200, 160, 40])
  // MP bar (blue/purple, right of HP).   hue ~230
  fillRect(img, 300 * s, 560 * s, 200 * s, 12 * s, [60, 70, 120])
  // EXP bar (orange, left mini-panel).   hue ~28, thick (height ≥ 12) → proportional split
  fillRect(img, 40 * s, 620 * s, 120 * s, 14 * s, [230, 120, 20])
  // ADENA icon (yellow, bottom-right).   hue ~51
  fillRect(img, 1100 * s, 620 * s, 24 * s, 24 * s, [230, 200, 30])

  return img
}

describe('detectGameUI (synthetic 1× frame)', () => {
  const res = detectGameUI(makeFrame(1))

  it('detects all four colour anchors', () => {
    expect(res.anchors.hp).not.toBeNull()
    expect(res.anchors.mp).not.toBeNull()
    expect(res.anchors.exp).not.toBeNull()
    expect(res.anchors.adena).not.toBeNull()
  })

  it('places anchors at the expected layout (HP left, MP right, EXP left panel, ADENA bottom-right)', () => {
    const { hp, mp, exp, adena } = res.anchors
    expect(hp!.x).toBeGreaterThanOrEqual(30)
    expect(hp!.x).toBeLessThanOrEqual(60)
    expect(mp!.x).toBeGreaterThan(hp!.x + hp!.width) // MP right of HP
    expect(exp!.x).toBeLessThan(1280 * 0.3) // EXP in left mini-panel
    expect(adena!.x).toBeGreaterThan(1280 * 0.8) // ADENA bottom-right
  })

  it('derives all text ROIs within frame bounds', () => {
    for (const r of [res.textRois.mp, res.textRois.exp, res.textRois.level, res.textRois.adena]) {
      expect(r).not.toBeNull()
      expect(r!.x0).toBeGreaterThanOrEqual(0)
      expect(r!.y0).toBeGreaterThanOrEqual(0)
      expect(r!.x1).toBeLessThanOrEqual(1280)
      expect(r!.y1).toBeLessThanOrEqual(720)
      expect(r!.x1).toBeGreaterThan(r!.x0)
      expect(r!.y1).toBeGreaterThan(r!.y0)
    }
  })

  it('reports a self-consistent (valid) layout', () => {
    expect(res.valid).toBe(true)
    expect(res.issues).toEqual([])
  })

  it('ADENA text ROI is right of the EXP text ROI', () => {
    expect(res.textRois.adena!.x0).toBeGreaterThan(res.textRois.exp!.x0)
  })
})

describe('detectGameUiScaled (HiDPI / large window normalization)', () => {
  it('matches detectGameUI exactly when the frame is at/below the reference width', () => {
    const frame = makeFrame(1)
    const scaled = detectGameUiScaled(frame)
    const direct = detectGameUI(frame)
    expect(scaled.anchors.hp!.x).toBe(direct.anchors.hp!.x)
    expect(scaled.textRois.mp!.x0).toBe(direct.textRois.mp!.x0)
  })

  it('detects on a 2× frame and maps ROIs back to the original (2×) pixel space', () => {
    expect(2560).toBeGreaterThan(Math.round(DETECTION_REFERENCE_WIDTH * 1.15)) // ensures the scale path runs
    const res = detectGameUiScaled(makeFrame(2))

    expect(res.anchors.hp).not.toBeNull()
    expect(res.anchors.mp).not.toBeNull()
    expect(res.anchors.adena).not.toBeNull()

    // Anchors should be ~2× their 1× positions (downscale→detect→scale-back).
    expect(res.anchors.hp!.x).toBeGreaterThan(60) // ~80
    expect(res.anchors.hp!.x).toBeLessThan(110)
    expect(res.anchors.mp!.x).toBeGreaterThan(res.anchors.hp!.x + res.anchors.hp!.width)
    expect(res.anchors.adena!.x).toBeGreaterThan(2560 * 0.8)

    // ROIs land inside the ORIGINAL 2× frame, not the downscaled one.
    for (const r of [res.textRois.mp, res.textRois.exp, res.textRois.level, res.textRois.adena]) {
      expect(r).not.toBeNull()
      expect(r!.x1).toBeLessThanOrEqual(2560)
      expect(r!.y1).toBeLessThanOrEqual(1440)
      expect(r!.x1).toBeGreaterThan(r!.x0)
    }
    // MP text ROI roughly doubles vs the 1× detection.
    const oneX = detectGameUI(makeFrame(1))
    expect(res.textRois.mp!.x0).toBeGreaterThan(oneX.textRois.mp!.x0 * 1.5)
  })
})

describe('detectGameUI robustness (decoys / thin-EXP / blank)', () => {
  it('ignores off-HUD decoy blobs and still picks the real HUD anchors', () => {
    const img = makeFrame(1)
    fillRect(img, 900, 300, 140, 10, [230, 120, 20]) // decoy orange, right of EXP's left-panel band
    fillRect(img, 500, 100, 160, 12, [220, 30, 30]) // decoy red, above HP's lower band
    fillRect(img, 50, 50, 24, 24, [230, 200, 30]) // decoy yellow, top-left (not bottom-right)
    const res = detectGameUI(img)
    expect(res.anchors.hp!.x).toBeLessThanOrEqual(60) // still the real HP, not the decoy
    expect(res.anchors.exp!.x).toBeLessThan(1280 * 0.3) // still left-panel EXP
    expect(res.anchors.adena!.x).toBeGreaterThan(1280 * 0.8) // still bottom-right ADENA
    expect(res.valid).toBe(true)
  })

  it('derives EXP/LEVEL from the LV text line when the EXP bar is too thin', () => {
    const res = detectGameUI(makeThinExpFrame(1))
    expect(res.anchors.exp).not.toBeNull()
    expect(res.textRois.exp).not.toBeNull()
    expect(res.textRois.level).not.toBeNull()
    // LEVEL cluster is left of the EXP cluster.
    expect(res.textRois.level!.x0).toBeLessThan(res.textRois.exp!.x0)
  })

  it('returns no anchors and does not throw on an all-dark frame (minimized / fullscreen-exclusive)', () => {
    const W = 1280
    const H = 720
    const data = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < W * H; i++) data[i * 4 + 3] = 255 // opaque black
    const res = detectGameUiScaled({ width: W, height: H, data })
    expect(res.anchors.hp).toBeNull()
    expect(res.anchors.mp).toBeNull()
    expect(res.anchors.exp).toBeNull()
    expect(res.anchors.adena).toBeNull()
    expect(res.valid).toBe(false)
  })
})
