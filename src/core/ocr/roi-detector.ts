/**
 * Automatic game-UI ROI detector — finds the HP / MP / EXP / ADENA anchors in a
 * captured frame and derives the text ROIs OCR should read.
 *
 * Pure port of `src/js/roi-detector.js`. The legacy detector entangled a DOM
 * `canvas.getContext('2d')` entry path and dozens of dated magic numbers spread
 * across the file (each carrying a "사용자 진단 YYYY-MM-DD" provenance comment). Here
 * the entry point is DOM-free (`detectGameUI(img: RgbaImage, opts?)`) and every tuned
 * constant is lifted into a single, documented {@link RoiConfig}; the historical
 * provenance is preserved as JSDoc on each field so the tuning history is not lost.
 *
 * Algorithm (unchanged):
 *   1. RGB -> HSV per pixel.
 *   2. HSV-threshold mask per anchor colour (red HP / blue MP / orange EXP / yellow ADENA).
 *   3. Connected-component labelling (reuses `connectedComponents` from segmentation)
 *      with per-blob bounding box / area / circular-mean hue / mean saturation.
 *   4. Position / aspect / area filtering -> ranked candidate lists.
 *   5. Combinatorial layout validation: pick the first HP×EXP×MP×ADENA tuple whose
 *      relative geometry (MP right of HP, golden frame between them, ADENA right of
 *      EXP, EXP adjacent to HP) is self-consistent.
 *   6. Derive text ROIs from the chosen anchors (with LV-text-line fallback for EXP).
 *
 * PURITY: DOM-free, node-free, no wall-clock reads.
 */
import type { RgbaImage, BinaryMask, GlyphBox } from './types'
import { connectedComponents } from './segmentation'
import { scaleToHeight, binarizeAuto, columnInk, cropImage } from './imaging'

// ─────────────────────────────────────────────────────────────────────────────
// Geometry types
// ─────────────────────────────────────────────────────────────────────────────

/** Axis-aligned box in `{x, y, width, height}` form (origin-relative). */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A colour blob: bounding box plus area and average HSV. */
export interface ColorBlob extends Box {
  area: number
  /** Circular-mean hue 0..360. */
  avgHue: number
  /** Mean saturation 0..1. */
  avgSat: number
}

/** The four detected UI anchors (any may be null when undetected). */
export interface UiAnchors {
  hp: ColorBlob | null
  mp: ColorBlob | null
  exp: ColorBlob | null
  adena: ColorBlob | null
}

/** A derived text ROI; `clipped` records frame-boundary clamping for diagnostics. */
export interface TextRoi extends GlyphBox {
  /** True if the ROI was clamped to the frame boundary (intended dims didn't fit). */
  clipped?: boolean
  /** Pre-clamp width, when `clipped`. */
  intendedWidth?: number
  /** Pre-clamp height, when `clipped`. */
  intendedHeight?: number
}

/** Derived text ROIs as half-open {@link GlyphBox}es, or null when underivable. */
export interface DerivedTextRois {
  mp: TextRoi | null
  exp: TextRoi | null
  level: TextRoi | null
  adena: TextRoi | null
}

/** Full detection result. */
export interface DetectResult {
  anchors: UiAnchors
  textRois: DerivedTextRois
  /** All four anchors present and ROI validation passed (ADENA-only issues excepted). */
  valid: boolean
  /** Human-readable diagnostics (Korean, matching the in-app drawer). */
  issues: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// RoiConfig — every tuned magic number, with provenance preserved as JSDoc.
// ─────────────────────────────────────────────────────────────────────────────

/** HSV threshold band for one anchor colour. `hueMin > hueMax` means hue wrap-around. */
export interface HsvBand {
  hueMin: number
  hueMax: number
  satMin: number
  valMin: number
}

/**
 * All detector tuning constants in one place. Defaults reproduce the v1.8.x legacy
 * behaviour exactly. Field docs cite the original "사용자 진단" provenance notes.
 */
export interface RoiConfig {
  // ── HP bar (red) ──────────────────────────────────────────────────────────
  /**
   * HP is red with hue wrap-around. Widened from 355-5 to 350-20 after the game
   * client measured HP at hue ~12 (orange-leaning red). sat>0.6, val>0.4.
   */
  hp: HsvBand
  /** HP min-area = max(hpMinAreaFloor, frameArea * hpMinAreaFrac). */
  hpMinAreaFloor: number
  hpMinAreaFrac: number
  /** HP must sit in the lower band of the frame: y >= frameH * hpYRelMin. */
  hpYRelMin: number
  /** HP candidate min width in px. */
  hpMinWidth: number
  /** HP "wide bar" preference: width/height > this ranks first. */
  hpWideAspect: number

  // ── MP bar (blue/purple) ──────────────────────────────────────────────────
  /**
   * MP is a dark grey-blue. Widened to hue 200-270 + sat>0.10 after the client
   * measured MP at hue ~248, sat ~20% (purple-leaning dark blue).
   */
  mp: HsvBand
  mpMinAreaFloor: number
  mpMinAreaFrac: number
  /** MP search band around HP: y in [hp.y - mpYPad, hp.y + hp.h + mpYPad]. */
  mpYPad: number
  /** MP must start right of HP: x >= hp.x + hp.w + frameW * mpXGapFrac. */
  mpXGapFrac: number
  /** MP candidate min aspect (width/height). */
  mpMinAspect: number
  /** Blobs with avgSat above this (vivid pure blue/purple = UI icons) rank last. */
  mpCalmSatMax: number

  // ── EXP bar (orange) ──────────────────────────────────────────────────────
  /** EXP is orange, widened to hue 12-38, sat>0.55, val>0.4 (client hue ~28). */
  exp: HsvBand
  expMinAreaFloor: number
  expMinAreaFrac: number
  /** EXP sits in the left mini-panel: x <= frameW * expXRelMax. */
  expXRelMax: number
  /** EXP vertical band: y in [frameH * expYRelMin, frameH * expYRelMax]. */
  expYRelMin: number
  expYRelMax: number
  /** EXP candidate min aspect. */
  expMinAspect: number
  /**
   * EXP absolute min width. A too-short orange element (e.g. "LEV:29" text) is not
   * an EXP bar; real bars are width>=80 (usually 100-250). [v1.5.1]
   */
  expMinWidth: number
  /** A thin true progress bar has aspect>=this and height<=expSlimMaxHeight. [v1.5.4] */
  expSlimAspect: number
  expSlimMaxHeight: number

  // ── ADENA icon (yellow) ────────────────────────────────────────────────────
  /** ADENA is yellow, hue 42-62, sat>0.55, val>0.4 (loosened yRel>0.80). */
  adena: HsvBand
  adenaMinAreaFloor: number
  adenaMinAreaFrac: number
  /** ADENA sits bottom-right: x >= frameW * adenaXRelMin, y >= frameH * adenaYRelMin. */
  adenaXRelMin: number
  adenaYRelMin: number
  /** ADENA icon aspect window. */
  adenaMinAspect: number
  adenaMaxAspect: number

