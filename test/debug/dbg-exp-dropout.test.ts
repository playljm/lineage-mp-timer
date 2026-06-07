/**
 * DEBUG instrumentation — EXP "30.4XYZ" -> "30..YZ" dropout / 4->"." misread.
 *
 * Reproduces the exact train/test split of test/ocr/accuracy.test.ts, then for
 * the four failing fixtures (30.4015 / 30.4295 / 30.4614 / 30.4912) dumps every
 * pipeline stage: scaled image, binarized mask, raw connected components,
 * post-merge segmentation boxes, per-glyph ASCII art, top-5 template scores,
 * and luminance statistics (integer part vs decimal part).
 *
 * READ-ONLY diagnostics: no src/ change, console.log evidence only.
 */
import { describe, it } from 'vitest'
import type { RegionKind, BinaryMask, RgbaImage } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import {
  recognizeImage,
  prepareRegionMask,
  WORK_HEIGHT
} from '@core/ocr/text-recognizer'
import { segmentGlyphs, connectedComponents } from '@core/ocr/segmentation'
import {
  normalizeGlyph,
  type TemplateSet,
  CANON_W,
  CANON_H
} from '@core/ocr/template-matcher'
import {
  scaleToHeight,
  binarizeAuto,
  removeSolidBands,
  borderMeanLuma,
  toGray,
  countInk
} from '@core/ocr/imaging'
import { loadFixtures, type Fixture } from '../helpers/fixtures'
import { buildTemplatesFromFixtures } from '../helpers/build-templates'

const REGIONS: RegionKind[] = ['mp', 'exp', 'level', 'adena']

function split<T>(arr: T[]): { train: T[]; test: T[] } {
  const train: T[] = []
  const test: T[] = []
  arr.forEach((x, i) => (i % 2 === 0 ? train : test).push(x))
  return { train, test }
}

function asciiMask(mask: BinaryMask, yStep = 1): string {
  const lines: string[] = []
  for (let y = 0; y < mask.height; y += yStep) {
    let line = ''
    for (let x = 0; x < mask.width; x++) line += mask.data[y * mask.width + x] ? '#' : '.'
    lines.push(line)
  }
  return lines.join('\n')
}

