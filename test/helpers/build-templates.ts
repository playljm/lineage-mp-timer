import type { RegionKind } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { TemplateBuilder, type TemplateSet } from '@core/ocr/template-matcher'
import { prepareRegionMask } from '@core/ocr/text-recognizer'
import { segmentGlyphs } from '@core/ocr/segmentation'
import type { Fixture } from './fixtures'

export interface BuildStats {
  used: number
  skipped: number
  perChar: Record<string, number>
}

/**
 * Build one shared template set from labelled fixtures across regions.
 * A sample only contributes if its segmentation count matches its label length
 * (otherwise the alignment is wrong and would contaminate templates) — this is
 * the learn-time guard the v2.x equal-width splitter lacked.
 */
export function buildTemplatesFromFixtures(
  groups: { region: RegionKind; fx: Fixture[] }[]
): { set: TemplateSet; stats: BuildStats } {
  const builder = new TemplateBuilder()
  const stats: BuildStats = { used: 0, skipped: 0, perChar: {} }
  for (const { region, fx } of groups) {
    const allowed = new Set(REGION_ALPHABET[region])
    for (const f of fx) {
      const chars = f.label.split('').filter((c) => allowed.has(c))
      const mask = prepareRegionMask(f.image, region)
      const glyphs = segmentGlyphs(mask)
      if (glyphs.length !== chars.length || chars.length === 0) {
        stats.skipped++
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