  // ── Golden-frame (negative-space) validation ────────────────────────────────
  /** Golden frame between HP and MP: hue 30-50, sat >= goldenSatMin. */
  goldenHueMin: number
  goldenHueMax: number
  goldenSatMin: number
  /** Min fraction of golden pixels between HP and MP to accept. Loosened 5%->3%. */
  goldenFracMin: number

  // ── MP text ROI ─────────────────────────────────────────────────────────────
  /**
   * MP text width must not follow the (variable) blue-fill width, else low MP clips
   * the right of "MP : 113/242". Use max(mpBar.w, hpBar.w, mpTextMinWidth). [v1.4.3]
   */
  mpTextMinWidth: number
  /** MP text ROI left inset from the bar start, px. */
  mpTextXInset: number

  // ── EXP / LEVEL text ROIs ────────────────────────────────────────────────────
  /** A thin EXP bar (height < this) triggers the LV-text-line fallback. */
  expThinBarHeight: number
  /** EXP text x offset from bar = bar.x + bar.w * expTextXFrac. */
  expTextXFrac: number
  /** EXP text width = max(expTextMinWidth, bar.w * expTextWFrac). [v1.5.2] */
  expTextWFrac: number
  expTextMinWidth: number
  /** LEVEL text x = bar.x; width = max(levelTextMinWidth, bar.w * levelTextWFrac). */
  levelTextWFrac: number
  levelTextMinWidth: number
  /** Vertical padding for text-line-derived ROIs, px. */
  textPadY: number
  /**
   * Horizontal padding for text-line ROIs (expand path). 14px guarantees 2 integer
   * digits captured + AA protection without crossing into the '%' glyph. [v1.8.4]
   */
  textPadXExpand: number
  /** Horizontal padding for the thick-bar text-line path. [v1.8.4] */
  textPadXThick: number
  /** A text line needs >= 2 clusters with a max inter-cluster gap > this. [v1.5.9] */
  clusterGapMin: number
  /** LV-number clusters within this px of the level cluster merge into it. */
  levelClusterMergeGap: number

  // ── LV text-line detection (left mini-panel) ─────────────────────────────────
  /** Search window for LV text lines: x in [0, frameW * lvTextXRelMax]. */
  lvTextXRelMax: number
  /** Search window: y in [frameH * lvTextYRelMin, frameH * lvTextYRelMax]. */
  lvTextYRelMin: number
  lvTextYRelMax: number
  /** A text pixel is bright (lum > lvTextLumMin) and low-sat (sat < lvTextSatMax). */
  lvTextLumMin: number
  lvTextSatMax: number
  /** Min text pixels per row to count as part of a text line. */
  lvTextRowMinPixels: number
  /** A text line must be at least this many rows tall. */
  lvTextMinLineHeight: number
  /** Small horizontal gaps (px) between glyphs are bridged. */
  lvTextGapBridge: number
  /** A column cluster must be at least this wide (px). */
  lvTextMinClusterWidth: number
  /** Within-line EXP candidate y must be within this of the bar y (thick path). */
  expNearBarY: number

  // ── ADENA text ROI ───────────────────────────────────────────────────────────
  /** Horizontal layout: text starts at icon center (x + w * adenaRightXFrac). [v1.5.11] */
  adenaRightXFrac: number
  adenaRightYFrac: number
  adenaRightWFrac: number
  adenaRightMinWidth: number
  adenaRightHFrac: number
  /** Vertical layout (digits below icon). [v1.6.4] */
  adenaBelowXShift: number
  adenaBelowYFrac: number
  adenaBelowWFrac: number
  adenaBelowMinWidth: number
  adenaBelowHFrac: number
  adenaBelowMinHeight: number
  /** Pick the below layout if its ink score beats right by this factor. */
  adenaBelowInkRatio: number

  // ── ink-density (edge ratio) helper ──────────────────────────────────────────
  /** Adjacent-pixel luma diff above this counts as an edge. */
  inkEdgeThreshold: number

  // ── candidate breadth for the combinatorial search ───────────────────────────
  hpTopK: number
  expTopK: number
  adenaTopK: number
  mpTopK: number

  // ── ROI validation thresholds ────────────────────────────────────────────────
  roiMinWidth: number
  roiMinHeight: number
  /** ADENA ROI below this width is flagged (5-digit+comma capture). [v1.5.11] */
  adenaRoiMinWidth: number
  /** EXP/LEVEL textROI min widths. */
  expRoiMinWidth: number
  levelRoiMinWidth: number
}

/** Documented defaults reproducing the proven v1.8.x legacy behaviour. */
export const DEFAULT_ROI_CONFIG: RoiConfig = {
  hp: { hueMin: 350, hueMax: 20, satMin: 0.6, valMin: 0.4 },
  hpMinAreaFloor: 20,
  hpMinAreaFrac: 0.0008,
  hpYRelMin: 0.6,
  hpMinWidth: 10,
  hpWideAspect: 3,

  mp: { hueMin: 200, hueMax: 270, satMin: 0.1, valMin: 0.25 },
  mpMinAreaFloor: 20,
  mpMinAreaFrac: 0.0006,
  mpYPad: 40,
  mpXGapFrac: 0.03,
  mpMinAspect: 2.5,
  mpCalmSatMax: 0.85,

  exp: { hueMin: 12, hueMax: 38, satMin: 0.55, valMin: 0.4 },
  expMinAreaFloor: 15,
  expMinAreaFrac: 0.0005,
  expXRelMax: 0.3,
  expYRelMin: 0.65,
  expYRelMax: 0.95,
  expMinAspect: 2,
  expMinWidth: 80,
  expSlimAspect: 5,
  expSlimMaxHeight: 12,

  adena: { hueMin: 42, hueMax: 62, satMin: 0.55, valMin: 0.4 },
  adenaMinAreaFloor: 10,
  adenaMinAreaFrac: 0.0002,
  adenaXRelMin: 0.8,
  adenaYRelMin: 0.8,
  adenaMinAspect: 0.5,
  adenaMaxAspect: 2.0,

  goldenHueMin: 30,
  goldenHueMax: 50,
  goldenSatMin: 0.4,
  goldenFracMin: 0.03,

  mpTextMinWidth: 200,
  mpTextXInset: 5,

  expThinBarHeight: 12,
  expTextXFrac: 0.45,
  expTextWFrac: 0.55,
  expTextMinWidth: 50,
  levelTextWFrac: 0.4,
  levelTextMinWidth: 30,
  textPadY: 4,
  textPadXExpand: 14,
  textPadXThick: 12,
  clusterGapMin: 20,
  levelClusterMergeGap: 25,

  lvTextXRelMax: 0.2,
  lvTextYRelMin: 0.75,
  lvTextYRelMax: 0.95,
  lvTextLumMin: 180,
  lvTextSatMax: 0.35,
  lvTextRowMinPixels: 15,
  lvTextMinLineHeight: 8,
  lvTextGapBridge: 3,
  lvTextMinClusterWidth: 8,
  expNearBarY: 30,

  adenaRightXFrac: 0.5,
  adenaRightYFrac: 0.1,
  adenaRightWFrac: 2.8,
  adenaRightMinWidth: 100,
  adenaRightHFrac: 0.8,
  adenaBelowXShift: 20,
  adenaBelowYFrac: 0.83,
  adenaBelowWFrac: 2.8,
  adenaBelowMinWidth: 100,
  adenaBelowHFrac: 0.55,
  adenaBelowMinHeight: 18,
  adenaBelowInkRatio: 1.3,

  inkEdgeThreshold: 25,

  hpTopK: 5,
  expTopK: 5,
  adenaTopK: 5,
  mpTopK: 3,

  roiMinWidth: 10,
  roiMinHeight: 5,
  adenaRoiMinWidth: 50,
  expRoiMinWidth: 50,
  // v3.1.2 trims the level ROI to just the value digits ("33" ≈ 18-26px), so the
  // legacy 30px floor would false-flag a correctly-trimmed ROI as invalid.
  levelRoiMinWidth: 14
}

export interface DetectOptions {
  /** Override any subset of the tuning constants. */
  config?: Partial<RoiConfig>
}

// ─────────────────────────────────────────────────────────────────────────────
// HSV
// ─────────────────────────────────────────────────────────────────────────────

interface Hsv {
  h: number // 0..360
  s: number // 0..1
  v: number // 0..1
}

/** RGB (0..255) -> HSV (h:0..360, s:0..1, v:0..1). */
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

/** Build a 1-byte-per-pixel mask from an HSV band (supports hue wrap-around). */
function buildHsvMask(img: RgbaImage, band: HsvBand): BinaryMask {
  const { width, height, data } = img
  const { hueMin, hueMax, satMin, valMin } = band
  const wraps = hueMin > hueMax
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    const hsv = rgbToHsv(data[i]!, data[i + 1]!, data[i + 2]!)
    const hueOk = wraps ? hsv.h <= hueMax || hsv.h >= hueMin : hsv.h >= hueMin && hsv.h <= hueMax
    if (hueOk && hsv.s >= satMin && hsv.v >= valMin) out[p] = 1
  }
  return { width, height, data: out }
}

