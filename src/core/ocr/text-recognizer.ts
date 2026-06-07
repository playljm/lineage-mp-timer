/**
 * Ties binarization -> segmentation -> per-glyph matching into a recognized
 * string with per-glyph confidence. Region-aware: constrains the matcher to the
 * region alphabet and applies region-appropriate binarization (e.g. killing the
 * MP gauge's blue background).
 *
 * This is the shared recognition core used both by the live recognizer and by the
 * offline accuracy benchmark against captured game samples.
 */
import type { RgbaImage, BinaryMask, RegionKind, GlyphConfidence } from './types'
import { REGION_ALPHABET } from './types'
import {
  binarizeAuto,
  scaleToHeight,
  removeSolidBands,
  cropImage,
  type AutoBinarizeOptions
} from './imaging'

/** Working height the ROI is normalized to before binarization (see scaleToHeight). */
export const WORK_HEIGHT = 48
import { segmentGlyphs, type SegmentOptions, type Glyph } from './segmentation'
import { matchGlyph, type TemplateSet } from './template-matcher'

export function defaultBinarizeOptions(region: RegionKind): AutoBinarizeOptions {
  const base: AutoBinarizeOptions = {}
  if (region === 'mp') base.blueMargin = 40 // suppress the blue MP-gauge fill behind the text
  return base
}

/**
 * Per-region segmentation defaults. The adena crop carries systematic non-text
 * junk (right-side inventory-UI fragment, noise blobs, partial-width gray bands
 * the 0.8 rowFrac cannot remove), so adena enables the median-relative junk
 * filter. Other regions keep the bare CCL pipeline — applying the edge filter
 * to tight crops (level) can cut a legitimate first/last digit.
 */
export function defaultSegmentOptions(region: RegionKind): SegmentOptions {
  return region === 'adena' ? { junkFilter: true } : {}
}

/**
 * Per-region removeSolidBands row fraction. The level crop includes the level
 * box's UI chrome (top border ~0.74, bottom block ~0.76 of full mask width),
 * which survives the 0.8 default and chain-merges/fuses with the digits;
 * 0.6 removes it (measured: level 71.4% -> 95%+). The other regions MUST stay
 * at 0.8 — a global 0.6 collapses exp to 7.3% and adena to 0% (measured), as
 * their long 7-glyph text rows approach the lower threshold.
 */
const REGION_ROW_FRAC: Record<RegionKind, number> = {
  mp: 0.8,
  exp: 0.8,
  level: 0.6,
  adena: 0.8
}

function prepareMaskOnce(img: RgbaImage, region: RegionKind, opts?: AutoBinarizeOptions): BinaryMask {
  const scaled = scaleToHeight(img, WORK_HEIGHT)
  const mask = binarizeAuto(scaled, { ...defaultBinarizeOptions(region), ...opts })
  return removeSolidBands(mask, REGION_ROW_FRAC[region])
}

/**
 * Longest contiguous row band covered by at least half the glyphs — i.e. the
 * text line. Junk (bottom gray band, corner noise blobs) sits outside it.
 */
function glyphRowBand(mask: BinaryMask, glyphs: Glyph[]): { y0: number; y1: number } | null {
  if (!glyphs.length) return null
  const cover = new Array<number>(mask.height).fill(0)
  for (const g of glyphs) for (let y = g.box.y0; y < g.box.y1; y++) cover[y]!++
  const need = Math.max(1, Math.ceil(glyphs.length / 2))
  let bestS = 0
  let bestE = 0
  let s = -1
  for (let y = 0; y <= mask.height; y++) {
    const ok = y < mask.height && cover[y]! >= need
    if (ok && s < 0) s = y
    if (!ok && s >= 0) {
      if (y - s > bestE - bestS) {
        bestS = s
        bestE = y
      }
      s = -1
    }
  }
  return bestE > bestS ? { y0: bestS, y1: bestE } : null
}

/**
 * Region binarization. For adena this is a TWO-PASS text-band pre-crop:
 * scaleToHeight squeezes the whole crop to 48px, so a tall adena crop where the
 * digits occupy only some rows (744x492 captures) shrinks them to ~13px and
 * they erode/merge (measured: 33151 -> "7777"). Pass 1 segments the plain mask,
 * finds the y-band the majority of glyphs cover (the text line), maps it back
 * to ORIGINAL image rows (+-2px margin) and re-binarizes just that crop — the
 * digits then fill the working height and the bottom gray band / vertical
 * padding are gone (prescription chain measured 5.5% -> 72.7% on fixtures).
 * Other regions are single-pass: their crops are already text-tight, and the
 * band heuristic could clip exp's '.' or mp's '/' descenders.
 */
