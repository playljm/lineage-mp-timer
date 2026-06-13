/**
 * dbg-mpcal-sat-gate — HANDOFF-2026-06-07 합성 ROI 재현 실험 → v3.1.1 수정 검증.
 *
 * 실측 증거 (docs/HANDOFF-2026-06-07-mp-calibration.md):
 *  - 정확한 ROI 255×24 @ (684,741) 에서도 보정 실패:
 *    "MP 게이지(파란 바)에 영역을 맞춰주세요 — 감지색 rgb(192,142,96)" (금장식 색!)
 *  - 게이지 본체(어두운 파랑) rgb(~74,74,92) → 채도 (92-74)/92 ≈ 0.196
 *  - 게이지 위에 흰 텍스트 "MP:327/327" 오버레이
 *  - 행 평균 rgb(64~142, 64~134, 80~160) — 전 행 파랑 우세
 *
 * 확정된 원인 (2026-06-13 점검, 이 파일의 초판으로 재현 입증):
 *  G1. detectFillColor 의 샘플 게이트 `lum>40 && saturation>0.25`
 *      → 본체 채도 0.196 은 탈락, 금장식 rgb(192,142,96) (채도 0.50, 휘도 152) 만 통과
 *      → fillColor = 정확히 rgb(192,142,96) (필드 감지색과 정수 일치 재현됐었음).
 *  G2. detectGaugeRowBand 의 픽셀 게이트 `b > max(r,g)+15`
 *      → 본체 마진 92-74=18 로 임계 15 대비 여유 3 — 광택/디더링에 밴드가 붕괴하면
 *        금장식 행까지 detectFillColor 샘플에 포함 → not_blue + 갈색 감지색 (필드 경로).
 *
 * v3.1.1 수정 (src/core/ocr/bar-fill.ts):
 *  ① FILL_SATURATION_GATE 0.25 → 0.12 (실측 게이지 채도 0.163~0.196 수용, 흰 텍스트 배제)
 *  ② BLUE_DOMINANCE_MARGIN 15 → 8 (본체 여유 3 → 10)
 *  ③ detectFillColor 파랑-클러스터 우선 평균 (금장식 혼입이 평균을 오염시켜도
 *     파랑 부분집합이 충분+과반이면 그 평균을 채택 — 갈색-only ROI 는 폴백 유지)
 *
 * 이 파일은 이제 "필드 시나리오에서 보정이 성공해야 한다"는 회귀 테스트다.
 * (공식 회귀망: test/ocr/bar-fill-calibration.test.ts 의 (d) 블록이 같은 시나리오 고정)
 */
import { describe, it, expect } from 'vitest'
import {
  calibrateBarChecked,
  cropRows,
  detectFillColor,
  detectGaugeRowBand,
  isBlueDominant,
  type Rgb
} from '@core/ocr/bar-fill'
import type { RgbaImage } from '@core/ocr/types'

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

/** Deterministic pseudo-noise (dbg-live-mpcal 과 동일 패턴, seed 고정 → 재현 가능). */
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

const GOLD: Rgb = { r: 192, g: 142, b: 96 } // 금장식 (필드의 옛 "감지색")
const WHITE: Rgb = { r: 230, g: 230, b: 230 } // "MP:327/327" 텍스트 모사
const BODY_HANDOFF: Rgb = { r: 74, g: 74, b: 92 } // 채도 0.196 — 옛 게이트 0.25 미달
const BODY_CONTROL: Rgb = { r: 68, g: 68, b: 92 } // 채도 0.261 — 옛 게이트 0.25 직상회

interface RoiOpts {
  body: Rgb
  noiseAmp: number
  /** 본체 픽셀 일부에 r,g+14 광택 스펙클(파랑-마진 18→4 로 붕괴) 적용 비율. */
  sheenFrac?: number
}

/**
 * 핸드오프 실측 ROI 모사: 255×24, 100% 채움.
 *  - rows 0-1 / 22-23: 금장식 rgb(192,142,96)
 *  - rows 2..21: 게이지 본체 (100% 채움이므로 전 컬럼)
 *  - rows 9..15 의 중앙부 x 95..159: 1/3 픽셀을 흰 텍스트로 산포 ("MP:327/327" 모사)
 */
