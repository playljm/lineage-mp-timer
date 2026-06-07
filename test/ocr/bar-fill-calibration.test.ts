/**
 * MP 바 보정 타당성 게이트 (v3.0.2) — 거짓성공 보정 / 보정값 유실 / 텍스트 폴백 오염 수정 검증.
 *
 * 실측 근거(.omc/research/ocr-diagnosis-live.json, 두 번째 findings):
 *  - 사용자 leveldb: mpBarRegion 287x47(과대), mpBarMaxX=277,
 *    mpBarRefColor=rgb(111.49, 91.61, 78.62) — 갈색 UI 패널을 학습한 보정.
 *  - 그 값을 replay 하면 실제 MP=12/235 도 cur=235 (MP 최대값 고착).
 *  - calibrateMpBar 의 raw store.set 은 flush 를 스케줄하지 않아 off-loop 보정이 유실.
 *  - useMpBar=true + 보정 없음 → 텍스트 OCR 폴백("000000" → cur=0)이 tracker 를 오염.
 *
 * 검증 시나리오:
 *  (a) 합성 과대 ROI(287x47, 갈색 패널 + 파란 게이지 밴드) → shrink-to-band 로 정상 보정
 *  (b) 갈색-only ROI / 실측 leveldb 갈색 보정색 → 거부(not_blue) + 로더 무효화
 *  (c) tight ROI(287x12) 정상 보정 회귀
 *  (+) flush 즉시 영속, processMp 텍스트 폴백 입구 차단, no-slash 보수화
 */
import { describe, it, expect } from 'vitest'
import {
  calibrateBar,
  calibrateBarChecked,
  cropRows,
  detectGaugeRowBand,
  barFillToMp,
  isBlueDominant,
  type Rgb
} from '@core/ocr/bar-fill'
import {
  parseRegionString,
  assessNoSlashMp,
  MP_NO_SLASH_CONFIDENCE_PENALTY
} from '@core/ocr/parser'
import type { RgbaImage } from '@core/ocr/types'
import type { AutoDetectState, CaptureRegion } from '@core/domain/storage-schema'
import {
  createAppStore,
  STORAGE_KEY,
  type AppStore,
  type StorageLike
} from '../../src/renderer/src/state/store'

// ── DOM-typed renderer modules (detection → screen-capture/api, logger) ──────
// tsconfig.node.json is intentionally DOM-free ("enforces core purity"), so these
// must NOT enter the node typecheck program. A non-literal specifier defeats tsc
// module resolution; vitest (vite runner) still resolves it at runtime. The small
// structural types below mirror only the surface this test touches.

interface DetectionEventLike {
  region: 'mp' | 'exp' | 'level' | 'adena'
  raw: string | null
  accepted: boolean
  value: unknown
  posterior: number
  source: string
  reason: string
  at: number
}
interface DetectionLike {
  onEvent(fn: (e: DetectionEventLike) => void): () => void
  calibrateMpBar(): Promise<{ ok: boolean; fullColumns?: number; fillColor?: Rgb; note?: string }>
}
interface DetectionCtor {
  new (app: AppStore, capture?: unknown): DetectionLike
}

const rendererDir = '../../src/renderer/src'
const { DetectionController } = (await import(`${rendererDir}/ocr/detection`)) as {
  DetectionController: DetectionCtor
}
const { logger } = (await import(`${rendererDir}/util/logger`)) as {
  logger: { consoleMirror: boolean }
}
logger.consoleMirror = false // keep vitest output readable

// ───────────────────────── synthetic image helpers ──────────────────────────

