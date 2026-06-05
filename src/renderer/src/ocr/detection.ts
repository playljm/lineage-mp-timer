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
import { detectGameUiScaled, type TextRoi } from '@core/ocr/roi-detector'
import type { AutoDetectState, CaptureRegion, WindowRoiBox } from '@core/domain/storage-schema'
import { ScreenCapture } from '../capture/screen-capture'
import { api } from '../platform/api'
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

/**
 * Auto-derived ROIs for window-capture mode. Kept in MEMORY (not the persisted
 * store) because they are ephemeral, window-relative and re-derived each session —
 * persisting them would poison the user's manual screen-mode regions on a mode
 * switch and thrash localStorage every refresh.
 */
interface WindowRois {
  mp: CaptureRegion | null
  mpBar: CaptureRegion | null
  exp: CaptureRegion | null
  level: CaptureRegion | null
  adena: CaptureRegion | null
}

/** Cheap sampled mean luminance — detects an all-black frame (fullscreen-exclusive / unpainted). */
function frameMeanLuma(img: RgbaImage): number {
  const { width, height, data } = img
  const step = Math.max(1, Math.floor((width * height) / 4096)) // ~4k samples max
  let sum = 0
  let n = 0
  for (let p = 0; p < width * height; p += step) {
    const i = p * 4
    sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
    n++
  }
  return n ? sum / n : 0
}

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

  // ── window-capture mode state ──────────────────────────────────────────────
  /** Live (re-resolved) window capture source id, or null in screen mode. */
  private windowSourceId: string | null = null
  /** Epoch ms of the last successful auto-ROI detection (cache freshness). */
  private roiResolvedAt = 0
  /** Consecutive auto-ROI detection failures (gated by roiFailThreshold). */
  private roiFailCount = 0
  /** Epoch ms of the last window re-resolution attempt (throttle). */
  private resolveRetryAt = 0
  /** In-memory auto-derived ROIs for window mode (never persisted). */
  private windowRois: WindowRois | null = null

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
    // Window mode uses the in-memory auto-derived ROIs, not the persisted (screen) regions.
    if (ad.captureMode === 'window' && this.windowRois) {
      return region === 'mp'
        ? this.windowRois.mp
        : region === 'exp'
          ? this.windowRois.exp
          : region === 'level'
            ? this.windowRois.level
            : this.windowRois.adena
    }
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
    const barRegion = ad.captureMode === 'window' ? this.windowRois?.mpBar ?? null : ad.mpBarRegion
    if (!barRegion) {
      logger.warn('calib', 'MP 바 영역이 지정되지 않았습니다')
      return {
        ok: false,
        note: ad.captureMode === 'window' ? '자동 인식을 먼저 시작해 MP 바를 검출하세요' : 'MP 바 영역을 먼저 지정하세요'
      }
    }
    const img = await this.captureRegion(barRegion)
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
    this.windowSourceId = null
    this.roiResolvedAt = 0
    this.roiFailCount = 0
    this.resolveRetryAt = 0
    this.windowRois = null

    if (ad.captureMode === 'window') {
      // Window ids (window:HWND:0) change every game restart, so always re-resolve
      // the current source by the saved title before opening.
      const ok = await this.openWindowSource(ad.windowTitle ?? '')
      if (!ok) {
        logger.warn('detect', 'window-mode: 게임 창을 찾지 못함 — 설정에서 게임 창을 선택하세요 (최소화/종료 상태?)')
      }
    } else {
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
    }

    this.running = true
    const interval = Math.max(300, ad.intervalMs)
    this.timer = window.setInterval(() => this.tick(), interval)
    logger.info('detect', 'loop running', {
      captureMode: ad.captureMode,
      windowSource: !!this.windowSourceId,
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
    this.windowSourceId = null
    this.windowRois = null
    this.running = false
    logger.info('detect', 'stopped')
  }

  /** Whether a live window capture source is currently resolved (window mode). */
  hasWindowSource(): boolean {
    return !!this.windowSourceId
  }

  /**
   * Capture the game window's full frame as a PNG data URL + its physical size, for
   * the manual ROI editor. Resolves/opens the window source on demand (so it works
   * even while detection is stopped) and retries briefly until the first frame is
   * painted. Returns null when no window is matched or no frame arrives.
   */
  async captureWindowFrame(): Promise<{ dataUrl: string; width: number; height: number } | null> {
    const ad = this.app.get().persisted.autoDetect
    if (!this.windowSourceId) {
      const ok = await this.openWindowSource(ad.windowTitle ?? '')
      if (!ok) return null
    }
    const sid = this.windowSourceId
    if (!sid) return null
    for (let i = 0; i < 8; i++) {
      const frame = this.capture.captureFullDataUrl(sid)
      if (frame) return frame
      await new Promise((r) => setTimeout(r, 150))
    }
    return null
  }

  /** Force the window-mode ROIs to be re-derived on the next tick (e.g. after an
   *  ROI override changed) instead of waiting out the cache window. */
  forceRoiRefresh(): void {
    this.roiResolvedAt = 0
    this.roiFailCount = 0
  }

  /**
   * Re-resolve the game window's CURRENT capture source by title and open it.
   * Persists the fresh (volatile) id + auto-matched title for diagnostics/next run.
   */
  private async openWindowSource(title: string): Promise<boolean> {
    try {
      const resolved = await api.resolveWindowSource(title)
      if (!resolved) return false
      await this.capture.open(resolved.sourceId)
      this.windowSourceId = resolved.sourceId
      this.app.store.set((prev) => ({
        persisted: {
          ...prev.persisted,
          autoDetect: {
            ...prev.persisted.autoDetect,
            windowId: resolved.sourceId,
            windowTitle: prev.persisted.autoDetect.windowTitle || resolved.title
          }
        }
      }))
      logger.info('detect', `window source resolved: "${resolved.title}" (${resolved.sourceId.slice(0, 24)}…)`)
      return true
    } catch (err) {
      logger.error('detect', `resolveWindowSource failed: ${String(err)}`)
      return false
    }
  }

  /**
   * Window mode: capture the whole game-window frame and auto-derive the MP/EXP/
   * level/adena ROIs via the scale-normalized detector, holding them IN MEMORY
   * (`this.windowRois`, window-frame physical px, scaleFactor=1). Cached for
   * `roiCacheMaxAge`; keeps the last good ROIs on a single miss. After
   * `roiFailThreshold` consecutive misses it drops the cache and forces a window
   * re-resolution (handles the game being closed/minimized/relaunched). Returns
   * whether usable ROIs are available after the call.
   */
  private ensureWindowRois(ad: AutoDetectState, now: number): boolean {
    const sid = this.windowSourceId
    if (!sid) return false
    const have = !!(this.windowRois && this.windowRois.mp && this.windowRois.exp && this.windowRois.level)
    const maxAgeMs = Math.max(5, ad.roiCacheMaxAge) * 1000
    if (have && now - this.roiResolvedAt < maxAgeMs) return true

    const frame = this.capture.captureFull(sid)
    if (!frame) return this.registerRoiFailure(ad, 'noframe', have)
    if (frameMeanLuma(frame) < 6) return this.registerRoiFailure(ad, 'black', have)

    const result = detectGameUiScaled(frame)
    const adapt = (r: TextRoi | null): CaptureRegion | null =>
      r ? { x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, sourceId: sid, scaleFactor: 1 } : null
    // Manual ROI overrides (window-frame px) take precedence over auto-detection.
    const ov = ad.windowRoi
    const fromBox = (b: WindowRoiBox | null): CaptureRegion | null =>
      b ? { x: b.x, y: b.y, width: b.width, height: b.height, sourceId: sid, scaleFactor: 1 } : null

    const mp = fromBox(ov.mp) ?? adapt(result.textRois.mp)
    const exp = fromBox(ov.exp) ?? adapt(result.textRois.exp)
    const level = fromBox(ov.level) ?? adapt(result.textRois.level)
    const adena = fromBox(ov.adena) ?? adapt(result.textRois.adena)

    // MP BAR region: prefer a manual override; else the blue-FILL anchor only spans
    // the currently-filled portion of a left-to-right gauge, so widen to the full
    // track (≈ HP bar width) — the v1.4.3 pitfall fix. Once a calibration exists,
    // freeze the geometry so it stays matched to the calibrated columns.
    const mpAnchor = result.anchors.mp
    const hpAnchor = result.anchors.hp
    const calibrated = ad.mpBarMaxX > 0 && !!this.windowRois?.mpBar
    const autoMpBar: CaptureRegion | null = calibrated
      ? this.windowRois!.mpBar
      : mpAnchor
        ? {
            x: mpAnchor.x,
            y: mpAnchor.y,
            width: Math.max(mpAnchor.width, hpAnchor ? hpAnchor.width : 0),
            height: mpAnchor.height,
            sourceId: sid,
            scaleFactor: 1
          }
        : (this.windowRois?.mpBar ?? null)
    const mpBar = fromBox(ov.mpBar) ?? autoMpBar

    if (!mp && !exp && !level && !adena) {
      return this.registerRoiFailure(ad, 'noanchor', have, result.issues)
    }

    const prev = this.windowRois
    this.windowRois = {
      mp: mp ?? prev?.mp ?? null,
      mpBar,
      exp: exp ?? prev?.exp ?? null,
      level: level ?? prev?.level ?? null,
      adena: adena ?? prev?.adena ?? null
    }
    this.roiFailCount = 0
    this.roiResolvedAt = now
    logger.info(
      'cap:roi',
      `window-mode ROI 검출 OK${result.valid ? '' : ' (부분)'} — mp=${!!mp} exp=${!!exp} lv=${!!level} adena=${!!adena} (frame ${frame.width}x${frame.height})`
    )
    return true
  }

  /**
   * Record an auto-ROI miss. Logs the cause; after `roiFailThreshold` consecutive
   * misses, drops the cached ROIs and the window source so the next ticks
   * re-resolve the window (self-heal when the game is relaunched). Returns the
   * `had` flag so callers can keep serving last-good ROIs until the threshold.
   */
  private registerRoiFailure(
    ad: AutoDetectState,
    kind: 'noframe' | 'black' | 'noanchor',
    had: boolean,
    issues?: string[]
  ): boolean {
    this.roiFailCount++
    const detail =
      kind === 'black'
        ? '검은 화면 — 전체화면 독점 모드? 창/테두리없음 모드로 실행하세요'
        : kind === 'noframe'
          ? '프레임 미준비 (게임 창 최소화?)'
          : `ROI 미검출 — ${(issues ?? []).slice(0, 3).join(' / ')}`
    logger.warn('cap:roi', `window-mode 실패 ${this.roiFailCount}/${Math.max(1, ad.roiFailThreshold)}: ${detail}`)
    if (this.roiFailCount >= Math.max(1, ad.roiFailThreshold)) {
      this.roiFailCount = 0
      this.windowRois = null
      this.windowSourceId = null // force re-resolution on subsequent ticks
      logger.warn('cap:roi', 'window-mode: 임계 초과 — 게임 창 재탐색 (창을 복원/실행했는지 확인)')
    }
    return had && !!this.windowRois
  }

  /** Throttled (3s) fire-and-forget window re-resolution while no source is bound. */
  private maybeReresolveWindow(ad: AutoDetectState, now: number): void {
    if (now - this.resolveRetryAt < 3000) return
    this.resolveRetryAt = now
    void this.openWindowSource(ad.windowTitle ?? '')
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

    if (ad.captureMode === 'window') {
      if (!this.windowSourceId) {
        // No bound window (initial resolve failed or game lost) — keep retrying so
        // detection self-heals when the game launches/restores, instead of spinning.
        this.maybeReresolveWindow(ad, now)
        return
      }
      this.ensureWindowRois(ad, now)
      const r = this.windowRois
      this.processMp({ mpRegion: r?.mp ?? null, mpBarRegion: r?.mpBar ?? null }, ad.useMpBar, this.barCalibration(ad), maxMp, now)
      if (r?.exp) this.processNumeric('exp', r.exp, now)
      if (r?.level) this.processNumeric('level', r.level, now)
      if (r?.adena) this.processNumeric('adena', r.adena, now)
      return
    }

    // Screen mode: read the user-picked regions from the store.
    this.processMp({ mpRegion: ad.mpRegion, mpBarRegion: ad.mpBarRegion }, ad.useMpBar, this.barCalibration(ad), maxMp, now)
    if (ad.expRegion) this.processNumeric('exp', ad.expRegion, now)
    if (ad.levelRegion) this.processNumeric('level', ad.levelRegion, now)
    if (ad.adenaRegion) this.processNumeric('adena', ad.adenaRegion, now)
  }

  private barCalibration(ad: AutoDetectState): BarCalibration | null {
    if (!ad.useMpBar || ad.mpBarMaxX <= 0 || !ad.mpBarRefColor) return null
    return { fullColumns: ad.mpBarMaxX, fillColor: ad.mpBarRefColor }
  }

  private processMp(
    regions: { mpRegion: CaptureRegion | null; mpBarRegion: CaptureRegion | null },
    useMpBar: boolean,
    cal: BarCalibration | null,
    maxMp: number,
    now: number
  ): void {
    const barImage = useMpBar && regions.mpBarRegion ? this.capture.captureRegion(regions.mpBarRegion) : null
    const textImage = regions.mpRegion ? this.capture.captureRegion(regions.mpRegion) : null
    if (!barImage && !textImage) {
      logger.warn('cap:mp', 'no MP capture (region null or frame not ready)')
      return
    }
    if (useMpBar && !cal) {
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
