/**
 * DEBUG (mp 영역 담당):
 * (G1) mp 픽스처가 전부 그레이스케일인지 + blueMargin(B>R+40) 트리거 픽셀 수
 *      → mp 전용 게이지 억제(blueMargin)가 픽스처에서 완전히 죽어있는지 확인
 * (G2) mp 이진화 파라미터 스윕: polarity='dark' + darkRatio ∈ {0.35,0.45,0.55,0.8(현행)}
 *      → train 가드 통과율 / mp-only 템플릿으로 TEST 정확도
 */
import { describe, it, expect } from 'vitest'
import type { RegionKind, BinaryMask } from '@core/ocr/types'
import { REGION_ALPHABET } from '@core/ocr/types'
import { recognizeImage, prepareRegionMask } from '@core/ocr/text-recognizer'
import { segmentGlyphs } from '@core/ocr/segmentation'
import { TemplateBuilder, type TemplateSet } from '@core/ocr/template-matcher'
import type { AutoBinarizeOptions } from '@core/ocr/imaging'
import { parseRegionString, parsedEquals } from '@core/ocr/parser'
import { loadFixtures, type Fixture } from '../helpers/fixtures'

function split<T>(arr: T[]): { train: T[]; test: T[] } {
  const train: T[] = []
  const test: T[] = []
  arr.forEach((x, i) => (i % 2 === 0 ? train : test).push(x))
  return { train, test }
}

const all = loadFixtures('mp')
const { train, test } = split(all)

describe('dbg-mp-binarize-sweep', () => {
  it('G1. mp 픽스처 그레이스케일 여부 + blueMargin 트리거 픽셀', () => {
    let grayCount = 0
    let blueTriggerTotal = 0
    let maxBminusR = -255
    for (const f of all) {
      const { data, width, height } = f.image
      let isGray = true
      let blueTrig = 0
      for (let p = 0; p < width * height * 4; p += 4) {
        const r = data[p]!
        const g = data[p + 1]!
        const b = data[p + 2]!
        if (r !== g || g !== b) isGray = false
        if (b > r + 40 && b > g) blueTrig++
        if (b - r > maxBminusR) maxBminusR = b - r
      }
      if (isGray) grayCount++
      blueTriggerTotal += blueTrig
    }
    console.log(
      `\n=== G1. mp 픽스처 ${all.length}장: 완전 그레이스케일=${grayCount}장, ` +
        `blueMargin(B>R+40 && B>G) 트리거 픽셀 총합=${blueTriggerTotal}, max(B-R)=${maxBminusR}`
    )
    expect(all.length).toBeGreaterThan(0)
  })

  it('G2. darkRatio 스윕: 가드 통과율 + mp-only 셋 TEST 정확도', () => {
    const variants: { name: string; opts?: AutoBinarizeOptions }[] = [
      { name: 'auto(현행)' },
      { name: 'dark r=0.80', opts: { polarity: 'dark', darkRatio: 0.8 } },
      { name: 'dark r=0.55', opts: { polarity: 'dark', darkRatio: 0.55 } },
      { name: 'dark r=0.45', opts: { polarity: 'dark', darkRatio: 0.45 } },
      { name: 'dark r=0.35', opts: { polarity: 'dark', darkRatio: 0.35 } }
    ]
    console.log('\n=== G2. mp 이진화 스윕 (train 가드 통과 → mp-only 템플릿 → TEST 정확도) ===')
    for (const v of variants) {
      const builder = new TemplateBuilder()
      let pass = 0
      for (const f of train) {
        const chars = f.label.split('').filter((c) => REGION_ALPHABET.mp.includes(c))
        const mask: BinaryMask = prepareRegionMask(f.image, 'mp', v.opts)
        const glyphs = segmentGlyphs(mask)
        if (glyphs.length !== chars.length || chars.length === 0) continue
        pass++
        for (let i = 0; i < glyphs.length; i++) builder.add(chars[i]!, glyphs[i]!.mask)
      }
      const set: TemplateSet = builder.finalize()
      let correct = 0
      const failures: string[] = []
      for (const f of test) {
        const r = recognizeImage(f.image, set, 'mp', { binarize: v.opts })
        const got = parseRegionString('mp', r.text)
        const want = parseRegionString('mp', f.label)
        if (want && parsedEquals(got, want)) correct++
        else if (failures.length < 3) failures.push(`${f.label}->"${r.text}"`)
      }
      console.log(
        `  ${v.name.padEnd(12)} 가드PASS ${String(pass).padStart(2)}/${train.length}` +
          `  chars=[${set.chars.map((c) => c.char).join('')}]` +
          `  TEST ${((correct / test.length) * 100).toFixed(1)}% (${correct}/${test.length})` +
          (failures.length ? `  실패예: ${failures.join(' ; ')}` : '')
      )
    }
    expect(true).toBe(true)
  })
})
