/**
 * dbg-live-mpcal — MP 바 보정(calibration)이 "해봤는데 안 됨"인 이유 실증.
 *
 * 라이브 증거 (읽기 전용으로 수집):
 *  - 6/4 진단 로그: useMpBar=true 인데 매초 "보정 없음 → 텍스트 OCR 폴백" WARN,
 *    mp raw="000000" conf 0.66.
 *  - 6/6 localStorage(leveldb) 덤프: mpBarRegion = {x:1776,y:976,w:287,h:47},
 *    mpBarMaxX=277, mpBarRefColor=rgb(111.5, 91.6, 78.6) ← 파란 게이지가 아니라 갈색!
 *
 * 가설:
 *  H1. 보정 저장/로드/적용 경로 자체는 동작한다 (277 cols 가 실제로 영속됨).
 *  H2. 진짜 문제는 ROI 기하: 287x47 ROI 는 실제 게이지 스트립(~십수 px)보다 훨씬
 *      커서 detectFillColor 가 갈색 패널 평균을 fill 색으로 학습 → 이후
 *      barFillToMp 가 MP 가 줄어도 패널을 "채움"으로 계속 셈 → MP 고착.
 *  H3. calibrateBar 의 "가득 참" 게이트(filledColumns >= width*0.5)는 이런
 *      잘못된 ROI 를 거부하지 못한다 (패널이 어디서나 매치되므로).
 *  H4. (부수) 79x23 mp 텍스트 ROI 의 "000000" — blueMargin=40 이진화가
 *      "cur/max" 텍스트를 어떻게 망가뜨리는지 픽스처 ASCII 덤프로 확인.
 *  H5. (잠재) detection.calibrateMpBar 의 저장은 raw store.set 이라 flush 가
 *      스케줄되지 않음 — 보정 직후 다른 영속 변이 없이 앱을 닫으면 유실.
 *
 * ── FIXED (v3.0.2) — 이 파일의 로그 기대치는 새 동작 기준 ──────────────────
 *  - calibrateBar 는 이제 shrink-to-band + 파란-우세 게이트를 거친다
 *    (calibrateBarChecked 래퍼). 과대 ROI(287x47)는 갈색 패널 대신 파란 게이지
 *    밴드(rows 18..29)를 학습해 "성공"하고, 게이지 없는 갈색 ROI 는 거부된다.
 *  - H1 의 replay 루프는 의도적으로 *축소 전* 전체 ROI 에 측정한다(과대 ROI 에서
 *    bar-pixel 이 왜 부정확한지 보존용) — 라이브에서는 detection.calibrateMpBar 가
 *    ROI 를 밴드로 축소 저장하므로 측정도 밴드에서 이뤄진다.
 *  - H2b 의 갈색 보정값 replay 는 순수 computeBarFill 재현으로 여전히 유효하지만,
 *    라이브에서는 detection.barCalibration 로더가 비-파랑 refColor 를 무효화해
 *    이 보정이 더 이상 적용되지 않는다 ('보정 필요' 상태).
 *  - H5 는 store 의 raw set 자체가 flush 를 안 하는 사실의 계측으로 여전히 참 —
 *    수정은 calibrateMpBar/openWindowSource 가 set 직후 app.flush() 를 명시 호출.
 *  새 동작의 단정(assert) 테스트는 test/ocr/bar-fill-calibration.test.ts 참고.
 */
import { describe, it } from 'vitest'
import {
  calibrateBar,
  computeBarFill,
  detectFillColor,
  detectEmptyColor,
  barFillToMp,
  type Rgb
} from '@core/ocr/bar-fill'
import { prepareRegionMask, recognizeImage } from '@core/ocr/text-recognizer'
import {
  deserializeTemplates,
  type SerializedTemplateSet,
  type TemplateSet
} from '@core/ocr/template-matcher'
import baseTemplatesData from '@core/ocr/base-templates.json'
import { parseRegionString } from '@core/ocr/parser'
import type { RgbaImage } from '@core/ocr/types'
import { loadFixtures } from '../helpers/fixtures'
import { createAppStore, STORAGE_KEY, type StorageLike } from '../../src/renderer/src/state/store'

const baseTemplates: TemplateSet = deserializeTemplates(
  baseTemplatesData as unknown as SerializedTemplateSet
)

// ───────────────────────── synthetic image helpers ──────────────────────────

function makeImage(width: number, height: number, bg: Rgb): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bg.r
    data[i * 4 + 1] = bg.g
    data[i * 4 + 2] = bg.b
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

function fillRect(img: RgbaImage, x0: number, y0: number, w: number, h: number, c: Rgb): void {
  for (let y = y0; y < Math.min(img.height, y0 + h); y++) {
    for (let x = x0; x < Math.min(img.width, x0 + w); x++) {
      const p = (y * img.width + x) * 4
      img.data[p] = c.r
      img.data[p + 1] = c.g
      img.data[p + 2] = c.b
    }
  }
}

