/**
 * Offline batch learner — bootstraps v3 user templates from the v2-era labelled
 * training corpus (`%APPDATA%/LineageMPTimer/training-data`, opened READ-ONLY).
 *
 * Background (.omc/research/ocr-diagnosis-live.json, finding #3): v3 has NO code
 * path that reads the 2,600+ file v2 label corpus — live `learnRegion` teaches one
 * capture at a time, so the statistically stronger averaged templates that
 * TemplateBuilder can produce from hundreds of samples were never built. Measured
 * on the repo held-out TEST split, an exp bootstrap from this corpus is worth
 * +7.3pp (54.5% → 61.8% at diagnosis time).
 *
 * Regions: `exp` ONLY (the measured win — its corpus covers all of 0-9 + '.').
 *   - `level` is EXCLUDED: its corpus is the exact repo-fixture set (zero new
 *     data, diagnosis E2: 0pp) AND its digits render at a different raster
 *     (17x20 vs exp 20x26) that is cross-incompatible with the exp/adena font —
 *     measured in test/ocr/accuracy.test.ts: level digits inside the shared set
 *     dilute '8' and flip exp 8->6 (100% -> 70.9%). Since the live recognizer
 *     applies ONE shared user set to every region, level samples here would
 *     poison exp recognition.
 *   - `adena` is EXCLUDED: its failure mode is segmentation/ROI (glyph-count
 *     mismatch, 44% label noise), so any template set measures 0pp there and the
 *     noise would only dilute the shared digit averages.
 *
 * Every sample passes the SAME strict guards as production learning
 * (`learnFromCapture`) and the bench template builder:
 *   (1) segmentation count == label length (alignment guard), and
 *   (2) `digitGlyphsPlausible` geometry guard (gauge-band / UI-chrome rejection).
 *
 * Output: `out/user-templates.json` (a `SerializedTemplateSet`). Apply it in the
 * app: 환경설정 탭 → 「OCR 유저 템플릿」 드로어 → 파일 내용을 붙여넣고 「가져오기」
 * (stores it under localStorage 'lmp.userTemplates.v3' and reloads detection).
 *
 * Run (repo convention — no tsx dependency):
 *   npm run templates:user           (= npx vitest run test/tools/build-user-templates.test.ts)
 * or, when tsx is available:
 *   npx tsx scripts/build-user-templates.ts [corpusDir] [outFile]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PNG } from 'pngjs'
import { REGION_ALPHABET, type RegionKind, type RgbaImage } from '../src/core/ocr/types'
import {
  TemplateBuilder,
  serializeTemplates,
  type SerializedTemplateSet,
  type TemplateSet
} from '../src/core/ocr/template-matcher'
import { prepareRegionMask } from '../src/core/ocr/text-recognizer'
import { segmentGlyphs } from '../src/core/ocr/segmentation'
import { digitGlyphsPlausible } from '../src/core/ocr/learn'

/** Default corpus location (the live app's training-data dir). READ-ONLY. */
export const DEFAULT_CORPUS_ROOT = join(
  process.env.APPDATA ?? '',
  'LineageMPTimer',
  'training-data'
)

/** exp ONLY — level/adena are intentionally excluded (see file header for the measurements). */
export const DEFAULT_REGIONS: readonly RegionKind[] = ['exp']

export interface RegionBuildStats {
  /** `.gt.txt` files found on disk. */
  onDisk: number
  /** Skipped because the basename was in `excludeNames` (held-out bench guard). */
  excluded: number
  /** Loaded (PNG + non-empty label present). */
  loaded: number
  /** Samples that contributed glyphs to the template average. */
  used: number
  /** Rejected: segmentation count != label length. */
  skippedSeg: number
  /** Rejected: a digit glyph failed the geometry plausibility guard. */
  skippedGeometry: number
  /** Rejected: label had no characters in the region alphabet. */
  skippedEmptyLabel: number
  /** Per-character contributing sample counts. */
  perChar: Record<string, number>
}

export interface BuildUserTemplatesResult {
  set: TemplateSet
  serialized: SerializedTemplateSet
  stats: Record<string, RegionBuildStats>
  totalUsed: number
}

export interface BuildUserTemplatesOptions {
  /** Corpus root (default: the live AppData training-data dir). */
  corpusRoot?: string
  /** Regions to import (default exp+level — see header for why adena is out). */
  regions?: readonly RegionKind[]
  /** Per-region basenames to exclude (leakage guard for held-out benchmarks). */
  excludeNames?: Partial<Record<RegionKind, ReadonlySet<string>>>
  /** Per-region sample cap (default: unlimited — full corpus is ~5s to build). */
  capPerRegion?: number
}

function loadPngAsRgba(path: string): RgbaImage {
  const png = PNG.sync.read(readFileSync(path))
  return {
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length)
  }
}