type PosFilter = (x: number, y: number, w: number, h: number) => boolean

/**
 * Find colour blobs by HSV thresholding + connected components, returning bounding
 * box / area / circular-mean hue / mean saturation, area-descending. Reuses
 * `connectedComponents` from segmentation; per-blob HSV stats are computed by
 * scanning each component's bounding box intersected with the mask.
 */
export function findColorBlobs(
  img: RgbaImage,
  band: HsvBand,
  opts: { minArea?: number; posFilter?: PosFilter } = {}
): ColorBlob[] {
  const { width, data } = img
  const minArea = opts.minArea ?? 1
  const mask = buildHsvMask(img, band)
  const comps = connectedComponents(mask, minArea)

  const blobs: ColorBlob[] = []
  for (const c of comps) {
    const bw = c.x1 - c.x0
    const bh = c.y1 - c.y0
    if (opts.posFilter && !opts.posFilter(c.x0, c.y0, bw, bh)) continue

    // Circular-mean hue + mean saturation over this component's ink pixels.
    let sinH = 0
    let cosH = 0
    let sumS = 0
    let n = 0
    for (let y = c.y0; y < c.y1; y++) {
      const row = y * width
      for (let x = c.x0; x < c.x1; x++) {
        if (!mask.data[row + x]) continue
        const di = (row + x) * 4
        const hsv = rgbToHsv(data[di]!, data[di + 1]!, data[di + 2]!)
        const rad = (hsv.h * Math.PI) / 180
        sinH += Math.sin(rad)
        cosH += Math.cos(rad)
        sumS += hsv.s
        n++
      }
    }
    const count = n || 1
    let avgHue = (Math.atan2(sinH / count, cosH / count) * 180) / Math.PI
    if (avgHue < 0) avgHue += 360
    blobs.push({
      x: c.x0,
      y: c.y0,
      width: bw,
      height: bh,
      area: c.area,
      avgHue,
      avgSat: sumS / count
    })
  }

  blobs.sort((a, b) => b.area - a.area)
  return blobs
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-anchor candidate detection
// ─────────────────────────────────────────────────────────────────────────────

export function findHpBarCandidates(img: RgbaImage, cfg: RoiConfig): ColorBlob[] {
  const w = img.width
  const h = img.height
  const minArea = Math.max(cfg.hpMinAreaFloor, Math.floor(w * h * cfg.hpMinAreaFrac))
  const posFilter: PosFilter = (_x, y, bw) => {
    if (y < h * cfg.hpYRelMin) return false
    if (bw < cfg.hpMinWidth) return false
    return true
  }
  const blobs = findColorBlobs(img, cfg.hp, { minArea, posFilter })
  // Prefer wide bars; keep the rest as fallback (area-desc within each group).
  const wide = blobs.filter((b) => b.width / b.height > cfg.hpWideAspect)
  const rest = blobs.filter((b) => b.width / b.height <= cfg.hpWideAspect)
  return wide.concat(rest)
}

export function findMpBarCandidates(img: RgbaImage, cfg: RoiConfig, hp: ColorBlob | null): ColorBlob[] {
  if (!hp) return []
  const w = img.width
  const h = img.height
  const yMin = hp.y - cfg.mpYPad
  const yMax = hp.y + hp.height + cfg.mpYPad
  const xMin = hp.x + hp.width + Math.floor(w * cfg.mpXGapFrac)
  const minArea = Math.max(cfg.mpMinAreaFloor, Math.floor(w * h * cfg.mpMinAreaFrac))
  const posFilter: PosFilter = (x, y, bw, bh) => {
    if (y < yMin || y > yMax) return false
    if (x < xMin) return false
    if (bw / Math.max(1, bh) < cfg.mpMinAspect) return false
    return true
  }
  const blobs = findColorBlobs(img, cfg.mp, { minArea, posFilter })
  // Vivid pure blue/purple (UI accent icons) rank last; the true MP bar is calm.
  const calm = blobs.filter((b) => b.avgSat <= cfg.mpCalmSatMax)
  const sharp = blobs.filter((b) => b.avgSat > cfg.mpCalmSatMax)
  return calm.concat(sharp)
}

export function findExpBarCandidates(img: RgbaImage, cfg: RoiConfig): ColorBlob[] {
  const w = img.width
  const h = img.height
  const minArea = Math.max(cfg.expMinAreaFloor, Math.floor(w * h * cfg.expMinAreaFrac))
  const posFilter: PosFilter = (x, y, bw, bh) => {
    if (x > w * cfg.expXRelMax) return false
    if (y < h * cfg.expYRelMin || y > h * cfg.expYRelMax) return false
    if (bw / Math.max(1, bh) < cfg.expMinAspect) return false
    if (bw < cfg.expMinWidth) return false
    return true
  }
  const blobs = findColorBlobs(img, cfg.exp, { minArea, posFilter })
  // A thin true progress bar (aspect>=5, height<=12) outranks thick text glyphs.
  const isSlim = (b: ColorBlob): boolean =>
    b.width / Math.max(1, b.height) >= cfg.expSlimAspect && b.height <= cfg.expSlimMaxHeight
  const slim = blobs.filter(isSlim)
  const thick = blobs.filter((b) => !isSlim(b))
  return slim.concat(thick)
}

export function findAdenaIconCandidates(img: RgbaImage, cfg: RoiConfig): ColorBlob[] {
  const w = img.width
  const h = img.height
  const minArea = Math.max(cfg.adenaMinAreaFloor, Math.floor(w * h * cfg.adenaMinAreaFrac))
  const posFilter: PosFilter = (x, y, bw, bh) => {
    if (x < w * cfg.adenaXRelMin) return false
    if (y < h * cfg.adenaYRelMin) return false
    const ar = bw / Math.max(1, bh)
    if (ar < cfg.adenaMinAspect || ar > cfg.adenaMaxAspect) return false
    return true
  }
  return findColorBlobs(img, cfg.adena, { minArea, posFilter })
}

// ─────────────────────────────────────────────────────────────────────────────
// Golden-frame (negative-space) validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confirm a golden/brown frame exists in the gap between HP and MP — rejects the
 * chance coincidence of red chat text next to blue gear icons.
 */
export function validateNegativeSpace(
  img: RgbaImage,
  hp: ColorBlob | null,
  mp: ColorBlob | null,
  cfg: RoiConfig
): boolean {
  if (!hp || !mp) return false
  const xStart = hp.x + hp.width
  const xEnd = mp.x
  if (xEnd <= xStart) return false
  const yStart = Math.min(hp.y, mp.y)
  const yEnd = Math.max(hp.y + hp.height, mp.y + mp.height)
  if (yEnd <= yStart) return false

  const { width, data } = img
  let total = 0
  let hit = 0
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const di = (y * width + x) * 4
      const hsv = rgbToHsv(data[di]!, data[di + 1]!, data[di + 2]!)
      total++
      if (hsv.h >= cfg.goldenHueMin && hsv.h <= cfg.goldenHueMax && hsv.s >= cfg.goldenSatMin) hit++
    }
  }
  if (total === 0) return false
  return hit / total >= cfg.goldenFracMin
}

