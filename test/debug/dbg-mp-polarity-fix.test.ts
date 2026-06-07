/**
 * DEBUG (mp 영역 담당): 가설 검증 — mp ROI는 밝은 게이지 프레임 때문에
 * borderMeanLuma>128 → binarizeAuto가 polarity를 'dark-text'로 오판해
 * 마스크가 반전(배경=잉크, 글자=구멍)되어 세그멘테이션이 완파된다.
 *
 * 실험: mp만 polarity:'bright' 강제(blueMargin 40 유지)하고
 *   (F1) mp train 가드 통과율 변화
 *   (F2) 교정된 공유 템플릿셋(전 영역, mp는 bright)으로 mp/exp/level/adena TEST 정확도
 *   (F3) 교정 마스크 ASCII 1장 (전/후 비교용)
 */
import { describe, it, expect } from 'vitest'
import type { RegionKind, BinaryMask } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { recognizeImage, prepareRegionMask } from '@core/ocr/text-recognizer'
import { segmentGlyphs } from '@core/ocr/segmentation'
import { TemplateBuilder, type TemplateSet } from '@core/ocr/template-matcher'
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
const byRegion = Object.fromEntries(data.map((d) => [d.region, d])) as Record<
  RegionKind,
  { region: RegionKind; train: Fixture[]; test: Fixture[] }
>

const MP_FIX = { polarity: 'bright' as const }

function maskFor(f: Fixture, region: RegionKind, useFix: boolean): BinaryMask {
  return region === 'mp' && useFix
    ? prepareRegionMask(f.image, region, MP_FIX)
    : prepareRegionMask(f.image, region)
}

/** build-templates.ts와 동일 로직, mp만 polarity:'bright' 옵션 주입 가능. */
function buildSet(groups: { region: RegionKind; fx: Fixture[] }[], useFix: boolean) {
  const builder = new TemplateBuilder()
  const perRegion: Record<string, { used: number; skipped: number; perChar: Record<string, number> }> = {}
  for (const { region, fx } of groups) {
    const allowed = new Set(REGION_ALPHABET[region])
    const s = (perRegion[region] = { used: 0, skipped: 0, perChar: {} as Record<string, number> })
    for (const f of fx) {
      const chars = f.label.split('').filter((c) => allowed.has(c))
      const glyphs = segmentGlyphs(maskFor(f, region, useFix))
      if (glyphs.length !== chars.length || chars.length === 0) {
        s.skipped++
        continue
      }
      for (let i = 0; i < glyphs.length; i++) {
        builder.add(chars[i]!, glyphs[i]!.mask)
        s.perChar[chars[i]!] = (s.perChar[chars[i]!] ?? 0) + 1
      }
      s.used++
    }
  }
  return { set: builder.finalize(), perRegion }
}

function evalRegion(region: RegionKind, fx: Fixture[], set: TemplateSet, useFix: boolean) {
  let correct = 0
  const failures: string[] = []
  for (const f of fx) {
    const r =
      region === 'mp' && useFix
        ? recognizeImage(f.image, set, region, { binarize: MP_FIX })
        : recognizeImage(f.image, set, region)
    const got = parseRegionString(region, r.text)
    const want = parseRegionString(region, f.label)
    if (want && parsedEquals(got, want)) correct++
    else if (failures.length < 8) failures.push(`${f.label} -> "${r.text}"`)
  }
  return { acc: fx.length ? correct / fx.length : 0, correct, total: fx.length, failures }
}

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

describe('dbg-mp-polarity-fix', () => {
  it('F1. mp train 가드 통과율: auto(현행) vs polarity=bright 강제', () => {
    let passAuto = 0
    let passFix = 0
    for (const f of byRegion.mp.train) {
      const chars = f.label.split('').filter((c) => REGION_ALPHABET.mp.includes(c))
      if (segmentGlyphs(maskFor(f, 'mp', false)).length === chars.length) passAuto++
      if (segmentGlyphs(maskFor(f, 'mp', true)).length === chars.length) passFix++
    }
    console.log(
      `\n=== F1. mp train ${byRegion.mp.train.length}장 가드(글리프수==라벨길이) 통과: ` +
        `auto-polarity=${passAuto}장 → bright강제=${passFix}장`
    )
    expect(passFix).toBeGreaterThanOrEqual(passAuto)
  })

  it('F2. 교정 공유셋으로 전 영역 TEST 정확도 재측정', () => {
    const fixed = buildSet(
      data.map((d) => ({ region: d.region, fx: d.train })),
      true
    )
    console.log('\n=== F2. mp=bright 교정 빌드 region별 기여 ===')
    for (const r of REGIONS) {
      const s = fixed.perRegion[r]!
      console.log(`  ${r.padEnd(5)} used=${s.used} skipped=${s.skipped} perChar=${JSON.stringify(s.perChar)}`)
    }
    console.log('\n=== F2. TEST 정확도 (교정 공유셋; mp 인식도 bright 강제) ===')
    for (const region of REGIONS) {
      const e = evalRegion(region, byRegion[region].test, fixed.set, true)
      console.log(
        `  ${region.padEnd(5)} ${(e.acc * 100).toFixed(1)}% (${e.correct}/${e.total})` +
          (e.failures.length ? `  실패예: ${e.failures.slice(0, 4).join(' ; ')}` : '')
      )
    }
    expect(fixed.set.chars.length).toBeGreaterThan(0)
  })

  it('F3. 교정 마스크 ASCII (B 섹션과 동일 샘플 전/후 비교)', () => {
    const f = byRegion.mp.train[0]!
    const fixedMask = maskFor(f, 'mp', true)
    const glyphs = segmentGlyphs(fixedMask)
    const chars = f.label.split('').filter((c) => REGION_ALPHABET.mp.includes(c))
    console.log(
      `\n=== F3. mp/${f.name} label="${f.label}" polarity=bright 강제: glyphs=${glyphs.length} ` +
        `(chars=${chars.length}) guard=${glyphs.length === chars.length ? 'PASS' : 'SKIP'}`
    )
    console.log(asciiMask(fixedMask).join('\n'))
    console.log(
      '  boxes: ' +
        glyphs.map((g) => `[x${g.box.x0}-${g.box.x1} ${g.box.x1 - g.box.x0}x${g.box.y1 - g.box.y0}]`).join(' ')
    )
    expect(true).toBe(true)
  })
})
