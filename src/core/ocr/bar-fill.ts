/**
 * MP-bar pixel-fill measurement — the primary, OCR-free MP source.
 *
 * The MP gauge fills left-to-right with a known colour. Counting how many columns
 * are "filled" gives the fill ratio directly, with none of the digit-confusion of
 * reading the small "cur/max" text. Calibrated once at 100% MP, then
 *   cur = round(maxMp * filledColumns / calibratedFullColumns).
 *
 * This is the single most reliable signal in the whole system and should be the
 * default for MP whenever a bar ROI is available.
 *
 * ROBUSTNESS (v3.0.1) — two field-observed failure modes are now handled:
 *
 *  1. SATURATION. When the gauge's empty track is a colour close to the fill
 *     (e.g. a muddy brown fill over a slightly darker brown track), a single fixed
 *     colour tolerance counts empty columns as "filled" and the bar reads ~full
 *     forever even as MP drains. We now sample the empty-track colour from the far
 *     right of the bar and classify each column *relatively* (closer to fill than to
 *     track), which separates the two even when they are similar.
 *
 *  2. TRANSIENT OCCLUSION. A skill effect / floating combat text / a mob standing in
 *     front of the gauge punches a hole in the fill. The old left-to-right "stop at
 *     the first gap" scan truncated at that hole and reported a false near-empty
 *     value. We now find the boundary by scanning from the RIGHT for the rightmost
 *     locally-dense fill edge, so an interior hole cannot truncate the measurement
 *     and isolated stray columns cannot inflate it.
 *
 * CALIBRATION VALIDITY (v3.0.2) — a third field-observed failure mode:
 *
 *  3. OVERSIZED ROI / FALSE-SUCCESS CALIBRATION. A user drew a 287x47 ROI around a
 *     ~12px gauge strip. `detectFillColor` then averaged the brown UI PANEL (which
 *     passes the luma/saturation gate) and `calibrateBar`'s only gate
 *     (filledColumns >= width*0.5) happily reported "보정 완료 (277 cols)" — with a
 *     reference colour of rgb(111.5, 91.6, 78.6), a colour the blue MP gauge can
 *     never produce. Replaying that calibration pins MP at max forever.
 *     `calibrateBarChecked` now (a) auto-shrinks the ROI rows to the blue-dominant
 *     gauge band (shrink-to-band), (b) REJECTS any calibration whose fill colour is
 *     not blue-dominant, and (c) self-verifies the calibration by re-measuring the
 *     same ROI (expected ratio ≈ 1.0 at 100% MP).
 */
import type { RgbaImage } from './types'

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface BarFillOptions {
  /** Calibrated fill colour. If omitted, it is auto-detected from the left interior. */
  refColor?: Rgb
  /**
   * Empty-track colour. If omitted, it is auto-detected from the far-right of the bar
   * (which is empty whenever MP < ~100%). When present, columns are classified by
   * relative distance (closer to fill than to track) — this is what defeats
   * saturation when fill and track colours are similar.
   */
  emptyColor?: Rgb
  /** Max RGB euclidean distance to count a pixel as "fill". Default 70. */
  colorTolerance?: number
  /** Fraction of a column's rows that must be fill for the column to count. Default 0.3. */
  minColumnDensity?: number
  /**
   * Restrict measurement to this row band [y0, y1) of the image — the gauge strip
   * detected at calibration time (shrink-to-band). Lets an oversized ROI measure
   * only the actual gauge rows.
   */
  rowBand?: RowBand
  /** @deprecated No longer used — the boundary is now found by a right-to-left dense-edge scan. */
  maxGap?: number
}

export interface BarFillResult {
  filledColumns: number
  totalColumns: number
  ratio: number
  fillColor: Rgb | null
  /** The empty-track colour used for relative classification, or null (absolute mode). */
  emptyColor: Rgb | null
}

/**
 * Minimum fill↔track euclidean contrast (squared) below which the far-right sample is
 * treated as "this bar is full, no usable empty sample" — falls back to absolute mode.
 */
const MIN_FILL_EMPTY_CONTRAST2 = 18 * 18