function asciiGrid(grid: Uint8Array, w: number, h: number): string {
  // template grid is mean occupancy 0..255 -> quantize
  const lines: string[] = []
  for (let y = 0; y < h; y++) {
    let line = ''
    for (let x = 0; x < w; x++) {
      const v = grid[y * w + x]!
      line += v >= 192 ? '#' : v >= 96 ? '+' : v >= 32 ? ':' : '.'
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/** Replicates matchGlyph scoring but returns top-K candidates. */
function topK(
  tight: BinaryMask,
  set: TemplateSet,
  allowed: ReadonlySet<string>,
  k = 5
): { char: string; score: number; pixelScore: number; aspectPenalty: number }[] {
  const aspectWeight = 0.15
  const norm = normalizeGlyph(tight, set.canonW, set.canonH)
  const aspect = tight.height > 0 ? tight.width / tight.height : 1
  const cells = set.canonW * set.canonH
  const scored = []
  for (const tpl of set.chars) {
    if (!allowed.has(tpl.char)) continue
    let diff = 0
    for (let i = 0; i < cells; i++) {
      const t = tpl.grid[i]! / 255
      diff += norm[i]! >= 1 ? 1 - t : t
    }
    const pixelScore = 1 - diff / cells
    const aspectPenalty = aspectWeight * Math.min(1, Math.abs(aspect - tpl.meanAspect))
    scored.push({ char: tpl.char, score: pixelScore - aspectPenalty, pixelScore, aspectPenalty })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

/** Mean/max luminance of ink pixels inside a box of the scaled image, given the mask. */
function inkLumaStats(
  scaled: RgbaImage,
  mask: BinaryMask,
  box: { x0: number; y0: number; x1: number; y1: number }
): { meanInk: number; maxInk: number; inkPx: number } {
  const gray = toGray(scaled)
  let sum = 0
  let max = 0
  let n = 0
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      if (mask.data[y * mask.width + x]) {
        const v = gray.data[y * gray.width + x]!
        sum += v
        if (v > max) max = v
        n++
      }
    }
  }
  return { meanInk: n ? sum / n : 0, maxInk: max, inkPx: n }
}

/** Max luminance per column range of the scaled gray image (pre-binarization view). */
function columnMaxLuma(scaled: RgbaImage, x0: number, x1: number): number {
  const gray = toGray(scaled)
  let max = 0
  for (let y = 0; y < gray.height; y++) {
    for (let x = x0; x < Math.min(x1, gray.width); x++) {
      const v = gray.data[y * gray.width + x]!
      if (v > max) max = v
    }
  }
  return max
}

describe('DEBUG exp 30.4XYZ dropout', () => {
  // Reproduce accuracy.test.ts split + shared template set exactly.
  const data = REGIONS.map((region) => {
    const all = loadFixtures(region)
    return { region, ...split(all) }
  })
  const { set, stats } = buildTemplatesFromFixtures(
    data.map((d) => ({ region: d.region, fx: d.train }))
  )
  const expData = data.find((d) => d.region === 'exp')!
  const allowed = new Set(REGION_ALPHABET.exp)

  it('A. template inventory: 4 and . templates', () => {
    console.log(`\n[A] perChar counts: ${JSON.stringify(stats.perChar)}`)
    console.log(`[A] build used=${stats.used} skipped=${stats.skipped}`)
    for (const ch of ['4', '.', '0', '1', '7']) {
      const tpl = set.chars.find((c) => c.char === ch)
      if (!tpl) {
        console.log(`[A] template '${ch}': MISSING`)
        continue
      }
      console.log(
        `[A] template '${ch}': samples=${tpl.samples} meanAspect=${tpl.meanAspect.toFixed(3)}`
      )
      console.log(asciiGrid(tpl.grid, CANON_W, CANON_H))
    }
  })

  it('B. which 30.4x samples are train vs test, and did train ones contribute?', () => {
    const all = [...expData.train.map((f) => ({ f, split: 'TRAIN' })), ...expData.test.map((f) => ({ f, split: 'TEST' }))]
    const t304 = all.filter((e) => e.f.label.startsWith('30.4'))
    for (const { f, split: sp } of t304) {
      const mask = prepareRegionMask(f.image, 'exp')
      const glyphs = segmentGlyphs(mask)
      const contributed = sp === 'TRAIN' && glyphs.length === f.label.length
      console.log(
        `[B] ${sp} ${f.label} (${f.name}): label len=${f.label.length} seg count=${glyphs.length}` +
          (sp === 'TRAIN' ? ` -> ${contributed ? 'CONTRIBUTED' : 'SKIPPED (seg mismatch)'}` : '')
      )
    }
    // Also count how many TRAIN samples contributed a '4' at all, by label position.
    let train4 = 0
    let train4used = 0
    for (const f of expData.train) {
      if (!f.label.includes('4')) continue
      train4++
      const mask = prepareRegionMask(f.image, 'exp')
      if (segmentGlyphs(mask).length === f.label.length) train4used++
    }
    console.log(`[B] exp TRAIN samples containing '4': ${train4}, of which seg-aligned (usable): ${train4used}`)
  })

  it('D. trace training-sample provenance for chars 1 / 4 / . (aspect contamination)', () => {
    // Replicate buildTemplatesFromFixtures alignment, but log each added glyph's
    // native aspect + source fixture for the suspicious chars.
    const watch = new Set(['1', '4', '.'])
    const adds: { char: string; region: string; fixture: string; w: number; h: number; aspect: number }[] = []
    for (const d of data) {
      const allowedR = new Set(REGION_ALPHABET[d.region])
      for (const f of d.train) {
        const chars = f.label.split('').filter((c) => allowedR.has(c))
        const mask = prepareRegionMask(f.image, d.region)
        const glyphs = segmentGlyphs(mask)
        if (glyphs.length !== chars.length || chars.length === 0) continue
        for (let i = 0; i < glyphs.length; i++) {
          const ch = chars[i]!
          if (!watch.has(ch)) continue
          const m = glyphs[i]!.mask
          adds.push({
            char: ch,
            region: d.region,
            fixture: f.name,
            w: m.width,
            h: m.height,
            aspect: m.height > 0 ? m.width / m.height : 1
          })
        }
      }
    }
    for (const ch of watch) {
      const list = adds.filter((a) => a.char === ch)
      const aspects = list.map((a) => a.aspect)
      const mean = aspects.reduce((s, v) => s + v, 0) / (aspects.length || 1)
      console.log(`\n[D] char '${ch}': ${list.length} train samples, meanAspect=${mean.toFixed(3)}`)
      // print all, sorted by aspect descending so outliers surface
      list.sort((a, b) => b.aspect - a.aspect)
      for (const a of list) {
        console.log(
          `[D]   '${a.char}' ${a.region}/${a.fixture} ${a.w}x${a.h} aspect=${a.aspect.toFixed(2)}${a.aspect > 2 ? '  <-- OUTLIER' : ''}`
        )
      }
    }
  })

  it('E. bridge mechanism + wide-split arithmetic for 30.4015', () => {
    const f = expData.test.find((x: Fixture) => x.label === '30.4015')!
    const scaled = scaleToHeight(f.image, WORK_HEIGHT)
    const gray = toGray(scaled)
    const bg = borderMeanLuma(scaled)
    const T = Math.max(20, bg * 0.8)
    // The merged comp is x=[70,111). The true boundary (per 30.5042 where the same
    // '50' pair separates at [70,90)+[91,111)) is ~x=90. Dump per-column min-luma
    // and ink count around the junction x=[86,96).
    console.log(`[E] threshold T=${T.toFixed(1)} (ink = luma < T)`)
    for (let x = 84; x < 98; x++) {
      let minL = 255
      let ink = 0
      let bridgeRows: number[] = []
      for (let y = 0; y < gray.height; y++) {
        const v = gray.data[y * gray.width + x]!
        if (v < minL) minL = v
        if (v < T) {
          ink++
          bridgeRows.push(y)
        }
      }
      console.log(
        `[E] col x=${x}: minLuma=${minL} inkRows=${ink}${ink > 0 && ink <= 4 ? ` rows=[${bridgeRows.join(',')}]` : ''}`
      )
    }
    // And the luma of the actual bridging pixels (columns where ink count is small)
    // Wide-split arithmetic replication (segmentGlyphs internals):
    const mask = prepareRegionMask(f.image, 'exp')
    const comps = connectedComponents(mask, 3).filter(
      (c) => !((c.x0 === 0 || c.x1 === mask.width) && c.x1 - c.x0 <= 3)
    )
    comps.sort((a, b) => a.x0 + a.x1 - (b.x0 + b.x1))
    // (merge step: none of these overlap in x for this fixture — verified in C dump)
    const widths = comps.map((c) => c.x1 - c.x0).sort((a, b) => a - b)
    const med = widths.length % 2 ? widths[widths.length >> 1]! : (widths[(widths.length >> 1) - 1]! + widths[widths.length >> 1]!) / 2
    const estGlyph = Math.max(med * 0.7, mask.height * 0.62)
    const inkH = 26 // measured ink rows y=[11,37)
    console.log(
      `[E] widths=[${widths.join(',')}] median=${med} | estGlyph=max(${(med * 0.7).toFixed(1)}, ${mask.height}*0.62=${(mask.height * 0.62).toFixed(1)})=${estGlyph.toFixed(1)} -> splitThreshold=${(estGlyph * 1.5).toFixed(1)} vs mergedW=41 => ${41 > estGlyph * 1.5 ? 'SPLIT' : 'NO SPLIT'}`
    )
    console.log(
      `[E] if ink-height used: est=${(inkH * 0.62).toFixed(1)} -> thr=${(inkH * 0.62 * 1.5).toFixed(1)} => split, parts=round(41/${(inkH * 0.62).toFixed(1)})=${Math.round(41 / (inkH * 0.62))} (over-split!)`
    )
    console.log(
      `[E] if median-width used: est=${med} -> thr=${med * 1.5} => ${41 > med * 1.5 ? 'SPLIT' : 'NO SPLIT'}, parts=round(41/${med})=${Math.round(41 / med)} (correct=2)`
    )
  })

  const targets = ['30.4015', '30.4295', '30.4614', '30.4912']
  // also one TRAIN sibling for contrast
  const contrastLabels = ['30.4226', '30.5042']

  for (const label of [...targets, ...contrastLabels]) {
    it(`C. deep dump ${label}`, () => {
      const f =
        expData.test.find((x: Fixture) => x.label === label) ??
        expData.train.find((x: Fixture) => x.label === label)
      if (!f) {
        console.log(`[C ${label}] fixture not found in either split`)
        return
      }
      const inTest = expData.test.includes(f)
      console.log(`\n[C ${label}] ===== ${f.name} (${inTest ? 'TEST' : 'TRAIN'}) =====`)
      console.log(`[C ${label}] source PNG ${f.image.width}x${f.image.height}`)

      const scaled = scaleToHeight(f.image, WORK_HEIGHT)
      const bg = borderMeanLuma(scaled)
      const darkText = bg > 128
      const T = darkText ? Math.max(20, bg * 0.8) : Math.min(235, bg + (255 - bg) * 0.5)
      console.log(
        `[C ${label}] scaled ${scaled.width}x${scaled.height} borderMeanLuma=${bg.toFixed(1)} polarity=${darkText ? 'dark' : 'bright'}-text threshold=${T.toFixed(1)}`
      )

      const rawMask = binarizeAuto(scaled, {})
      const mask = removeSolidBands(rawMask)
      const removedRows: number[] = []
      for (let y = 0; y < rawMask.height; y++) {
        let cRaw = 0
        let cClean = 0
        for (let x = 0; x < rawMask.width; x++) {
          if (rawMask.data[y * rawMask.width + x]) cRaw++
          if (mask.data[y * mask.width + x]) cClean++
        }
        if (cRaw > 0 && cClean === 0) removedRows.push(y)
      }
      console.log(
        `[C ${label}] ink: raw=${countInk(rawMask)} afterRemoveSolidBands=${countInk(mask)} removedRows=[${removedRows.join(',')}]`
      )

      // Full-mask ASCII (y-step 2 to keep it readable)
      console.log(`[C ${label}] full mask (every 2nd row):\n${asciiMask(mask, 2)}`)

      // Raw CCL components at minArea=1 (see sub-threshold fragments too)
      const comps1 = connectedComponents(mask, 1)
      comps1.sort((a, b) => a.x0 - b.x0)
      console.log(
        `[C ${label}] raw CCL minArea=1: ${comps1.length} comps:\n` +
          comps1
            .map(
              (c) =>
                `    x=[${c.x0},${c.x1}) y=[${c.y0},${c.y1}) w=${c.x1 - c.x0} h=${c.y1 - c.y0} area=${c.area}`
            )
            .join('\n')
      )

      // Final segmentation
      const glyphs = segmentGlyphs(mask)
      console.log(`[C ${label}] segmentGlyphs -> ${glyphs.length} glyphs (label has ${f.label.length} chars)`)
      const gray = toGray(scaled)
      glyphs.forEach((g, i) => {
        const st = inkLumaStats(scaled, mask, g.box)
        const cands = topK(g.mask, set, allowed, 5)
        console.log(
          `[C ${label}] glyph#${i} box x=[${g.box.x0},${g.box.x1}) y=[${g.box.y0},${g.box.y1}) ` +
            `w=${g.box.x1 - g.box.x0} h=${g.box.y1 - g.box.y0} ink=${countInk(g.mask)} ` +
            `meanInkLuma=${st.meanInk.toFixed(1)} maxInkLuma=${st.maxInk}`
        )
        console.log(
          `[C ${label}]   top5: ` +
            cands
              .map(
                (c) =>
                  `'${c.char}'=${c.score.toFixed(3)}(px${c.pixelScore.toFixed(3)}-asp${c.aspectPenalty.toFixed(3)})`
              )
              .join(' ')
        )
        console.log(asciiMask(g.mask))
      })

      // Pre-binarization luminance by glyph-x band: is the decimal part dimmer?
      // Use the recognized glyph boxes to bound bands; also probe the gap regions.
      const bands: { name: string; x0: number; x1: number }[] = []
      glyphs.forEach((g, i) => bands.push({ name: `glyph#${i}`, x0: g.box.x0, x1: g.box.x1 }))
      for (const b of bands) {
        console.log(
          `[C ${label}] band ${b.name} x=[${b.x0},${b.x1}) colMaxLuma=${columnMaxLuma(scaled, b.x0, b.x1)}`
        )
      }
      // Column max-luma profile across the whole width (compact: every 4 cols)
      let prof = ''
      for (let x = 0; x < gray.width; x += 4) {
        let m = 0
        for (let y = 0; y < gray.height; y++) m = Math.max(m, gray.data[y * gray.width + x]!)
        prof += m >= T ? (m >= T + 40 ? 'H' : 'h') : m >= T - 20 ? '~' : '.'
      }
      console.log(`[C ${label}] colMaxLuma profile (4px/char, H=>T+40 h>=T ~>=T-20): ${prof}`)

      // End-to-end
      const r = recognizeImage(f.image, set, 'exp')
      console.log(
        `[C ${label}] recognizeImage -> "${r.text}" minConf=${r.minConfidence.toFixed(3)} glyphConfs=[${r.glyphs
          .map((g) => `${g.char || '∅'}:${g.confidence.toFixed(2)}${g.runnerUp ? `(ru ${g.runnerUp}:${g.runnerUpConfidence.toFixed(2)})` : ''}`)
          .join(' ')}]`
      )
    })
  }
})