// ─────────────────────────────────────────────────────────────────────────────
// ink-density (edge ratio) helper
// ─────────────────────────────────────────────────────────────────────────────

/** Edge-pixel ratio in a region — high where digit/text edges live, low on flat fill. */
function inkScore(img: RgbaImage, x: number, y: number, w: number, h: number, cfg: RoiConfig): number {
  const { width: fw, height: fh, data } = img
  const xMin = Math.max(0, Math.floor(x))
  const yMin = Math.max(0, Math.floor(y))
  const xMax = Math.min(fw - 1, Math.floor(x + w))
  const yMax = Math.min(fh - 1, Math.floor(y + h))
  let edges = 0
  let total = 0
  for (let yy = yMin; yy < yMax; yy++) {
    for (let xx = xMin; xx < xMax; xx++) {
      const i = (yy * fw + xx) * 4
      const lumC = (data[i]! + data[i + 1]! + data[i + 2]!) / 3
      const lumR = (data[i + 4]! + data[i + 5]! + data[i + 6]!) / 3
      if (Math.abs(lumC - lumR) > cfg.inkEdgeThreshold) edges++
      total++
    }
  }
  return total > 0 ? edges / total : 0
}

// ─────────────────────────────────────────────────────────────────────────────
// LV text-line detection (left mini-panel)
// ─────────────────────────────────────────────────────────────────────────────

interface TextCluster {
  xStart: number
  xEnd: number
  width: number
}
interface TextLine {
  yStart: number
  yEnd: number
  height: number
  clusters: TextCluster[]
}

/**
 * Detect bright low-saturation text lines in the left mini-panel and split each into
 * horizontal column clusters. Used to derive EXP/LEVEL ROIs directly from the
 * "LEV:NN  EXP%" text when the progress bar is too thin to localize.
 */
export function findLevelTextLines(img: RgbaImage, cfg: RoiConfig): TextLine[] {
  const { width: fw, height: fh, data } = img
  const xMin = 0
  const xMax = Math.floor(fw * cfg.lvTextXRelMax)
  const yMin = Math.floor(fh * cfg.lvTextYRelMin)
  const yMax = Math.floor(fh * cfg.lvTextYRelMax)
  const isText = (r: number, g: number, b: number): boolean => {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const lum = (r + g + b) / 3
    const sat = max === 0 ? 0 : (max - min) / max
    return lum > cfg.lvTextLumMin && sat < cfg.lvTextSatMax
  }

  // Per-row text-pixel counts -> group adjacent rows into lines.
  const rowCounts: Array<{ y: number; count: number }> = []
  for (let y = yMin; y < yMax; y++) {
    let count = 0
    for (let x = xMin; x < xMax; x++) {
      const i = (y * fw + x) * 4
      if (isText(data[i]!, data[i + 1]!, data[i + 2]!)) count++
    }
    rowCounts.push({ y, count })
  }

  const lines: TextLine[] = []
  let lineStart: number | null = null
  for (let i = 0; i < rowCounts.length; i++) {
    const c = rowCounts[i]!.count
    if (c >= cfg.lvTextRowMinPixels && lineStart === null) {
      lineStart = rowCounts[i]!.y
    } else if (c < cfg.lvTextRowMinPixels && lineStart !== null) {
      const yEnd = rowCounts[i]!.y - 1
      if (rowCounts[i]!.y - lineStart >= cfg.lvTextMinLineHeight) {
        lines.push({ yStart: lineStart, yEnd, height: rowCounts[i]!.y - lineStart, clusters: [] })
      }
      lineStart = null
    }
  }
  if (lineStart !== null) {
    const last = rowCounts[rowCounts.length - 1]!
    lines.push({ yStart: lineStart, yEnd: last.y, height: last.y - lineStart, clusters: [] })
  }

  // Column clustering within each line (bridge small glyph gaps).
  for (const line of lines) {
    const colHits = new Array<number>(xMax - xMin).fill(0)
    for (let y = line.yStart; y <= line.yEnd; y++) {
      for (let x = xMin; x < xMax; x++) {
        const i = (y * fw + x) * 4
        if (isText(data[i]!, data[i + 1]!, data[i + 2]!)) colHits[x - xMin]!++
      }
    }
    const minColPixels = Math.max(1, Math.floor(line.height * 0.2))
    const clusters: TextCluster[] = []
    let cs: number | null = null
    for (let x = 0; x < colHits.length; x++) {
      if (colHits[x]! >= minColPixels) {
        if (cs === null) cs = x
      } else if (cs !== null) {
        let gapEnd = -1
        for (let nx = x + 1; nx <= Math.min(x + cfg.lvTextGapBridge, colHits.length - 1); nx++) {
          if (colHits[nx]! >= minColPixels) {
            gapEnd = nx
            break
          }
        }
        if (gapEnd > 0) {
          x = gapEnd - 1
          continue
        }
        if (x - cs >= cfg.lvTextMinClusterWidth) clusters.push({ xStart: cs, xEnd: x - 1, width: x - cs })
        cs = null
      }
    }
    if (cs !== null && colHits.length - cs >= cfg.lvTextMinClusterWidth) {
      clusters.push({ xStart: cs, xEnd: colHits.length - 1, width: colHits.length - cs })
    }
    line.clusters = clusters
  }
  return lines
}

