import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RegionKind } from '@core/ocr/types'
import { serializeTemplates } from '@core/ocr/template-matcher'
import { loadFixtures } from '../helpers/fixtures'
import { buildTemplatesFromFixtures } from '../helpers/build-templates'

/**
 * Generates the bundled bootstrap templates from the captured corpus.
 * Regenerate with: npx vitest run test/tools/gen-base-templates.test.ts
 */
describe('generate base-templates.json', () => {
  it('builds and writes bundled bootstrap templates', () => {
    const regions: RegionKind[] = ['mp', 'exp', 'level', 'adena']
    const groups = regions.map((region) => ({ region, fx: loadFixtures(region) }))
    const { set, stats } = buildTemplatesFromFixtures(groups)

    const here = dirname(fileURLToPath(import.meta.url))
    const out = join(here, '..', '..', 'src', 'core', 'ocr', 'base-templates.json')
    writeFileSync(out, JSON.stringify(serializeTemplates(set)))

    // eslint-disable-next-line no-console
    console.log(
      `[gen] base templates: ${set.chars.length} chars from ${stats.used} samples ` +
        `(skipped ${stats.skipped}, ${stats.rejectedByGeometry} by geometry guard); ` +
        `per-char ${JSON.stringify(stats.perChar)}`
    )
    for (const d of '0123456789') {
      expect(set.chars.some((c) => c.char === d)).toBe(true)
    }
    // Poisoning regression guard: every digit template must have a plausible
    // width prior. Before the geometry guard + median aspect, mis-segmented MP
    // gauge bands drove '1'.meanAspect to 6.36 (true value ~0.69), saturating the
    // matcher's aspect penalty and causing the 1->7 confusion.
    for (const c of set.chars) {
      if (!/[0-9]/.test(c.char)) continue
      expect(c.meanAspect, `digit '${c.char}' meanAspect`).toBeGreaterThan(0.3)
      expect(c.meanAspect, `digit '${c.char}' meanAspect`).toBeLessThan(1.4)
    }
    const one = set.chars.find((c) => c.char === '1')!
    expect(one.meanAspect).toBeGreaterThanOrEqual(0.6)
    expect(one.meanAspect).toBeLessThanOrEqual(0.7)
  })
})
