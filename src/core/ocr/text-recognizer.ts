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
import { binarizeAuto, scaleToHeight, removeSolidBands, type AutoBinarizeOptions } from './imaging'

/** Working height the ROI is normalized to before binarization (see scaleToHeight). */
export const WORK_HEIGHT = 48
import { segmentGlyphs, type SegmentOptions } from './segmentation'
import { matchGlyph, type TemplateSet } from './template-matcher'

export function defaultBinarizeOptions(region: RegionKind): AutoBinarizeOptions {
  const base: AutoBinarizeOptions = {}
  if (region === 'mp') base.blueMargin = 40 // suppress the blue MP-gauge fill behind the text
  return base
}

export function prepareRegionMask(
  img: RgbaImage,
  region: RegionKind,
  opts?: AutoBinarizeOptions
): BinaryMask {
  const scaled = scaleToHeight(img, WORK_HEIGHT)
  const mask = binarizeAuto(scaled, { ...defaultBinarizeOptions(region), ...opts })
  return removeSolidBands(mask)
}

export interface RecognizeResult {
  text: string
  glyphs: GlyphConfidence[]
  minConfidence: number
  meanConfidence: number
}

export function recognizeMask(
  mask: BinaryMask,
  set: TemplateSet,
  region: RegionKind,
  segOpts?: SegmentOptions
): RecognizeResult {
  const allowed = REGION_ALPHABET[region]
  const glyphs = segmentGlyphs(mask, segOpts)
  const out: GlyphConfidence[] = []
  let text = ''
  let minC = 1
  let sumC = 0
  for (const g of glyphs) {
    const m = matchGlyph(g.mask, set, { allowed })
    out.push({
      char: m.char,
      confidence: m.confidence,
      runnerUp: m.runnerUp,
      runnerUpConfidence: m.runnerUpConfidence,
      box: g.box
    })
    text += m.char
    minC = Math.min(minC, m.confidence)
    sumC += m.confidence
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