// ─────────────────────────────────────────────────────────────────────────────
// Text-ROI derivation
// ─────────────────────────────────────────────────────────────────────────────

function toRoi(b: Box): TextRoi {
  return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height }
}

/** Find the first sufficiently-separated (>2 cluster, gap > clusterGapMin) text line. */
function findSeparatedLine(lines: TextLine[], cfg: RoiConfig): TextLine | null {
  for (const l of lines) {
    if (l.clusters.length < 2) continue
    const sorted = l.clusters.slice().sort((a, b) => a.xStart - b.xStart)
    let maxGap = 0
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]!.xStart - sorted[i - 1]!.xEnd
      if (gap > maxGap) maxGap = gap
    }
    if (maxGap > cfg.clusterGapMin) return l
  }
  return null
}

/** Split a sorted cluster list into a LEVEL box and an EXP box (or null EXP). */
function splitLevelExp(
  line: TextLine,
  frameH: number,
  padX: number,
  cfg: RoiConfig
): { level: TextRoi; exp: TextRoi | null } {
  const sorted = line.clusters.slice().sort((a, b) => a.xStart - b.xStart)
  const y = Math.max(0, line.yStart - cfg.textPadY)
  const h = Math.min(frameH - y, line.height + cfg.textPadY * 2)
  const leftMost = sorted[0]!
  const rightMost = sorted[sorted.length - 1]!

  // LEVEL = first cluster + any adjacent clusters within the merge gap.
  let lvlEnd = sorted[0]!.xEnd
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.xStart - lvlEnd <= cfg.levelClusterMergeGap) lvlEnd = sorted[i]!.xEnd
    else break
  }
  // EXP = first cluster clearly past the LEVEL group.
  let expStartX = -1
  for (const c of sorted) {
    if (c.xStart > lvlEnd + cfg.clusterGapMin) {
      expStartX = c.xStart
      break
    }
  }

  const level: TextRoi = toRoi({
    x: Math.max(0, leftMost.xStart - padX),
    y,
    width: lvlEnd - leftMost.xStart + padX * 2,
    height: h
  })
  const exp: TextRoi | null =
    expStartX >= 0
      ? toRoi({
          x: Math.max(0, expStartX - padX),
          y,
          width: rightMost.xEnd - expStartX + padX * 2,
          height: h
        })
      : null
  return { level, exp }
}

/**
 * Trim a LEVEL text ROI down to just the value digits when it also captured the
 * "LEV:" label (the in-game level display is "LEV:NN", one visual group). Binarizes
 * the ROI the SAME way the recognizer does ({@link binarizeAuto}) and groups ink
 * columns into glyph runs; if a clear separator gap exists, keeps only the trailing
 * 1-3 runs to the RIGHT of the rightmost separator — the value. Returns the box
 * unchanged when there is no label prefix (≤1 run, or no gap clearly larger than the
 * inter-digit spacing — e.g. a clean "NN" crop).
 *
 * Field evidence (2026-06-13): the auto ROI captured "LEV:33" → OCR read "660133"
 * → parseLevel(null), rejected every tick. The first cut used an absolute brightness
 * gate (lum>180) that the renderer's screen-capture (dimmer than PrintWindow) fell
 * below, so it found no glyphs and never trimmed on the actual device. Using the
 * recognizer's adaptive binarization makes glyph detection match what actually gets
 * OCR'd, so the trim fires wherever the text is readable. Glyph runs L E V : 3 3 have
 * a label↔value gap (~6px) wider than the inter-digit gap (~3px); splitting at the
 * rightmost large gap isolates "33".
 */
export function refineLevelRoiToValue(img: RgbaImage, roi: TextRoi, cfg: RoiConfig): TextRoi {
  const { width: fw } = img
  const x0 = Math.max(0, roi.x0)
  const x1 = Math.min(fw, roi.x1)
  const y0 = Math.max(0, roi.y0)
  const y1 = Math.min(img.height, roi.y1)
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return roi

  // Adaptive binarization (same path as the recognizer) → per-column ink counts.
  // Keying on the binarized glyph mask (not an absolute brightness gate) makes the
  // trim robust to capture-method brightness differences.
  const crop = cropImage(img, { x0, y0, x1, y1 })
  const mask = binarizeAuto(crop)
  const ink = columnInk(mask) // ink pixels per column (length w)
  const onThreshold = Math.max(1, Math.floor(h * 0.12))

  // Group columns into glyph runs.
  const runs: Array<{ s: number; e: number }> = []
  let st = -1
  for (let x = 0; x <= w; x++) {
    const on = x < w && (ink[x] ?? 0) >= onThreshold
    if (on && st < 0) st = x
    else if (!on && st >= 0) {
      runs.push({ s: st, e: x - 1 })
      st = -1
    }
  }
  if (runs.length <= 1) return roi // single glyph / solid block — no label to strip

  const gaps: number[] = []
  for (let i = 1; i < runs.length; i++) gaps.push(runs[i]!.s - runs[i - 1]!.e)
  const sorted = gaps.slice().sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  // A separator gap is clearly wider than the inter-digit spacing.
  const sepThreshold = Math.max(5, median * 1.5)

  // Rightmost separator whose right side is a plausible 1-3 digit value.
  for (let i = gaps.length - 1; i >= 0; i--) {
    if (gaps[i]! < sepThreshold) continue
    const rightCount = runs.length - (i + 1)
    if (rightCount < 1 || rightCount > 3) continue
    const valStart = runs[i + 1]!.s
    const valEnd = runs[runs.length - 1]!.e
    const pad = 3
    return {
      ...roi,
      x0: Math.max(0, x0 + valStart - pad),
      x1: Math.min(fw, x0 + valEnd + 1 + pad)
    }
  }
  return roi
}

