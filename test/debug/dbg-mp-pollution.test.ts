/**
 * DEBUG (mp 영역 담당): MP OCR 완파 원인 + 공유 템플릿셋 mp-오염 조사.
 *
 * (A) 공유 템플릿셋의 char별 템플릿 출처(region별 샘플 카운트) — mp 유래 비율
 * (B) mp 픽스처 세그멘테이션 ASCII 시각화 — 게이지 배경 위 텍스트가 어떻게 깨지는지
 * (C) 가드를 통과한 mp train 샘플의 "정렬 감사" — mp-free 셋 기준으로 글리프가
 *     라벨 문자와 일치하는지 (불일치 = 잘못된 글리프가 템플릿에 들어감)
 * (D) 대조 실험: mp 포함 vs mp 제외 공유 셋으로 exp/level/adena TEST 정확도 비교
 * (E) mp TEST 실패 샘플의 글리프별 top-3 후보 점수 덤프
 *
 * src/ 는 절대 수정하지 않음 — export 된 API만 호출.
 */
import { describe, it, expect } from 'vitest'
import type { RegionKind, BinaryMask } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { recognizeImage, prepareRegionMask } from '@core/ocr/text-recognizer'
import { segmentGlyphs, type Glyph } from '@core/ocr/segmentation'
import { normalizeGlyph, type TemplateSet, type CharTemplate } from '@core/ocr/template-matcher'
import { borderMeanLuma, scaleToHeight } from '@core/ocr/imaging'
import { parseRegionString, parsedEquals } from '@core/ocr/parser'
import { loadFixtures, type Fixture } from '../helpers/fixtures'
import { buildTemplatesFromFixtures, type BuildStats } from '../helpers/build-templates'

const REGIONS: RegionKind[] = ['mp', 'exp', 'level', 'adena']

function split<T>(arr: T[]): { train: T[]; test: T[] } {
  const train: T[] = []
  const test: T[] = []
  arr.forEach((x, i) => (i % 2 === 0 ? train : test).push(x))
  return { train, test }
}

// ---- shared data (accuracy.test.ts와 동일 분할) ----
const data = REGIONS.map((region) => {
  const all = loadFixtures(region)
  return { region, ...split(all) }
})
const byRegion = Object.fromEntries(data.map((d) => [d.region, d])) as Record<
  RegionKind,
  { region: RegionKind; train: Fixture[]; test: Fixture[] }
>

const sharedWithMp = buildTemplatesFromFixtures(data.map((d) => ({ region: d.region, fx: d.train })))
const sharedNoMp = buildTemplatesFromFixtures(
  data.filter((d) => d.region !== 'mp').map((d) => ({ region: d.region, fx: d.train }))
)

// ---- helpers ----

/** ASCII dump of a BinaryMask, downsampled to fit maxW columns. '#'=ink '.'=bg */
function asciiMask(mask: BinaryMask, maxW = 150): string[] {
  const step = Math.max(1, Math.ceil(mask.width / maxW))
  const rows: string[] = []
  for (let y = 0; y < mask.height; y += step) {
    let line = ''
    for (let x = 0; x < mask.width; x += step) {
      let on = 0
      for (let yy = y; yy < Math.min(y + step, mask.height) && !on; yy++)
        for (let xx = x; xx < Math.min(x + step, mask.width) && !on; xx++)
          if (mask.data[yy * mask.width + xx]) on = 1
      line += on ? '#' : '.'
    }
    rows.push(line)
  }
  if (step > 1) rows.unshift(`(downsampled x${step}: ${mask.width}x${mask.height})`)
  return rows
}

