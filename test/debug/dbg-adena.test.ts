/**
 * DEBUG (adena 영역 전멸 원인 조사) — src/ 는 건드리지 않는 계측 전용 테스트.
 *
 * accuracy.test.ts 와 동일한 train/test 분할 + 공유 템플릿셋을 재현한 뒤:
 *  A) adena 테스트 실패 샘플 전수: 세그 박스 수 vs 라벨 자릿수, 분류 집계
 *  B) 실패 8+개 딥덤프: PNG 크기 / 전체 마스크 ASCII / 글리프별 ASCII + top-3 점수
 *  C) 영역간 폰트/배경 픽셀 통계 비교 (공유 폰트 가정 검증)
 *  D) 파일명 패턴 vs 라벨 대응 분석 (라벨 노이즈 추정)
 */
import { describe, it } from 'vitest'
import type { RegionKind, BinaryMask } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { recognizeImage, prepareRegionMask, WORK_HEIGHT } from '@core/ocr/text-recognizer'
import { parseRegionString, parsedEquals } from '@core/ocr/parser'
import { segmentGlyphs } from '@core/ocr/segmentation'
import { normalizeGlyph, matchGlyph, TemplateBuilder, type TemplateSet } from '@core/ocr/template-matcher'
import { borderMeanLuma, scaleToHeight, countInk, cropImage } from '@core/ocr/imaging'
import { loadFixtures, type Fixture } from '../helpers/fixtures'
import { buildTemplatesFromFixtures } from '../helpers/build-templates'

const REGIONS: RegionKind[] = ['mp', 'exp', 'level', 'adena']

function split<T>(arr: T[]): { train: T[]; test: T[] } {
  const train: T[] = []
  const test: T[] = []
  arr.forEach((x, i) => (i % 2 === 0 ? train : test).push(x))
  return { train, test }
}

// accuracy.test.ts 와 동일하게 구성
const data = REGIONS.map((region) => {
  const all = loadFixtures(region)
  return { region, ...split(all) }
})
const { set } = buildTemplatesFromFixtures(data.map((d) => ({ region: d.region, fx: d.train })))

function ascii(mask: BinaryMask, maxW = 110): string[] {
  const step = Math.max(1, Math.ceil(mask.width / maxW))
  const rows: string[] = []
  for (let y = 0; y < mask.height; y += step) {
    let line = ''
    for (let x = 0; x < mask.width; x += step) {
      // step 블록 내 잉크가 하나라도 있으면 #
      let ink = 0
      for (let yy = y; yy < Math.min(mask.height, y + step) && !ink; yy++)
        for (let xx = x; xx < Math.min(mask.width, x + step); xx++)
          if (mask.data[yy * mask.width + xx]!) {
            ink = 1
            break
          }
      line += ink ? '#' : '.'
    }
    rows.push(line)
  }
  return rows
}