/** Deterministic pseudo-noise so panel pixels are not perfectly uniform. */
function addNoise(img: RgbaImage, amp: number): void {
  let seed = 12345
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 2 - 1
  }
  for (let i = 0; i < img.width * img.height; i++) {
    for (let k = 0; k < 3; k++) {
      const p = i * 4 + k
      img.data[p] = Math.max(0, Math.min(255, img.data[p]! + rnd() * amp))
    }
  }
}

/**
 * 사용자 환경 재현: 287x47 의 큰 ROI.
 *  - 전체: 리니지 UI 갈색 패널 rgb(110,92,78) (채도 0.29 > 0.25, 휘도 ~95 > 40
 *    → detectFillColor 의 샘플 게이트를 통과하는 색).
 *  - 게이지 스트립: rows 18..29 (12px), 좌측부터 fillRatio 만큼 파란 채움
 *    rgb(40,80,200), 나머지는 어두운 빈 트랙 rgb(30,25,20).
 */
function makeUserLikeBarRoi(fillRatio: number): RgbaImage {
  const img = makeImage(287, 47, { r: 110, g: 92, b: 78 })
  const stripY = 18
  const stripH = 12
  fillRect(img, 0, stripY, 287, stripH, { r: 30, g: 25, b: 20 }) // empty track
  fillRect(img, 0, stripY, Math.round(287 * fillRatio), stripH, { r: 40, g: 80, b: 200 }) // blue fill
  addNoise(img, 6)
  return img
}

/** 대조군: 게이지 스트립에 딱 맞는 287x12 ROI. */
function makeTightBarRoi(fillRatio: number): RgbaImage {
  const img = makeImage(287, 12, { r: 30, g: 25, b: 20 })
  fillRect(img, 0, 0, Math.round(287 * fillRatio), 12, { r: 40, g: 80, b: 200 })
  addNoise(img, 6)
  return img
}

function fmt(c: Rgb | null): string {
  return c ? `rgb(${c.r.toFixed(1)},${c.g.toFixed(1)},${c.b.toFixed(1)})` : 'null'
}

function asciiMask(maskW: number, maskH: number, get: (x: number, y: number) => number): string {
  const lines: string[] = []
  const stepX = Math.max(1, Math.floor(maskW / 110))
  const stepY = Math.max(1, Math.floor(maskH / 28))
  for (let y = 0; y < maskH; y += stepY) {
    let row = ''
    for (let x = 0; x < maskW; x += stepX) row += get(x, y) ? '#' : '.'
    lines.push(row)
  }
  return lines.join('\n')
}

// ──────────────────────────────── tests ─────────────────────────────────────

