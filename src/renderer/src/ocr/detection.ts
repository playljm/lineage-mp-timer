/**
 * Live detection loop. Each tick crops the configured ROIs, runs the canvas-free
 * recognizer (bar-pixel for MP, user/base templates otherwise), passes the value
 * through the AUTHORITATIVE temporal tracker, and only commits accepted values to
 * the store. This is where the renewed OCR core meets the running app.
 *
 * Source of truth is the store — never a DOM input (the v2.x DOM-as-anchor
 * anti-pattern is gone). A `force`d tracker observe is used when the user types a
 * value manually, so manual corrections always win.
 */
import baseTemplatesData from '@core/ocr/base-templates.json'
import {
  deserializeTemplates,
  serializeTemplates,
  type SerializedTemplateSet,
  type TemplateSet
} from '@core/ocr/template-matcher'
import { recognizeRegion } from '@core/ocr/recognizer'
import { createRegionTrackers, type RegionTrackers } from '@core/ocr/tracker'
import { learnFromCapture } from '@core/ocr/learn'
import type { ParsedValue, RegionKind, RgbaImage } from '@core/ocr/types'
import { calibrateBar, type BarCalibration } from '@core/ocr/bar-fill'
import type { AutoDetectState, CaptureRegion } from '@core/domain/storage-schema'
import { ScreenCapture } from '../capture/screen-capture'
import type { AppStore } from '../state/store'
import { logger } from '../util/logger'

const baseTemplates: TemplateSet = deserializeTemplates(
  baseTemplatesData as unknown as SerializedTemplateSet
)

const USER_TEMPLATE_KEY = 'lmp.userTemplates.v3'

export interface DetectionEvent {
  region: 'mp' | 'exp' | 'level' | 'adena'
  raw: string | null
  accepted: boolean
  value: ParsedValue | null
  posterior: number
  source: string
  reason: string
  at: number
}

export type DetectionListener = (e: DetectionEvent) => void

function loadUserTemplates(): TemplateSet | null {
  try {
    const raw = localStorage.getItem(USER_TEMPLATE_KEY)
    if (!raw) return null
    return deserializeTemplates(JSON.parse(raw) as SerializedTemplateSet)
  } catch {
    return null
  }
}

export class DetectionController {
  private readonly capture = new ScreenCapture()
  private readonly trackers: RegionTrackers = createRegionTrackers()
  private readonly listeners = new Set<DetectionListener>()
  private timer: number | null = null
  private userTemplates: TemplateSet | null = loadUserTemplates()
  private latest: { exp: number; level: number; adena: number }
  running = false

  constructor(private readonly app: AppStore) {
    const t = app.get().persisted.tracker.current
    this.latest = { exp: t.exp, level: t.level, adena: t.adena }
  }

  onEvent(fn: DetectionListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: DetectionEvent): void {
    for (const fn of [...this.listeners]) fn(e)
  }

  reloadUserTemplates(): void {
    this.userTemplates = loadUserTemplates()
  }

  /** Force a manually-entered value into the tracker so OCR cannot overwrite it. */
  forceValue(region: DetectionEvent['region'], value: ParsedValue, nowMs: number): void {
    if (region === 'mp' && value.kind === 'mp') {
      this.trackers.mp.observe({ cur: value.cur, max: value.max }, 1, nowMs, { force: true })
    } else if (region === 'exp' && value.kind === 'exp') {
      this.trackers.exp.observe(value.pct, 1, nowMs, { force: true })
      this.latest.exp = value.pct
    } else if (region === 'level' && value.kind === 'level') {
      this.trackers.level.observe(value.level, 1, nowMs, { force: true })
      this.latest.level = value.level
    } else if (region === 'adena' && value.kind === 'adena') {
      this.trackers.adena.observe(value.amount, 1, nowMs, { force: true })
      this.latest.adena = value.amount
    }
  }

  /** Capture one region, opening its source on demand (for calibrate/learn off-loop). */
  async captureRegion(region: CaptureRegion): Promise<RgbaImage | null> {
    if (region.sourceId && !this.capture.hasSource(region.sourceId)) {
      try {
        await this.capture.open(region.sourceId)
      } catch (err) {
        logger.error('capture', `source open failed: ${String(err)}`)
        return null
      }
    }
    return this.capture.captureRegion(region)
  }

  private regionFor(region: RegionKind): CaptureRegion | null {
    const ad = this.app.get().persisted.autoDetect
    return region === 'mp'
      ? ad.mpRegion
      : region === 'exp'
        ? ad.expRegion
        : region === 'level'
          ? ad.levelRegion
          : ad.adenaRegion
  }

