/**
 * DEBUG instrumentation: can the v2-era labelled training corpus
 * (%APPDATA%/LineageMPTimer/training-data, READ-ONLY) bootstrap v3 user
 * templates offline, and how much accuracy does that buy on the repo's
 * held-out TEST split?
 *
 * Method:
 *   1. Replicate accuracy.test.ts exactly: repo fixtures, even-index TRAIN /
 *      odd-index TEST split, shared template set from TRAIN -> baseline accuracy.
 *   2. Import AppData exp/level/adena samples (label = .gt.txt content),
 *      EXCLUDING any file whose basename appears in the repo TEST split
 *      (the repo fixtures are a 100%-name-overlap subset of the AppData corpus,
 *      so without this exclusion the experiment would leak test images into
 *      training). Cap 300 per region.
 *   3. Build template sets with the same seg-count==label-length guard as
 *      test/helpers/build-templates.ts (strict), plus an "exp relaxed" variant
 *      mirroring learnFromCapture's leftmost-slice for over-segmented EXP.
 *   4. Evaluate on the repo TEST split:
 *        E0 repo-train baseline (sanity: must reproduce known numbers)
 *        E1 bundled base-templates.json alone (live default for this user)
 *        E2 v2-import set alone (strict guard)
 *        E3 v2-import merged over bundled base  (== recognizeRegion's
 *           effectiveSet when user templates are preloaded -> the proposed
 *           "오프라인 일괄 학습 → 유저 템플릿 선적재" production condition)
 *        E4 same as E3 but with the exp-relaxed import
 *
 * Diagnostic only — no assertions on accuracy. Does not touch src/.
 * AppData is opened READ-ONLY (readdirSync/readFileSync only).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RegionKind } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { recognizeImage, prepareRegionMask } from '@core/ocr/text-recognizer'
import { segmentGlyphs } from '@core/ocr/segmentation'
import { parseRegionString, parsedEquals } from '@core/ocr/parser'
import {
  TemplateBuilder,
  mergeTemplateSets,
  deserializeTemplates,
  type TemplateSet,
  type SerializedTemplateSet
} from '@core/ocr/template-matcher'
import baseTemplatesData from '@core/ocr/base-templates.json'
import { loadFixtures, loadPngAsRgba, type Fixture } from '../helpers/fixtures'
import { buildTemplatesFromFixtures } from '../helpers/build-templates'

const APPDATA_ROOT = 'C:\\Users\\playl\\AppData\\Roaming\\LineageMPTimer\\training-data'
const IMPORT_REGIONS: RegionKind[] = ['exp', 'level', 'adena']
const ALL_REGIONS: RegionKind[] = ['mp', 'exp', 'level', 'adena']
const PER_REGION_CAP = 300

function split<T>(arr: T[]): { train: T[]; test: T[] } {
  const train: T[] = []
  const test: T[] = []
  arr.forEach((x, i) => (i % 2 === 0 ? train : test).push(x))
  return { train, test }
}

interface V2Sample {
  name: string
  region: RegionKind
  label: string
  image: ReturnType<typeof loadPngAsRgba>
}

/** Load AppData samples for one region, skipping names in `exclude`. READ-ONLY. */
function loadV2Samples(region: RegionKind, exclude: Set<string>, cap: number): {
  samples: V2Sample[]
  totalOnDisk: number
  excluded: number
} {
  const dir = join(APPDATA_ROOT, region)
  if (!existsSync(dir)) return { samples: [], totalOnDisk: 0, excluded: 0 }
  const gts = readdirSync(dir)
    .filter((f) => f.endsWith('.gt.txt'))
    .sort()
  const samples: V2Sample[] = []
  let excluded = 0
  for (const gt of gts) {
    const base = gt.slice(0, -'.gt.txt'.length)
    if (exclude.has(base)) {
      excluded++
      continue
    }
    if (samples.length >= cap) continue
    const pngPath = join(dir, base + '.png')
    if (!existsSync(pngPath)) continue
    const label = readFileSync(join(dir, gt), 'utf8').trim()
    if (!label) continue
    samples.push({ name: base, region, label, image: loadPngAsRgba(pngPath) })
  }
  return { samples, totalOnDisk: gts.length, excluded }
}