// ── Calibration validity constants (v3.0.2) ─────────────────────────────────
/**
 * Blue-dominance margin for the FINAL colour gate {@link isBlueDominant}: a colour
 * counts as a plausible MP-gauge fill when `b > max(r, g) + BLUE_DOMINANCE_MARGIN`.
 * The Lineage Classic MP gauge is always blue; the field-observed garbage
 * calibration rgb(111.5, 91.6, 78.6) (brown UI panel learned from an oversized
 * ROI) fails this by a wide margin.
 *
 * v3.1.1: stays 15. The 2026-06-07 field failure was never this final gate — the
 * saturation gate starved the sample and the mixed mean got dragged by gold trim;
 * with the blue-cluster mean (see {@link detectFillColor}) the learned colour's
 * margin is ~18 and clears 15 comfortably. Keeping 15 preserves the whole v3.0.2
 * false-success defence: uniform blue-grays (shadow/water, margin 9–15, e.g.
 * rgb(70,70,80)) and purples stay rejected, and legacy stored calibrations that
 * v3.0.2 invalidated stay invalid. Only the per-pixel band VOTE is relaxed
 * ({@link BAND_PIXEL_VOTE_MARGIN}).
 */
export const BLUE_DOMINANCE_MARGIN = 15
/**
 * Per-pixel vote margin for gauge row-band detection ({@link detectGaugeRowBand}).
 *
 * v3.1.1: 15 → 8 for the vote ONLY. The field gauge body clears max(r,g) by just
 * 18 and gloss/dither speckle drops individual pixels to ~4, so with 15 a single
 * texture step flipped rows below the 50% threshold — the band collapsed and the
 * gold trim entered the fill-colour sample. The calibration colour itself is still
 * gated by isBlueDominant at 15, so the looser vote cannot admit a non-blue
 * calibration on its own.
 */
const BAND_PIXEL_VOTE_MARGIN = 8
/**
 * Fraction of a row's pixels that must be blue-dominant for the row to count as
 * part of the gauge band during shrink-to-band (calibration happens at ~100% MP,
 * so gauge rows are blue across most of their width).
 */
const BAND_MIN_ROW_FRACTION = 0.5
/** Minimum usable gauge-band height (rows); thinner runs are treated as noise. */
const MIN_BAND_HEIGHT = 2
/**
 * Saturation gate for fill-colour sampling in {@link detectFillColor}.
 *
 * v3.1.1: 0.25 → 0.12. The field MP gauge's dark blue measures saturation
 * 0.163–0.196 (body rgb(74,74,92) → (92−74)/92 ≈ 0.196), which the old 0.25 gate
 * rejected wholesale — the gold trim (sat 0.50) was then the only survivor, so the
 * "detected fill colour" came out brown rgb(192,142,96) and calibration failed
 * with not_blue forever (HANDOFF-2026-06-07, reproduced in
 * test/debug/dbg-mpcal-sat-gate.test.ts). 0.12 accepts every observed gauge shade
 * while still excluding white overlay text (sat ≤ ~0.05) and the dark empty track
 * (blocked by the luma gate).
 */
const FILL_SATURATION_GATE = 0.12

/** Row band [y0, y1) within a bar ROI. */
export interface RowBand {
  y0: number
  y1: number
}

/** Whether a colour is a plausible MP-gauge fill (blue-dominant). */
export function isBlueDominant(c: Rgb): boolean {
  return c.b > Math.max(c.r, c.g) + BLUE_DOMINANCE_MARGIN
}

