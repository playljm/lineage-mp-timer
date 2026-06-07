import type { RegionKind } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { TemplateBuilder, type TemplateSet } from '@core/ocr/template-matcher'
import { prepareRegionMask, defaultSegmentOptions } from '@core/ocr/text-recognizer'
import { segmentGlyphs } from '@core/ocr/segmentation'
import { digitGlyphsPlausible } from '@core/ocr/learn'
import type { Fixture } from './fixtures'

export interface BuildStats {
  used: number
  skipped: number
  /** Samples whose segmentation count matched but a digit glyph failed the geometry guard. */
  rejectedByGeometry: number
  perChar: Record<string, number>
}

/**
 * Build one shared template set from labelled fixtures across regions.
 * A sample only contributes if
 *   (1) its segmentation count matches its label length (otherwise the alignment
 *       is wrong and would contaminate templates — the learn-time guard the v2.x
 *       equal-width splitter lacked), AND
 *   (2) every digit-labelled glyph passes the geometric plausibility guard
 *       (digitGlyphsPlausible — same production guard as learn.ts). Count matches
 *       alone let 54x2 MP gauge bands be learned as '1' and 33x48 level chrome
 *       mega-glyphs as '2', which poisoned the shared set (measured exp 54.5%).
 */
export function buildTemplatesFromFixtures(
  groups: { region: RegionKind; fx: Fixture[] }[]
): { set: TemplateSet; stats: BuildStats } {
  const builder = new TemplateBuilder()
  const stats: BuildStats = { used: 0, skipped: 0, rejectedByGeometry: 0, perChar: {} }
  for (const { region, fx } of groups) {
    const allowed = new Set(REGION_ALPHABET[region])
    for (const f of fx) {
      const chars = f.label.split('').filter((c) => allowed.has(c))
      // Same chain as learnFromCapture: adena gets the 2-pass text-band pre-crop
      // (inside prepareRegionMask) + junk filter, so its train fixtures pass the
      // count guard instead of being starved out (measured: used 12 -> 30+).
      const mask = prepareRegionMask(f.image, region)
      const glyphs = segmentGlyphs(mask, defaultSegmentOptions(region))
      if (glyphs.length !== chars.length || chars.length === 0) {
        stats.skipped++
        continue
      }
      // adena: maskHeight 0 disables the chrome-mega-glyph check (c) — digits
      // legitimately fill the working height after the pre-crop (same reasoning
      // as learnFromCapture).
      if (!digitGlyphsPlausible(glyphs, chars, region === 'adena' ? 0 : mask.height)) {
        stats.skipped++
        stats.rejectedByGeometry++
        continue
      }
      for (let i = 0; i < glyphs.length; i++) {
        builder.add(chars[i]!, glyphs[i]!.mask)
        stats.perChar[chars[i]!] = (stats.perChar[chars[i]!] ?? 0) + 1
      }
      stats.used++
    }
  }
  return { set: builder.finalize(), stats }
}
