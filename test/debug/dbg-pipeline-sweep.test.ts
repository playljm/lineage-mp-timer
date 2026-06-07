/**
 * dbg-pipeline-sweep — pipeline-level instrumentation + threshold sweeps.
 *
 * Reproduces the exact train/test split of test/ocr/accuracy.test.ts, then:
 *  1. dumps per-region template-build skip rates + glyph-count mismatch histograms
 *  2. quantifies train/test label leakage (same value captured in adjacent frames)
 *  3. sweeps parameterizable knobs WITHOUT touching src/:
 *     - WORK_HEIGHT      (hard-coded 48 in text-recognizer.ts:15 — replicated here)
 *     - brightRatio      (binarizeAuto option, default 0.5 imaging.ts:173)
 *     - rowFrac          (removeSolidBands, hard-coded 0.8 default imaging.ts:198,
 *                         call-site not parameterized in prepareRegionMask — replicated)
 *     - aspectWeight     (matchGlyph option, default 0.15 template-matcher.ts:104 —
 *                         NOT exposed through recognizeMask, so recognizeMask is
 *                         replicated here)
 *  4. shows there is NO match-rejection threshold anywhere in the pipeline by
 *     measuring confidence/margin distributions of correct vs wrong glyph reads.
 *
 * NOTE: templates are REBUILT with each preprocessing config so train and test go
 * through the same pipeline (otherwise the sweep would be unfair to non-default
 * configs).
 */
import { describe, it } from 'vitest'
import type { RegionKind, RgbaImage, BinaryMask } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import {
  scaleToHeight,
  binarizeAuto,
  removeSolidBands,
  type AutoBinarizeOptions
} from '@core/ocr/imaging'
import { segmentGlyphs } from '@core/ocr/segmentation'
import {
  TemplateBuilder,
  matchGlyph,
  type TemplateSet
} from '@core/ocr/template-matcher'
import { parseRegionString, parsedEquals } from '@core/ocr/parser'
import { loadFixtures, type Fixture } from '../helpers/fixtures'

const REGIONS: RegionKind[] = ['mp', 'exp', 'level', 'adena']

function split<T>(arr: T[]): { train: T[]; test: T[] } {
  const train: T[] = []
  const test: T[] = []
  arr.forEach((x, i) => (i % 2 === 0 ? train : test).push(x))
  return { train, test }
}

const data = REGIONS.map((region) => {
  const all = loadFixtures(region)
  return { region, ...split(all) }
})

// ---- parameterized replica of prepareRegionMask (text-recognizer.ts:25-33) ----
interface PipelineCfg {
  workHeight: number // src hard-codes 48
  binarize?: AutoBinarizeOptions // brightRatio default 0.5, darkRatio 0.8
  rowFrac: number // src hard-codes removeSolidBands default 0.8
  aspectWeight: number // src hard-codes matchGlyph default 0.15
}
const DEFAULT_CFG: PipelineCfg = { workHeight: 48, rowFrac: 0.8, aspectWeight: 0.15 }

function prepMask(img: RgbaImage, region: RegionKind, cfg: PipelineCfg): BinaryMask {
  const scaled = scaleToHeight(img, cfg.workHeight)
  const base: AutoBinarizeOptions = region === 'mp' ? { blueMargin: 40 } : {}
  const mask = binarizeAuto(scaled, { ...base, ...cfg.binarize })
  return cfg.rowFrac >= 1 ? mask : removeSolidBands(mask, cfg.rowFrac)
}

// ---- parameterized replica of buildTemplatesFromFixtures (helpers/build-templates.ts) ----
function buildTemplates(cfg: PipelineCfg): {
  set: TemplateSet
  perRegion: Record<string, { used: number; skipped: number; mismatches: Record<string, number> }>
} {
  const builder = new TemplateBuilder()
  const perRegion: Record<
    string,
    { used: number; skipped: number; mismatches: Record<string, number> }
  > = {}
  for (const { region, train } of data) {
    const allowed = new Set(REGION_ALPHABET[region])
    const stat = { used: 0, skipped: 0, mismatches: {} as Record<string, number> }
    perRegion[region] = stat
    for (const f of train) {
      const chars = f.label.split('').filter((c) => allowed.has(c))
      const mask = prepMask(f.image, region, cfg)
      const glyphs = segmentGlyphs(mask)
      if (glyphs.length !== chars.length || chars.length === 0) {
        stat.skipped++
        const key = `${chars.length}->${glyphs.length}`
        stat.mismatches[key] = (stat.mismatches[key] ?? 0) + 1
        continue
      }
      for (let i = 0; i < glyphs.length; i++) builder.add(chars[i]!, glyphs[i]!.mask)
      stat.used++
    }
  }
  return { set: builder.finalize(), perRegion }
}

