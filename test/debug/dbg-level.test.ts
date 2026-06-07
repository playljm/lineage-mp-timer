/**
 * DEBUG instrumentation for LEVEL region failures (28 -> "2" glyph loss, 8 -> "2"
 * confusion). Reproduces the exact accuracy.test.ts train/test split + shared
 * template set, then dumps internal pipeline state for every failing fixture:
 *   - raw connected components (before filters) + which filter would drop them
 *   - segmentGlyphs output boxes
 *   - ASCII visualization of the prepared mask and of each glyph
 *   - per-glyph top-5 candidate scores (replicates matchGlyph scoring exactly)
 *   - '8' vs '2' template ASCII comparison
 *   - label distribution / per-char train counts
 *
 * Diagnostic only. Does not modify src/. Run:
 *   npx vitest run test/debug/dbg-level.test.ts
 */
import { describe, it } from 'vitest'
import type { BinaryMask, RegionKind } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { recognizeImage, prepareRegionMask } from '@core/ocr/text-recognizer'
import { parseRegionString, parsedEquals } from '@core/ocr/parser'
import { segmentGlyphs, connectedComponents } from '@core/ocr/segmentation'
import {
  normalizeGlyph,
  CANON_W,
  CANON_H,
  type TemplateSet,
  type CharTemplate
} from '@core/ocr/template-matcher'
import { inkBounds, cropMask, scaleToHeight } from '@core/ocr/imaging'
import { loadFixtures, type Fixture } from '../helpers/fixtures'
import { buildTemplatesFromFixtures } from '../helpers/build-templates'

const REGIONS: RegionKind[] = ['mp', 'exp', 'level', 'adena']

function split<T>(arr: T[]): { train: T[]; test: T[] } {
  const train: T[] = []
  const test: T[] = []
  arr.forEach((x, i) => (i % 2 === 0 ? train : test).push(x))
  return { train, test }
}

function asciiMask(mask: BinaryMask): string {
  const lines: string[] = []
  for (let y = 0; y < mask.height; y++) {
    let row = ''
    for (let x = 0; x < mask.width; x++) row += mask.data[y * mask.width + x] ? '#' : '.'
    lines.push(row)
  }
  return lines.join('\n')
}

function asciiTemplate(tpl: CharTemplate, canonW: number, canonH: number): string {
  // occupancy quartiles: ' ' <64, '.' <128, '+' <192, '#' >=192
  const lines: string[] = []
  for (let y = 0; y < canonH; y++) {
    let row = ''
    for (let x = 0; x < canonW; x++) {
      const v = tpl.grid[y * canonW + x]!
      row += v >= 192 ? '#' : v >= 128 ? '+' : v >= 64 ? '.' : ' '
    }
    lines.push(row)
  }
  return lines.join('\n')
}