/**
 * Build one averaged template set from the labelled corpus with the production
 * strict guards. Pure read — never writes into the corpus.
 */
export function buildUserTemplates(
  opts: BuildUserTemplatesOptions = {}
): BuildUserTemplatesResult {
  const corpusRoot = opts.corpusRoot ?? DEFAULT_CORPUS_ROOT
  const regions = opts.regions ?? DEFAULT_REGIONS
  const cap = opts.capPerRegion ?? Number.POSITIVE_INFINITY

  const builder = new TemplateBuilder()
  const stats: Record<string, RegionBuildStats> = {}
  let totalUsed = 0

  for (const region of regions) {
    const s: RegionBuildStats = {
      onDisk: 0,
      excluded: 0,
      loaded: 0,
      used: 0,
      skippedSeg: 0,
      skippedGeometry: 0,
      skippedEmptyLabel: 0,
      perChar: {}
    }
    stats[region] = s

    const dir = join(corpusRoot, region)
    if (!existsSync(dir)) continue
    const exclude = opts.excludeNames?.[region]
    const allowed = new Set(REGION_ALPHABET[region])
    const gts = readdirSync(dir)
      .filter((f) => f.endsWith('.gt.txt'))
      .sort()
    s.onDisk = gts.length

    for (const gt of gts) {
      if (s.loaded >= cap) break
      const base = gt.slice(0, -'.gt.txt'.length)
      if (exclude?.has(base)) {
        s.excluded++
        continue
      }
      const pngPath = join(dir, base + '.png')
      if (!existsSync(pngPath)) continue
      const label = readFileSync(join(dir, gt), 'utf8').trim()
      if (!label) continue
      s.loaded++

      const chars = label.split('').filter((c) => allowed.has(c))
      if (chars.length === 0) {
        s.skippedEmptyLabel++
        continue
      }
      const image = loadPngAsRgba(pngPath)
      const mask = prepareRegionMask(image, region)
      const glyphs = segmentGlyphs(mask)
      if (glyphs.length !== chars.length) {
        s.skippedSeg++
        continue
      }
      if (!digitGlyphsPlausible(glyphs, chars, mask.height)) {
        s.skippedGeometry++
        continue
      }
      for (let i = 0; i < glyphs.length; i++) {
        builder.add(chars[i]!, glyphs[i]!.mask)
        s.perChar[chars[i]!] = (s.perChar[chars[i]!] ?? 0) + 1
      }
      s.used++
      totalUsed++
    }
  }

  const set = builder.finalize()
  return { set, serialized: serializeTemplates(set), stats, totalUsed }
}

/** Render the per-region stats block used by both the CLI and the vitest wrapper. */
export function formatBuildReport(result: BuildUserTemplatesResult): string {
  const lines: string[] = []
  for (const [region, s] of Object.entries(result.stats)) {
    lines.push(
      `[${region}] onDisk=${s.onDisk} excluded=${s.excluded} loaded=${s.loaded} → used=${s.used} ` +
        `(skip: seg=${s.skippedSeg} geometry=${s.skippedGeometry} emptyLabel=${s.skippedEmptyLabel})`
    )
    lines.push(`[${region}] perChar ${JSON.stringify(s.perChar)}`)
  }
  lines.push(
    `[set] ${result.set.chars.length} chars from ${result.totalUsed} samples: ` +
      result.set.chars.map((c) => `'${c.char}'×${c.samples}`).join(' ')
  )
  return lines.join('\n')
}

/** Write the serialized set + print the report and how to apply it in the app. */
export function writeUserTemplates(outFile: string, result: BuildUserTemplatesResult): void {
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, JSON.stringify(result.serialized))
  // eslint-disable-next-line no-console
  console.log(
    [
      formatBuildReport(result),
      `[out] ${outFile}`,
      '[apply] 앱 → 환경설정 탭 → 「OCR 유저 템플릿」 드로어 → 파일 내용 붙여넣기 → 「가져오기」',
      "[apply] (localStorage 'lmp.userTemplates.v3'에 저장되고 즉시 인식에 반영됩니다)"
    ].join('\n')
  )
}

// ── direct CLI entry (npx tsx scripts/build-user-templates.ts) ────────────────
const isDirectRun = ((): boolean => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  } catch {
    return false
  }
})()

if (isDirectRun) {
  const corpusRoot = process.argv[2] ?? DEFAULT_CORPUS_ROOT
  const outFile = process.argv[3] ?? resolve(dirname(resolve(process.argv[1]!)), '..', 'out', 'user-templates.json')
  if (!existsSync(corpusRoot)) {
    // eslint-disable-next-line no-console
    console.error(`[err] corpus not found: ${corpusRoot}`)
    process.exit(1)
  }
  writeUserTemplates(outFile, buildUserTemplates({ corpusRoot }))
}