/** matchGlyph와 동일한 점수식으로 전 후보 점수 계산 (top-N 덤프용). */
function scoreAll(
  tight: BinaryMask,
  set: TemplateSet,
  allowed: Iterable<string>
): { char: string; score: number }[] {
  const allowedSet = new Set(allowed)
  const norm = normalizeGlyph(tight, set.canonW, set.canonH)
  const aspect = tight.height > 0 ? tight.width / tight.height : 1
  const cells = set.canonW * set.canonH
  const res: { char: string; score: number }[] = []
  for (const tpl of set.chars) {
    if (!allowedSet.has(tpl.char)) continue
    let diff = 0
    for (let i = 0; i < cells; i++) {
      const t = tpl.grid[i]! / 255
      diff += norm[i]! >= 1 ? 1 - t : t
    }
    const pixelScore = 1 - diff / cells
    const score = pixelScore - 0.15 * Math.min(1, Math.abs(aspect - tpl.meanAspect))
    res.push({ char: tpl.char, score })
  }
  res.sort((a, b) => b.score - a.score)
  return res
}

function evalRegion(
  region: RegionKind,
  fx: Fixture[],
  set: TemplateSet
): { acc: number; correct: number; total: number; failures: string[] } {
  let correct = 0
  const failures: string[] = []
  for (const f of fx) {
    const r = recognizeImage(f.image, set, region)
    const got = parseRegionString(region, r.text)
    const want = parseRegionString(region, f.label)
    if (want && parsedEquals(got, want)) correct++
    else failures.push(`${f.label} -> "${r.text}"`)
  }
  return { acc: fx.length ? correct / fx.length : 0, correct, total: fx.length, failures }
}

function tplAscii(tpl: CharTemplate, canonW: number, canonH: number): string[] {
  const rows: string[] = []
  for (let y = 0; y < canonH; y++) {
    let line = ''
    for (let x = 0; x < canonW; x++) {
      const v = tpl.grid[y * canonW + x]!
      line += v >= 160 ? '#' : v >= 64 ? '+' : '.'
    }
    rows.push(line)
  }
  return rows
}

