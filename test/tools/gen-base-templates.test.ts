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
        `(skipped ${stats.skipped}); per-char ${JSON.stringify(stats.perChar)}`
    )
    for (const d of '0123456789') {
      expect(set.chars.some((c) => c.char === d)).toBe(true)
    }
  })
})