  /** Calibrate the MP bar at 100% MP: stores fill column count + reference colour. */
  async calibrateMpBar(): Promise<{ ok: boolean; fullColumns?: number; note?: string }> {
    const ad = this.app.get().persisted.autoDetect
    if (!ad.mpBarRegion) {
      logger.warn('calib', 'MP 바 영역이 지정되지 않았습니다')
      return { ok: false, note: 'MP 바 영역을 먼저 지정하세요' }
    }
    const img = await this.captureRegion(ad.mpBarRegion)
    if (!img) {
      logger.warn('calib', 'MP 바 캡처 실패')
      return { ok: false, note: 'MP 바 캡처 실패' }
    }
    const cal = calibrateBar(img)
    if (!cal) {
      logger.warn('calib', 'MP 바 보정 실패 — 게이지가 가득 찬 상태인지 확인하세요')
      return { ok: false, note: '게이지가 가득 찬 상태(100%)에서 보정하세요' }
    }
    this.app.store.set((prev) => ({
      persisted: {
        ...prev.persisted,
        autoDetect: { ...prev.persisted.autoDetect, mpBarMaxX: cal.fullColumns, mpBarRefColor: cal.fillColor }
      }
    }))
    logger.info(
      'calib',
      `MP 바 보정 완료: ${cal.fullColumns} cols · rgb(${Math.round(cal.fillColor.r)},${Math.round(cal.fillColor.g)},${Math.round(cal.fillColor.b)})`
    )
    return { ok: true, fullColumns: cal.fullColumns }
  }

  /** Teach the user's own glyphs for a region from its true value. */
  async learnRegion(region: RegionKind, label: string): Promise<{ ok: boolean; learned: number; note?: string }> {
    const roi = this.regionFor(region)
    if (!roi) return { ok: false, learned: 0, note: `${region} 영역 미지정` }
    const img = await this.captureRegion(roi)
    if (!img) return { ok: false, learned: 0, note: '캡처 실패' }
    const result = learnFromCapture(region, img, label, this.userTemplates)
    if (!result.ok) {
      logger.warn('learn', `${region} 학습 실패: ${result.note}`)
      return { ok: false, learned: 0, note: result.note }
    }
    this.userTemplates = result.set
    try {
      localStorage.setItem(USER_TEMPLATE_KEY, JSON.stringify(serializeTemplates(result.set)))
    } catch (err) {
      logger.error('learn', `저장 실패: ${String(err)}`)
    }
    logger.info('learn', `${region} 학습 완료: "${label}" (${result.learned} glyphs)`)
    return { ok: true, learned: result.learned }
  }

  async start(): Promise<void> {
    const ad = this.app.get().persisted.autoDetect
    const ids = this.sourceIds(ad)
    logger.info('detect', `start: opening ${ids.length} source(s)`, { sourceIds: ids, intervalMs: ad.intervalMs })
    if (ids.length === 0) {
      logger.warn('detect', 'no capture sources — regions have no sourceId (재지정 필요?)')
    }
    for (const id of ids) {
      try {
        await this.capture.open(id)
        logger.info('detect', `source opened ok: ${id.slice(0, 24)}…`)
      } catch (err) {
        logger.error('detect', `source open FAILED: ${id.slice(0, 24)}…`, String(err))
      }
    }
    this.running = true
    const interval = Math.max(300, ad.intervalMs)
    this.timer = window.setInterval(() => this.tick(), interval)
    logger.info('detect', 'loop running', {
      regions: {
        mp: !!ad.mpRegion,
        mpBar: !!ad.mpBarRegion,
        useMpBar: ad.useMpBar,
        exp: !!ad.expRegion,
        level: !!ad.levelRegion,
        adena: !!ad.adenaRegion
      }
    })
  }

  stop(): void {
    if (this.timer != null) window.clearInterval(this.timer)
    this.timer = null
    this.capture.closeAll()
    this.running = false
    logger.info('detect', 'stopped')
  }

  private sourceIds(ad: AutoDetectState): string[] {
    const ids = new Set<string>()
    for (const r of [ad.mpRegion, ad.mpBarRegion, ad.expRegion, ad.levelRegion, ad.adenaRegion, ad.gameRegion]) {
      if (r?.sourceId) ids.add(r.sourceId)
    }
    return [...ids]
  }

  private tick(): void {
    const state = this.app.get().persisted
    const ad = state.autoDetect
    const now = Date.now()
    const maxMp = state.mpConfig.maxMp

    this.processMp(ad, maxMp, now)
    if (ad.expRegion) this.processNumeric('exp', ad.expRegion, now)
    if (ad.levelRegion) this.processNumeric('level', ad.levelRegion, now)
    if (ad.adenaRegion) this.processNumeric('adena', ad.adenaRegion, now)
  }