function dist2(a: Rgb, r: number, g: number, b: number): number {
  const dr = a.r - r
  const dg = a.g - g
  const db = a.b - b
  return dr * dr + dg * dg + db * db
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

/**
 * Auto-detect the fill colour by averaging the most saturated/bright pixels in the
 * left interior of the bar (which is filled whenever MP > 0).
 *
 * v3.1.1 blue-cluster priority: gate-passing pixels are additionally split into a
 * blue-leaning cluster (b > max(r, g)). When that cluster is both sufficient and
 * the majority, its mean is returned INSTEAD of the mixed mean — otherwise a few
 * percent of gold-trim contamination in the sample drags the mixed mean below the
 * blue-dominance gate and calibration fails not_blue even though the gauge itself
 * is perfectly visible. A brown-panel-only ROI has an empty blue cluster and still
 * falls through to the mixed (brown) mean, so the false-success rejection path is
 * preserved.
 */
export function detectFillColor(img: RgbaImage): Rgb | null {
  const { width, height, data } = img
  const x1 = Math.max(1, Math.floor(width * 0.25))
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  let blueR = 0
  let blueG = 0
  let blueB = 0
  let blueN = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < x1; x++) {
      const p = (y * width + x) * 4
      const pr = data[p]!
      const pg = data[p + 1]!
      const pb = data[p + 2]!
      const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb
      if (lum > 40 && saturation(pr, pg, pb) > FILL_SATURATION_GATE) {
        r += pr
        g += pg
        b += pb
        n++
        if (pb > Math.max(pr, pg)) {
          blueR += pr
          blueG += pg
          blueB += pb
          blueN++
        }
      }
    }
  }
  // v3.1.1: the sample floor is area-proportional (5% of the sampled left quarter),
  // not just height*0.5 (~0.7% of the area) — otherwise a handful of noise outliers
  // on a below-gate uniform colour could define the fill colour by lottery. The
  // field gauge passes the gate with 55–100% of its pixels, far above the floor.
  const minSamples = Math.max(height * 0.5, x1 * height * 0.05)
  if (n < minSamples) return null
  if (blueN >= minSamples && blueN * 2 >= n) {
    return { r: blueR / blueN, g: blueG / blueN, b: blueB / blueN }
  }
  return { r: r / n, g: g / n, b: b / n }
}

/**
 * Auto-detect the empty-track colour from the far-right of the bar. Whenever MP is
 * below ~100% those columns are the empty gauge track. Returns null when the sample
 * is basically the fill colour (bar is full → no usable empty reference).
 */
export function detectEmptyColor(
  img: RgbaImage,
  fillColor: Rgb,
  sampleFrac = 0.08
): Rgb | null {
  const { width, height, data } = img
  if (width === 0 || height === 0) return null
  const x0 = Math.max(0, width - Math.max(2, Math.floor(width * sampleFrac)))
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = 0; y < height; y++) {
    for (let x = x0; x < width; x++) {
      const p = (y * width + x) * 4
      r += data[p]!
      g += data[p + 1]!
      b += data[p + 2]!
      n++
    }
  }
  if (n === 0) return null
  const mean: Rgb = { r: r / n, g: g / n, b: b / n }
  if (dist2(mean, fillColor.r, fillColor.g, fillColor.b) < MIN_FILL_EMPTY_CONTRAST2) return null
  return mean
}

/**
 * Find the gauge strip inside a (possibly oversized) bar ROI: the tallest run of
 * consecutive rows whose pixels are mostly blue-dominant. Returns null when no such
 * band exists (ROI does not contain a mostly-filled blue gauge).
 */
export function detectGaugeRowBand(img: RgbaImage): RowBand | null {
  const { width, height, data } = img
  if (width === 0 || height === 0) return null
  const need = Math.max(1, Math.ceil(width * BAND_MIN_ROW_FRACTION))
  let bestY0 = -1
  let bestY1 = -1
  let runStart = -1
  for (let y = 0; y <= height; y++) {
    let isBand = false
    if (y < height) {
      let cnt = 0
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4
        const r = data[p]!
        const g = data[p + 1]!
        const b = data[p + 2]!
        if (b > Math.max(r, g) + BAND_PIXEL_VOTE_MARGIN) cnt++
      }
      isBand = cnt >= need
    }
    if (isBand) {
      if (runStart < 0) runStart = y
    } else if (runStart >= 0) {
      if (y - runStart > bestY1 - bestY0) {
        bestY0 = runStart
        bestY1 = y
      }
      runStart = -1
    }
  }
  if (bestY0 < 0 || bestY1 - bestY0 < MIN_BAND_HEIGHT) return null
  return { y0: bestY0, y1: bestY1 }
}

