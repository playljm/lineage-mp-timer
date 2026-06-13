/**
 * dbg-live-frame-roi — 실제 게임 프레임(C:/dev/tmp/lc-frame.png, 1296×999)에
 * detectGameUiScaled 를 돌려 레벨·아데나 자동 ROI 가 왜 빗나가는지 정밀 진단.
 * (사용자 실측 프레임 기반 — 추측 없이 현장 좌표로 원인 특정)
 */
import { describe, it } from 'vitest'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { detectGameUiScaled, findAdenaIconCandidates, DEFAULT_ROI_CONFIG, type ColorBlob } from '@core/ocr/roi-detector'
import { recognizeRegion } from '@core/ocr/recognizer'
import { deserializeTemplates, type SerializedTemplateSet } from '@core/ocr/template-matcher'
import baseTemplatesData from '@core/ocr/base-templates.json'
import type { RgbaImage, RegionKind } from '@core/ocr/types'

const baseTemplates = deserializeTemplates(baseTemplatesData as unknown as SerializedTemplateSet)

function load(path: string): RgbaImage {
  const png = PNG.sync.read(readFileSync(path))
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) }
}

function cropImg(img: RgbaImage, x0: number, y0: number, x1: number, y1: number): RgbaImage {
  const w = x1 - x0
  const h = y1 - y0
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * img.width + (x0 + x)) * 4
      const di = (y * w + x) * 4
      out[di] = img.data[si]!
      out[di + 1] = img.data[si + 1]!
      out[di + 2] = img.data[si + 2]!
      out[di + 3] = img.data[si + 3]!
    }
  }
  return { width: w, height: h, data: out }
}

function savePng(img: RgbaImage, path: string): void {
  const png = new PNG({ width: img.width, height: img.height })
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length)
  writeFileSync(path, PNG.sync.write(png))
}

const FRAME = 'C:/dev/tmp/lc-frame.png'

describe('dbg-live-frame-roi: 실제 프레임 자동 ROI 진단', () => {
  it('detectGameUiScaled anchors/textRois/issues 덤프', () => {
    if (!existsSync(FRAME)) {
      console.log(`[skip] ${FRAME} 없음`)
      return
    }
    const img = load(FRAME)
    console.log(`\n=== FRAME ${img.width}x${img.height} ===`)
    const res = detectGameUiScaled(img)
    const fmtBlob = (b: ColorBlob | null): string =>
      b ? `@(${b.x},${b.y}) ${b.width}x${b.height} area=${b.area} hue=${b.avgHue.toFixed(0)} sat=${b.avgSat.toFixed(2)}` : 'null'
    const fmtRoi = (r: { x0: number; y0: number; x1: number; y1: number } | null): string =>
      r ? `(${r.x0},${r.y0})-(${r.x1},${r.y1}) ${r.x1 - r.x0}x${r.y1 - r.y0}` : 'null'

    console.log('--- ANCHORS ---')
    console.log('  hp   :', fmtBlob(res.anchors.hp))
    console.log('  mp   :', fmtBlob(res.anchors.mp))
    console.log('  exp  :', fmtBlob(res.anchors.exp))
    console.log('  adena:', fmtBlob(res.anchors.adena))
    console.log('--- TEXT ROIS ---')
    console.log('  mp   :', fmtRoi(res.textRois.mp))
    console.log('  exp  :', fmtRoi(res.textRois.exp))
    console.log('  level:', fmtRoi(res.textRois.level))
    console.log('  adena:', fmtRoi(res.textRois.adena))
    console.log('--- valid:', res.valid, '---')
    console.log('--- ISSUES ---')
    for (const s of res.issues) console.log('  •', s)

    // 아데나 후보를 직접 — 게이트 통과 여부 단계별 진단 (native 1296, 다운스케일 없음)
    console.log('\n--- ADENA 후보 직접 검출 (게이트 진단) ---')
    const cands = findAdenaIconCandidates(img, DEFAULT_ROI_CONFIG)
    console.log(`  후보 ${cands.length}개:`)
    for (const c of cands.slice(0, 8)) console.log('   ', fmtBlob(c))
    const cfg = DEFAULT_ROI_CONFIG
    console.log(`  게이트: x>=${Math.round(img.width * cfg.adenaXRelMin)} y>=${Math.round(img.height * cfg.adenaYRelMin)} aspect ${cfg.adenaMinAspect}~${cfg.adenaMaxAspect} hue ${cfg.adena.hueMin}~${cfg.adena.hueMax} sat>=${cfg.adena.satMin} minArea=${Math.max(cfg.adenaMinAreaFloor, Math.floor(img.width * img.height * cfg.adenaMinAreaFrac))}`)

    // 도출된 ROI 를 그대로 크롭 → recognizeRegion (앱이 실제로 내놓을 결과)
    console.log('\n--- 도출 ROI 크롭 후 인식 (앱 실제 결과 재현) ---')
    const recog = (region: RegionKind, r: { x0: number; y0: number; x1: number; y1: number } | null): void => {
      if (!r) {
        console.log(`  ${region}: ROI null`)
        return
      }
      const crop = cropImg(img, r.x0, r.y0, r.x1, r.y1)
      savePng(crop, `C:/dev/tmp/roi-${region}.png`)
      const res = recognizeRegion({ region, image: crop }, { baseTemplates, userTemplates: undefined })
      console.log(`  ${region}: raw="${res.raw}" value=${JSON.stringify(res.value)} conf=${res.confidence.toFixed(2)} src=${res.source}  [crop ${crop.width}x${crop.height} → C:/dev/tmp/roi-${region}.png]`)
    }
    recog('mp', res.textRois.mp)
    recog('exp', res.textRois.exp)
    recog('level', res.textRois.level)
    recog('adena', res.textRois.adena)
  })
})
