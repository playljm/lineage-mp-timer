/**
 * DEBUG P4 — after the segmentation fixes (flat-sliver filter + ink-height
 * wide-split + level rowFrac 0.6), exp regressed 81.8% -> 70.9% with a NEW
 * failure mode: 8 -> 6 flips at high confidence (0.83+).
 *
 * Hypothesis: the fixes unlocked ~30 previously-skipped TRAIN samples
 * ('8' samples 18 -> 41, +16 from level train whose digits render at a smaller
 * raster 17x20 vs exp 20x26), and the '8' template grid got diluted.
 *
 * This test builds template-set variants and evaluates every region on each,
 * to attribute the 8->6 flip to its source corpus. READ-ONLY diagnostics.
 */
import { describe, it } from 'vitest'
import type { RegionKind } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { recognizeImage, prepareRegionMask } from '@core/ocr/text-recognizer'
import { parseRegionString, parsedEquals } from '@core/ocr/parser'
import { segmentGlyphs } from '@core/ocr/segmentation'
import { normalizeGlyph, type TemplateSet } from '@core/ocr/template-matcher'
import { loadFixtures, type Fixture } from '../helpers/fixtures'
import { buildTemplatesFromFixtures } from '../helpers/build-templates'

const REGIONS: RegionKind[] = ['mp', 'exp', 'level', 'adena']

function split<T>(arr: T[]): { train: T[]; test: T[] } {
  const train: T[] = []
  const test: T[] = []
  arr.forEach((x, i) => (i % 2 === 0 ? train : test).push(x))
  return { train, test }
}

function evalRegion(set: TemplateSet, region: RegionKind, test: Fixture[]): string {
  let correct = 0
  const fails: string[] = []
  for (const f of test) {
    const r = recognizeImage(f.image, set, region)
    const got = parseRegionString(region, r.text)
    const want = parseRegionString(region, f.label)
    if (want && parsedEquals(got, want)) correct++
    else if (fails.length < 6) fails.push(`${f.label}->"${r.text}"`)
  }
  return `${((correct / test.length) * 100).toFixed(1)}% (${correct}/${test.length})` +
    (fails.length ? ` fails: ${fails.join(' | ')}` : '')
}

describe('DEBUG P4 exp 8->6 attribution', () => {
  const data = REGIONS.map((region) => ({ region, ...split(loadFixtures(region)) }))
  const nonMp = data.filter((d) => d.region !== 'mp')

  const variants: { name: string; regions: RegionKind[] }[] = [
    { name: 'exp+level+adena (current)', regions: ['exp', 'level', 'adena'] },
    { name: 'exp+adena (no level)', regions: ['exp', 'adena'] },
    { name: 'exp+level (no adena)', regions: ['exp', 'level'] },
    { name: 'exp only', regions: ['exp'] }
  ]

  it('A. evaluate all regions against each template-set variant', () => {
    for (const v of variants) {
      const { set, stats } = buildTemplatesFromFixtures(
        nonMp.filter((d) => v.regions.includes(d.region)).map((d) => ({ region: d.region, fx: d.train }))
      )
      console.log(`\n[set ${v.name}] used=${stats.used} perChar=${JSON.stringify(stats.perChar)}`)
      const t8 = set.chars.find((c) => c.char === '8')
      const t6 = set.chars.find((c) => c.char === '6')
      if (t8) console.log(`[set ${v.name}] '8' samples=${t8.samples} meanAspect=${t8.meanAspect.toFixed(3)}`)
      if (t6) console.log(`[set ${v.name}] '6' samples=${t6.samples} meanAspect=${t6.meanAspect.toFixed(3)}`)
      for (const d of nonMp) {
        console.log(`[set ${v.name}] ${d.region}: ${evalRegion(set, d.region, d.test as Fixture[])}`)
      }
    }
  }, 120000)

  it('C. level evaluated with level-only set and with level-over-shared merge', async () => {
    const { mergeTemplateSets } = await import('@core/ocr/template-matcher')
    const levelData = data.find((d) => d.region === 'level')!
    const { set: levelSet, stats: levelStats } = buildTemplatesFromFixtures([
      { region: 'level', fx: levelData.train }
    ])
    console.log(`[C] level-only set: used=${levelStats.used} perChar=${JSON.stringify(levelStats.perChar)}`)
    console.log(`[C] level w/ level-only set: ${evalRegion(levelSet, 'level', levelData.test as Fixture[])}`)
    const { set: sharedSet } = buildTemplatesFromFixtures(
      nonMp.filter((d) => d.region !== 'level').map((d) => ({ region: d.region, fx: d.train }))
    )
    const merged = mergeTemplateSets(levelSet, sharedSet)
    console.log(`[C] level w/ merged (level wins per char): ${evalRegion(merged, 'level', levelData.test as Fixture[])}`)
    console.log(`[C] exp w/ merged should stay polluted-by-level for chars 2/8: ${evalRegion(merged, 'exp', (data.find((d) => d.region === 'exp')!.test) as Fixture[])}`)
  }, 120000)

  it('B. score a failing exp 8 glyph against 8/6 templates per variant', () => {
    const expData = data.find((d) => d.region === 'exp')!
    const f = (expData.test as Fixture[]).find((x) => x.label === '27.0865')!
    const mask = prepareRegionMask(f.image, 'exp')
    const glyphs = segmentGlyphs(mask)
    // label 27.0865 -> glyph index 4 is '8'
    const g8 = glyphs[4]!
    console.log(`[glyph] 27.0865 glyph#4 ('8') ${g8.mask.width}x${g8.mask.height} aspect=${(g8.mask.width / g8.mask.height).toFixed(3)}`)
    const allowed = new Set(REGION_ALPHABET.exp)
    for (const v of variants) {
      const { set } = buildTemplatesFromFixtures(
        nonMp.filter((d) => v.regions.includes(d.region)).map((d) => ({ region: d.region, fx: d.train }))
      )
      const aspect = g8.mask.width / g8.mask.height
      const norm = normalizeGlyph(g8.mask, set.canonW, set.canonH)
      const cells = set.canonW * set.canonH
      const scored: { char: string; score: number; px: number }[] = []
      for (const tpl of set.chars) {
        if (!allowed.has(tpl.char)) continue
        let diff = 0
        for (let i = 0; i < cells; i++) {
          const t = tpl.grid[i]! / 255
          diff += norm[i]! >= 1 ? 1 - t : t
        }
        const px = 1 - diff / cells
        scored.push({ char: tpl.char, px, score: px - 0.15 * Math.min(1, Math.abs(aspect - tpl.meanAspect)) })
      }
      scored.sort((a, b) => b.score - a.score)
      console.log(
        `[score ${v.name}] top4: ` +
          scored.slice(0, 4).map((s) => `'${s.char}'=${s.score.toFixed(3)}(px${s.px.toFixed(3)})`).join(' ')
      )
    }
  }, 120000)
})