/** Zero-copy view of an image restricted to a row band (rows are contiguous). */
export function cropRows(img: RgbaImage, band: RowBand): RgbaImage {
  const y0 = Math.max(0, Math.min(img.height, Math.floor(band.y0)))
  const y1 = Math.max(y0, Math.min(img.height, Math.floor(band.y1)))
  return {
    width: img.width,
    height: y1 - y0,
    data: img.data.subarray(y0 * img.width * 4, y1 * img.width * 4)
  }
}

export function computeBarFill(img: RgbaImage, opts: BarFillOptions = {}): BarFillResult {
  if (opts.rowBand) {
    const { rowBand, ...rest } = opts
    return computeBarFill(cropRows(img, rowBand), rest)
  }
  const { width, height, data } = img
  const tolerance = opts.colorTolerance ?? 70
  const minDensity = opts.minColumnDensity ?? 0.3
  const refColor = opts.refColor ?? detectFillColor(img)

  if (!refColor || width === 0 || height === 0) {
    return { filledColumns: 0, totalColumns: width, ratio: 0, fillColor: refColor ?? null, emptyColor: null }
  }

  const emptyColor = opts.emptyColor ?? detectEmptyColor(img, refColor)
  const tol2 = tolerance * tolerance
  const need = Math.max(1, Math.floor(height * minDensity))

  // 1) Classify each column as fill / not-fill. With an empty-track reference we use
  //    relative distance (closer to fill than to track) so a similar-coloured track
  //    is still rejected; otherwise we fall back to an absolute tolerance.
  const colFilled: boolean[] = new Array(width)
  for (let x = 0; x < width; x++) {
    let cnt = 0
    for (let y = 0; y < height; y++) {
      const p = (y * width + x) * 4
      const r = data[p]!
      const g = data[p + 1]!
      const b = data[p + 2]!
      const dFill = dist2(refColor, r, g, b)
      let isFill: boolean
      if (emptyColor) {
        const dEmpty = dist2(emptyColor, r, g, b)
        isFill = dFill < dEmpty && dFill <= tol2
      } else {
        isFill = dFill <= tol2
      }
      if (isFill) cnt++
    }
    colFilled[x] = cnt >= need
  }

  // 2) Boundary = rightmost filled column that has local fill support. Scanning from
  //    the right means a transient interior occlusion (a hole in an otherwise full
  //    bar) cannot truncate the measurement, while the local-density gate prevents an
  //    isolated stray column on the right from inflating it.
  const win = Math.max(3, Math.round(width * 0.04))
  let boundary = -1
  for (let x = width - 1; x >= 0; x--) {
    if (!colFilled[x]) continue
    let cnt = 0
    let tot = 0
    for (let k = Math.max(0, x - win + 1); k <= x; k++) {
      tot++
      if (colFilled[k]) cnt++
    }
    if (cnt / tot >= 0.5) {
      boundary = x
      break
    }
  }

  const filledColumns = boundary + 1
  return {
    filledColumns,
    totalColumns: width,
    ratio: width > 0 ? filledColumns / width : 0,
    fillColor: refColor,
    emptyColor: emptyColor ?? null
  }
}

export interface BarCalibration {
  fullColumns: number
  fillColor: Rgb
}

/** Why a checked calibration was rejected. */
export type BarCalibrationFailure =
  | 'empty_roi' // zero-sized capture
  | 'no_fill_color' // detectFillColor found nothing bright/saturated enough
  | 'not_blue' // detected fill colour is not blue-dominant (panel/track learned)
  | 'not_full' // gauge not ≥50% filled — calibration requires ~100% MP

/** Result of {@link calibrateBarChecked}: success carries the calibration plus the
 *  detected gauge row band and a self-verification ratio; failure carries a
 *  user-facing reason (with the offending colour, for UX display). */