/** matchGlyph 내부 점수식 복제 — 전체 후보 랭킹 확보용 (top-3 덤프). */
function scoreAll(tight: BinaryMask, tplSet: TemplateSet, allowed: string[]) {
  const norm = normalizeGlyph(tight, tplSet.canonW, tplSet.canonH)
  const aspect = tight.height > 0 ? tight.width / tight.height : 1
  const cells = tplSet.canonW * tplSet.canonH
  const allowedSet = new Set(allowed)
  const out: { char: string; score: number; px: number; ap: number }[] = []
  for (const tpl of tplSet.chars) {
    if (!allowedSet.has(tpl.char)) continue
    let diff = 0
    for (let i = 0; i < cells; i++) {
      const t = tpl.grid[i]! / 255
      diff += norm[i]! >= 1 ? 1 - t : t
    }
    const px = 1 - diff / cells
    const ap = 0.15 * Math.min(1, Math.abs(aspect - tpl.meanAspect))
    out.push({ char: tpl.char, score: px - ap, px, ap })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

describe('dbg-adena: 5.5% 전멸 원인 계측', () => {
  it('A) 실패 전수 집계: 세그 박스 수 vs 라벨 자릿수', () => {
    const adena = data.find((d) => d.region === 'adena')!
    let pass = 0
    let segMismatch = 0 // 글리프 수 != 라벨 길이 (분할 or 크롭에 여분 글리프)
    let segMatchWrong = 0 // 글리프 수 == 라벨 길이인데 글자 오인 (순수 매칭 실패)
    const lines: string[] = []
    for (const f of adena.test as Fixture[]) {
      const r = recognizeImage(f.image, set, 'adena')
      const got = parseRegionString('adena', r.text)
      const want = parseRegionString('adena', f.label)
      const ok = !!want && parsedEquals(got, want)
      const mask = prepareRegionMask(f.image, 'adena')
      const glyphs = segmentGlyphs(mask)
      if (ok) pass++
      else if (glyphs.length !== f.label.length) segMismatch++
      else segMatchWrong++
      lines.push(
        `${ok ? 'OK  ' : 'FAIL'} ${f.name.padEnd(34)} label=${f.label.padEnd(7)} got="${r.text}" ` +
          `png=${f.image.width}x${f.image.height} mask=${mask.width}x${mask.height} ` +
          `glyphs=${glyphs.length} labelLen=${f.label.length} minConf=${r.minConfidence.toFixed(2)}`
      )
    }
    console.log(`\n[A] adena test=${adena.test.length} pass=${pass} ` +
      `segMismatch(글리프수!=라벨길이)=${segMismatch} segMatchWrong(수일치·글자오인)=${segMatchWrong}`)
    console.log(lines.join('\n'))
  })

  it('B) 실패 딥덤프: 마스크 ASCII + 글리프별 top-3', () => {
    const adena = data.find((d) => d.region === 'adena')!
    let dumped = 0
    for (const f of adena.test as Fixture[]) {
      if (dumped >= 10) break
      const r = recognizeImage(f.image, set, 'adena')
      const got = parseRegionString('adena', r.text)
      const want = parseRegionString('adena', f.label)
      if (want && parsedEquals(got, want)) continue
      dumped++
      const mask = prepareRegionMask(f.image, 'adena')
      const glyphs = segmentGlyphs(mask)
      console.log(`\n===== [B${dumped}] ${f.name} label="${f.label}" got="${r.text}" png=${f.image.width}x${f.image.height} mask=${mask.width}x${mask.height} =====`)
      console.log(ascii(mask).join('\n'))
      glyphs.forEach((g, i) => {
        const top = scoreAll(g.mask, set, REGION_ALPHABET.adena).slice(0, 3)
        console.log(
          `  glyph[${i}] box=(${g.box.x0},${g.box.y0})-(${g.box.x1},${g.box.y1}) ` +
            `${g.mask.width}x${g.mask.height} ink=${countInk(g.mask)} top3=` +
            top.map((t) => `${t.char}:${t.score.toFixed(3)}(px${t.px.toFixed(3)}-ap${t.ap.toFixed(3)})`).join(' ')
        )
        console.log(ascii(g.mask, 40).map((l) => '    ' + l).join('\n'))
      })
    }
  })

  it('C) 영역간 폰트/배경 픽셀 통계 비교', () => {
    for (const d of data) {
      const sample = (d.test as Fixture[]).slice(0, 40)
      if (!sample.length) continue
      const glyphH: number[] = []
      const glyphW: number[] = []
      const dens: number[] = []
      let darkPol = 0
      let segEqLabel = 0
      const lumas: number[] = []
      const pngHs: number[] = []
      for (const f of sample) {
        const scaled = scaleToHeight(f.image, WORK_HEIGHT)
        lumas.push(borderMeanLuma(scaled))
        if (borderMeanLuma(scaled) > 128) darkPol++
        pngHs.push(f.image.height)
        const mask = prepareRegionMask(f.image, d.region)
        const glyphs = segmentGlyphs(mask)
        const labelChars = f.label.split('').filter((c) => REGION_ALPHABET[d.region].includes(c))
        if (glyphs.length === labelChars.length) segEqLabel++
        for (const g of glyphs) {
          glyphH.push(g.mask.height)
          glyphW.push(g.mask.width)
          dens.push(countInk(g.mask) / (g.mask.width * g.mask.height))
        }
      }
      const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0
      console.log(
        `\n[C] ${d.region}: n=${sample.length} pngH(med)=${med(pngHs)} borderLuma(med)=${med(lumas).toFixed(0)} ` +
          `darkTextPolarity=${darkPol}/${sample.length} glyphH(med)=${med(glyphH)} glyphW(med)=${med(glyphW)} ` +
          `inkDensity(med)=${med(dens).toFixed(3)} segCount==labelLen: ${segEqLabel}/${sample.length}`
      )
    }
  })

  it('E) 실패 모드 분해: 라벨포함(junk만) vs 진짜 오인 + 캡처 배치별 집계', () => {
    const adena = data.find((d) => d.region === 'adena')!
    const byBatch = new Map<string, { n: number; pass: number; junkOnly: number; misread: number }>()
    let junkOnly = 0
    let misread = 0
    const confusion = new Map<string, number>()
    for (const f of adena.test as Fixture[]) {
      const key = `${f.image.width}x${f.image.height}`
      let b = byBatch.get(key)
      if (!b) byBatch.set(key, (b = { n: 0, pass: 0, junkOnly: 0, misread: 0 }))
      b.n++
      const r = recognizeImage(f.image, set, 'adena')
      const got = parseRegionString('adena', r.text)
      const want = parseRegionString('adena', f.label)
      if (want && parsedEquals(got, want)) {
        b.pass++
        continue
      }
      if (r.text.includes(f.label)) {
        junkOnly++
        b.junkOnly++
      } else {
        misread++
        b.misread++
        // 같은 길이면 위치별 confusion 수집
        if (r.text.length === f.label.length) {
          for (let i = 0; i < f.label.length; i++)
            if (r.text[i] !== f.label[i]) {
              const k = `${f.label[i]}->${r.text[i]}`
              confusion.set(k, (confusion.get(k) ?? 0) + 1)
            }
        }
      }
    }
    console.log(`\n[E] 실패 중 junkOnly(인식문자열이 라벨을 부분문자열로 포함)=${junkOnly} misread(글자 자체 오인 포함)=${misread}`)
    for (const [k, v] of byBatch)
      console.log(`[E] batch ${k}: n=${v.n} pass=${v.pass} junkOnly=${v.junkOnly} misread=${v.misread}`)
    if (confusion.size)
      console.log('[E] 등길이 confusion: ' + [...confusion.entries()].map(([k, v]) => `${k}x${v}`).join(' '))
  })

  it('F) 실험: adena 전용 템플릿 / junk 필터 적용 시 정확도', () => {
    const adena = data.find((d) => d.region === 'adena')!
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0

    // junk 필터: 마스크 가장자리 접촉 / 키 절반 미만 / 잉크 1/4 미만 글리프 제거
    const filterGlyphs = (mask: BinaryMask, glyphs: ReturnType<typeof segmentGlyphs>) => {
      if (!glyphs.length) return glyphs
      const medH = med(glyphs.map((g) => g.mask.height))
      const medInk = med(glyphs.map((g) => countInk(g.mask)))
      return glyphs.filter((g) => {
        if (g.box.x0 <= 1 || g.box.x1 >= mask.width - 1) return false
        if (g.mask.height < 0.5 * medH) return false
        if (countInk(g.mask) < 0.25 * medInk) return false
        return true
      })
    }

    // adena 전용 템플릿 (junk 필터를 학습 시에도 적용)
    const adenaBuilder = new TemplateBuilder()
    let usedF = 0
    let skippedF = 0
    for (const f of adena.train as Fixture[]) {
      const mask = prepareRegionMask(f.image, 'adena')
      const glyphs = filterGlyphs(mask, segmentGlyphs(mask))
      const chars = f.label.split('').filter((c) => REGION_ALPHABET.adena.includes(c))
      if (glyphs.length !== chars.length || !chars.length) {
        skippedF++
        continue
      }
      for (let i = 0; i < glyphs.length; i++) adenaBuilder.add(chars[i]!, glyphs[i]!.mask)
      usedF++
    }
    const adenaSet = adenaBuilder.finalize()
    console.log(`\n[F] adena 전용+필터 템플릿: train=${adena.train.length} used=${usedF} skipped=${skippedF} chars=${adenaSet.chars.map((c) => c.char).join('')}`)

    const evalWith = (tplSet: TemplateSet, useFilter: boolean): { acc: number; n: number; ok: number } => {
      let ok = 0
      let n = 0
      for (const f of adena.test as Fixture[]) {
        n++
        const mask = prepareRegionMask(f.image, 'adena')
        let glyphs = segmentGlyphs(mask)
        if (useFilter) glyphs = filterGlyphs(mask, glyphs)
        let text = ''
        for (const g of glyphs) text += matchGlyph(g.mask, tplSet, { allowed: REGION_ALPHABET.adena }).char
        const got = parseRegionString('adena', text)
        const want = parseRegionString('adena', f.label)
        if (want && parsedEquals(got, want)) ok++
      }
      return { acc: n ? ok / n : 0, n, ok }
    }

    const cases: [string, TemplateSet, boolean][] = [
      ['공유셋 + 필터없음(현행)', set, false],
      ['공유셋 + junk필터', set, true],
      ['adena전용셋 + 필터없음', adenaSet, false],
      ['adena전용셋 + junk필터', adenaSet, true]
    ]
    for (const [name, tplSet, useFilter] of cases) {
      const r = evalWith(tplSet, useFilter)
      console.log(`[F] ${name}: ${(r.acc * 100).toFixed(1)}% (${r.ok}/${r.n})`)
    }
  })

  it('H) 실험: 텍스트밴드 프리크롭(재스케일) + junk필터 정확도', () => {
    const adena = data.find((d) => d.region === 'adena')!
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0

    // 1차 마스크에서 다수 글리프가 덮는 y밴드를 찾아 원본을 행크롭 → 재스케일 시 디지트가 48px 높이를 꽉 채움
    const preCrop = (img: Fixture['image']) => {
      const mask = prepareRegionMask(img, 'adena')
      const glyphs = segmentGlyphs(mask)
      if (!glyphs.length) return img
      const cover = new Array<number>(mask.height).fill(0)
      for (const g of glyphs) for (let y = g.box.y0; y < g.box.y1; y++) cover[y]!++
      const need = Math.max(1, Math.ceil(glyphs.length / 2))
      let bestS = 0
      let bestE = 0
      let s = -1
      for (let y = 0; y <= mask.height; y++) {
        const ok = y < mask.height && cover[y]! >= need
        if (ok && s < 0) s = y
        if (!ok && s >= 0) {
          if (y - s > bestE - bestS) {
            bestS = s
            bestE = y
          }
          s = -1
        }
      }
      if (bestE <= bestS) return img
      const fy = img.height / mask.height
      const y0 = Math.max(0, Math.floor(bestS * fy) - 2)
      const y1 = Math.min(img.height, Math.ceil(bestE * fy) + 2)
      return cropImage(img, { x0: 0, y0, x1: img.width, y1 })
    }

    const segFiltered = (img: Fixture['image']) => {
      const cropped = preCrop(img)
      const mask = prepareRegionMask(cropped, 'adena')
      let glyphs = segmentGlyphs(mask)
      if (glyphs.length) {
        const medH = med(glyphs.map((g) => g.mask.height))
        const medInk = med(glyphs.map((g) => countInk(g.mask)))
        glyphs = glyphs.filter((g) => {
          if (g.box.x0 <= 1 || g.box.x1 >= mask.width - 1) return false
          if (g.mask.height < 0.5 * medH) return false
          if (countInk(g.mask) < 0.25 * medInk) return false
          return true
        })
      }
      return glyphs
    }

    // 동일 파이프라인으로 adena 전용 템플릿 빌드
    const builder = new TemplateBuilder()
    let used = 0
    for (const f of adena.train as Fixture[]) {
      const glyphs = segFiltered(f.image)
      const chars = f.label.split('').filter((c) => REGION_ALPHABET.adena.includes(c))
      if (glyphs.length !== chars.length || !chars.length) continue
      for (let i = 0; i < glyphs.length; i++) builder.add(chars[i]!, glyphs[i]!.mask)
      used++
    }
    const hSet = builder.finalize()
    console.log(`\n[H] preCrop+필터 adena 템플릿: train=${adena.train.length} used=${used} chars=${hSet.chars.map((c) => c.char).join('')}`)

    // 끝단 gap-트림: 좌우 양끝 글리프가 중앙 글리프 간격의 2.5배 이상 떨어져 있으면 junk로 제거
    const gapTrim = (glyphs: ReturnType<typeof segmentGlyphs>) => {
      const out = [...glyphs]
      const gaps = () => out.slice(1).map((g, i) => g.box.x0 - out[i]!.box.x1)
      while (out.length >= 3) {
        const gs = gaps()
        const m = med(gs)
        if (m <= 0) break
        if (gs[gs.length - 1]! > 2.5 * m) out.pop()
        else if (gs[0]! > 2.5 * m) out.shift()
        else break
      }
      return out
    }

    for (const [name, tplSet, useTrim] of [
      ['공유셋', set, false],
      ['adena전용(H)셋', hSet, false],
      ['adena전용(H)셋+gap트림', hSet, true]
    ] as [string, TemplateSet, boolean][]) {
      let ok = 0
      let n = 0
      const fails: string[] = []
      const byBatch = new Map<string, { n: number; ok: number }>()
      for (const f of adena.test as Fixture[]) {
        n++
        const key = f.name.includes('__') && !/_\d{8}_/.test(f.name) ? 'dunder(블록열화)' : `${f.image.width}x${f.image.height}`
        let b = byBatch.get(key)
        if (!b) byBatch.set(key, (b = { n: 0, ok: 0 }))
        b.n++
        let glyphs = segFiltered(f.image)
        if (useTrim) glyphs = gapTrim(glyphs)
        let text = ''
        for (const g of glyphs) text += matchGlyph(g.mask, tplSet, { allowed: REGION_ALPHABET.adena }).char
        const got = parseRegionString('adena', text)
        const want = parseRegionString('adena', f.label)
        if (want && parsedEquals(got, want)) {
          ok++
          b.ok++
        } else if (fails.length < 30) fails.push(`    ${f.label} -> "${text}" (${f.name})`)
      }
      console.log(`[H] preCrop+필터${useTrim ? '+gap트림' : ''} + ${name}: ${((ok / n) * 100).toFixed(1)}% (${ok}/${n})`)
      console.log('    batch별: ' + [...byBatch.entries()].map(([k, v]) => `${k}=${v.ok}/${v.n}`).join(' '))
      if (fails.length) console.log(fails.join('\n'))
    }
  })

  it('G) 타겟 딥덤프: misread 대표 샘플의 마스크/글리프 구조', () => {
    const targets = [
      '31113_20260507_234752_401_v2', // 31113 -> "9791700"
      '26737_20260507_234752_170_v2', // 26737 -> "90737" (등길이 misread)
      '24754_20260509_201026_738_v2', // 24754 -> "00475400"
      '33151_20260509_201026_827_v2', // 33151 -> "7777" (글리프 부족)
      '34691__20260503_013609_914' // 34691 -> "0897"
    ]
    const adena = data.find((d) => d.region === 'adena')!
    for (const f of adena.test as Fixture[]) {
      if (!targets.includes(f.name)) continue
      const mask = prepareRegionMask(f.image, 'adena')
      const glyphs = segmentGlyphs(mask)
      const r = recognizeImage(f.image, set, 'adena')
      console.log(`\n===== [G] ${f.name} label="${f.label}" got="${r.text}" png=${f.image.width}x${f.image.height} mask=${mask.width}x${mask.height} =====`)
      console.log(ascii(mask).join('\n'))
      glyphs.forEach((g, i) => {
        const top = scoreAll(g.mask, set, REGION_ALPHABET.adena).slice(0, 3)
        console.log(
          `  glyph[${i}] box=(${g.box.x0},${g.box.y0})-(${g.box.x1},${g.box.y1}) ` +
            `${g.mask.width}x${g.mask.height} ink=${countInk(g.mask)} top3=` +
            top.map((t) => `${t.char}:${t.score.toFixed(3)}`).join(' ')
        )
      })
    }
  })

  it('D) 파일명 패턴 vs 라벨 + 영역별 템플릿 빌드 기여도', () => {
    const adenaAll = loadFixtures('adena')
    let dunder = 0
    let dunderThirdMismatch = 0
    let leadingZero = 0
    const suspicious: string[] = []
    for (const f of adenaAll) {
      const m = f.name.match(/^(.+?)__(\d+)__(.+?)_v2$/)
      if (m) {
        dunder++
        if (m[1] !== m[3]) {
          dunderThirdMismatch++
          if (suspicious.length < 15) suspicious.push(`  ${f.name} label=${f.label} first=${m[1]} third=${m[3]}`)
        }
      }
      if (/^0\d/.test(f.label)) leadingZero++
    }
    console.log(
      `\n[D] adena fixtures=${adenaAll.length} dunder형(__x__y)=${dunder} ` +
        `first!=third(의심 라벨)=${dunderThirdMismatch} leadingZeroLabel=${leadingZero}`
    )
    if (suspicious.length) console.log('의심 파일명:\n' + suspicious.join('\n'))

    // 영역별 단독 빌드 통계 — 공유셋에 adena 가 얼마나 기여했나
    for (const d of data) {
      const { stats } = buildTemplatesFromFixtures([{ region: d.region, fx: d.train }])
      console.log(
        `[D] ${d.region} train=${d.train.length} used=${stats.used} skipped(seg!=label)=${stats.skipped} perChar=${JSON.stringify(stats.perChar)}`
      )
    }
  })
})
