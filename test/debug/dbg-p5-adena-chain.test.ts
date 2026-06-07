/**
 * DEBUG (P5 adena 전처리 체인 파라미터 스윕) — src/ 를 건드리지 않는 계측 전용.
 *
 * recognizeMask 의 adena 경로(2-pass preCrop 마스크 -> junkFilter 세그 ->
 * matchGlyph -> 끝단 gap 트림)를 파라미터화해 재현하고:
 *  A) gap 트림 (gapRatio x confGuard) 그리드 스윕
 *  B) junk 필터 변형 (edgeWidthRatio / minInkRatio) 스윕
 *  C) 템플릿셋 변형: 공유셋(exp+adena) vs adena-우선 머지셋(level 전례)
 *  D) 최종 구성 실패 전수 덤프 (라벨 vs 인식)
 */
import { describe, it } from 'vitest'
import type { RegionKind } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { prepareRegionMask } from '@core/ocr/text-recognizer'
import { parseRegionString, parsedEquals } from '@core/ocr/parser'
import { segmentGlyphs, type JunkFilterOptions } from '@core/ocr/segmentation'
import { matchGlyph, mergeTemplateSets, TemplateBuilder, type TemplateSet } from '@core/ocr/template-matcher'
import { digitGlyphsPlausible } from '@core/ocr/learn'
import { loadFixtures, type Fixture } from '../helpers/fixtures'
import { buildTemplatesFromFixtures } from '../helpers/build-templates'

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

// accuracy.test.ts 와 동일한 공유셋 (exp+adena train, mp/level 제외)
const { set: sharedSet } = buildTemplatesFromFixtures(
  data
    .filter((d) => d.region !== 'mp' && d.region !== 'level')
    .map((d) => ({ region: d.region, fx: d.train }))
)
// adena-우선 머지셋: adena 전용셋을 공유셋 위에 머지 (level 전례와 동일 의미)
const adenaData = data.find((d) => d.region === 'adena')!
const { set: adenaOnlySet, stats: adenaStats } = buildTemplatesFromFixtures([
  { region: 'adena', fx: adenaData.train }
])
const adenaMergedSet = mergeTemplateSets(adenaOnlySet, sharedSet)

const med = (a: number[]) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

interface Matched {
  char: string
  confidence: number
  x0: number
  x1: number
}

/** recognizeMask(adena) 재현: preCrop 마스크 -> junkFilter 세그 -> match */
function matchedGlyphs(f: Fixture, tplSet: TemplateSet, junk: JunkFilterOptions | true): Matched[] {
  const mask = prepareRegionMask(f.image, 'adena')
  const glyphs = segmentGlyphs(mask, { junkFilter: junk })
  return glyphs.map((g) => {
    const m = matchGlyph(g.mask, tplSet, { allowed: REGION_ALPHABET.adena })
    return { char: m.char, confidence: m.confidence, x0: g.box.x0, x1: g.box.x1 }
  })
}

function gapTrim(matched: Matched[], gapRatio: number, confGuard: number): Matched[] {
  const out = [...matched]
  while (out.length >= 3) {
    const gaps = out.slice(1).map((g, i) => g.x0 - out[i]!.x1)
    const m = med(gaps)
    if (m <= 0) break
    if (gaps[gaps.length - 1]! > gapRatio * m && out[out.length - 1]!.confidence < confGuard) out.pop()
    else if (gaps[0]! > gapRatio * m && out[0]!.confidence < confGuard) out.shift()
    else break
  }
  return out
}

function evalChain(
  tplSet: TemplateSet,
  junk: JunkFilterOptions | true,
  gapRatio: number,
  confGuard: number,
  dumpFails = 0
): { ok: number; n: number; fails: string[] } {
  let ok = 0
  let n = 0
  const fails: string[] = []
  for (const f of adenaData.test as Fixture[]) {
    n++
    const matched = gapTrim(matchedGlyphs(f, tplSet, junk), gapRatio, confGuard)
    const text = matched.map((m) => m.char).join('')
    const got = parseRegionString('adena', text)
    const want = parseRegionString('adena', f.label)
    if (want && parsedEquals(got, want)) ok++
    else if (fails.length < dumpFails)
      fails.push(
        `    ${f.label} -> "${text}" conf=[${matched.map((m) => m.confidence.toFixed(2)).join(',')}] (${f.name})`
      )
  }
  return { ok, n, fails }
}