const PANEL_BROWN: Rgb = { r: 110, g: 92, b: 78 } // 리니지 UI 패널 (실측 학습색과 동일 계열)
const GAUGE_BLUE: Rgb = { r: 40, g: 80, b: 200 }
const EMPTY_TRACK: Rgb = { r: 30, g: 25, b: 20 }
/** 6/6 leveldb 에서 추출한 실제 사용자 보정색 (갈색 — 파란 게이지 불가능). */
const LIVE_BAD_REF: Rgb = { r: 111.49, g: 91.61, b: 78.62 }

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
  const data = img.data as Uint8ClampedArray
  for (let y = y0; y < Math.min(img.height, y0 + h); y++) {
    for (let x = x0; x < Math.min(img.width, x0 + w); x++) {
      const p = (y * img.width + x) * 4
      data[p] = c.r
      data[p + 1] = c.g
      data[p + 2] = c.b
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
  const data = img.data as Uint8ClampedArray
  for (let i = 0; i < img.width * img.height; i++) {
    for (let k = 0; k < 3; k++) {
      const p = i * 4 + k
      data[p] = Math.max(0, Math.min(255, data[p]! + rnd() * amp))
    }
  }
}

const STRIP_Y = 18
const STRIP_H = 12

/** 사용자 환경 재현: 287x47 과대 ROI — 갈색 패널 안에 12px 파란 게이지 밴드(rows 18..29). */
function makeOversizedBarRoi(fillRatio: number): RgbaImage {
  const img = makeImage(287, 47, PANEL_BROWN)
  fillRect(img, 0, STRIP_Y, 287, STRIP_H, EMPTY_TRACK)
  fillRect(img, 0, STRIP_Y, Math.round(287 * fillRatio), STRIP_H, GAUGE_BLUE)
  addNoise(img, 6)
  return img
}

/** 갈색 패널만 있고 게이지가 전혀 없는 과대 ROI (완전히 빗나간 영역). */
function makePanelOnlyRoi(): RgbaImage {
  const img = makeImage(287, 47, PANEL_BROWN)
  addNoise(img, 6)
  return img
}

/** 대조군: 게이지 스트립에 딱 맞는 287x12 ROI. */
function makeTightBarRoi(fillRatio: number): RgbaImage {
  const img = makeImage(287, 12, EMPTY_TRACK)
  fillRect(img, 0, 0, Math.round(287 * fillRatio), 12, GAUGE_BLUE)
  addNoise(img, 6)
  return img
}

// ───────────────────────── DetectionController harness ──────────────────────

interface Harness {
  app: ReturnType<typeof createAppStore>
  mem: Map<string, string>
  writes: string[]
  drain: () => void
}

function makeHarness(adPatch: Partial<AutoDetectState>, maxMp = 235, curMp = 111): Harness {
  const mem = new Map<string, string>()
  const writes: string[] = []
  const storage: StorageLike = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => {
      mem.set(k, v)
      writes.push(k)
    }
  }
  const queue: Array<() => void> = []
  const app = createAppStore({ storage, scheduler: (fn) => queue.push(fn) })
  // raw set (no scheduled flush) so `writes` stays clean for flush assertions
  app.store.set((prev) => ({
    persisted: {
      ...prev.persisted,
      autoDetect: { ...prev.persisted.autoDetect, ...adPatch },
      mpConfig: { ...prev.persisted.mpConfig, maxMp, curMp }
    }
  }))
  return {
    app,
    mem,
    writes,
    drain: () => {
      while (queue.length) queue.shift()!()
    }
  }
}

/** Capture stub routed by "WxH" of the requested region (duck-types ScreenCapture). */
function fakeCapture(byKey: Record<string, RgbaImage | null | (() => RgbaImage | null)>): unknown {
  return {
    hasSource: () => true,
    open: async () => {},
    closeAll: () => {},
    captureRegion: (r: CaptureRegion) => {
      const v = byKey[`${r.width}x${r.height}`]
      return typeof v === 'function' ? v() : (v ?? null)
    },
    captureFull: () => null,
    captureFullDataUrl: () => null
  }
}

const tick = (d: DetectionLike): void => (d as unknown as { tick(): void }).tick()

// ──────────────────────────────── tests ─────────────────────────────────────

