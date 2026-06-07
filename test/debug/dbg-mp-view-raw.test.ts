/**
 * DEBUG (mp 영역 담당): mp 픽스처 PNG의 "원본 픽셀"이 실제로 어떻게 생겼는지
 * 그레이스케일 ASCII로 직접 확인 (이진화 가정 검증).
 * 비교를 위해 exp/adena 픽스처도 1장씩 덤프.
 */
import { describe, it, expect } from 'vitest'
import type { RgbaImage } from '@core/ocr/types'
import { toGray, borderMeanLuma, scaleToHeight } from '@core/ocr/imaging'
import { loadFixtures } from '../helpers/fixtures'

function asciiGray(img: RgbaImage, maxW = 140): string[] {
  const gray = toGray(img)
  const step = Math.max(1, Math.ceil(img.width / maxW))
  const rows: string[] = []
  for (let y = 0; y < img.height; y += step) {
    let line = ''
    for (let x = 0; x < img.width; x += step) {
      // block average
      let sum = 0
      let n = 0
      for (let yy = y; yy < Math.min(y + step, img.height); yy++)
        for (let xx = x; xx < Math.min(x + step, img.width); xx++) {
          sum += gray.data[yy * img.width + xx]!
          n++
        }
      const v = sum / n
      line += v < 51 ? ' ' : v < 102 ? '.' : v < 153 ? '+' : v < 204 ? 'x' : '#'
    }
    rows.push(line)
  }
  rows.unshift(`(downsampled x${step}: ${img.width}x${img.height}; ' '<51 '.'<102 '+'<153 'x'<204 '#'>=204)`)
  return rows
}

function channelStats(img: RgbaImage): string {
  let r = 0
  let g = 0
  let b = 0
  const n = img.width * img.height
  for (let p = 0; p < n * 4; p += 4) {
    r += img.data[p]!
    g += img.data[p + 1]!
    b += img.data[p + 2]!
  }
  return `meanRGB=(${(r / n).toFixed(0)},${(g / n).toFixed(0)},${(b / n).toFixed(0)})`
}

describe('dbg-mp-view-raw', () => {
  it('mp 픽스처 원본 그레이 ASCII 3장 + exp/adena 1장씩', () => {
    const mp = loadFixtures('mp', 6)
    for (const f of [mp[0]!, mp[2]!, mp[4]!]) {
      const scaled = scaleToHeight(f.image, 48)
      console.log(
        `\n=== RAW mp/${f.name} label="${f.label}" ${f.image.width}x${f.image.height} ` +
          `${channelStats(f.image)} borderLuma(scaled48)=${borderMeanLuma(scaled).toFixed(1)}`
      )
      console.log(asciiGray(scaled).join('\n'))
    }
    for (const region of ['exp', 'adena'] as const) {
      const fx = loadFixtures(region, 1)
      const f = fx[0]!
      const scaled = scaleToHeight(f.image, 48)
      console.log(
        `\n=== RAW ${region}/${f.name} label="${f.label}" ${f.image.width}x${f.image.height} ` +
          `${channelStats(f.image)} borderLuma(scaled48)=${borderMeanLuma(scaled).toFixed(1)}`
      )
      console.log(asciiGray(scaled).join('\n'))
    }
    expect(mp.length).toBeGreaterThan(0)
  })
})