/** Replicates matchGlyph scoring (aspectWeight 0.15) but returns ALL candidates sorted. */
function scoreAll(
  tight: BinaryMask,
  set: TemplateSet,
  allowed: ReadonlySet<string>
): { char: string; pixelScore: number; aspectPenalty: number; score: number }[] {
  const aspectWeight = 0.15
  const norm = normalizeGlyph(tight, set.canonW, set.canonH)
  const aspect = tight.height > 0 ? tight.width / tight.height : 1
  const cells = set.canonW * set.canonH
  const out: { char: string; pixelScore: number; aspectPenalty: number; score: number }[] = []
  for (const tpl of set.chars) {
    if (!allowed.has(tpl.char)) continue
    let diff = 0
    for (let i = 0; i < cells; i++) {
      const t = tpl.grid[i]! / 255
      const s = norm[i]!
      diff += s >= 1 ? 1 - t : t
    }
    const pixelScore = 1 - diff / cells
    const aspectPenalty = aspectWeight * Math.min(1, Math.abs(aspect - tpl.meanAspect))
    out.push({ char: tpl.char, pixelScore, aspectPenalty, score: pixelScore - aspectPenalty })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

describe('dbg-level: glyph loss / 8-vs-2 confusion instrumentation', () => {
  const data = REGIONS.map((region) => {
    const all = loadFixtures(region)
    return { region, ...split(all) }
  })
  const { set, stats } = buildTemplatesFromFixtures(
    data.map((d) => ({ region: d.region, fx: d.train }))
  )
  const levelData = data.find((d) => d.region === 'level')!
  const allowed = new Set(REGION_ALPHABET.level)

  it('(4) label distribution + train per-char counts', () => {
    const all = loadFixtures('level')
    const labelCount: Record<string, number> = {}
    for (const f of all) labelCount[f.label] = (labelCount[f.label] ?? 0) + 1
    const trainLabels: Record<string, number> = {}
    for (const f of levelData.train) trainLabels[f.label] = (trainLabels[f.label] ?? 0) + 1
    const testLabels: Record<string, number> = {}
    for (const f of levelData.test) testLabels[f.label] = (testLabels[f.label] ?? 0) + 1
    console.log(`[dist] level fixtures total=${all.length} labels=${JSON.stringify(labelCount)}`)
    console.log(`[dist] level TRAIN n=${levelData.train.length} labels=${JSON.stringify(trainLabels)}`)
    console.log(`[dist] level TEST  n=${levelData.test.length} labels=${JSON.stringify(testLabels)}`)
    console.log(`[dist] shared-set build: used=${stats.used} skipped=${stats.skipped}`)
    console.log(`[dist] shared-set perChar (ALL regions train): ${JSON.stringify(stats.perChar)}`)
    // How many '8' samples came from level train specifically?
    let level8 = 0
    for (const f of levelData.train) {
      if (f.label.includes('8')) level8++
    }
    console.log(`[dist] level TRAIN samples whose label contains '8': ${level8}`)
    for (const c of set.chars) {
      console.log(
        `[dist] template '${c.char}': samples=${c.samples} meanAspect=${c.meanAspect.toFixed(3)}`
      )
    }
  })

  it('(3) template ASCII: 8 vs 2 (and 0 for reference)', () => {
    for (const ch of ['2', '8', '0']) {
      const tpl = set.chars.find((c) => c.char === ch)
      if (!tpl) {
        console.log(`[tpl] '${ch}' NOT IN TEMPLATE SET`)
        continue
      }
      console.log(
        `\n[tpl] '${ch}' samples=${tpl.samples} meanAspect=${tpl.meanAspect.toFixed(3)}\n` +
          asciiTemplate(tpl, set.canonW, set.canonH)
      )
    }
  })

  it('(1)(2) per-failure segmentation + matching dump', () => {
    const failures: Fixture[] = []
    for (const f of levelData.test) {
      const r = recognizeImage(f.image, set, 'level')
      const got = parseRegionString('level', r.text)
      const want = parseRegionString('level', f.label)
      if (!(want && parsedEquals(got, want))) failures.push(f)
    }
    console.log(`[fail] level test failures: ${failures.length}/${levelData.test.length}`)

    const seenPattern = new Set<string>()
    for (const f of failures) {
      const r = recognizeImage(f.image, set, 'level')
      const mask = prepareRegionMask(f.image, 'level')
      const scaled = scaleToHeight(f.image, 48)
      const ib = inkBounds(mask)
      console.log(
        `\n=== [fail] ${f.name} label="${f.label}" got="${r.text}"` +
          ` | png ${f.image.width}x${f.image.height} -> scaled ${scaled.width}x${scaled.height}` +
          ` -> mask ${mask.width}x${mask.height}` +
          ` | inkBounds=${ib ? `x[${ib.x0},${ib.x1}) y[${ib.y0},${ib.y1})` : 'EMPTY'}` +
          ` | rightGap=${ib ? mask.width - ib.x1 : 'n/a'} leftGap=${ib ? ib.x0 : 'n/a'}`
      )

      // Raw components BEFORE any filter, and what each filter would do.
      const rawComps = connectedComponents(mask, 1)
      for (const c of rawComps) {
        const w = c.x1 - c.x0
        const touchesEdge = c.x0 === 0 || c.x1 === mask.width
        const droppedMinArea = c.area < 3
        const droppedSliver = touchesEdge && w <= 3
        console.log(
          `  [comp] x[${c.x0},${c.x1}) y[${c.y0},${c.y1}) w=${w} h=${c.y1 - c.y0} area=${c.area}` +
            `${touchesEdge ? ' EDGE' : ''}${droppedMinArea ? ' DROP(minArea<3)' : ''}` +
            `${droppedSliver ? ' DROP(edgeSliver)' : ''}`
        )
      }

      // Final segmentation output.
      const glyphs = segmentGlyphs(mask)
      console.log(`  [seg] segmentGlyphs -> ${glyphs.length} glyph(s)`)
      // Width-split diagnostics: replicate estGlyph computation.
      const widths = glyphs.map((g) => g.box.x1 - g.box.x0)
      console.log(
        `  [seg] glyph widths=${JSON.stringify(widths)} mask.height=${mask.height}` +
          ` heightTerm(estGlyph>=h*0.62)=${(mask.height * 0.62).toFixed(1)}` +
          ` splitThreshold(x1.5)=${(mask.height * 0.62 * 1.5).toFixed(1)}`
      )

      for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i]!
        const top = scoreAll(g.mask, set, allowed).slice(0, 5)
        console.log(
          `  [glyph ${i}] box x[${g.box.x0},${g.box.x1}) y[${g.box.y0},${g.box.y1})` +
            ` size=${g.mask.width}x${g.mask.height} aspect=${(g.mask.width / g.mask.height).toFixed(3)}`
        )
        for (const t of top) {
          console.log(
            `    cand '${t.char}' score=${t.score.toFixed(4)} (pixel=${t.pixelScore.toFixed(4)}` +
              ` aspectPen=${t.aspectPenalty.toFixed(4)})`
          )
        }
      }

      // ASCII once per distinct (label -> got) pattern to bound log size.
      const key = `${f.label}->${r.text}`
      if (!seenPattern.has(key)) {
        seenPattern.add(key)
        console.log(`  [ascii] full prepared mask (${mask.width}x${mask.height}):\n${asciiMask(mask)}`)
        for (let i = 0; i < glyphs.length; i++) {
          console.log(`  [ascii] glyph ${i} tight mask:\n${asciiMask(glyphs[i]!.mask)}`)
        }
      }
    }
  })

  it('(5) train-side contamination: what does a level TRAIN sample teach the 2 template?', () => {
    let two = 0
    let one = 0
    let other = 0
    let dumped = false
    for (const f of levelData.train) {
      const mask = prepareRegionMask(f.image, 'level')
      const glyphs = segmentGlyphs(mask)
      if (glyphs.length === 2) two++
      else if (glyphs.length === 1) one++
      else other++
      if (glyphs.length === 2 && !dumped) {
        dumped = true
        console.log(
          `[train] sample ${f.name} label="${f.label}" -> 2 glyphs ` +
            `boxes=${glyphs.map((g) => `x[${g.box.x0},${g.box.x1})y[${g.box.y0},${g.box.y1})`).join(' ')}`
        )
        console.log(
          `[train] glyph0 (LEARNED as '2', ${glyphs[0]!.mask.width}x${glyphs[0]!.mask.height}):\n` +
            asciiMask(glyphs[0]!.mask)
        )
        console.log(
          `[train] glyph1 (LEARNED as '8', ${glyphs[1]!.mask.width}x${glyphs[1]!.mask.height}):\n` +
            asciiMask(glyphs[1]!.mask)
        )
      }
    }
    console.log(
      `[train] level TRAIN seg outcomes: 2-glyphs(contributes)=${two} 1-glyph(skipped)=${one} other=${other}`
    )
  })

  it('(6) counterfactual: templates built WITHOUT level train (no chrome contamination)', () => {
    const { set: cleanSet, stats: cleanStats } = buildTemplatesFromFixtures(
      data.filter((d) => d.region !== 'level').map((d) => ({ region: d.region, fx: d.train }))
    )
    console.log(`[cf] clean-set perChar: ${JSON.stringify(cleanStats.perChar)}`)
    let correct = 0
    const fails: string[] = []
    for (const f of levelData.test) {
      const r = recognizeImage(f.image, cleanSet, 'level')
      const got = parseRegionString('level', r.text)
      const want = parseRegionString('level', f.label)
      if (want && parsedEquals(got, want)) correct++
      else if (fails.length < 25) fails.push(`  ${f.label} -> "${r.text}"`)
    }
    console.log(
      `[cf] level TEST accuracy with NO level-train contamination: ` +
        `${((correct / levelData.test.length) * 100).toFixed(1)}% (${correct}/${levelData.test.length})` +
        ` vs 71.4% with contaminated set`
    )
    if (fails.length) console.log(`[cf] failures:\n${fails.join('\n')}`)
    // Score the chrome+2 mega-glyph (glyph0 of a passing fixture) against both sets.
    const passing = levelData.test.find((f) => f.name === '28_20260503_021404_295') ?? levelData.test[0]!
    const mask = prepareRegionMask(passing.image, 'level')
    const glyphs = segmentGlyphs(mask)
    if (glyphs.length >= 1) {
      const g0 = glyphs[0]!
      const contaminated = scoreAll(g0.mask, set, allowed).slice(0, 3)
      const clean = scoreAll(g0.mask, cleanSet, allowed).slice(0, 3)
      console.log(
        `[cf] mega-glyph (chrome+'2', ${g0.mask.width}x${g0.mask.height}) top-3 vs CONTAMINATED set: ` +
          contaminated.map((t) => `'${t.char}'=${t.score.toFixed(4)}`).join(' ')
      )
      console.log(
        `[cf] mega-glyph top-3 vs CLEAN set:                       ` +
          clean.map((t) => `'${t.char}'=${t.score.toFixed(4)}`).join(' ')
      )
    }
  })

  it('(2) right-edge truncation scan across ALL level fixtures', () => {
    const all = loadFixtures('level')
    let touchRight = 0
    let touchLeft = 0
    const sizes = new Map<string, number>()
    for (const f of all) {
      const k = `${f.image.width}x${f.image.height}`
      sizes.set(k, (sizes.get(k) ?? 0) + 1)
      const mask = prepareRegionMask(f.image, 'level')
      const ib = inkBounds(mask)
      if (!ib) continue
      if (ib.x1 >= mask.width) touchRight++
      if (ib.x0 === 0) touchLeft++
    }
    console.log(`[edge] png sizes: ${JSON.stringify([...sizes.entries()])}`)
    console.log(
      `[edge] fixtures whose ink touches mask right edge: ${touchRight}/${all.length}, left edge: ${touchLeft}/${all.length}`
    )
    // For one passing fixture, show a reference dump for comparison.
    const passing = levelData.test.find((f) => {
      const r = recognizeImage(f.image, set, 'level')
      const got = parseRegionString('level', r.text)
      const want = parseRegionString('level', f.label)
      return want && parsedEquals(got, want)
    })
    if (passing) {
      const mask = prepareRegionMask(passing.image, 'level')
      const glyphs = segmentGlyphs(mask)
      console.log(
        `[ref] PASSING ${passing.name} label="${passing.label}" -> ${glyphs.length} glyphs, ` +
          `boxes=${glyphs.map((g) => `x[${g.box.x0},${g.box.x1})`).join(' ')}`
      )
      console.log(`[ref] mask:\n${asciiMask(mask)}`)
    }
  })
})