describe('(a) 과대 ROI shrink-to-band 보정', () => {
  it('287x47 과대 ROI(갈색 패널+파란 밴드)를 게이지 밴드로 축소해 파란색을 학습한다', () => {
    const img = makeOversizedBarRoi(1.0)
    const check = calibrateBarChecked(img)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    // 검출 밴드 = 합성 스트립 rows 18..29 (±1 허용)
    expect(check.rowBand.y0).toBeGreaterThanOrEqual(STRIP_Y - 1)
    expect(check.rowBand.y0).toBeLessThanOrEqual(STRIP_Y + 1)
    expect(check.rowBand.y1).toBeGreaterThanOrEqual(STRIP_Y + STRIP_H - 1)
    expect(check.rowBand.y1).toBeLessThanOrEqual(STRIP_Y + STRIP_H + 1)
    // 학습된 색은 파란 우세 (갈색 패널이 아님)
    expect(isBlueDominant(check.calibration.fillColor)).toBe(true)
    expect(check.calibration.fillColor.b).toBeGreaterThan(150)
    // 100% 보정: full columns ≈ 287, 자기검증 ratio 0.95~1.0
    expect(check.calibration.fullColumns).toBeGreaterThanOrEqual(280)
    expect(check.calibration.fullColumns).toBeLessThanOrEqual(287)
    expect(check.selfRatio).toBeGreaterThanOrEqual(0.95)
    expect(check.selfRatio).toBeLessThanOrEqual(1.0)
  })

  it('축소 밴드(rowBand)를 적용하면 과대 ROI에서도 MP 추적이 정확하다', () => {
    const check = calibrateBarChecked(makeOversizedBarRoi(1.0))
    expect(check.ok).toBe(true)
    if (!check.ok) return
    for (const ratio of [1.0, 0.6, 0.3, 0.05]) {
      const img = makeOversizedBarRoi(ratio)
      // (1) BarFillOptions.rowBand 경로
      const cur = barFillToMp(img, 235, check.calibration, { rowBand: check.rowBand })
      expect(Math.abs(cur - 235 * ratio)).toBeLessThanOrEqual(10)
      // (2) detection 이 ROI 자체를 축소한 뒤의 경로 (cropRows = 축소 ROI 재캡처와 동일)
      const curShrunk = barFillToMp(cropRows(img, check.rowBand), 235, check.calibration)
      expect(Math.abs(curShrunk - 235 * ratio)).toBeLessThanOrEqual(10)
    }
  })
})

describe('(b) 갈색(비-파랑) 보정 거부 — 실측 leveldb 시나리오', () => {
  it('실측 보정색 rgb(111.5,91.6,78.6)은 isBlueDominant=false (파란 게이지 불가능 색)', () => {
    expect(isBlueDominant(LIVE_BAD_REF)).toBe(false)
    expect(isBlueDominant(GAUGE_BLUE)).toBe(true)
  })

  it('게이지 없는 갈색 패널 ROI는 not_blue로 거부되고 감지색을 알려준다', () => {
    const check = calibrateBarChecked(makePanelOnlyRoi())
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toBe('not_blue')
    expect(check.note).toContain('파란')
    expect(check.note).toContain('감지색')
    expect(check.fillColor).not.toBeNull()
    expect(isBlueDominant(check.fillColor!)).toBe(false)
    // 레거시 래퍼도 동일하게 null (예전엔 "보정 완료 277 cols" 거짓성공)
    expect(calibrateBar(makePanelOnlyRoi())).toBeNull()
    // 갈색 패널엔 파란 밴드가 없으므로 밴드 검출도 null
    expect(detectGaugeRowBand(makePanelOnlyRoi())).toBeNull()
  })

  it('레거시 갈색 보정값(277 cols)이 영속돼 있으면 로더가 무효화해 "보정 필요"가 된다 (cur=235 고착 차단)', () => {
    const barRegion: CaptureRegion = { x: 1776, y: 976, width: 287, height: 47, scaleFactor: 1 }
    const mpRegion: CaptureRegion = { x: 1700, y: 950, width: 79, height: 23, scaleFactor: 1 }
    const h = makeHarness({
      captureMode: 'screen',
      useMpBar: true,
      mpBarRegion: barRegion,
      mpRegion,
      mpBarMaxX: 277,
      mpBarRefColor: { ...LIVE_BAD_REF } // 6/6 leveldb 실측값
    })
    const d = new DetectionController(
      h.app,
      fakeCapture({ '287x47': makeOversizedBarRoi(0.05), '79x23': makeImage(79, 23, EMPTY_TRACK) })
    )
    const events: DetectionEventLike[] = []
    d.onEvent((e) => events.push(e))
    tick(d)
    // 갈색 보정은 무효 → bar-pixel cur=235 도, 텍스트 폴백 cur=0 도 발생하지 않는다
    expect(events).toHaveLength(1)
    expect(events[0]!.region).toBe('mp')
    expect(events[0]!.accepted).toBe(false)
    expect(events[0]!.reason).toBe('calibration_required')
    expect(h.app.get().persisted.mpConfig.curMp).toBe(111) // untouched
  })
})