// ---- parameterized replica of recognizeMask (text-recognizer.ts:42-74) ----
function recognize(
  img: RgbaImage,
  set: TemplateSet,
  region: RegionKind,
  cfg: PipelineCfg
): {
  text: string
  minConf: number
  glyphDetails: { char: string; conf: number; runnerUp: string | null; margin: number }[]
} {
  const mask = prepMask(img, region, cfg)
  const glyphs = segmentGlyphs(mask)
  const allowed = REGION_ALPHABET[region]
  let text = ''
  let minConf = 1
  const glyphDetails: { char: string; conf: number; runnerUp: string | null; margin: number }[] = []
  for (const g of glyphs) {
    const m = matchGlyph(g.mask, set, { allowed, aspectWeight: cfg.aspectWeight })
    text += m.char
    minConf = Math.min(minConf, m.confidence)
    glyphDetails.push({
      char: m.char,
      conf: m.confidence,
      runnerUp: m.runnerUp,
      margin: m.confidence - m.runnerUpConfidence
    })
  }
  return { text, minConf: glyphs.length ? minConf : 0, glyphDetails }
}

function evaluate(set: TemplateSet, cfg: PipelineCfg): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { region, test } of data) {
    let correct = 0
    let total = 0
    for (const f of test as Fixture[]) {
      const r = recognize(f.image, set, region, cfg)
      const got = parseRegionString(region, r.text)
      const want = parseRegionString(region, f.label)
      total++
      if (want && parsedEquals(got, want)) correct++
    }
    out[region] = `${((correct / Math.max(1, total)) * 100).toFixed(1)}% (${correct}/${total})`
  }
  return out
}

const buildCache = new Map<string, ReturnType<typeof buildTemplates>>()
function cachedBuild(cfg: PipelineCfg): ReturnType<typeof buildTemplates> {
  const key = JSON.stringify({ w: cfg.workHeight, b: cfg.binarize, r: cfg.rowFrac })
  let v = buildCache.get(key)
  if (!v) {
    v = buildTemplates(cfg)
    buildCache.set(key, v)
  }
  return v
}

