/**
 * dbg-synthesis-brightratio-mechanism — adjudicate a cross-agent conflict.
 *
 * pipeline-sweep agent: "brightRatio 0.45 alone lifts exp 54.5%→81.8% (default 0.5
 * is an aliasing-sensitive local minimum)".
 * mp-pollution / exp-confusion agents: "exp loss is mp-sliver contamination of the
 * '1' template meanAspect (6.257)".
 *
 * Hypothesis to test: exp/level/adena fixtures are all dark-text (borderLuma>128),
 * so brightRatio (bright-text-only threshold) cannot affect them at recognition
 * time. Its only causal path to exp accuracy is via the TRAIN build: the 8 garbage
 * mp train samples sit at borderLuma 123-124 (bright path), and a brightRatio
 * change perturbs their segmentation out of the count==label guard, removing the
 * '1' meanAspect contamination. If true: at br=0.45 the mp 'used' count should
 * drop (or its glyphs change) and '1'.meanAspect should normalize to ~0.65-0.7.
 */
import { describe, it } from 'vitest'
import type { RegionKind, RgbaImage, BinaryMask } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import {
  scaleToHeight,
  binarizeAuto,
  removeSolidBands,
  borderMeanLuma,
  type AutoBinarizeOptions
} from '@core/ocr/imaging'
import { segmentGlyphs } from '@core/ocr/segmentation'
import { TemplateBuilder, type TemplateSet } from '@core/ocr/template-matcher'
import { loadFixtures } from '../helpers/fixtures'

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

function prepMask(img: RgbaImage, region: RegionKind, binarize?: AutoBinarizeOptions): BinaryMask {
  const scaled = scaleToHeight(img, 48)
  const base: AutoBinarizeOptions = region === 'mp' ? { blueMargin: 40 } : {}
  const mask = binarizeAuto(scaled, { ...base, ...binarize })
  return removeSolidBands(mask, 0.8)
}

function build(binarize?: AutoBinarizeOptions): {
  set: TemplateSet
  usedPerRegion: Record<string, number>
} {
  const builder = new TemplateBuilder()
  const usedPerRegion: Record<string, number> = {}
  for (const { region, train } of data) {
    const allowed = new Set(REGION_ALPHABET[region])
    let used = 0
    for (const f of train) {
      const chars = f.label.split('').filter((c) => allowed.has(c))
      const glyphs = segmentGlyphs(prepMask(f.image, region, binarize))
      if (glyphs.length !== chars.length || chars.length === 0) continue
      for (let i = 0; i < glyphs.length; i++) builder.add(chars[i]!, glyphs[i]!.mask)
      used++
    }
    usedPerRegion[region] = used
  }
  return { set: builder.finalize(), usedPerRegion }
}

describe('dbg-synthesis-brightratio-mechanism', () => {
  it('1. polarity census: which regions even use the bright-text path?', () => {
    for (const { region, train } of data) {
      let bright = 0
      let dark = 0
      for (const f of train) {
        const bl = borderMeanLuma(scaleToHeight(f.image, 48))
        if (bl > 128) dark++
        else bright++
      }
      console.log(`[polarity:${region}] train n=${train.length} darkText(bg>128)=${dark} brightText(bg<=128)=${bright}`)
    }
  }, 120000)

  it("2. '1'.meanAspect + mp used count at brightRatio 0.5 vs 0.45", () => {
    for (const br of [0.5, 0.45]) {
      const { set, usedPerRegion } = build({ brightRatio: br })
      const one = set.chars.find((c) => c.char === '1')
      const seven = set.chars.find((c) => c.char === '7')
      console.log(
        `[br=${br}] used=${JSON.stringify(usedPerRegion)} ` +
          `'1': samples=${one?.samples} meanAspect=${one?.meanAspect.toFixed(3)} | ` +
          `'7': samples=${seven?.samples} meanAspect=${seven?.meanAspect.toFixed(3)}`
      )
    }
  }, 300000)
})