/**
 * Tighten a derived ROI to the bounding box of its bright low-saturation pixels —
 * the white HUD digits. This keys on the TEXT's own colour, so it drops the yellow
 * coin icon (high saturation) and the dark inventory-cell borders (low brightness)
 * that a geometric box around the adena number inevitably catches. Returns the box
 * unchanged when no text-like region is found (e.g. synthetic icon-only frames), so
 * an ROI is never lost.
 *
 * Field evidence (2026-06-13): the adena number "16476" sits in a tight cell right
 * under the coin icon; the geometric box bled coin/border pixels → OCR "154058".
 */
export function tightenToTextBBox(img: RgbaImage, roi: TextRoi, cfg: RoiConfig, pad: number): TextRoi {
  const { width: fw, data } = img
  const x0 = Math.max(0, roi.x0)
  const x1 = Math.min(fw, roi.x1)
  const y0 = Math.max(0, roi.y0)
  const y1 = Math.min(img.height, roi.y1)
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return roi

  const isText = (i: number): boolean => {
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const lum = (r + g + b) / 3
    const sat = max === 0 ? 0 : (max - min) / max
    return lum > cfg.lvTextLumMin && sat < cfg.lvTextSatMax
  }

  // Column/row text-pixel counts; require >=2 to ignore stray AA pixels.
  const colOn = new Array<boolean>(w).fill(false)
  const rowOn = new Array<boolean>(h).fill(false)
  const colCnt = new Array<number>(w).fill(0)
  const rowCnt = new Array<number>(h).fill(0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isText(((y0 + y) * fw + (x0 + x)) * 4)) {
        colCnt[x]!++
        rowCnt[y]!++
      }
    }
  }
  for (let x = 0; x < w; x++) colOn[x] = colCnt[x]! >= 2
  for (let y = 0; y < h; y++) rowOn[y] = rowCnt[y]! >= 2

  let cMin = -1
  let cMax = -1
  for (let x = 0; x < w; x++) if (colOn[x]) { if (cMin < 0) cMin = x; cMax = x }
  let rMin = -1
  let rMax = -1
  for (let y = 0; y < h; y++) if (rowOn[y]) { if (rMin < 0) rMin = y; rMax = y }
  if (cMin < 0 || rMin < 0) return roi // no text found — keep original box

  return {
    ...roi,
    x0: Math.max(0, x0 + cMin - pad),
    y0: Math.max(0, y0 + rMin - pad),
    x1: Math.min(fw, x0 + cMax + 1 + pad),
    y1: Math.min(img.height, y0 + rMax + 1 + pad)
  }
}

