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
  type CharTemplate,
  type TemplateSet
} from './template-matcher'
import { prepareRegionMask, defaultSegmentOptions } from './text-recognizer'
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

const DIGIT_RE = /^[0-9]$/

function medianOf(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/**
 * Per-glyph geometric plausibility guard for learning (DIGITS ONLY).
 *
 * The count==length guard alone lets mis-segmented samples through when the blob
 * count happens to match: 54x2 MP gauge bands learned as '1' (meanAspect 6.257)
 * and 33x48 level chrome mega-glyphs learned as '2' poisoned the shared templates
 * (measured: exp 54.5% from 1->7 confusion alone). A digit-labelled glyph is
 * implausible when:
 *   (a) its height is under half the median height of its sibling digit glyphs
 *       (flat gauge-band sliver), or
 *   (b) its aspect (w/h) exceeds 1.4 — digits in this font are taller than wide
 *       (catches multi-glyph blobs that pass the height check), or
 *   (c) its box height fills >= 0.9 of the prepared region mask height
 *       (UI-chrome mega-glyph spanning the whole padded ROI).
 * Any implausible digit glyph rejects the WHOLE sample (alignment is untrustworthy).
 *
 * Non-digit labels ('.', ',', '/', '%') are EXEMPT: '.' and ',' are legitimately
 * tiny, so applying the height check to them rejects ~all real samples (measured:
 * 70/80 exp fixtures dropped -> exp 0%).
 */
export function digitGlyphsPlausible(
  glyphs: readonly { mask: { width: number; height: number } }[],
  chars: readonly string[],
  regionMaskHeight: number
): boolean {
  const digitHeights: number[] = []
  for (let i = 0; i < glyphs.length; i++) {
    if (DIGIT_RE.test(chars[i] ?? '')) digitHeights.push(glyphs[i]!.mask.height)
  }
  if (!digitHeights.length) return true
  const medH = medianOf(digitHeights)
  for (let i = 0; i < glyphs.length; i++) {
    if (!DIGIT_RE.test(chars[i] ?? '')) continue // '.', ',', '/', '%' exempt
    const { width, height } = glyphs[i]!.mask
    if (height <= 0) return false
    if (medH > 0 && height < medH * 0.5) return false // (a) flat sliver vs siblings
    if (width / height > 1.4) return false // (b) wider than any digit can be
    if (regionMaskHeight > 0 && height >= 0.9 * regionMaskHeight) return false // (c) chrome mega-glyph
  }
  return true
}

export interface WeightedMergeOptions {
  /**
   * Blend weight floor guaranteed to `primary` for overlapping characters
   * (default 0.5). Keeps the "re-teach to immediately correct a bad template" UX:
   * even one fresh capture against a 300-sample average still moves the merged
   * template at least half-way to the new shape (two re-teaches ≥ 75%, …).
   */
  minPrimaryWeight?: number
}

/**
 * Sample-weighted template merge.
 *
 * `mergeTemplateSets` is last-writer-wins per character: teaching the same digit
 * twice keeps only the second single capture, so repeat teaching never gains the
 * statistical strength a TemplateBuilder average has (measured on the v2 corpus:
 * a 248-sample average beat single-capture-equivalent templates by +5.4pp).
 * Here, characters present in both sets are blended cell-wise by their sample
 * counts — repeat teaching now accumulates — while `minPrimaryWeight` floors the
 * fresh teaching's influence so deliberate corrections still take effect
 * immediately. Characters present in only one set carry over unchanged.
 *
 * Falls back to plain `mergeTemplateSets` when the canonical grids differ
 * (cell-wise blending across grid sizes would corrupt both shapes).
 */
export function mergeTemplateSetsWeighted(
  primary: TemplateSet,
  fallback: TemplateSet,
  opts: WeightedMergeOptions = {}
): TemplateSet {
  if (primary.canonW !== fallback.canonW || primary.canonH !== fallback.canonH) {
    return mergeTemplateSets(primary, fallback)
  }
  const minW = Math.min(1, Math.max(0, opts.minPrimaryWeight ?? 0.5))
  const byChar = new Map<string, CharTemplate>()
  for (const c of fallback.chars) byChar.set(c.char, c)
  for (const p of primary.chars) {
    const f = byChar.get(p.char)
    if (!f || f.grid.length !== p.grid.length) {
      byChar.set(p.char, p)
      continue
    }
    const pn = Math.max(1, p.samples)
    const fn = Math.max(0, f.samples)
    const w = Math.max(minW, pn / (pn + fn))
    const grid = new Uint8Array(p.grid.length)
    for (let i = 0; i < grid.length; i++) {
      grid[i] = Math.round(w * p.grid[i]! + (1 - w) * f.grid[i]!)
    }
    byChar.set(p.char, {
      char: p.char,
      grid,
      samples: pn + fn,
      meanAspect: w * p.meanAspect + (1 - w) * f.meanAspect
    })
  }
  return {
    canonW: primary.canonW,
    canonH: primary.canonH,
    chars: [...byChar.values()].sort((a, b) => a.char.localeCompare(b.char))
  }
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

  // Same preprocessing chain as recognition: for adena this is the 2-pass
  // text-band pre-crop (inside prepareRegionMask) + junk-glyph filter (via
  // defaultSegmentOptions). Without it the systematic crop junk fails the
  // count==length guard and starves the templates of adena samples (measured:
  // 43/55 train fixtures skipped); with it the same captures that recognition
  // sees cleanly also LEARN cleanly. Other regions get empty defaults (no-op).
  const mask = prepareRegionMask(image, region)
  let glyphs = segmentGlyphs(mask, defaultSegmentOptions(region))
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
  // Geometry guard: a count match alone can still align gauge bands / UI chrome to
  // digit labels (the exact poisoning that broke the shared bench templates).
  // Applies to digit-labelled glyphs only; '.', ',', '/' are exempt by design.
  // adena passes 0 for the mask height: after the text-band pre-crop the digits
  // legitimately fill ~the whole working height, so the chrome-mega-glyph check
  // (c) would reject every valid adena sample. The pre-crop + junk filter already
  // remove the chrome that check exists for; the aspect check (b) still applies.
  if (!digitGlyphsPlausible(glyphs, chars, region === 'adena' ? 0 : mask.height)) {
    return {
      ok: false,
      set: base,
      learned: 0,
      note: '글자 모양이 비정상입니다(게이지/UI 테두리가 섞임) — 영역을 숫자에 맞게 다시 지정하세요'
    }
  }

  const builder = new TemplateBuilder()
  for (let i = 0; i < glyphs.length; i++) builder.add(chars[i]!, glyphs[i]!.mask)
  const learned = builder.finalize()
  // Sample-weighted accumulation: repeat teaching averages with what is already
  // known (statistically stronger), while the ≥50% floor for the fresh capture
  // keeps "re-teach to immediately correct" working. (Was last-writer-wins.)
  const merged = existing ? mergeTemplateSetsWeighted(learned, existing) : learned
  return { ok: true, set: merged, learned: glyphs.length }
}