interface V2BuildStats {
  used: number
  skippedSeg: number
  skippedEmpty: number
  perChar: Record<string, number>
  segMismatchExamples: string[]
}

/**
 * Same guard as test/helpers/build-templates.ts (seg count == label length).
 * `expRelax=true` additionally mirrors learnFromCapture's EXP leftmost-slice
 * (src/core/ocr/learn.ts:61-63) for over-segmented EXP crops.
 */
function buildV2Templates(
  groups: { region: RegionKind; samples: V2Sample[] }[],
  expRelax: boolean
): { set: TemplateSet; stats: Record<string, V2BuildStats> } {
  const builder = new TemplateBuilder()
  const stats: Record<string, V2BuildStats> = {}
  for (const { region, samples } of groups) {
    const s: V2BuildStats = {
      used: 0,
      skippedSeg: 0,
      skippedEmpty: 0,
      perChar: {},
      segMismatchExamples: []
    }
    stats[region] = s
    const allowed = new Set(REGION_ALPHABET[region])
    for (const f of samples) {
      const chars = f.label.split('').filter((c) => allowed.has(c))
      if (chars.length === 0) {
        s.skippedEmpty++
        continue
      }
      const mask = prepareRegionMask(f.image, region)
      let glyphs = segmentGlyphs(mask)
      if (expRelax && region === 'exp' && glyphs.length > chars.length) {
        glyphs = glyphs.slice(0, chars.length)
      }
      if (glyphs.length !== chars.length) {
        s.skippedSeg++
        if (s.segMismatchExamples.length < 5) {
          s.segMismatchExamples.push(`${f.name} label="${f.label}" seg=${glyphs.length} want=${chars.length}`)
        }
        continue
      }
      for (let i = 0; i < glyphs.length; i++) {
        builder.add(chars[i]!, glyphs[i]!.mask)
        s.perChar[chars[i]!] = (s.perChar[chars[i]!] ?? 0) + 1
      }
      s.used++
    }
  }
  return { set: builder.finalize(), stats }
}

function evalSet(
  set: TemplateSet,
  testByRegion: { region: RegionKind; test: Fixture[] }[]
): Record<string, { acc: number; correct: number; total: number; failures: string[] }> {
  const out: Record<string, { acc: number; correct: number; total: number; failures: string[] }> = {}
  for (const { region, test } of testByRegion) {
    let correct = 0
    let total = 0
    const failures: string[] = []
    for (const f of test) {
      const result = recognizeImage(f.image, set, region)
      const got = parseRegionString(region, result.text)
      const want = parseRegionString(region, f.label)
      total++
      if (want && parsedEquals(got, want)) correct++
      else if (failures.length < 5) failures.push(`${f.label} -> "${result.text}"`)
    }
    out[region] = { acc: total ? correct / total : 0, correct, total, failures }
  }
  return out
}

function fmt(r: Record<string, { acc: number; correct: number; total: number }>): string {
  return Object.entries(r)
    .map(([k, v]) => `${k}=${(v.acc * 100).toFixed(1)}% (${v.correct}/${v.total})`)
    .join('  ')
}

