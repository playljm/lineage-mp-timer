/**
 * Vitest entry for the offline user-template batch learner (repo convention —
 * tsx is not a dependency, so scripts are executed through vitest like
 * gen-base-templates.test.ts).
 *
 *   npm run templates:user
 *   (= npx vitest run test/tools/build-user-templates.test.ts)
 *
 * Test 1 builds the PRODUCTION artifact from the full AppData corpus (READ-ONLY)
 * into out/user-templates.json and validates it round-trips through
 * deserializeTemplates with sane digit geometry.
 *
 * Test 2 is the honest held-out benchmark: the repo fixtures are a 100%-name
 * subset of the AppData corpus, so the corpus is re-built EXCLUDING every repo
 * TEST-split basename before evaluating on that TEST split (no leakage), both
 * alone and merged over the bundled base set (== the production effectiveSet
 * once the artifact is imported).
 *
 * Skips entirely on machines without the AppData corpus.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RegionKind } from '@core/ocr/types'
import {
  deserializeTemplates,
  mergeTemplateSets,
  type SerializedTemplateSet,
  type TemplateSet
} from '@core/ocr/template-matcher'
import { recognizeImage } from '@core/ocr/text-recognizer'
import { parseRegionString, parsedEquals } from '@core/ocr/parser'
import baseTemplatesData from '@core/ocr/base-templates.json'
import { loadFixtures, type Fixture } from '../helpers/fixtures'
import {
  DEFAULT_CORPUS_ROOT,
  buildUserTemplates,
  formatBuildReport,
  writeUserTemplates
} from '../../scripts/build-user-templates'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_FILE = join(here, '..', '..', 'out', 'user-templates.json')
const BENCH_REGIONS: RegionKind[] = ['exp', 'level', 'adena']

const hasCorpus = existsSync(DEFAULT_CORPUS_ROOT)

/** accuracy.test.ts split: even index → TRAIN, odd index → TEST. */
function testSplit(all: Fixture[]): Fixture[] {
  return all.filter((_, i) => i % 2 === 1)
}

function evalSet(set: TemplateSet, region: RegionKind, test: Fixture[]): {
  acc: number
  correct: number
  total: number
} {
  let correct = 0
  for (const f of test) {
    const got = parseRegionString(region, recognizeImage(f.image, set, region).text)
    const want = parseRegionString(region, f.label)
    if (want && parsedEquals(got, want)) correct++
  }
  return { acc: test.length ? correct / test.length : 0, correct, total: test.length }
}

describe.runIf(hasCorpus)('build-user-templates (offline v2-corpus batch learner)', () => {
  it('builds the production artifact and round-trips it', { timeout: 120_000 }, () => {
    const result = buildUserTemplates({})
    writeUserTemplates(OUT_FILE, result)

    expect(result.totalUsed).toBeGreaterThan(0)
    expect(existsSync(OUT_FILE)).toBe(true)

    // The artifact must survive exactly the app's import path.
    const parsed = JSON.parse(readFileSync(OUT_FILE, 'utf8')) as SerializedTemplateSet
    const set = deserializeTemplates(parsed)
    expect(set.canonW).toBeGreaterThan(0)
    expect(set.canonH).toBeGreaterThan(0)
    for (const c of set.chars) {
      expect(c.grid.length, `'${c.char}' grid cells`).toBe(set.canonW * set.canonH)
      expect(c.samples, `'${c.char}' samples`).toBeGreaterThan(0)
    }
    // exp+level corpus must cover all digits + the exp decimal point.
    for (const d of '0123456789.') {
      expect(set.chars.some((c) => c.char === d), `char '${d}' present`).toBe(true)
    }
    // Geometry sanity (the poisoning regression the guards exist for): every digit
    // width prior must be plausible — see gen-base-templates.test.ts.
    for (const c of set.chars) {
      if (!/[0-9]/.test(c.char)) continue
      expect(c.meanAspect, `digit '${c.char}' meanAspect`).toBeGreaterThan(0.3)
      expect(c.meanAspect, `digit '${c.char}' meanAspect`).toBeLessThan(1.4)
    }
  })

  it('held-out benchmark: leakage-free corpus build vs repo TEST split', { timeout: 300_000 }, () => {
    const fixturesByRegion = BENCH_REGIONS.map((region) => ({
      region,
      test: testSplit(loadFixtures(region))
    }))

    // Leakage guard: drop every repo TEST basename from the corpus build.
    const excludeNames: Partial<Record<RegionKind, ReadonlySet<string>>> = {}
    for (const { region, test } of fixturesByRegion) {
      excludeNames[region] = new Set(test.map((f) => f.name))
    }
    const result = buildUserTemplates({ excludeNames })
    const bundled = deserializeTemplates(baseTemplatesData as unknown as SerializedTemplateSet)
    const merged = mergeTemplateSets(result.set, bundled) // production effectiveSet after import

    const lines: string[] = [formatBuildReport(result)]
    let expAlone = 0
    let expMerged = 0
    let expBase = 0
    for (const { region, test } of fixturesByRegion) {
      const base = evalSet(bundled, region, test)
      const alone = evalSet(result.set, region, test)
      const over = evalSet(merged, region, test)
      if (region === 'exp') {
        expAlone = alone.acc
        expMerged = over.acc
        expBase = base.acc
      }
      lines.push(
        `[bench ${region}] base-alone=${(base.acc * 100).toFixed(1)}% (${base.correct}/${base.total})  ` +
          `v2-alone=${(alone.acc * 100).toFixed(1)}% (${alone.correct}/${alone.total})  ` +
          `v2-over-base=${(over.acc * 100).toFixed(1)}% (${over.correct}/${over.total})`
      )
    }
    // eslint-disable-next-line no-console
    console.log('\n' + lines.join('\n') + '\n')

    // The whole point of the bootstrap: imported exp templates must not be worse
    // than the bundled base the live app would otherwise use.
    expect(expMerged).toBeGreaterThanOrEqual(expBase)
    expect(expAlone).toBeGreaterThan(0)
  })
})
