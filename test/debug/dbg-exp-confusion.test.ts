/**
 * DEBUG instrumentation: EXP 1<->7 confusion ("27.0710" -> "27.0770", minConf ~0.70).
 *
 * Reproduces accuracy.test.ts's exact train/test split + shared template set,
 * then dumps for every exp test fixture where a labeled '1' was recognized as '7'
 * (or vice versa):
 *   - segmentation boxes
 *   - the glyph's native tight mask (ASCII) + normalized 16x24 grid (ASCII)
 *   - full candidate score table (pixelScore / aspectPenalty / total) top-5
 * Plus template forensics:
 *   - '1' and '7' template sample counts, meanAspect, ASCII heatmaps
 *   - provenance: which train fixtures contributed '1'/'7' glyphs, and whether any
 *     contributed glyph scores higher against the *other* template (contamination).
 *
 * Diagnostic only — no assertions on accuracy. Does not touch src/.
 */
import { describe, it, expect } from 'vitest'
import type { RegionKind, BinaryMask } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { recognizeImage, prepareRegionMask } from '@core/ocr/text-recognizer'
import { segmentGlyphs } from '@core/ocr/segmentation'
import {
  normalizeGlyph,
  CANON_W,
  CANON_H,
  type TemplateSet,
  type CharTemplate
} from '@core/ocr/template-matcher'
import { loadFixtures, type Fixture } from '../helpers/fixtures'
import { buildTemplatesFromFixtures } from '../helpers/build-templates'

const REGIONS: RegionKind[] = ['mp', 'exp', 'level', 'adena']

function split<T>(arr: T[]): { train: T[]; test: T[] } {
  const train: T[] = []
  const test: T[] = []
  arr.forEach((x, i) => (i % 2 === 0 ? train : test).push(x))
  return { train, test }
}

// ---- score replication (mirrors matchGlyph exactly, but keeps ALL candidates) ----
interface CandidateScore {
  char: string
  pixelScore: number
  aspectPenalty: number
  score: number
}