describe('dbg-pipeline-sweep', () => {
  it('A. baseline diagnostics: build skip rates + seg-count mismatches per region', () => {
    const { perRegion } = cachedBuild(DEFAULT_CFG)
    for (const region of REGIONS) {
      const s = perRegion[region]!
      console.log(
        `[build:${region}] used=${s.used} skipped=${s.skipped} ` +
          `skipRate=${((s.skipped / Math.max(1, s.used + s.skipped)) * 100).toFixed(0)}% ` +
          `mismatch(label->seg): ${JSON.stringify(s.mismatches)}`
      )
    }
    // TEST-side glyph-count mismatch histogram (how often segmentation count != label length)
    for (const { region, test } of data) {
      const allowed = new Set(REGION_ALPHABET[region])
      const hist: Record<string, number> = {}
      for (const f of test) {
        const chars = f.label.split('').filter((c) => allowed.has(c))
        const glyphs = segmentGlyphs(prepMask(f.image, region, DEFAULT_CFG))
        const key = glyphs.length === chars.length ? 'match' : `${chars.length}->${glyphs.length}`
        hist[key] = (hist[key] ?? 0) + 1
      }
      console.log(`[testseg:${region}] ${JSON.stringify(hist)}`)
    }
  }, 120000)

  it('B. train/test label leakage: identical values across the even/odd split', () => {
    for (const { region, train, test } of data) {
      const trainLabels = new Set(train.map((f) => f.label))
      const leaked = test.filter((f) => trainLabels.has(f.label)).length
      const uniqTest = new Set(test.map((f) => f.label)).size
      console.log(
        `[leak:${region}] test=${test.length} uniqueTestLabels=${uniqTest} ` +
          `testLabelAlsoInTrain=${leaked} (${((leaked / Math.max(1, test.length)) * 100).toFixed(0)}%)`
      )
    }
  }, 60000)

  it('C. confidence/margin distributions: correct vs wrong glyph reads (no rejection exists in src)', () => {
    const { set } = cachedBuild(DEFAULT_CFG)
    // exp+level only (clean labels). A sample counts as "correct" if its full text
    // parses to the label; collect minConf + min margin per sample for both classes.
    for (const { region, test } of data) {
      if (region !== 'exp' && region !== 'level') continue
      const ok: { conf: number; margin: number }[] = []
      const bad: { conf: number; margin: number }[] = []
      for (const f of test) {
        const r = recognize(f.image, set, region, DEFAULT_CFG)
        const got = parseRegionString(region, r.text)
        const want = parseRegionString(region, f.label)
        const minMargin = r.glyphDetails.length
          ? Math.min(...r.glyphDetails.map((g) => g.margin))
          : 0
        const rec = { conf: r.minConf, margin: minMargin }
        if (want && parsedEquals(got, want)) ok.push(rec)
        else bad.push(rec)
      }
      const stats = (xs: { conf: number; margin: number }[]) => {
        if (!xs.length) return 'n=0'
        const cs = xs.map((x) => x.conf).sort((a, b) => a - b)
        const ms = xs.map((x) => x.margin).sort((a, b) => a - b)
        const q = (arr: number[], p: number) => arr[Math.floor(p * (arr.length - 1))]!.toFixed(3)
        return `n=${xs.length} minConf[p10,p50,p90]=[${q(cs, 0.1)},${q(cs, 0.5)},${q(cs, 0.9)}] margin[p10,p50,p90]=[${q(ms, 0.1)},${q(ms, 0.5)},${q(ms, 0.9)}]`
      }
      console.log(`[confdist:${region}] CORRECT ${stats(ok)}`)
      console.log(`[confdist:${region}] WRONG   ${stats(bad)}`)
    }
  }, 120000)

  it('D. sweep WORK_HEIGHT (src hard-codes 48; replicated pipeline)', () => {
    for (const wh of [24, 32, 48, 64, 96]) {
      const cfg = { ...DEFAULT_CFG, workHeight: wh }
      const { set } = cachedBuild(cfg)
      console.log(`[sweep:workHeight=${wh}] ${JSON.stringify(evaluate(set, cfg))}`)
    }
  }, 600000)

  it('E. sweep brightRatio (binarizeAuto, default 0.5)', () => {
    for (const br of [0.35, 0.45, 0.5, 0.55, 0.65]) {
      const cfg = { ...DEFAULT_CFG, binarize: { brightRatio: br } }
      const { set } = cachedBuild(cfg)
      console.log(`[sweep:brightRatio=${br}] ${JSON.stringify(evaluate(set, cfg))}`)
    }
  }, 600000)

  it('F. sweep removeSolidBands rowFrac (call-site hard-coded; >=1 disables)', () => {
    for (const rf of [0.6, 0.8, 1.1]) {
      const cfg = { ...DEFAULT_CFG, rowFrac: rf }
      const { set } = cachedBuild(cfg)
      console.log(`[sweep:rowFrac=${rf}] ${JSON.stringify(evaluate(set, cfg))}`)
    }
  }, 600000)

  it('G. sweep aspectWeight (matchGlyph option NOT exposed via recognizeMask)', () => {
    const { set } = cachedBuild(DEFAULT_CFG) // templates independent of aspectWeight
    for (const aw of [0, 0.05, 0.15, 0.3]) {
      const cfg = { ...DEFAULT_CFG, aspectWeight: aw }
      console.log(`[sweep:aspectWeight=${aw}] ${JSON.stringify(evaluate(set, cfg))}`)
    }
  }, 600000)

  it('H. combined configs (stacking the individually-best knobs)', () => {
    const combos: { name: string; cfg: PipelineCfg }[] = [
      { name: 'br45+aw0', cfg: { workHeight: 48, binarize: { brightRatio: 0.45 }, rowFrac: 0.8, aspectWeight: 0 } },
      { name: 'br45+aw0+rf60', cfg: { workHeight: 48, binarize: { brightRatio: 0.45 }, rowFrac: 0.6, aspectWeight: 0 } },
      { name: 'br45+aw0+rfOFF', cfg: { workHeight: 48, binarize: { brightRatio: 0.45 }, rowFrac: 1.1, aspectWeight: 0 } },
      { name: 'wh64+aw0', cfg: { workHeight: 64, rowFrac: 0.8, aspectWeight: 0 } },
      { name: 'wh64+br45+aw0', cfg: { workHeight: 64, binarize: { brightRatio: 0.45 }, rowFrac: 0.8, aspectWeight: 0 } },
      { name: 'rf60+aw0', cfg: { workHeight: 48, rowFrac: 0.6, aspectWeight: 0 } }
    ]
    for (const { name, cfg } of combos) {
      const { set } = cachedBuild(cfg)
      console.log(`[combo:${name}] ${JSON.stringify(evaluate(set, cfg))}`)
    }
  }, 600000)

  it('I. mp over-segmentation characterization (why mp OCR is 0% in every config)', () => {
    const mp = data.find((d) => d.region === 'mp')!
    for (const f of (mp.test as Fixture[]).slice(0, 3)) {
      const mask = prepMask(f.image, 'mp', DEFAULT_CFG)
      const glyphs = segmentGlyphs(mask)
      const boxes = glyphs
        .map((g) => `${g.box.x1 - g.box.x0}x${g.box.y1 - g.box.y0}@(${g.box.x0},${g.box.y0})`)
        .join(' ')
      console.log(`[mpseg] label="${f.label}" mask=${mask.width}x${mask.height} glyphs=${glyphs.length}: ${boxes}`)
    }
    // ASCII dump of the first sample's mask, 2x2-compressed (#=ink majority)
    const f0 = (mp.test as Fixture[])[0]!
    const m = prepMask(f0.image, 'mp', DEFAULT_CFG)
    const lines: string[] = []
    for (let y = 0; y < m.height; y += 2) {
      let row = ''
      for (let x = 0; x < m.width; x += 2) {
        let c = 0
        for (let dy = 0; dy < 2 && y + dy < m.height; dy++)
          for (let dx = 0; dx < 2 && x + dx < m.width; dx++)
            c += m.data[(y + dy) * m.width + (x + dx)]!
        row += c >= 2 ? '#' : c === 1 ? '+' : '.'
      }
      lines.push(row)
    }
    console.log(`[mpmask] label="${f0.label}"\n${lines.join('\n')}`)
  }, 120000)
})