export function prepareRegionMask(
  img: RgbaImage,
  region: RegionKind,
  opts?: AutoBinarizeOptions
): BinaryMask {
  const mask = prepareMaskOnce(img, region, opts)
  if (region !== 'adena') return mask
  const band = glyphRowBand(mask, segmentGlyphs(mask))
  if (!band) return mask
  const fy = img.height / mask.height
  const y0 = Math.max(0, Math.floor(band.y0 * fy) - 2)
  const y1 = Math.min(img.height, Math.ceil(band.y1 * fy) + 2)
  if (y0 <= 0 && y1 >= img.height) return mask // band crop would be a no-op
  return prepareMaskOnce(cropImage(img, { x0: 0, y0, x1: img.width, y1 }), region, opts)
}

export interface RecognizeResult {
  text: string
  glyphs: GlyphConfidence[]
  minConfidence: number
  meanConfidence: number
}

function medianOf(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** End glyphs whose gap to the row exceeds this x median inter-glyph gap are junk candidates. */
const ADENA_TRIM_GAP_RATIO = 3
/**
 * Only LOW-confidence outliers are trimmed. An unconditional gap trim removes a
 * real trailing digit when kerning is uneven (measured: 28491 -> "2849", 1 case);
 * junk fragments match digits weakly while real digits match strongly, so the
 * confidence guard keeps the digit and still drops the UI fragment.
 */
const ADENA_TRIM_MAX_CONFIDENCE = 0.7

/**
 * adena end-gap trim: the inventory-UI fragment sits at the right crop border,
 * far from the digit row's glyph pitch. Runs AFTER matching so each candidate's
 * confidence is known (see ADENA_TRIM_MAX_CONFIDENCE).
 */
function trimAdenaEndGapJunk(matched: GlyphConfidence[]): GlyphConfidence[] {
  const out = [...matched]
  while (out.length >= 3) {
    const gaps = out.slice(1).map((g, i) => g.box.x0 - out[i]!.box.x1)
    const m = medianOf(gaps)
    if (m <= 0) break
    const lastGap = gaps[gaps.length - 1]!
    const firstGap = gaps[0]!
    if (lastGap > ADENA_TRIM_GAP_RATIO * m && out[out.length - 1]!.confidence < ADENA_TRIM_MAX_CONFIDENCE) {
      out.pop()
    } else if (firstGap > ADENA_TRIM_GAP_RATIO * m && out[0]!.confidence < ADENA_TRIM_MAX_CONFIDENCE) {
      out.shift()
    } else {
      break
    }
  }
  return out
}

export function recognizeMask(
  mask: BinaryMask,
  set: TemplateSet,
  region: RegionKind,
  segOpts?: SegmentOptions
): RecognizeResult {
  const allowed = REGION_ALPHABET[region]
  const glyphs = segmentGlyphs(mask, { ...defaultSegmentOptions(region), ...segOpts })
  let out: GlyphConfidence[] = []
  for (const g of glyphs) {
    const m = matchGlyph(g.mask, set, { allowed })
    out.push({
      char: m.char,
      confidence: m.confidence,
      runnerUp: m.runnerUp,
      runnerUpConfidence: m.runnerUpConfidence,
      box: g.box
    })
  }
  if (region === 'adena') out = trimAdenaEndGapJunk(out)
  let text = ''
  let minC = 1
  let sumC = 0
  for (const g of out) {
    text += g.char
    minC = Math.min(minC, g.confidence)
    sumC += g.confidence
  }
  const n = out.length
  return {
    text,
    glyphs: out,
    minConfidence: n ? minC : 0,
    meanConfidence: n ? sumC / n : 0
  }
}

export interface RecognizeImageOptions {
  binarize?: AutoBinarizeOptions
  seg?: SegmentOptions
}

export function recognizeImage(
  img: RgbaImage,
  set: TemplateSet,
  region: RegionKind,
  opts: RecognizeImageOptions = {}
): RecognizeResult {
  const mask = prepareRegionMask(img, region, opts.binarize)
  return recognizeMask(mask, set, region, opts.seg)
}