describe('dbg-mp-pollution', () => {
  it('A. 공유 템플릿셋 char별 출처(region) 카운트 — mp 유래 비율', () => {
    // 같은 prepareRegionMask/segmentGlyphs/가드를 region별로 따로 돌리면
    // 합산이 공유 셋 기여와 정확히 일치한다 (샘플 독립적).
    const perRegionStats: Record<string, BuildStats> = {}
    for (const d of data) {
      const { stats } = buildTemplatesFromFixtures([{ region: d.region, fx: d.train }])
      perRegionStats[d.region] = stats
    }
    console.log('\n=== A. region별 train 기여 (used/skipped) ===')
    for (const r of REGIONS) {
      const s = perRegionStats[r]!
      console.log(
        `  ${r.padEnd(5)} train=${byRegion[r].train.length} used=${s.used} skipped=${s.skipped}` +
          `  perChar=${JSON.stringify(s.perChar)}`
      )
    }
    // char × region 매트릭스 + mp 점유율
    const allChars = new Set<string>()
    for (const r of REGIONS) for (const c of Object.keys(perRegionStats[r]!.perChar)) allChars.add(c)
    console.log('\n=== A. char별 출처 매트릭스 (글리프 샘플 수) ===')
    console.log('  char |    mp |   exp | level | adena |  mp%')
    for (const c of [...allChars].sort()) {
      const counts = REGIONS.map((r) => perRegionStats[r]!.perChar[c] ?? 0)
      const total = counts.reduce((a, b) => a + b, 0)
      const mpPct = total ? ((counts[0]! / total) * 100).toFixed(1) : '0.0'
      console.log(
        `   '${c}' | ${counts.map((n) => String(n).padStart(5)).join(' | ')} | ${mpPct.padStart(4)}%`
      )
    }
    // 합산 검증: 공유 셋 perChar == region별 합
    const sumPerChar: Record<string, number> = {}
    for (const r of REGIONS)
      for (const [c, n] of Object.entries(perRegionStats[r]!.perChar))
        sumPerChar[c] = (sumPerChar[c] ?? 0) + n
    expect(sumPerChar).toEqual(sharedWithMp.stats.perChar)
    console.log(
      `\n[검증] region별 합 == 공유셋 perChar OK. 공유셋: used=${sharedWithMp.stats.used} skipped=${sharedWithMp.stats.skipped}`
    )
  })

  it('B. mp 픽스처 세그멘테이션 ASCII — 이진화/분할에서 어떻게 깨지나', () => {
    const samples = byRegion.mp.train.slice(0, 4)
    for (const f of samples) {
      const scaled = scaleToHeight(f.image, 48)
      const bg = borderMeanLuma(scaled)
      const mask = prepareRegionMask(f.image, 'mp')
      const glyphs = segmentGlyphs(mask)
      const chars = f.label.split('').filter((c) => REGION_ALPHABET.mp.includes(c))
      console.log(
        `\n=== B. mp/${f.name} label="${f.label}" (chars=${chars.length}) ` +
          `src=${f.image.width}x${f.image.height} mask=${mask.width}x${mask.height} ` +
          `borderLuma=${bg.toFixed(1)} polarity=${bg > 128 ? 'dark-text' : 'bright-text'} ` +
          `glyphs=${glyphs.length} guard=${glyphs.length === chars.length ? 'PASS' : 'SKIP'}`
      )
      console.log(asciiMask(mask).join('\n'))
      console.log(
        '  boxes: ' +
          glyphs
            .map((g) => `[x${g.box.x0}-${g.box.x1} y${g.box.y0}-${g.box.y1} ${g.box.x1 - g.box.x0}x${g.box.y1 - g.box.y0}]`)
            .join(' ')
      )
    }
    expect(samples.length).toBeGreaterThan(0)
  })

  it('C. 가드 통과한 mp train 샘플 정렬 감사 (mp-free 셋으로 분류)', () => {
    // 가드(글리프수==라벨길이)를 통과해 공유 셋에 들어간 mp 샘플들에 대해,
    // 각 글리프를 mp-free 셋(exp/level/adena 학습)으로 분류해 라벨 문자와 비교.
    // 디지트 위치 불일치율이 높으면 = 엉뚱한 글리프가 그 char 템플릿을 오염.
    let pass = 0
    let glyphTotal = 0
    let glyphAgree = 0
    const lines: string[] = []
    const passedSamples: { f: Fixture; glyphs: Glyph[]; chars: string[] }[] = []
    for (const f of byRegion.mp.train) {
      const chars = f.label.split('').filter((c) => REGION_ALPHABET.mp.includes(c))
      const mask = prepareRegionMask(f.image, 'mp')
      const glyphs = segmentGlyphs(mask)
      if (glyphs.length !== chars.length || chars.length === 0) continue
      pass++
      passedSamples.push({ f, glyphs, chars })
      let pred = ''
      let agree = 0
      let digitN = 0
      for (let i = 0; i < glyphs.length; i++) {
        const want = chars[i]!
        if (want === '/') {
          pred += '/'
          continue // mp-free 셋엔 '/' 템플릿이 없어 감사 불가 — 디지트만 감사
        }
        digitN++
        const top = scoreAll(glyphs[i]!.mask, sharedNoMp.set, '0123456789')[0]
        pred += top ? top.char : '?'
        if (top && top.char === want) agree++
      }
      glyphTotal += digitN
      glyphAgree += agree
      lines.push(
        `  ${f.label.padEnd(8)} -> mp-free예측 "${pred}"  digit일치 ${agree}/${digitN}  (${f.name})`
      )
    }
    console.log(
      `\n=== C. mp train ${byRegion.mp.train.length}장 중 가드 PASS=${pass}장 (이들이 공유셋에 들어감)`
    )
    console.log(
      `  PASS 샘플 디지트 글리프 ${glyphTotal}개 중 mp-free 셋 분류와 라벨 일치 ${glyphAgree}개 ` +
        `(일치율 ${glyphTotal ? ((glyphAgree / glyphTotal) * 100).toFixed(1) : 0}%)`
    )
    console.log(lines.slice(0, 30).join('\n'))

    // PASS 샘플 1~2장은 글리프 ASCII로 직접 확인
    for (const s of passedSamples.slice(0, 2)) {
      console.log(`\n--- C. PASS 샘플 글리프 덤프: ${s.f.name} label="${s.f.label}"`)
      for (let i = 0; i < s.glyphs.length; i++) {
        const g = s.glyphs[i]!
        console.log(
          `  glyph[${i}] -> 라벨 '${s.chars[i]}' (${g.mask.width}x${g.mask.height} @x${g.box.x0})`
        )
        console.log(asciiMask(g.mask, 40).map((l) => '    ' + l).join('\n'))
      }
    }
    expect(pass).toBeGreaterThanOrEqual(0)
  })

  it('D. 대조 실험: mp 포함 vs 제외 공유셋 + region 단독셋 정확도', () => {
    console.log('\n=== D. TEST 정확도 비교 (동일 holdout) ===')
    console.log(
      `  templates: with-mp chars=${sharedWithMp.set.chars.map((c) => c.char).join('')} | ` +
        `no-mp chars=${sharedNoMp.set.chars.map((c) => c.char).join('')}`
    )
    const rows: string[] = []
    for (const region of ['exp', 'level', 'adena'] as RegionKind[]) {
      const test = byRegion[region].test
      const withMp = evalRegion(region, test, sharedWithMp.set)
      const noMp = evalRegion(region, test, sharedNoMp.set)
      const own = buildTemplatesFromFixtures([{ region, fx: byRegion[region].train }])
      const ownEval = evalRegion(region, test, own.set)
      rows.push(
        `  ${region.padEnd(5)} with-mp ${(withMp.acc * 100).toFixed(1)}% (${withMp.correct}/${withMp.total})` +
          ` | no-mp ${(noMp.acc * 100).toFixed(1)}% (${noMp.correct}/${noMp.total})` +
          ` | ${region}-only ${(ownEval.acc * 100).toFixed(1)}% (${ownEval.correct}/${ownEval.total})`
      )
      if (noMp.failures.length)
        rows.push(`        no-mp 잔존 실패 예시: ${noMp.failures.slice(0, 5).join(' ; ')}`)
    }
    // mp 자신도 셋별로 측정 (no-mp 셋엔 '/'가 없어 불리함 — 참고용)
    const mpWith = evalRegion('mp', byRegion.mp.test, sharedWithMp.set)
    rows.push(`  mp    with-mp ${(mpWith.acc * 100).toFixed(1)}% (${mpWith.correct}/${mpWith.total})`)
    console.log(rows.join('\n'))
    expect(true).toBe(true)
  })

  it('E. mp TEST 실패 글리프별 top-3 후보 점수 + 템플릿 ASCII', () => {
    for (const f of byRegion.mp.test.slice(0, 2)) {
      const mask = prepareRegionMask(f.image, 'mp')
      const glyphs = segmentGlyphs(mask)
      const r = recognizeImage(f.image, sharedWithMp.set, 'mp')
      console.log(
        `\n=== E. mp/${f.name} label="${f.label}" -> "${r.text}" minConf=${r.minConfidence.toFixed(2)} glyphs=${glyphs.length}`
      )
      for (let i = 0; i < Math.min(glyphs.length, 12); i++) {
        const g = glyphs[i]!
        const top = scoreAll(g.mask, sharedWithMp.set, REGION_ALPHABET.mp).slice(0, 3)
        console.log(
          `  glyph[${i}] ${g.mask.width}x${g.mask.height}@x${g.box.x0}: ` +
            top.map((t) => `'${t.char}'=${t.score.toFixed(3)}`).join('  ')
        )
      }
    }
    // mp가 기여하는 핵심 char 템플릿 시각화 (with-mp vs no-mp)
    for (const ch of ['/', '0', '2']) {
      const a = sharedWithMp.set.chars.find((c) => c.char === ch)
      const b = sharedNoMp.set.chars.find((c) => c.char === ch)
      console.log(`\n--- E. 템플릿 '${ch}' with-mp(samples=${a?.samples ?? 0}) vs no-mp(samples=${b?.samples ?? 0})`)
      const la = a ? tplAscii(a, sharedWithMp.set.canonW, sharedWithMp.set.canonH) : []
      const lb = b ? tplAscii(b, sharedNoMp.set.canonW, sharedNoMp.set.canonH) : []
      const h = Math.max(la.length, lb.length)
      for (let y = 0; y < h; y++)
        console.log(`  ${(la[y] ?? ' '.repeat(16)).padEnd(18)}|  ${lb[y] ?? ''}`)
    }
    expect(true).toBe(true)
  })
})