describe('dbg-live-v2import: v2 AppData corpus -> offline user-template bootstrap', () => {
  // ── repo fixtures, exact accuracy.test.ts split ────────────────────────────
  const repo = ALL_REGIONS.map((region) => {
    const all = loadFixtures(region)
    return { region, ...split(all) }
  })
  const testByRegion = repo
    .filter((d) => IMPORT_REGIONS.includes(d.region))
    .map((d) => ({ region: d.region, test: d.test }))

  // Leakage guard: repo fixtures are a name-subset of the AppData corpus.
  const testNames = new Map<RegionKind, Set<string>>()
  for (const d of repo) testNames.set(d.region, new Set(d.test.map((f) => f.name)))

  it('runs the v2-import experiment and reports accuracy deltas', { timeout: 300_000 }, () => {
    const lines: string[] = []

    // E0: baseline — repo TRAIN shared set (replicates accuracy.test.ts).
    const { set: baselineSet, stats: baseStats } = buildTemplatesFromFixtures(
      repo.map((d) => ({ region: d.region, fx: d.train }))
    )
    const e0 = evalSet(baselineSet, testByRegion)
    lines.push(`[E0 repo-train baseline] trained=${baseStats.used} skipped=${baseStats.skipped}`)
    lines.push(`[E0 repo-train baseline] ${fmt(e0)}`)

    // E1: bundled base templates alone (what this user's live app uses today).
    const bundled = deserializeTemplates(baseTemplatesData as unknown as SerializedTemplateSet)
    const e1 = evalSet(bundled, testByRegion)
    lines.push(`[E1 bundled base alone ] ${fmt(e1)}`)

    // ── load v2 corpus (read-only), excluding repo TEST names ────────────────
    const v2Groups: { region: RegionKind; samples: V2Sample[] }[] = []
    for (const region of IMPORT_REGIONS) {
      const { samples, totalOnDisk, excluded } = loadV2Samples(
        region,
        testNames.get(region)!,
        PER_REGION_CAP
      )
      lines.push(
        `[v2 corpus] ${region}: onDisk=${totalOnDisk} excludedTestNames=${excluded} loaded=${samples.length} (cap ${PER_REGION_CAP})`
      )
      v2Groups.push({ region, samples })
    }

    // E2: v2-import strict guard, alone.
    const strict = buildV2Templates(v2Groups, false)
    for (const region of IMPORT_REGIONS) {
      const s = strict.stats[region]!
      const denom = s.used + s.skippedSeg + s.skippedEmpty
      lines.push(
        `[v2 build strict] ${region}: used=${s.used} skippedSeg=${s.skippedSeg} skippedEmpty=${s.skippedEmpty} ` +
          `(seg-guard filter ${denom ? ((s.skippedSeg / denom) * 100).toFixed(1) : '0'}%)`
      )
      if (s.segMismatchExamples.length) {
        lines.push(`[v2 build strict] ${region} seg-mismatch ex: ${s.segMismatchExamples.join(' | ')}`)
      }
    }
    lines.push(
      `[v2 build strict] perChar: ${JSON.stringify(
        Object.fromEntries(
          Object.entries(
            strict.stats
          ).map(([r, s]) => [r, s.perChar])
        )
      )}`
    )
    const e2 = evalSet(strict.set, testByRegion)
    lines.push(`[E2 v2-import alone   ] ${fmt(e2)}`)

    // E3: v2-import merged over bundled base — the proposed preload condition
    // (mirrors recognizeRegion effectiveSet: user wins per char).
    const e3 = evalSet(mergeTemplateSets(strict.set, bundled), testByRegion)
    lines.push(`[E3 v2 over bundled   ] ${fmt(e3)}`)

    // E4: exp-relaxed import (learnFromCapture's leftmost slice), over bundled.
    const relaxed = buildV2Templates(v2Groups, true)
    const sExp = relaxed.stats['exp']!
    lines.push(
      `[v2 build exp-relaxed] exp: used=${sExp.used} skippedSeg=${sExp.skippedSeg} (vs strict used=${strict.stats['exp']!.used})`
    )
    const e4 = evalSet(mergeTemplateSets(relaxed.set, bundled), testByRegion)
    lines.push(`[E4 v2(expRelax)+base ] ${fmt(e4)}`)

    // E5: v2-import merged over repo-train baseline (upper-bound combination).
    const e5 = evalSet(mergeTemplateSets(strict.set, baselineSet), testByRegion)
    lines.push(`[E5 v2 over repo-train] ${fmt(e5)}`)

    // Failure examples (why a region does/doesn't move).
    for (const region of IMPORT_REGIONS) {
      const f2 = e2[region]!
      if (f2.failures.length) lines.push(`[E2 fail ex] ${region}: ${f2.failures.join(' | ')}`)
    }

    // Deltas vs the known baseline.
    for (const region of IMPORT_REGIONS) {
      const d = (x: Record<string, { acc: number }>): string =>
        ((x[region]!.acc - e0[region]!.acc) * 100).toFixed(1)
      lines.push(
        `[delta vs E0] ${region}: E1=${d(e1)}pp E2=${d(e2)}pp E3=${d(e3)}pp E4=${d(e4)}pp E5=${d(e5)}pp`
      )
    }

    // eslint-disable-next-line no-console
    console.log('\n' + lines.join('\n') + '\n')
    expect(true).toBe(true)
  })
})