  private barCalibration(ad: AutoDetectState): BarCalibration | null {
    if (!ad.useMpBar || ad.mpBarMaxX <= 0 || !ad.mpBarRefColor) return null
    return { fullColumns: ad.mpBarMaxX, fillColor: ad.mpBarRefColor }
  }

  private processMp(ad: AutoDetectState, maxMp: number, now: number): void {
    const cal = this.barCalibration(ad)
    const barImage = ad.useMpBar && ad.mpBarRegion ? this.capture.captureRegion(ad.mpBarRegion) : null
    const textImage = ad.mpRegion ? this.capture.captureRegion(ad.mpRegion) : null
    if (!barImage && !textImage) {
      logger.warn('cap:mp', 'no MP capture (region null or frame not ready)')
      return
    }
    if (ad.useMpBar && !cal) {
      logger.warn('ocr:mp', 'MP 바 픽셀 모드 ON 이지만 보정(calibration) 없음 → 텍스트 OCR로 폴백 (100% MP에서 보정 필요)')
    }

    const result = recognizeRegion(
      {
        region: 'mp',
        image: textImage ?? barImage!,
        barImage: barImage ?? undefined,
        maxMp,
        barCalibration: cal ?? undefined
      },
      { baseTemplates, userTemplates: this.userTemplates }
    )

    const dims = `${(textImage ?? barImage)!.width}x${(textImage ?? barImage)!.height}`
    if (result.value?.kind === 'mp') {
      const v = result.value
      const verdict = this.trackers.mp.observe({ cur: v.cur, max: v.max || maxMp }, result.confidence, now)
      if (verdict.accepted && verdict.value) {
        this.app.setMpConfig({ curMp: verdict.value.cur })
      }
      logger.debug('ocr:mp', `[${dims}] raw="${result.raw}" src=${result.source} conf=${result.confidence.toFixed(2)} → ${verdict.accepted ? 'ACCEPT' : 'reject'} cur=${verdict.value?.cur} post=${verdict.posterior.toFixed(2)} (${verdict.reason})`)
      this.emit({ region: 'mp', raw: result.raw, accepted: verdict.accepted, value: result.value, posterior: verdict.posterior, source: result.source, reason: verdict.reason, at: now })
    } else {
      logger.debug('ocr:mp', `[${dims}] raw="${result.raw}" src=${result.source} → parse FAIL`)
      this.emit({ region: 'mp', raw: result.raw, accepted: false, value: null, posterior: 0, source: result.source, reason: 'reject', at: now })
    }
  }

  private processNumeric(region: 'exp' | 'level' | 'adena', roi: CaptureRegion, now: number): void {
    const image = this.capture.captureRegion(roi)
    if (!image) {
      logger.warn(`cap:${region}`, 'no capture (frame not ready / sourceId invalid)')
      return
    }
    const result = recognizeRegion({ region, image }, { baseTemplates, userTemplates: this.userTemplates })
    const value = result.value
    const dims = `${image.width}x${image.height}`

    let accepted = false
    let posterior = 0
    let reason = 'reject'

    if (value?.kind === 'exp') {
      const verdict = this.trackers.exp.observe(value.pct, result.confidence, now)
      accepted = verdict.accepted
      posterior = verdict.posterior
      reason = verdict.reason
      if (accepted && verdict.value != null) this.latest.exp = verdict.value
    } else if (value?.kind === 'level') {
      const verdict = this.trackers.level.observe(value.level, result.confidence, now)
      accepted = verdict.accepted
      posterior = verdict.posterior
      reason = verdict.reason
      if (accepted && verdict.value != null) this.latest.level = verdict.value
    } else if (value?.kind === 'adena') {
      const verdict = this.trackers.adena.observe(value.amount, result.confidence, now)
      accepted = verdict.accepted
      posterior = verdict.posterior
      reason = verdict.reason
      if (accepted && verdict.value != null) this.latest.adena = verdict.value
    }

    if (accepted) {
      this.app.ingestSample({ t: now, expPct: this.latest.exp, adena: this.latest.adena, level: this.latest.level })
    }
    logger.debug(
      `ocr:${region}`,
      `[${dims}] raw="${result.raw}" src=${result.source} conf=${result.confidence.toFixed(2)} → ${accepted ? 'ACCEPT' : 'reject'} post=${posterior.toFixed(2)} (${reason})`
    )
    this.emit({ region, raw: result.raw, accepted, value, posterior, source: result.source, reason, at: now })
  }
}