describe('(c) tight ROI 정상 보정 회귀', () => {
  it('287x12 tight ROI: 보정 성공 + 밴드는 전체 높이 + 추적 정확', () => {
    const check = calibrateBarChecked(makeTightBarRoi(1.0))
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.rowBand).toEqual({ y0: 0, y1: 12 })
    expect(check.calibration.fullColumns).toBeGreaterThanOrEqual(280)
    expect(isBlueDominant(check.calibration.fillColor)).toBe(true)
    expect(check.selfRatio).toBeGreaterThanOrEqual(0.95)
    for (const ratio of [0.6, 0.3]) {
      const cur = barFillToMp(makeTightBarRoi(ratio), 235, check.calibration)
      expect(Math.abs(cur - 235 * ratio)).toBeLessThanOrEqual(10)
    }
  })

  it('가득 차지 않은(30%) tight ROI는 not_full로 거부된다', () => {
    const check = calibrateBarChecked(makeTightBarRoi(0.3))
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toBe('not_full')
  })
})

describe('calibrateMpBar 통합: 보정 → ROI 축소 + 즉시 flush 영속', () => {
  it('과대 ROI 보정 성공 시 mpBarRegion 이 밴드로 축소되고 localStorage 에 즉시 영속된다', async () => {
    const barRegion: CaptureRegion = { x: 1776, y: 976, width: 287, height: 47, scaleFactor: 1 }
    const h = makeHarness({ captureMode: 'screen', useMpBar: true, mpBarRegion: barRegion })
    const d = new DetectionController(h.app, fakeCapture({ '287x47': makeOversizedBarRoi(1.0) }))

    expect(h.writes).toHaveLength(0)
    const res = await d.calibrateMpBar()
    expect(res.ok).toBe(true)
    expect(res.fullColumns).toBeGreaterThanOrEqual(280)
    expect(res.fillColor).toBeDefined()
    expect(isBlueDominant(res.fillColor!)).toBe(true)

    // flush 즉시 영속: 디바운스 스케줄러를 drain 하지 않아도 이미 기록돼 있어야 한다
    // (수정 전: raw store.set 만 → 기록 0회 → off-loop 보정 후 종료 시 유실)
    expect(h.writes.length).toBeGreaterThanOrEqual(1)
    const persisted = JSON.parse(h.mem.get(STORAGE_KEY)!) as {
      autoDetect: {
        mpBarMaxX: number
        mpBarRefColor: Rgb
        mpBarRegion: { x: number; y: number; width: number; height: number }
      }
    }
    expect(persisted.autoDetect.mpBarMaxX).toBeGreaterThanOrEqual(280)
    expect(isBlueDominant(persisted.autoDetect.mpBarRefColor)).toBe(true)
    // shrink-to-band: 47px → 12px 밴드(rows 18..29), y 는 밴드 시작만큼 내려감
    expect(persisted.autoDetect.mpBarRegion.height).toBeGreaterThanOrEqual(STRIP_H - 1)
    expect(persisted.autoDetect.mpBarRegion.height).toBeLessThanOrEqual(STRIP_H + 2)
    expect(persisted.autoDetect.mpBarRegion.y).toBeGreaterThanOrEqual(976 + STRIP_Y - 1)
    expect(persisted.autoDetect.mpBarRegion.y).toBeLessThanOrEqual(976 + STRIP_Y + 1)
    expect(persisted.autoDetect.mpBarRegion.width).toBe(287)
  })

  it('갈색 ROI 보정은 거부되고 아무 보정값도 저장하지 않는다', async () => {
    const barRegion: CaptureRegion = { x: 1776, y: 976, width: 287, height: 47, scaleFactor: 1 }
    const h = makeHarness({ captureMode: 'screen', useMpBar: true, mpBarRegion: barRegion })
    const d = new DetectionController(h.app, fakeCapture({ '287x47': makePanelOnlyRoi() }))

    const res = await d.calibrateMpBar()
    expect(res.ok).toBe(false)
    expect(res.note).toContain('파란')
    expect(res.fillColor).toBeDefined() // UX 스와치용 감지색 동봉
    h.drain()
    const raw = h.mem.get(STORAGE_KEY)
    const maxX = raw ? (JSON.parse(raw) as { autoDetect: { mpBarMaxX: number } }).autoDetect.mpBarMaxX : 0
    expect(maxX).toBe(0)
    expect(h.app.get().persisted.autoDetect.mpBarRegion).toEqual(barRegion) // ROI 도 무변경
  })
})