describe('dbg-live-mpcal: MP 바 보정이 안 먹히는 단계 특정', () => {
  it('H1/H2: 사용자형 287x47 ROI — 보정은 "성공"하지만 갈색 패널을 학습한다', () => {
    const img100 = makeUserLikeBarRoi(1.0)

    const fill = detectFillColor(img100)
    console.log(`[oversized ROI 287x47 @100%] detectFillColor = ${fmt(fill)}  (live 영속값: rgb(111.5,91.6,78.6))`)
    const empty = fill ? detectEmptyColor(img100, fill) : null
    console.log(`[oversized ROI 287x47 @100%] detectEmptyColor = ${fmt(empty)}`)

    const cal = calibrateBar(img100)
    console.log(`[oversized ROI 287x47 @100%] calibrateBar → ${cal ? `OK fullColumns=${cal.fullColumns} fillColor=${fmt(cal.fillColor)}` : 'null(실패)'}`)

    if (!cal) return
    // MP가 30%로 빠졌을 때 bar-pixel 측정이 따라오는가?
    for (const ratio of [1.0, 0.6, 0.3, 0.05]) {
      const img = makeUserLikeBarRoi(ratio)
      const cur = barFillToMp(img, 235, cal)
      const res = computeBarFill(img, { refColor: cal.fillColor })
      console.log(
        `[oversized ROI] 실제 MP=${Math.round(235 * ratio)}/235 → bar-pixel cur=${cur}  (filled=${res.filledColumns}/${res.totalColumns}, empty=${fmt(res.emptyColor)})`
      )
    }
  })

  it('H2b: 라이브 영속 보정값 재생 — fullColumns=277, refColor=rgb(111.5,91.6,78.6)', () => {
    // 6/6 leveldb 에서 추출한 실제 사용자 보정값
    const liveCal = { fullColumns: 277, fillColor: { r: 111.49, g: 91.61, b: 78.62 } }
    for (const ratio of [1.0, 0.6, 0.3, 0.05]) {
      const img = makeUserLikeBarRoi(ratio)
      const cur = barFillToMp(img, 235, liveCal)
      const res = computeBarFill(img, { refColor: liveCal.fillColor })
      console.log(
        `[live-cal replay] 실제 MP=${Math.round(235 * ratio)}/235 → bar-pixel cur=${cur}  (filled=${res.filledColumns}/${res.totalColumns}, emptyMode=${res.emptyColor ? 'relative' : 'absolute'})`
      )
    }
  })

  it('H3: 게이지가 가득 차지 않아도(30%) calibrateBar 가 통과해버리는가', () => {
    const img30 = makeUserLikeBarRoi(0.3)
    const cal30 = calibrateBar(img30)
    console.log(`[oversized ROI @30% MP] calibrateBar → ${cal30 ? `OK(!) fullColumns=${cal30.fullColumns} fillColor=${fmt(cal30.fillColor)}` : 'null(정상 거부)'}`)

    const tight30 = makeTightBarRoi(0.3)
    const calT30 = calibrateBar(tight30)
    console.log(`[tight ROI @30% MP] calibrateBar → ${calT30 ? `OK(!) fullColumns=${calT30.fullColumns}` : 'null(정상 거부)'}`)
  })

  it('대조군: 게이지에 딱 맞는 287x12 ROI 면 보정·추적 모두 정상', () => {
    const img100 = makeTightBarRoi(1.0)
    const fill = detectFillColor(img100)
    console.log(`[tight ROI 287x12 @100%] detectFillColor = ${fmt(fill)}`)
    const cal = calibrateBar(img100)
    console.log(`[tight ROI 287x12 @100%] calibrateBar → ${cal ? `OK fullColumns=${cal.fullColumns} fillColor=${fmt(cal.fillColor)}` : 'null(실패)'}`)
    if (!cal) return
    for (const ratio of [1.0, 0.6, 0.3, 0.05]) {
      const img = makeTightBarRoi(ratio)
      const cur = barFillToMp(img, 235, cal)
      console.log(`[tight ROI] 실제 MP=${Math.round(235 * ratio)}/235 → bar-pixel cur=${cur}`)
    }
  })

  it('H4: mp 텍스트 ROI "000000" — 픽스처 ASCII 덤프 (blueMargin=40 vs 없음)', () => {
    const fixtures = loadFixtures('mp', 2)
    if (fixtures.length === 0) {
      console.log('mp 픽스처 없음 — skip')
      return
    }
    for (const fx of fixtures) {
      console.log(`\n=== fixture ${fx.name} (gt="${fx.label}", ${fx.image.width}x${fx.image.height}) ===`)
      const rec = recognizeImage(fx.image, baseTemplates, 'mp')
      const parsed = parseRegionString('mp', rec.text)
      console.log(
        `recognize(blueMargin=40): raw="${rec.text}" mean=${rec.meanConfidence.toFixed(2)} → parsed=${parsed ? JSON.stringify(parsed) : 'null'}`
      )
      console.log(
        `  glyphs: ${rec.glyphs.map((g) => `${g.char}(${g.confidence.toFixed(2)}${g.runnerUp ? `/${g.runnerUp}` : ''})`).join(' ')}`
      )
      const maskDefault = prepareRegionMask(fx.image, 'mp')
      console.log(`-- mask (region='mp', blueMargin=40) ${maskDefault.width}x${maskDefault.height}:`)
      console.log(asciiMask(maskDefault.width, maskDefault.height, (x, y) => maskDefault.data[y * maskDefault.width + x]!))
      const maskNoBlue = prepareRegionMask(fx.image, 'mp', { blueMargin: undefined })
      console.log(`-- mask (blueMargin=off):`)
      console.log(asciiMask(maskNoBlue.width, maskNoBlue.height, (x, y) => maskNoBlue.data[y * maskNoBlue.width + x]!))
      const recNoBlue = recognizeImage(fx.image, baseTemplates, 'mp', { binarize: { blueMargin: undefined } })
      console.log(`recognize(blueMargin=off): raw="${recNoBlue.text}" mean=${recNoBlue.meanConfidence.toFixed(2)}`)
    }
  })

  it('H5: calibrateMpBar 식 raw store.set 은 localStorage flush 를 스케줄하지 않는다', () => {
    const writes: string[] = []
    const mem = new Map<string, string>()
    const storage: StorageLike = {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => {
        mem.set(k, v)
        writes.push(k)
      }
    }
    const queue: Array<() => void> = []
    const app = createAppStore({ storage, scheduler: (fn) => queue.push(fn) })
    const drain = (): void => {
      while (queue.length) queue.shift()!()
    }

    // detection.ts:197 과 동일한 raw store.set 으로 보정값 기록
    app.store.set((prev) => ({
      persisted: {
        ...prev.persisted,
        autoDetect: { ...prev.persisted.autoDetect, mpBarMaxX: 277, mpBarRefColor: { r: 1, g: 2, b: 3 } }
      }
    }))
    drain()
    const afterRawSet = mem.get(STORAGE_KEY)
    console.log(
      `raw store.set 후 localStorage 기록 횟수=${writes.length}, mpBarMaxX 영속=${afterRawSet ? JSON.parse(afterRawSet).autoDetect?.mpBarMaxX : '(미기록)'}`
    )

    // 이후 아무 patchPersisted 경유 변이가 발생하면 그때서야 통째로 영속됨
    app.setUi({})
    drain()
    const afterPatch = mem.get(STORAGE_KEY)
    console.log(
      `setUi(patchPersisted) 후 기록 횟수=${writes.length}, mpBarMaxX 영속=${afterPatch ? JSON.parse(afterPatch).autoDetect?.mpBarMaxX : '(미기록)'}`
    )
  })
})