function makeHandoffRoi(opts: RoiOpts): RgbaImage {
  const W = 255
  const H = 24
  const img = makeImage(W, H, opts.body)
  // 금장식 상하 2행씩
  fillRect(img, 0, 0, W, 2, GOLD)
  fillRect(img, 0, H - 2, W, 2, GOLD)
  // 광택 스펙클 (본체 행에만; 결정적 패턴)
  if (opts.sheenFrac && opts.sheenFrac > 0) {
    let s = 99991
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
    for (let y = 2; y < H - 2; y++) {
      for (let x = 0; x < W; x++) {
        if (rnd() < opts.sheenFrac) {
          const p = (y * W + x) * 4
          img.data[p] = Math.min(255, img.data[p]! + 14)
          img.data[p + 1] = Math.min(255, img.data[p + 1]! + 14)
        }
      }
    }
  }
  // 흰 텍스트 모사: 중앙 7행 × 중앙 65px, 1/3 산포 (스트로크 커버리지 근사)
  for (let y = 9; y <= 15; y++) {
    for (let x = 95; x < 160; x++) {
      if ((x + y * 3) % 3 === 0) {
        const p = (y * W + x) * 4
        img.data[p] = WHITE.r
        img.data[p + 1] = WHITE.g
        img.data[p + 2] = WHITE.b
      }
    }
  }
  addNoise(img, opts.noiseAmp)
  return img
}

function fmt(c: Rgb | null): string {
  return c ? `rgb(${c.r.toFixed(1)},${c.g.toFixed(1)},${c.b.toFixed(1)})` : 'null'
}

function sat(c: Rgb): number {
  const max = Math.max(c.r, c.g, c.b)
  const min = Math.min(c.r, c.g, c.b)
  return max === 0 ? 0 : (max - min) / max
}

/**
 * detectFillColor 의 샘플 게이트(lum>40 && sat>GATE)를 통과하는 픽셀 수를
 * shrink-to-band 후 좌측 25% 샘플 영역에서 직접 계수 — 게이트 마진 정량화.
 * (bar-fill.ts FILL_SATURATION_GATE=0.12 판정식의 재현, src 수정 없음)
 */
const SAT_GATE = 0.12
function countGatePass(img: RgbaImage): { pass: number; total: number; need: number } {
  const band = detectGaugeRowBand(img)
  const work = band ? cropRows(img, band) : img
  const x1 = Math.max(1, Math.floor(work.width * 0.25))
  let pass = 0
  for (let y = 0; y < work.height; y++) {
    for (let x = 0; x < x1; x++) {
      const p = (y * work.width + x) * 4
      const r = work.data[p]!
      const g = work.data[p + 1]!
      const b = work.data[p + 2]!
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const s = max === 0 ? 0 : (max - min) / max
      if (lum > 40 && s > SAT_GATE) pass++
    }
  }
  return { pass, total: x1 * work.height, need: Math.ceil(work.height * 0.5) }
}

function report(tag: string, img: RgbaImage): ReturnType<typeof calibrateBarChecked> {
  const band = detectGaugeRowBand(img)
  const fillFull = detectFillColor(img)
  console.log(`[${tag}] detectGaugeRowBand = ${band ? `rows ${band.y0}..${band.y1}` : 'null (밴드 붕괴 → 전체 ROI 사용)'}`)
  const gp = countGatePass(img)
  console.log(
    `[${tag}] 채도 게이트(>${SAT_GATE}) 통과 픽셀: ${gp.pass}/${gp.total} (${((100 * gp.pass) / gp.total).toFixed(1)}%) — detectFillColor 성립 최소 요구 ${gp.need}개`
  )
  console.log(
    `[${tag}] detectFillColor(전체 ROI) = ${fmt(fillFull)}${fillFull ? ` (채도 ${sat(fillFull).toFixed(3)}, blueDominant=${isBlueDominant(fillFull)})` : ''}`
  )
  // This suite validates the saturation/blue-dominance COLOUR gate (v3.1.1). Pin the
  // pre-v3.1.6 column-density (0.3) so the unrelated density default change (raised to
  // 0.5 for thin real gauges) doesn't reject these artificial full-height 24px ROIs
  // (their gold-trim + text rows drop column density below 0.5).
  const res = calibrateBarChecked(img, { minColumnDensity: 0.3 })
  if (res.ok) {
    console.log(
      `[${tag}] calibrateBarChecked → 성공: fullColumns=${res.calibration.fullColumns}, fillColor=${fmt(res.fillColor)}, band=${res.rowBand.y0}..${res.rowBand.y1}, selfRatio=${res.selfRatio.toFixed(3)}`
    )
  } else {
    console.log(
      `[${tag}] calibrateBarChecked → 실패: reason=${res.reason}, 감지 fillColor=${fmt(res.fillColor)}, note="${res.note}"`
    )
  }
  return res
}