export type BarCalibrationCheck =
  | {
      ok: true
      calibration: BarCalibration
      /** Gauge row band [y0, y1) within the INPUT image actually used for calibration.
       *  Spans the full height when no shrink was needed (already-tight ROI). */
      rowBand: RowBand
      /** Self-check: re-measured fill ratio on the same ROI with the new calibration
       *  (barFillToMp-style). Expected 0.95–1.0 at 100% MP. */
      selfRatio: number
      fillColor: Rgb
    }
  | { ok: false; reason: BarCalibrationFailure; fillColor: Rgb | null; note: string }

function fmtRgb(c: Rgb): string {
  return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`
}

/**
 * Capture calibration at 100% MP with validity gates (v3.0.2):
 *  1. shrink-to-band — find the blue-dominant row band inside the ROI and calibrate
 *     on those rows only (auto-corrects an oversized ROI like the field 287x47);
 *  2. colour gate — reject when the detected fill colour is not blue-dominant
 *     (the false-success path that learned the brown UI panel);
 *  3. fullness gate — the band must be ≥50% filled (calibrate at ~100% MP);
 *  4. self-check — re-measure the same band with the new calibration (ratio ≈ 1.0).
 */
export function calibrateBarChecked(img: RgbaImage, opts: BarFillOptions = {}): BarCalibrationCheck {
  // Apply a caller-provided row band up front so band detection runs on the crop.
  if (opts.rowBand) {
    const { rowBand, ...rest } = opts
    return calibrateBarChecked(cropRows(img, rowBand), rest)
  }
  if (img.width === 0 || img.height === 0) {
    return { ok: false, reason: 'empty_roi', fillColor: null, note: 'MP 바 캡처가 비어 있습니다 — 영역을 다시 지정하세요' }
  }

  const band = detectGaugeRowBand(img)
  const rowBand: RowBand = band ?? { y0: 0, y1: img.height }
  const work = band && band.y1 - band.y0 < img.height ? cropRows(img, band) : img

  const res = computeBarFill(work, opts)
  const fillColor = res.fillColor
  if (!fillColor) {
    return {
      ok: false,
      reason: 'no_fill_color',
      fillColor: null,
      note: '채움 색을 찾지 못했습니다 — MP 게이지(파란 바)에 영역을 맞춰주세요'
    }
  }
  if (!isBlueDominant(fillColor)) {
    return {
      ok: false,
      reason: 'not_blue',
      fillColor,
      note: `MP 게이지(파란 바)에 영역을 맞춰주세요 — 감지색 ${fmtRgb(fillColor)}`
    }
  }
  if (res.filledColumns < work.width * 0.5) {
    return { ok: false, reason: 'not_full', fillColor, note: '게이지가 가득 찬 상태(100%)에서 보정하세요' }
  }

  const calibration: BarCalibration = { fullColumns: res.filledColumns, fillColor }
  // Self-verification: measure the SAME band exactly the way live measurement will
  // (refColor = the new calibration colour). At 100% MP this must read ~full.
  const verify = computeBarFill(work, { ...opts, refColor: fillColor })
  const selfRatio = calibration.fullColumns > 0 ? verify.filledColumns / calibration.fullColumns : 0
  return { ok: true, calibration, rowBand, selfRatio, fillColor }
}

/**
 * Capture calibration at 100% MP: the fill colour and the full-bar column count.
 * Thin wrapper over {@link calibrateBarChecked} — returns null on any rejection
 * (including the v3.0.2 blue-dominance gate).
 */
export function calibrateBar(img: RgbaImage, opts: BarFillOptions = {}): BarCalibration | null {
  const r = calibrateBarChecked(img, opts)
  return r.ok ? r.calibration : null
}

/** Convert a measured fill to a current MP value using calibration + known max. */
export function barFillToMp(
  img: RgbaImage,
  maxMp: number,
  cal: BarCalibration,
  opts: BarFillOptions = {}
): number {
  const res = computeBarFill(img, { ...opts, refColor: cal.fillColor })
  if (cal.fullColumns <= 0) return 0
  const cur = Math.round((maxMp * res.filledColumns) / cal.fullColumns)
  return Math.max(0, Math.min(maxMp, cur))
}