describe('processMp: 텍스트 폴백 입구 차단 + bar-pixel 정상 경로', () => {
  it('useMpBar=true + 보정 없음 → 텍스트 OCR 을 tracker 에 넣지 않고 calibration_required 만 노출', () => {
    const mpRegion: CaptureRegion = { x: 0, y: 0, width: 79, height: 23, scaleFactor: 1 }
    const barRegion: CaptureRegion = { x: 0, y: 30, width: 287, height: 12, scaleFactor: 1 }
    const h = makeHarness({ captureMode: 'screen', useMpBar: true, mpRegion, mpBarRegion: barRegion })
    let textCaptured = 0
    const d = new DetectionController(
      h.app,
      fakeCapture({
        '287x12': makeTightBarRoi(0.5),
        '79x23': () => {
          textCaptured++
          return makeImage(79, 23, EMPTY_TRACK)
        }
      })
    )
    const events: DetectionEventLike[] = []
    d.onEvent((e) => events.push(e))
    for (let i = 0; i < 3; i++) tick(d)
    expect(events).toHaveLength(3)
    for (const e of events) {
      expect(e.region).toBe('mp')
      expect(e.accepted).toBe(false)
      expect(e.reason).toBe('calibration_required')
      expect(e.value).toBeNull()
    }
    expect(textCaptured).toBe(0) // 입구 차단: 텍스트 ROI 캡처/인식 자체가 일어나지 않음
    expect(h.app.get().persisted.mpConfig.curMp).toBe(111)
  })

  it('유효한 파란 보정이면 bar-pixel 경로로 MP 가 정상 추적된다 (3틱 부트스트랩)', () => {
    const barRegion: CaptureRegion = { x: 0, y: 30, width: 287, height: 12, scaleFactor: 1 }
    const cal = calibrateBarChecked(makeTightBarRoi(1.0))
    expect(cal.ok).toBe(true)
    if (!cal.ok) return
    const h = makeHarness({
      captureMode: 'screen',
      useMpBar: true,
      mpBarRegion: barRegion,
      mpBarMaxX: cal.calibration.fullColumns,
      mpBarRefColor: cal.calibration.fillColor
    })
    const d = new DetectionController(h.app, fakeCapture({ '287x12': makeTightBarRoi(0.5) }))
    const events: DetectionEventLike[] = []
    d.onEvent((e) => events.push(e))
    for (let i = 0; i < 3; i++) tick(d) // MP init consistency = 3
    expect(events[2]!.accepted).toBe(true)
    expect(events[2]!.source).toBe('bar-pixel')
    const cur = h.app.get().persisted.mpConfig.curMp
    expect(Math.abs(cur - 235 * 0.5)).toBeLessThanOrEqual(8)
  })
})

describe('parseMp no-slash 보수화', () => {
  it('컨텍스트 없으면 기존 동작 유지 (cur-only)', () => {
    expect(parseRegionString('mp', '000000')).toEqual({ kind: 'mp', cur: 0, max: 0 })
    expect(parseRegionString('mp', '230')).toEqual({ kind: 'mp', cur: 230, max: 0 })
  })

  it('maxMp 컨텍스트가 있으면 cur > maxMp×2 인 no-slash 파싱을 무효화 (픽스처 "6610068380" 케이스)', () => {
    expect(parseRegionString('mp', '6610068380', { maxMp: 235 })).toBeNull()
    expect(parseRegionString('mp', '471', { maxMp: 235 })).toBeNull() // 경계 초과 (470+1)
    expect(parseRegionString('mp', '470', { maxMp: 235 })).toEqual({ kind: 'mp', cur: 470, max: 0 })
    expect(parseRegionString('mp', '000000', { maxMp: 235 })).toEqual({ kind: 'mp', cur: 0, max: 0 })
  })

  it('슬래시 형식은 컨텍스트와 무관하게 기존 검증 유지', () => {
    expect(parseRegionString('mp', '121/235', { maxMp: 99 })).toEqual({ kind: 'mp', cur: 121, max: 235 })
  })

  it('assessNoSlashMp: 황당값은 ok=false, 그 외엔 confidence 감점', () => {
    expect(assessNoSlashMp(6610068380, 0.66, 235).ok).toBe(false)
    const kept = assessNoSlashMp(120, 0.66, 235)
    expect(kept.ok).toBe(true)
    expect(kept.confidence).toBeCloseTo(0.66 * MP_NO_SLASH_CONFIDENCE_PENALTY, 5)
    // maxMp 미상(0)이어도 감점은 적용 — "000000" conf 0.66 → 0.396 (<0.5 init 게이트권)
    const unknownMax = assessNoSlashMp(0, 0.66, 0)
    expect(unknownMax.ok).toBe(true)
    expect(unknownMax.confidence).toBeCloseTo(0.396, 3)
  })
})