function scoreAll(
  tight: BinaryMask,
  set: TemplateSet,
  allowed: ReadonlySet<string>,
  aspectWeight = 0.15
): CandidateScore[] {
  const norm = normalizeGlyph(tight, set.canonW, set.canonH)
  const aspect = tight.height > 0 ? tight.width / tight.height : 1
  const cells = set.canonW * set.canonH
  const out: CandidateScore[] = []
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

// ---- ASCII visualization ----
function asciiMask(mask: BinaryMask): string {
  const rows: string[] = []
  for (let y = 0; y < mask.height; y++) {
    let r = ''
    for (let x = 0; x < mask.width; x++) r += mask.data[y * mask.width + x] ? '#' : '.'
    rows.push(r)
  }
  return rows.join('\n')
}

function asciiGrid(grid: Uint8Array, w: number, h: number): string {
  // occupancy heatmap: ' ' <10%, '.' <30%, '+' <60%, '#' <85%, '@' >=85%
  const rows: string[] = []
  for (let y = 0; y < h; y++) {
    let r = ''
    for (let x = 0; x < w; x++) {
      const v = grid[y * w + x]! / 255
      r += v < 0.1 ? '.' : v < 0.3 ? ':' : v < 0.6 ? '+' : v < 0.85 ? '#' : '@'
    }
    rows.push(r)
  }
  return rows.join('\n')
}

function sideBySide(blocks: { title: string; body: string }[], gap = 4): string {
  const split = blocks.map((b) => [b.title, ...b.body.split('\n')])
  const widths = split.map((lines) => Math.max(...lines.map((l) => l.length)))
  const height = Math.max(...split.map((l) => l.length))
  const out: string[] = []
  for (let y = 0; y < height; y++) {
    out.push(
      split
        .map((lines, i) => (lines[y] ?? '').padEnd(widths[i]! + gap))
        .join('')
        .trimEnd()
    )
  }
  return out.join('\n')
}

function fmtCand(c: CandidateScore): string {
  return `'${c.char}' total=${c.score.toFixed(4)} (pixel=${c.pixelScore.toFixed(4)} aspectPen=${c.aspectPenalty.toFixed(4)})`
}

describe('DEBUG exp 1<->7 confusion', () => {
  // Exact same data prep as accuracy.test.ts
  const data = REGIONS.map((region) => {
    const all = loadFixtures(region)
    return { region, ...split(all) }
  })
  const { set, stats } = buildTemplatesFromFixtures(
    data.map((d) => ({ region: d.region, fx: d.train }))
  )
  const expAllowed = new Set(REGION_ALPHABET.exp)

  it('dumps template forensics for 1 and 7 (counts, aspect, heatmaps, provenance)', () => {
    const log: string[] = []
    log.push(`[build] used=${stats.used} skipped=${stats.skipped}`)
    log.push(`[build] perChar=${JSON.stringify(stats.perChar)}`)

    const byChar = new Map<string, CharTemplate>(set.chars.map((c) => [c.char, c]))
    for (const ch of ['1', '7', '4', '2']) {
      const t = byChar.get(ch)
      if (!t) {
        log.push(`[tpl '${ch}'] MISSING from template set`)
        continue
      }
      log.push(`[tpl '${ch}'] samples=${t.samples} meanAspect=${t.meanAspect.toFixed(3)}`)
    }
    const t1 = byChar.get('1')
    const t7 = byChar.get('7')
    if (t1 && t7) {
      log.push(
        sideBySide([
          { title: `TPL '1' (n=${t1.samples})`, body: asciiGrid(t1.grid, CANON_W, CANON_H) },
          { title: `TPL '7' (n=${t7.samples})`, body: asciiGrid(t7.grid, CANON_W, CANON_H) }
        ])
      )
      // cell-level overlap between the two averaged templates
      let l1 = 0
      const cells = CANON_W * CANON_H
      for (let i = 0; i < cells; i++) l1 += Math.abs(t1.grid[i]! - t7.grid[i]!) / 255
      log.push(`[tpl distance] meanAbsDiff('1','7') = ${(l1 / cells).toFixed(4)} (max separation=1.0)`)
    }

    // ---- provenance: replay the exact build loop, record which train glyph went into '1'/'7' ----
    interface Contribution {
      fixture: string
      region: RegionKind
      pos: number
      labeledChar: string
      mask: BinaryMask
      aspect: number
    }
    const contributions: Contribution[] = []
    for (const { region, train } of data.map((d) => ({ region: d.region, train: d.train }))) {
      const allowed = new Set(REGION_ALPHABET[region])
      for (const f of train as Fixture[]) {
        const chars = f.label.split('').filter((c) => allowed.has(c))
        const mask = prepareRegionMask(f.image, region)
        const glyphs = segmentGlyphs(mask)
        if (glyphs.length !== chars.length || chars.length === 0) continue // skipped at build
        for (let i = 0; i < glyphs.length; i++) {
          if (chars[i] === '1' || chars[i] === '7') {
            const m = glyphs[i]!.mask
            contributions.push({
              fixture: f.name,
              region,
              pos: i,
              labeledChar: chars[i]!,
              mask: m,
              aspect: m.height > 0 ? m.width / m.height : 1
            })
          }
        }
      }
    }
    const ones = contributions.filter((c) => c.labeledChar === '1')
    const sevens = contributions.filter((c) => c.labeledChar === '7')
    log.push(`[provenance] '1' contributions=${ones.length}  '7' contributions=${sevens.length}`)
    const aspStats = (arr: Contribution[]) => {
      const a = arr.map((c) => c.aspect).sort((x, y) => x - y)
      return a.length
        ? `min=${a[0]!.toFixed(3)} med=${a[(a.length / 2) | 0]!.toFixed(3)} max=${a[a.length - 1]!.toFixed(3)}`
        : 'n/a'
    }
    log.push(`[provenance] '1' native aspects: ${aspStats(ones)}`)
    log.push(`[provenance] '7' native aspects: ${aspStats(sevens)}`)

    // contamination check: does any train glyph labeled '1' score higher vs '7' (and vice versa)?
    let contam = 0
    for (const c of contributions) {
      const scores = scoreAll(c.mask, set, expAllowed)
      const best = scores[0]!
      if (best.char !== c.labeledChar) {
        contam++
        const own = scores.find((s) => s.char === c.labeledChar)!
        log.push(
          `[CONTAM?] ${c.region}/${c.fixture} pos=${c.pos} labeled '${c.labeledChar}' ` +
            `(${c.mask.width}x${c.mask.height} asp=${c.aspect.toFixed(2)}) but best=${fmtCand(best)} vs own=${fmtCand(own)}`
        )
        log.push(asciiMask(c.mask))
      }
    }
    log.push(`[provenance] train glyphs whose best-match != own label: ${contam}/${contributions.length}`)

    // sample a few raw '1' and '7' train glyphs at native resolution for shape reference
    for (const grp of [ones.slice(0, 3), sevens.slice(0, 3)]) {
      if (!grp.length) continue
      log.push(
        sideBySide(
          grp.map((c) => ({
            title: `'${c.labeledChar}' ${c.fixture.slice(0, 12)} ${c.mask.width}x${c.mask.height}`,
            body: asciiMask(c.mask)
          }))
        )
      )
    }

    console.log('\n' + log.join('\n'))
    expect(set.chars.length).toBeGreaterThan(0)
  })

  it('dumps per-glyph candidate scores for exp test fixtures with 1<->7 errors', () => {
    const { test } = data.find((d) => d.region === 'exp')!
    const log: string[] = []
    let confusionCount = 0
    let otherFail = 0

    for (const f of test as Fixture[]) {
      const result = recognizeImage(f.image, set, 'exp')
      const labelChars = f.label.split('').filter((c) => expAllowed.has(c))
      const gotText = result.text
      if (gotText === labelChars.join('')) continue

      // detect 1<->7 confusion specifically (same length, positional swap)
      const sameLen = result.glyphs.length === labelChars.length
      const swaps: number[] = []
      if (sameLen) {
        for (let i = 0; i < labelChars.length; i++) {
          const want = labelChars[i]!
          const got = result.glyphs[i]!.char
          if (want !== got && ((want === '1' && got === '7') || (want === '7' && got === '1')))
            swaps.push(i)
        }
      }
      if (!swaps.length) {
        otherFail++
        continue
      }
      confusionCount++
      log.push(`\n=== ${f.name}  label="${f.label}" -> got "${gotText}" (minConf ${result.minConfidence.toFixed(3)})`)
      // segmentation overview
      const mask = prepareRegionMask(f.image, 'exp')
      const glyphs = segmentGlyphs(mask)
      log.push(
        `  seg: ${glyphs.length} boxes: ` +
          glyphs.map((g) => `[x${g.box.x0}-${g.box.x1} y${g.box.y0}-${g.box.y1}]`).join(' ')
      )
      for (const i of swaps) {
        const g = glyphs[i]!
        const scores = scoreAll(g.mask, set, expAllowed)
        log.push(
          `  glyph[${i}] want='${labelChars[i]}' got='${result.glyphs[i]!.char}' ` +
            `native=${g.mask.width}x${g.mask.height} aspect=${(g.mask.width / g.mask.height).toFixed(3)}`
        )
        for (const c of scores.slice(0, 5)) log.push(`    ${fmtCand(c)}`)
        const norm = normalizeGlyph(g.mask, CANON_W, CANON_H)
        const normMask: BinaryMask = { width: CANON_W, height: CANON_H, data: norm }
        log.push(
          sideBySide([
            { title: `native ${g.mask.width}x${g.mask.height}`, body: asciiMask(g.mask) },
            { title: `norm ${CANON_W}x${CANON_H}`, body: asciiMask(normMask) }
          ])
        )
        // also show a correctly-recognized true '7' from the same fixture for contrast
        const trueSevenIdx = labelChars.findIndex(
          (c, j) => c === '7' && result.glyphs[j]?.char === '7'
        )
        if (trueSevenIdx >= 0) {
          const g7 = glyphs[trueSevenIdx]!
          const s7 = scoreAll(g7.mask, set, expAllowed)
          log.push(
            `  [contrast] true '7' at pos ${trueSevenIdx}: native=${g7.mask.width}x${g7.mask.height} ` +
              `aspect=${(g7.mask.width / g7.mask.height).toFixed(3)} top: ${s7.slice(0, 3).map(fmtCand).join(' | ')}`
          )
          log.push(asciiMask(g7.mask))
        }
      }
    }
    log.unshift(
      `[exp test] 1<->7 confusion fixtures: ${confusionCount}, other failures: ${otherFail}, total test=${(test as Fixture[]).length}`
    )
    console.log('\n' + log.join('\n'))
    expect(true).toBe(true)
  })

  it('COUNTERFACTUAL: exp accuracy when train glyphs with implausible geometry are excluded', async () => {
    // Same build loop, but drop any train *fixture* containing a glyph whose
    // height deviates wildly from the sample's median glyph height, or whose
    // aspect is impossible for the labeled char (the 54x2 gauge bands etc.).
    // This simulates a per-glyph plausibility guard at learn time.
    const { TemplateBuilder } = await import('@core/ocr/template-matcher')
    const builder = new TemplateBuilder()
    let dropped = 0
    let used = 0
    for (const { region, train } of data.map((d) => ({ region: d.region, train: d.train }))) {
      const allowed = new Set(REGION_ALPHABET[region])
      for (const f of train as Fixture[]) {
        const chars = f.label.split('').filter((c) => allowed.has(c))
        const mask = prepareRegionMask(f.image, region)
        const glyphs = segmentGlyphs(mask)
        if (glyphs.length !== chars.length || chars.length === 0) continue
        // Geometry checks apply to DIGITS only ('.', ',' are legitimately tiny).
        const digitHeights = glyphs
          .filter((_, i) => /[0-9]/.test(chars[i]!))
          .map((g) => g.mask.height)
          .sort((a, b) => a - b)
        const medH = digitHeights.length ? digitHeights[(digitHeights.length / 2) | 0]! : 0
        const plausible = glyphs.every((g, i) => {
          if (!/[0-9]/.test(chars[i]!)) return true
          const asp = g.mask.width / g.mask.height
          if (medH > 0 && g.mask.height < medH * 0.5) return false // flat sliver vs sibling digits
          if (asp > 1.3) return false // digits are taller than wide in this font
          return true
        })
        if (!plausible) {
          dropped++
          continue
        }
        for (let i = 0; i < glyphs.length; i++) builder.add(chars[i]!, glyphs[i]!.mask)
        used++
      }
    }
    const cleanSet = builder.finalize()
    const t1c = cleanSet.chars.find((c) => c.char === '1')
    const t7c = cleanSet.chars.find((c) => c.char === '7')
    console.log(
      `\n[counterfactual] used=${used} droppedByGuard=${dropped}` +
        `\n[counterfactual] clean tpl '1': samples=${t1c?.samples} meanAspect=${t1c?.meanAspect.toFixed(3)}` +
        `\n[counterfactual] clean tpl '7': samples=${t7c?.samples} meanAspect=${t7c?.meanAspect.toFixed(3)}`
    )
    if (t1c) {
      console.log(sideBySide([{ title: `CLEAN TPL '1' (n=${t1c.samples})`, body: asciiGrid(t1c.grid, CANON_W, CANON_H) }]))
    }

    // Counterfactual B: original grids untouched, ONLY '1'.meanAspect repaired to the
    // median of plausible '1' train aspects — isolates the aspect-poisoning factor.
    const legitOneAspects: number[] = []
    for (const { region, train } of data.map((d) => ({ region: d.region, train: d.train }))) {
      const allowed = new Set(REGION_ALPHABET[region])
      for (const f of train as Fixture[]) {
        const chars = f.label.split('').filter((c) => allowed.has(c))
        const mask = prepareRegionMask(f.image, region)
        const glyphs = segmentGlyphs(mask)
        if (glyphs.length !== chars.length || chars.length === 0) continue
        for (let i = 0; i < glyphs.length; i++) {
          if (chars[i] === '1') {
            const asp = glyphs[i]!.mask.width / glyphs[i]!.mask.height
            if (asp <= 1.3) legitOneAspects.push(asp)
          }
        }
      }
    }
    legitOneAspects.sort((a, b) => a - b)
    const medOneAspect = legitOneAspects[(legitOneAspects.length / 2) | 0] ?? 0.6
    const aspectFixedSet: TemplateSet = {
      ...set,
      chars: set.chars.map((c) => (c.char === '1' ? { ...c, meanAspect: medOneAspect } : c))
    }
    console.log(
      `[counterfactual] aspect-only fix: '1'.meanAspect ${set.chars.find((c) => c.char === '1')!.meanAspect.toFixed(3)} -> ${medOneAspect.toFixed(3)} (median of ${legitOneAspects.length} plausible train '1's, grid left contaminated)`
    )

    // Re-run the exp benchmark with each set.
    const { parseRegionString, parsedEquals } = await import('@core/ocr/parser')
    const { test } = data.find((d) => d.region === 'exp')!
    for (const [name, s] of [
      ['original', set],
      ['aspect-only-fix', aspectFixedSet],
      ['clean', cleanSet]
    ] as const) {
      let correct = 0
      let total = 0
      const failures: string[] = []
      for (const f of test as Fixture[]) {
        const r = recognizeImage(f.image, s, 'exp')
        const got = parseRegionString('exp', r.text)
        const want = parseRegionString('exp', f.label)
        total++
        if (want && parsedEquals(got, want)) correct++
        else if (failures.length < 12) failures.push(`    ${f.label} -> "${r.text}"`)
      }
      console.log(
        `[counterfactual] exp accuracy with ${name} set: ${((correct / total) * 100).toFixed(1)}% (${correct}/${total})` +
          (failures.length ? `\n${failures.join('\n')}` : '')
      )
    }
    // Also: level + adena with clean set, to check for cross-region regression.
    for (const region of ['level', 'adena'] as RegionKind[]) {
      const { test: t } = data.find((d) => d.region === region)!
      for (const [name, s] of [
        ['original', set],
        ['aspect-only-fix', aspectFixedSet],
        ['clean', cleanSet]
      ] as const) {
        let correct = 0
        let total = 0
        for (const f of t as Fixture[]) {
          const r = recognizeImage(f.image, s, region)
          const got = parseRegionString(region, r.text)
          const want = parseRegionString(region, f.label)
          total++
          if (want && parsedEquals(got, want)) correct++
        }
        console.log(
          `[counterfactual] ${region} accuracy with ${name} set: ${((correct / total) * 100).toFixed(1)}% (${correct}/${total})`
        )
      }
    }
    expect(true).toBe(true)
  })
})