function deriveTextRois(img: RgbaImage, anchors: UiAnchors, cfg: RoiConfig): DerivedTextRois {
  const frameW = img.width
  const frameH = img.height
  const { hp, mp, exp, adena } = anchors
  const out: DerivedTextRois = { mp: null, exp: null, level: null, adena: null }

  if (mp) {
    const mpFullWidth = Math.max(mp.width, hp ? hp.width : 0, cfg.mpTextMinWidth)
    out.mp = toRoi({
      x: Math.round(mp.x + cfg.mpTextXInset),
      y: Math.round(mp.y),
      width: Math.round(Math.max(0, mpFullWidth - cfg.mpTextXInset)),
      height: Math.round(mp.height)
    })
  }

  if (exp) {
    const useExpand = exp.height < cfg.expThinBarHeight
    const expXBar = Math.round(exp.x + exp.width * cfg.expTextXFrac)
    const expWBar = Math.max(cfg.expTextMinWidth, Math.round(exp.width * cfg.expTextWFrac))
    const lvlXBar = Math.round(exp.x)
    const lvlWBar = Math.max(cfg.levelTextMinWidth, Math.round(exp.width * cfg.levelTextWFrac))

    if (useExpand) {
      const lines = findLevelTextLines(img, cfg)
      const lvLine = findSeparatedLine(lines, cfg)
      if (lvLine) {
        const { level, exp: expRoi } = splitLevelExp(lvLine, frameH, cfg.textPadXExpand, cfg)
        out.level = level
        out.exp = expRoi // may be null when EXP cluster cannot be separated
      } else {
        // Fallback: ink-score sweep above/below the thin bar for the text band.
        const textH = Math.max(18, Math.round(exp.height * 4))
        const overlapsHp = (roiY: number, roiH: number): boolean => {
          if (!hp) return false
          return Math.min(roiY + roiH, hp.y + hp.height) - Math.max(roiY, hp.y) > 0
        }
        const yCands: number[] = []
        const step = Math.max(6, Math.floor(textH / 3))
        for (let dy = -textH * 3; dy <= -textH + 2; dy += step) {
          const y2 = exp.y + dy
          if (y2 >= 0 && y2 + textH <= frameH) yCands.push(y2)
        }
        for (let dy = exp.height + 1; dy <= textH * 4; dy += step) {
          const y2 = exp.y + dy
          if (y2 >= 0 && y2 + textH <= frameH) yCands.push(y2)
        }
        let bestY: number | null = null
        let bestScore = -1
        for (const y of yCands) {
          if (overlapsHp(y, textH)) continue
          const s = inkScore(img, expXBar, y, expWBar, textH, cfg)
          if (s > bestScore) {
            bestScore = s
            bestY = y
          }
        }
        if (bestY === null) bestY = Math.max(0, exp.y - textH - 1)
        out.exp = toRoi({ x: expXBar, y: Math.round(bestY), width: expWBar, height: textH })
        out.level = toRoi({ x: lvlXBar, y: Math.round(bestY), width: lvlWBar, height: textH })
      }
    } else {
      // Thick bar: prefer a nearby separated text line; else simple proportional split.
      let usedTextLine = false
      const lines = findLevelTextLines(img, cfg)
      const near = lines.filter((l) => Math.abs(l.yStart - exp.y) <= cfg.expNearBarY)
      const candLine =
        near.find((l) => l.clusters.length >= 2) ?? lines.find((l) => l.clusters.length >= 2) ?? null
      if (candLine) {
        const { level, exp: expRoi } = splitLevelExp(candLine, frameH, cfg.textPadXThick, cfg)
        if (expRoi) {
          out.level = level
          out.exp = expRoi
          usedTextLine = true
        }
      }
      if (!usedTextLine) {
        out.exp = toRoi({ x: expXBar, y: Math.round(exp.y), width: expWBar, height: Math.round(exp.height) })
        out.level = toRoi({ x: lvlXBar, y: Math.round(exp.y), width: lvlWBar, height: Math.round(exp.height) })
      }
    }
  }

  if (exp && out.level) {
    // Strip the "LEV:" label from the level ROI, keeping only the value digits.
    out.level = refineLevelRoiToValue(img, out.level, cfg)
  }

  if (adena) {
    const right: Box = {
      x: Math.round(adena.x + adena.width * cfg.adenaRightXFrac),
      y: Math.round(adena.y + adena.height * cfg.adenaRightYFrac),
      width: Math.max(cfg.adenaRightMinWidth, Math.round(adena.width * cfg.adenaRightWFrac)),
      height: Math.round(adena.height * cfg.adenaRightHFrac)
    }
    // The "below" number sits UNDER the coin icon — start the box at the icon's
    // bottom edge, not partway up it. adenaBelowYFrac (0.83) clipped ~5px into a
    // 32px icon, whose yellow pixels segmented as a phantom leading digit
    // ("16476" → "115476", field 2026-06-13). Clamp the top to the icon bottom.
    const belowY = Math.max(
      Math.round(adena.y + adena.height * cfg.adenaBelowYFrac),
      Math.round(adena.y + adena.height)
    )
    const below: Box = {
      x: Math.max(0, Math.round(adena.x - cfg.adenaBelowXShift)),
      y: belowY,
      width: Math.max(cfg.adenaBelowMinWidth, Math.round(adena.width * cfg.adenaBelowWFrac)),
      height: Math.max(cfg.adenaBelowMinHeight, Math.round(adena.height * cfg.adenaBelowHFrac))
    }
    let chosen = right
    const rs = inkScore(img, right.x, right.y, right.width, right.height, cfg)
    const bs = inkScore(img, below.x, below.y, below.width, below.height, cfg)
    if (bs > rs * cfg.adenaBelowInkRatio) chosen = below
    // Tighten to the white-digit bbox so the yellow coin icon and the inventory-cell
    // borders the geometric box catches don't bleed phantom glyphs into the OCR.
    out.adena = tightenToTextBBox(img, toRoi(chosen), cfg, 2)
  }

  // Frame-boundary clamp — record clipping for diagnostics.
  for (const key of ['mp', 'exp', 'level', 'adena'] as const) {
    const r = out[key]
    if (!r) continue
    const intendedWidth = r.x1 - r.x0
    const intendedHeight = r.y1 - r.y0
    if (r.x0 < 0) r.x0 = 0
    if (r.y0 < 0) r.y0 = 0
    if (r.x1 > frameW) r.x1 = frameW
    if (r.y1 > frameH) r.y1 = frameH
    if (r.x1 < r.x0) r.x1 = r.x0
    if (r.y1 < r.y0) r.y1 = r.y0
    if (r.x1 - r.x0 < intendedWidth || r.y1 - r.y0 < intendedHeight) {
      r.clipped = true
      r.intendedWidth = intendedWidth
      r.intendedHeight = intendedHeight
    }
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// ROI validation
// ─────────────────────────────────────────────────────────────────────────────

interface Validation {
  valid: boolean
  issues: string[]
  adenaIssues: string[]
}

function roiW(r: GlyphBox): number {
  return r.x1 - r.x0
}
function roiH(r: GlyphBox): number {
  return r.y1 - r.y0
}

function validateRois(
  rois: DerivedTextRois,
  anchors: UiAnchors,
  frameW: number,
  frameH: number,
  cfg: RoiConfig
): Validation {
  const issues: string[] = []
  const adenaIssues: string[] = []

  const checkRoi = (name: string, r: TextRoi | null): boolean => {
    const push = (msg: string): void => {
      if (name === 'adena') adenaIssues.push(msg)
      else issues.push(msg)
    }
    if (!r) {
      push(`${name} ROI 누락`)
      return false
    }
    const w = roiW(r)
    const h = roiH(r)
    if (w <= cfg.roiMinWidth || h <= cfg.roiMinHeight) {
      push(`${name} ROI 너무 작음 (${w}x${h})`)
      return false
    }
    if (r.x0 < 0 || r.y0 < 0 || r.x1 > frameW || r.y1 > frameH) {
      push(`${name} ROI 경계 초과`)
      return false
    }
    if (name === 'adena' && w < cfg.adenaRoiMinWidth) {
      if (r.clipped && r.intendedWidth != null) {
        const need = r.intendedWidth - w + 10
        adenaIssues.push(
          `ADENA ROI 우측 클램프 (의도 ${r.intendedWidth}px → ${w}px) — 게임 영역을 우측으로 ${need}px 이상 확장해주세요`
        )
      } else {
        adenaIssues.push(`ADENA ROI 폭 부족 (${w}px<${cfg.adenaRoiMinWidth}) — 게임 영역을 우측으로 넓게 다시 지정해주세요`)
      }
      return false
    }
    return true
  }

  const okMp = checkRoi('mp', rois.mp)
  const okExp = checkRoi('exp', rois.exp)
  checkRoi('level', rois.level)
  const okAdena = checkRoi('adena', rois.adena)

  const { hp, mp, exp, adena } = anchors
  if (hp && mp && mp.x <= hp.x + hp.width) issues.push('MP 바가 HP 바 우측에 있지 않음')
  if (hp && exp) {
    const yDist = Math.abs(exp.y - hp.y)
    const tolerance = (hp.height + exp.height) * 4 + 30
    if (yDist > tolerance) issues.push(`EXP 바가 HP 바와 너무 멀리 있음 (${yDist}px > ${tolerance}px)`)
  }
  if (exp && adena && rois.exp && rois.adena && rois.adena.x0 <= rois.exp.x0) {
    issues.push('ADENA가 EXP 좌측에 있음')
  }

  if (exp && exp.width < cfg.expMinWidth) {
    issues.push(`expBar 후보 너무 짧음 (${exp.width}px<${cfg.expMinWidth}) — orange element 오인 가능성`)
  }
  if (rois.exp && roiW(rois.exp) < cfg.expRoiMinWidth) {
    issues.push(`EXP textROI 폭 너무 좁음 (${roiW(rois.exp)}px<${cfg.expRoiMinWidth})`)
  }
  if (rois.level && roiW(rois.level) < cfg.levelRoiMinWidth) {
    issues.push(`LEVEL textROI 폭 너무 좁음 (${roiW(rois.level)}px<${cfg.levelRoiMinWidth})`)
  }

  void okMp
  void okExp
  void okAdena

  return {
    valid: issues.length === 0,
    issues: [...issues, ...adenaIssues],
    adenaIssues
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect HP / MP / EXP / ADENA anchors and derive their text ROIs from a captured
 * frame. Pure: no DOM, no node, no wall-clock reads.
 */
export function detectGameUI(img: RgbaImage, opts: DetectOptions = {}): DetectResult {
  const cfg: RoiConfig = { ...DEFAULT_ROI_CONFIG, ...opts.config }
  const w = img.width
  const h = img.height
  const issues: string[] = []

  const hpCands = findHpBarCandidates(img, cfg).slice(0, cfg.hpTopK)
  const expCands = findExpBarCandidates(img, cfg).slice(0, cfg.expTopK)
  const adenaCands = findAdenaIconCandidates(img, cfg).slice(0, cfg.adenaTopK)

  if (hpCands.length === 0) issues.push('HP 바 미탐지 (빨강)')
  if (expCands.length === 0) issues.push('EXP 바 미탐지 (오렌지)')
  if (adenaCands.length === 0) issues.push('ADENA 아이콘 미탐지 (노랑)')

  // Combinatorial layout validation — accept the first self-consistent tuple.
  let chosenHp: ColorBlob | null = null
  let chosenMp: ColorBlob | null = null
  let chosenExp: ColorBlob | null = null
  let chosenAdena: ColorBlob | null = null
  let triedCombos = 0

  outer: for (const hp of hpCands) {
    const mpCands = findMpBarCandidates(img, cfg, hp).slice(0, cfg.mpTopK)
    for (const exp of expCands) {
      const yDist = Math.abs(exp.y - hp.y)
      const yTolerance = (hp.height + exp.height) * 4 + 30
      if (yDist > yTolerance) continue
      for (const mp of mpCands) {
        if (mp.x <= hp.x + hp.width) continue
        if (!validateNegativeSpace(img, hp, mp, cfg)) continue
        for (const ad of adenaCands) {
          triedCombos++
          const tentAnchors: UiAnchors = { hp, mp, exp, adena: ad }
          const tentRois = deriveTextRois(img, tentAnchors, cfg)
          if (tentRois.adena && tentRois.exp && tentRois.adena.x0 > tentRois.exp.x0) {
            chosenHp = hp
            chosenMp = mp
            chosenExp = exp
            chosenAdena = ad
            break outer
          }
        }
      }
    }
  }

  // Fallback to top candidates when no tuple validated.
  if (!chosenHp) chosenHp = hpCands[0] ?? null
  if (!chosenExp) chosenExp = expCands[0] ?? null
  if (!chosenAdena) chosenAdena = adenaCands[0] ?? null
  if (!chosenMp && chosenHp) chosenMp = findMpBarCandidates(img, cfg, chosenHp)[0] ?? null
  if (!chosenMp) issues.push('MP 바 미탐지 (파랑)')

  const tupleFound = !!(
    chosenHp &&
    chosenMp &&
    chosenExp &&
    chosenAdena &&
    Math.abs(chosenExp.y - chosenHp.y) <= (chosenHp.height + chosenExp.height) * 4 + 30 &&
    chosenMp.x > chosenHp.x + chosenHp.width &&
    validateNegativeSpace(img, chosenHp, chosenMp, cfg)
  )
  if (!tupleFound && hpCands.length && expCands.length) {
    issues.push(
      `레이아웃 검증 통과 조합 없음 (HP×EXP×ADENA ${hpCands.length}×${expCands.length}×${adenaCands.length} 시도, ${triedCombos} 조합)`
    )
  }
  if (!tupleFound && chosenHp && chosenMp && !validateNegativeSpace(img, chosenHp, chosenMp, cfg)) {
    issues.push('HP/MP 사이 황금 프레임 미확인 (false positive 가능)')
  }

  const anchors: UiAnchors = { hp: chosenHp, mp: chosenMp, exp: chosenExp, adena: chosenAdena }
  const textRois = deriveTextRois(img, anchors, cfg)
  const validation = validateRois(textRois, anchors, w, h, cfg)
  issues.push(...validation.issues)

  return {
    anchors,
    textRois,
    valid: !!(validation.valid && chosenHp && chosenMp && chosenExp && chosenAdena),
    issues
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scale-normalized entry point (for window-capture / HiDPI frames)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reference frame width the {@link DEFAULT_ROI_CONFIG} absolute-pixel thresholds
 * (expMinWidth, mpTextMinWidth, lvText pixel gates, …) were tuned at. Frames much
 * wider than this (whole game windows, HiDPI physical-pixel captures) are
 * downscaled to this width before detection so the thresholds stay valid.
 */
export const DETECTION_REFERENCE_WIDTH = 1280

function scaleTextRoi(r: TextRoi | null, k: number, fw: number, fh: number): TextRoi | null {
  if (!r) return null
  const x0 = Math.max(0, Math.min(fw, Math.round(r.x0 * k)))
  const y0 = Math.max(0, Math.min(fh, Math.round(r.y0 * k)))
  const x1 = Math.max(x0, Math.min(fw, Math.round(r.x1 * k)))
  const y1 = Math.max(y0, Math.min(fh, Math.round(r.y1 * k)))
  const out: TextRoi = { x0, y0, x1, y1 }
  if (r.clipped) {
    out.clipped = true
    if (r.intendedWidth != null) out.intendedWidth = Math.round(r.intendedWidth * k)
    if (r.intendedHeight != null) out.intendedHeight = Math.round(r.intendedHeight * k)
  }
  return out
}

function scaleBlob(b: ColorBlob | null, k: number): ColorBlob | null {
  if (!b) return null
  return {
    x: Math.round(b.x * k),
    y: Math.round(b.y * k),
    width: Math.round(b.width * k),
    height: Math.round(b.height * k),
    area: Math.round(b.area * k * k),
    avgHue: b.avgHue,
    avgSat: b.avgSat
  }
}

/**
 * Like {@link detectGameUI} but scale-normalized: a frame wider than
 * {@link DETECTION_REFERENCE_WIDTH} is area-averaged down to that width before
 * detection (so the px-tuned config stays valid), then the resulting anchors/ROIs
 * are scaled back to the ORIGINAL frame's pixel space. Frames at/below the
 * reference width are detected natively (no scaling). Pure — no DOM/node/clock.
 *
 * This is the entry point window-capture mode uses: it feeds the whole game-window
 * frame (any size / DPI) and gets ROIs in that frame's own physical pixels, ready
 * to crop with `captureRegion` (scaleFactor=1) directly.
 */
export function detectGameUiScaled(img: RgbaImage, opts: DetectOptions = {}): DetectResult {
  const refW = DETECTION_REFERENCE_WIDTH
  if (img.width <= Math.round(refW * 1.15)) return detectGameUI(img, opts)

  const targetH = Math.max(1, Math.round(img.height * (refW / img.width)))
  const small = scaleToHeight(img, targetH)
  if (small.width >= img.width) return detectGameUI(img, opts) // safety: no downscale happened

  const res = detectGameUI(small, opts)
  const k = img.width / small.width
  const fw = img.width
  const fh = img.height
  return {
    anchors: {
      hp: scaleBlob(res.anchors.hp, k),
      mp: scaleBlob(res.anchors.mp, k),
      exp: scaleBlob(res.anchors.exp, k),
      adena: scaleBlob(res.anchors.adena, k)
    },
    textRois: {
      mp: scaleTextRoi(res.textRois.mp, k, fw, fh),
      exp: scaleTextRoi(res.textRois.exp, k, fw, fh),
      level: scaleTextRoi(res.textRois.level, k, fw, fh),
      adena: scaleTextRoi(res.textRois.adena, k, fw, fh)
    },
    valid: res.valid,
    issues: res.issues
  }
}