describe('dbg-p5: adena 체인 파라미터 스윕', () => {
  it('A) gap트림 gapRatio x confGuard 그리드 (공유셋 / adena머지셋)', () => {
    console.log(
      `\n[A] adena전용셋 빌드: train=${adenaData.train.length} used=${adenaStats.used} skipped=${adenaStats.skipped} perChar=${JSON.stringify(adenaStats.perChar)}`
    )
    for (const [setName, tplSet] of [
      ['공유셋', sharedSet],
      ['adena머지셋', adenaMergedSet]
    ] as [string, TemplateSet][]) {
      for (const gapRatio of [2.5, 3]) {
        const row: string[] = []
        for (const conf of [0, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 1.01]) {
          const r = evalChain(tplSet, true, gapRatio, conf)
          row.push(`conf${conf === 1.01 ? '∞' : conf === 0 ? 'off' : conf}=${((r.ok / r.n) * 100).toFixed(1)}%(${r.ok})`)
        }
        console.log(`[A] ${setName} gap${gapRatio}x: ${row.join(' ')}`)
      }
    }
  })

  it('B) junk필터 변형 스윕 (gap트림 3x/0.7 고정, 양 셋)', () => {
    console.log('') // vitest stdout 헤더와 첫 행이 한 줄로 붙는 것 방지
    const variants: [string, JunkFilterOptions][] = [
      ['기본(edge1.0/h0.5/ink0.25)', {}],
      ['edge0.7(진단 제안 복합조건)', { edgeWidthRatio: 0.7 }],
      ['edge무조건(edge99)', { edgeWidthRatio: 99 }],
      ['ink필터off', { minInkRatio: 0 }],
      ['edge99+inkOff', { edgeWidthRatio: 99, minInkRatio: 0 }]
    ]
    for (const [setName, tplSet] of [
      ['공유셋', sharedSet],
      ['adena머지셋', adenaMergedSet]
    ] as [string, TemplateSet][]) {
      for (const [name, junk] of variants) {
        const r = evalChain(tplSet, junk, 3, 0.7)
        console.log(`[B] ${setName} ${name}: ${((r.ok / r.n) * 100).toFixed(1)}% (${r.ok}/${r.n})`)
      }
    }
  })

  it('C) 학습 경로 필터 변형: adena train 활용률 + 재빌드 셋 정확도', () => {
    console.log('') // vitest stdout 헤더와 첫 행이 한 줄로 붙는 것 방지
    const expData = data.find((d) => d.region === 'exp')!
    const variants: [string, JunkFilterOptions][] = [
      ['edge0.7(진단 제안)', { edgeWidthRatio: 0.7 }],
      ['edge1.0(현행 기본)', {}],
      ['edge99(무조건)', { edgeWidthRatio: 99 }]
    ]
    for (const [name, junk] of variants) {
      // adena만 variant 필터로 학습, exp 는 표준 체인 (buildTemplatesFromFixtures 동일 가드)
      const builder = new TemplateBuilder()
      const adenaBuilder = new TemplateBuilder()
      let used = 0
      let skipped = 0
      const addGroup = (region: RegionKind, fx: Fixture[], b: TemplateBuilder[], j?: JunkFilterOptions) => {
        const allowed = new Set(REGION_ALPHABET[region])
        for (const f of fx) {
          const chars = f.label.split('').filter((c) => allowed.has(c))
          const mask = prepareRegionMask(f.image, region)
          const glyphs = segmentGlyphs(mask, j ? { junkFilter: j } : {})
          if (glyphs.length !== chars.length || !chars.length) {
            if (region === 'adena') skipped++
            continue
          }
          if (!digitGlyphsPlausible(glyphs, chars, region === 'adena' ? 0 : mask.height)) {
            if (region === 'adena') skipped++
            continue
          }
          for (let i = 0; i < glyphs.length; i++) for (const bb of b) bb.add(chars[i]!, glyphs[i]!.mask)
          if (region === 'adena') used++
        }
      }
      addGroup('exp', expData.train as Fixture[], [builder])
      addGroup('adena', adenaData.train as Fixture[], [builder, adenaBuilder], junk)
      const rebuiltShared = builder.finalize()
      const rebuiltMerged = mergeTemplateSets(adenaBuilder.finalize(), rebuiltShared)
      // 평가는 인식 변형도 동일 필터로
      const rs = evalChain(rebuiltShared, junk, 3, 0.7)
      const rm = evalChain(rebuiltMerged, junk, 3, 0.7)
      console.log(
        `[C] ${name}: adena train used=${used} skipped=${skipped} | 재빌드공유셋=${((rs.ok / rs.n) * 100).toFixed(1)}%(${rs.ok}) adena머지셋=${((rm.ok / rm.n) * 100).toFixed(1)}%(${rm.ok})`
      )
    }
  })

  it('D) 현행 프로덕션 구성(공유셋, gap3x, conf0.7) 실패 전수 덤프', () => {
    const r = evalChain(sharedSet, true, 3, 0.7, 30)
    console.log(`\n[D] 현행 구성: ${((r.ok / r.n) * 100).toFixed(1)}% (${r.ok}/${r.n})\n` + r.fails.join('\n'))
  })
})