// ──────────────────────────────── tests ─────────────────────────────────────

describe('dbg-mpcal-sat-gate: 핸드오프 합성 ROI — v3.1.1 게이트 수정 후 보정 성공 검증', () => {
  it('A0: 노이즈 0 — 본체 채도 0.196 이 게이트 0.12 를 통과해 보정 성공 (수정 전: no_fill_color)', () => {
    const img = makeHandoffRoi({ body: BODY_HANDOFF, noiseAmp: 0 })
    const res = report('A0', img)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(isBlueDominant(res.fillColor)).toBe(true)
      expect(res.calibration.fullColumns).toBe(255)
      expect(res.selfRatio).toBeGreaterThan(0.9)
      // 밴드가 금장식 행을 제외하고 검출돼야 한다 (rows ~2..22)
      expect(res.rowBand.y0).toBeGreaterThanOrEqual(1)
      expect(res.rowBand.y1).toBeLessThanOrEqual(23)
    }
  })

  it('A1: 핸드오프 충실 (본체 rgb(74,74,92) 채도 0.196, 노이즈 ±3) — 게이트 통과가 본체 다수 픽셀', () => {
    const img = makeHandoffRoi({ body: BODY_HANDOFF, noiseAmp: 3 })
    console.log(
      `[A1] 본체 ${fmt(BODY_HANDOFF)} 채도=${sat(BODY_HANDOFF).toFixed(3)} (새 게이트 0.12 상회), 금장식 ${fmt(GOLD)} 채도=${sat(GOLD).toFixed(3)}`
    )
    const res = report('A1', img)
    expect(res.ok).toBe(true)
    if (res.ok) expect(isBlueDominant(res.fillColor)).toBe(true)
    // 수정 전: 통과 0~1.6% (노이즈 이상치 의존 복권) → 수정 후: 본체 다수가 정상 통과
    const gp = countGatePass(img)
    expect(gp.pass / gp.total).toBeGreaterThan(0.5)
  })

  it('A2: A1 + 실기 광택 텍스처 (필드 실패 경로) — 파랑-클러스터 우선 평균으로 보정 성공 (수정 전: not_blue + 금장식색)', () => {
    const img = makeHandoffRoi({ body: BODY_HANDOFF, noiseAmp: 3, sheenFrac: 0.55 })
    // 행 평균 확인 (핸드오프 실측 범위와의 정합성)
    {
      const W = img.width
      let r = 0, g = 0, b = 0
      const y = 5 // 텍스트 없는 본체 행
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4
        r += img.data[p]!; g += img.data[p + 1]!; b += img.data[p + 2]!
      }
      console.log(`[A2] 본체 행(y=5) 평균 = rgb(${(r / W).toFixed(0)},${(g / W).toFixed(0)},${(b / W).toFixed(0)})  (핸드오프 실측: r 64~142, g 64~134, b 80~160)`)
    }
    const res = report('A2', img)
    // 필드와 동일 조건에서 이제 보정이 성공해야 하고, 학습 색은 금장식(갈색)이 아닌 파랑이어야 한다
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(isBlueDominant(res.fillColor)).toBe(true)
      expect(res.fillColor.r).toBeLessThan(res.fillColor.b) // 갈색(r>b) 학습 금지
      expect(res.calibration.fullColumns).toBeGreaterThanOrEqual(250)
      expect(res.selfRatio).toBeGreaterThan(0.9)
    }
  })

  it('B: 대조군 — 본체 채도 0.261 (rgb(68,68,92)): 수정 전후 모두 성공 (단조 완화 확인)', () => {
    const img = makeHandoffRoi({ body: BODY_CONTROL, noiseAmp: 3 })
    console.log(
      `[B] 본체 ${fmt(BODY_CONTROL)} 채도=${sat(BODY_CONTROL).toFixed(3)} — 옛 게이트(0.25)도 통과하던 케이스`
    )
    const res = report('B', img)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(isBlueDominant(res.fillColor)).toBe(true)
      expect(res.selfRatio).toBeGreaterThan(0.9)
    }
    const gp = countGatePass(img)
    expect(gp.pass / gp.total).toBeGreaterThan(0.3)
  })
})
