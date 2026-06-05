/**
 * User-template learning from a labelled capture.
 *
 * The base templates are built from one source corpus and never perfectly fit a
 * given user's client (font, scaling, capture polarity). The renewal design makes
 * USER templates the primary numeric path: the user types the true value once,
 * the app segments their actual on-screen glyphs and stores per-digit templates,
 * and from then on that character is read from the user's own font.
 *
 * Learn-time guard: a sample is only accepted when its segmentation count matches
 * the label length, so a mis-drawn ROI cannot silently contaminate templates
 * (the exact failure mode that poisoned the v2.x equal-width learner).
 */
import {
  TemplateBuilder,
  mergeTemplateSets,
  CANON_W,
  CANON_H,
  type TemplateSet
} from './template-matcher'
import { prepareRegionMask } from './text-recognizer'
import { segmentGlyphs } from './segmentation'
import { REGION_ALPHABET, type RegionKind, type RgbaImage } from './types'

export interface LearnResult {
  ok: boolean
  set: TemplateSet
  learned: number
  note?: string
}

export function emptyTemplateSet(): TemplateSet {
  return { canonW: CANON_W, canonH: CANON_H, chars: [] }
}

/**
 * Learn the glyphs of `label` from `image` (the region's capture) and merge them
 * over `existing`. Returns ok=false (with `existing` unchanged) when the ROI does
 * not segment into exactly the labelled characters.
 */
export function learnFromCapture(
  region: RegionKind,
  image: RgbaImage,
  label: string,
  existing: TemplateSet | null
): LearnResult {
  const base = existing ?? emptyTemplateSet()
  const allowed = new Set(REGION_ALPHABET[region])
  const chars = label.split('').filter((c) => allowed.has(c))
  if (chars.length === 0) {
    return { ok: false, set: base, learned: 0, note: '라벨에 인식할 글자가 없습니다' }
  }

  const mask = prepareRegionMask(image, region)
  let glyphs = segmentGlyphs(mask)
  // EXP is rendered "DD.DDDD%" and the trailing "%" segments into extra blobs that
  // get misread as digits. The numeric glyphs are left-aligned, so when the ROI is
  // over-segmented we learn the leftmost `chars.length` glyphs (the real number) and
  // drop the trailing "%" pieces. Other regions stay strict (noise can be on either
  // side), so a mis-drawn ROI still can't silently contaminate their templates.
  if (region === 'exp' && glyphs.length > chars.length) {
    glyphs = glyphs.slice(0, chars.length)
  }
  if (glyphs.length !== chars.length) {
    return {
      ok: false,
      set: base,
      learned: 0,
      note: `글자 분할(${glyphs.length}) ≠ 입력 길이(${chars.length}) — 영역을 숫자에 맞게 다시 지정하세요`
    }
  }

  const builder = new TemplateBuilder()
  for (let i = 0; i < glyphs.length; i++) builder.add(chars[i]!, glyphs[i]!.mask)
  const learned = builder.finalize()
  // New per-char templates win over old (latest teaching is authoritative).
  const merged = existing ? mergeTemplateSets(learned, existing) : learned
  return { ok: true, set: merged, learned: glyphs.length }
}
