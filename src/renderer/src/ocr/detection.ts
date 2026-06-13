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
import {
  calibrateBarChecked,
  computeBarFill,
  isBlueDominant,
  solveLeftOffsetFrac,
  type BarCalibration,
  type BarCalibrationFailure,
  type Rgb,
  type RowBand
} from '@core/ocr/bar-fill'
import { assessNoSlashMp, MP_NO_SLASH_MAX_FACTOR } from '@core/ocr/parser'
import { detectGameUiScaled, type TextRoi } from '@core/ocr/roi-detector'
import type { AutoDetectState, CaptureRegion, WindowRoiBox } from '@core/domain/storage-schema'
import { ScreenCapture } from '../capture/screen-capture'
import { api } from '../platform/api'
import type { AppStore } from '../state/store'
import { logger } from '../util/logger'

const baseTemplates: TemplateSet = deserializeTemplates(
  baseTemplatesData as unknown as SerializedTemplateSet
)

/** localStorage key holding the user's learned/imported templates (shared with the settings import UI). */
export const USER_TEMPLATE_KEY = 'lmp.userTemplates.v3'

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

/**
 * Encode an RgbaImage as a PNG data URL via an offscreen canvas. Renderer-only;
 * returns null in DOM-less environments (node vitest) or on any canvas failure —
 * callers treat the data URL as best-effort.
 */
function rgbaToPngDataUrl(img: RgbaImage): string | null {
  if (typeof document === 'undefined') return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

export class DetectionController {
  private readonly capture: ScreenCapture
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

  /** `capture` is injectable for tests (node env has no DOM for ScreenCapture). */
  constructor(
    private readonly app: AppStore,
    capture?: ScreenCapture
  ) {
    this.capture = capture ?? new ScreenCapture()
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

  /**
   * Calibrate the MP bar at 100% MP: stores fill column count + reference colour.
   * v3.0.2: validity-gated (blue-dominance + shrink-to-band + self-check) so an
   * oversized/misplaced ROI can no longer produce a false-success calibration that
   * pins MP at max, and the result is flushed immediately (an off-loop calibrate →
   * app close used to silently lose the calibration).
   */
  async calibrateMpBar(): Promise<{
    ok: boolean
    fullColumns?: number
    fillColor?: Rgb
    note?: string
    /** v3.1.1: 실패 사유 — UI 가 reason 별 다음 행동(영역 재지정/재보정)을 안내한다. */
    reason?: BarCalibrationFailure | 'no_region' | 'capture_fail'
    /** v3.1.1: 자기검증 비율(성공 시) — 0.95~1.0 밖이면 selfOk=false 로 재보정 권고. */
    selfRatio?: number
    selfOk?: boolean
  }> {
    const ad = this.app.get().persisted.autoDetect
    let barRegion: CaptureRegion | null
    if (ad.captureMode === 'window') {
      // v3.1.1: bind a window source on demand so calibration works with the loop
      // stopped (a valid manual override used to fail with "start auto-detection").
      if (!this.windowSourceId && ad.windowTitle) {
        await this.openWindowSource(ad.windowTitle)
      }
      const sid = this.windowSourceId
      const ov = ad.windowRoi.mpBar
      if (sid && ov) {
        // Prefer the PERSISTED manual override over the in-memory cache.
        // forceRoiRefresh() after an ROI save only marks the cache stale — the
        // rebuild happens on the NEXT tick — so calibrating right after drawing the
        // box used to capture the OLD region (the 6/7 field pattern: correct ROI
        // saved, gold trim measured). Mirror the fresh region into the cache so the
        // shrink-to-band update below operates on the same geometry we captured.
        barRegion = { x: ov.x, y: ov.y, width: ov.width, height: ov.height, sourceId: sid, scaleFactor: 1 }
        if (this.windowRois) this.windowRois = { ...this.windowRois, mpBar: barRegion }
      } else {
        barRegion = this.windowRois?.mpBar ?? null
      }
    } else {
      barRegion = ad.mpBarRegion
    }
    if (!barRegion) {
      logger.warn('calib', 'MP 바 영역이 지정되지 않았습니다')
      return {
        ok: false,
        reason: 'no_region',
        note:
          ad.captureMode === 'window'
            ? '자동 인식을 시작하거나 「영역 직접 지정」으로 MP 바를 지정하세요'
            : 'MP 바 영역을 먼저 지정하세요'
      }
    }
    let img = await this.captureRegion(barRegion)
    // Cold-open first-frame race: right after an on-demand openWindowSource the
    // <video> may not have painted yet (videoWidth 0 → null, or an unpainted black
    // frame). Mirror captureWindowFrame's short retry instead of failing the click.
    for (let i = 0; i < 8 && (!img || frameMeanLuma(img) < 6); i++) {
      await new Promise((r) => setTimeout(r, 150))
      img = await this.captureRegion(barRegion)
    }
    if (!img) {
      logger.warn('calib', 'MP 바 캡처 실패')
      return { ok: false, reason: 'capture_fail', note: 'MP 바 캡처 실패' }
    }
    const check = calibrateBarChecked(img)
    if (!check.ok) {
      logger.warn('calib', `MP 바 보정 거부(${check.reason}): ${check.note}`)
      return { ok: false, reason: check.reason, note: check.note, fillColor: check.fillColor ?? undefined }
    }
    const cal = check.calibration

    // shrink-to-band: when the ROI was taller than the detected gauge strip, narrow
    // the stored bar ROI to the band so every future measurement sees only gauge
    // rows (an oversized ROI dilutes column density below the fill threshold).
    const bandH = check.rowBand.y1 - check.rowBand.y0
    if (bandH > 0 && bandH < img.height) {
      this.shrinkBarRoiToBand(check.rowBand)
      logger.info(
        'calib',
        `MP 바 ROI 행 밴드 자동 축소: ${img.height}px → rows ${check.rowBand.y0}..${check.rowBand.y1 - 1} (${bandH}px)`
      )
    }

    this.app.store.set((prev) => ({
      persisted: {
        ...prev.persisted,
        autoDetect: { ...prev.persisted.autoDetect, mpBarMaxX: cal.fullColumns, mpBarRefColor: cal.fillColor }
      }
    }))
    // Raw store.set does NOT schedule a persistence write (only patchPersisted/
    // ingestSample do) — flush now so calibrating while the loop is stopped and then
    // closing the app cannot silently lose the calibration (the 6/4 field pattern).
    this.app.flush()

    const selfOk = check.selfRatio >= 0.95 && check.selfRatio <= 1.0
    logger.info(
      'calib',
      `MP 바 보정 완료: ${cal.fullColumns} cols · rgb(${Math.round(cal.fillColor.r)},${Math.round(cal.fillColor.g)},${Math.round(cal.fillColor.b)})` +
        ` · 자기검증 ratio=${check.selfRatio.toFixed(3)} (기대 0.95~1.0 → ${selfOk ? 'OK' : '⚠ 비정상'})`
    )
    return { ok: true, fullColumns: cal.fullColumns, fillColor: cal.fillColor, selfRatio: check.selfRatio, selfOk }
  }

  /** Narrow every stored MP-bar ROI variant to the calibrated gauge row band. */
  private shrinkBarRoiToBand(band: RowBand): void {
    const ad = this.app.get().persisted.autoDetect
    const h = band.y1 - band.y0
    if (ad.captureMode === 'window') {
      const cur = this.windowRois?.mpBar
      if (this.windowRois && cur) {
        this.windowRois = { ...this.windowRois, mpBar: { ...cur, y: cur.y + band.y0, height: h } }
      }
      const ov = ad.windowRoi.mpBar
      if (ov) {
        this.app.store.set((prev) => ({
          persisted: {
            ...prev.persisted,
            autoDetect: {
              ...prev.persisted.autoDetect,
              windowRoi: {
                ...prev.persisted.autoDetect.windowRoi,
                mpBar: { ...ov, y: ov.y + band.y0, height: h }
              }
            }
          }
        }))
      }
    } else if (ad.mpBarRegion) {
      const r = ad.mpBarRegion
      this.app.store.set((prev) => ({
        persisted: {
          ...prev.persisted,
          autoDetect: { ...prev.persisted.autoDetect, mpBarRegion: { ...r, y: r.y + band.y0, height: h } }
        }
      }))
    }
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
    // Resume label-corpus collection (stopped in v3 — nothing called the wired-up
    // saveTrainingSample IPC): persist the accepted capture + label so the offline
    // batch learner (scripts/build-user-templates.ts) keeps gaining data.
    // Best-effort fire-and-forget: missing IPC (browser preview) or disk errors
    // must never fail the teach itself.
    const dataUrl = rgbaToPngDataUrl(img)
    if (dataUrl) {
      void api
        .saveTrainingSample({ region, dataUrl, label })
        .then((r) => {
          if (r.ok) logger.debug('learn', `학습 샘플 저장됨: ${r.path ?? '(training-data)'}`)
        })
        .catch(() => {})
    }
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
      // Raw store.set does not schedule persistence — flush so the resolved id/title
      // survive an app close even when no other persisted mutation follows.
      this.app.flush()
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
    // v3.1.1: only a VALID calibration freezes the geometry. The old `mpBarMaxX > 0`
    // check was asymmetric with barCalibration() (which invalidates non-blue
    // reference colours): a legacy/garbage calibration the system itself treats as
    // "no calibration" still froze the first auto-derived ROI, and every
    // recalibration then re-captured that frozen wrong ROI — a self-reinforcing
    // deadlock only a manual override or storage reset could escape.
    const calibrated =
      ad.mpBarMaxX > 0 &&
      !!ad.mpBarRefColor &&
      isBlueDominant(ad.mpBarRefColor) &&
      !!this.windowRois?.mpBar
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
    // Invalidate legacy/garbage calibrations whose reference colour cannot be an MP
    // gauge (field case: brown PANEL rgb(111.5,91.6,78.6) learned from an oversized
    // ROI — replaying it pins MP at max forever). Treat as "calibration required".
    if (!isBlueDominant(ad.mpBarRefColor)) return null
    return { fullColumns: ad.mpBarMaxX, fillColor: ad.mpBarRefColor, leftOffsetFrac: ad.mpBarLeftOffsetFrac }
  }

  /**
   * Fine-tune the MP bar's static left-offset (v3.1.12) from a user-entered true MP at any
   * non-full level: capture the current bar, measure its raw fill, back-solve leftOffsetFrac,
   * and persist it. Closes the residual low-MP over-read that the affine correction targets
   * (the offset has no visual cap, so it can only be learned from one known reading).
   */
  async calibrateMpOffsetFromValue(trueMp: number): Promise<{ ok: boolean; offsetFrac?: number; note?: string }> {
    const ad = this.app.get().persisted.autoDetect
    const cal = this.barCalibration(ad)
    if (!cal) return { ok: false, note: 'MP 바 100% 보정을 먼저 하세요' }
    const maxMp = this.app.get().persisted.mpConfig.maxMp
    if (!(trueMp >= 0) || trueMp >= maxMp) return { ok: false, note: `0 이상 ${maxMp} 미만의 실제 MP 값이 필요합니다 (가득 찬 상태 말고)` }
    const barRegion = ad.captureMode === 'window' ? this.windowRois?.mpBar ?? null : ad.mpBarRegion
    if (!barRegion) return { ok: false, note: 'MP 바 영역이 없습니다' }
    const img = await this.captureRegion(barRegion)
    if (!img) return { ok: false, note: 'MP 바 캡처 실패' }
    const res = computeBarFill(img, { refColor: cal.fillColor })
    const offsetFrac = solveLeftOffsetFrac(res.filledColumns, trueMp, cal.fullColumns, maxMp)
    this.app.store.set((prev) => ({
      persisted: { ...prev.persisted, autoDetect: { ...prev.persisted.autoDetect, mpBarLeftOffsetFrac: offsetFrac } }
    }))
    this.app.flush()
    logger.info('calib', `MP 좌측 오프셋 보정: filled=${res.filledColumns}/${cal.fullColumns}, 실제=${trueMp}/${maxMp} → leftOffsetFrac=${offsetFrac.toFixed(4)}`)
    return { ok: true, offsetFrac }
  }

  private processMp(
    regions: { mpRegion: CaptureRegion | null; mpBarRegion: CaptureRegion | null },
    useMpBar: boolean,
    cal: BarCalibration | null,
    maxMp: number,
    now: number
  ): void {
    if (useMpBar && !cal) {
      // ENTRY BLOCK (v3.0.2): bar mode is ON but there is no (valid) calibration.
      // The old behaviour fell back to text OCR of the tiny cur/max — which misreads
      // as digit soup ("000000" → cur=0) that the tracker then ACCEPTS as an anchor.
      // Garbage must not enter the tracker at all: surface "calibration required"
      // through the existing event channel and read nothing this tick.
      logger.warn(
        'ocr:mp',
        'MP 바 픽셀 모드 ON 이지만 유효한 보정(calibration) 없음 → MP 인식 보류 — 100% MP에서 「MP 바 100% 보정」을 실행하세요'
      )
      this.emit({
        region: 'mp',
        raw: null,
        accepted: false,
        value: null,
        posterior: 0,
        source: 'mp-bar',
        reason: 'calibration_required',
        at: now
      })
      return
    }

    const barImage = useMpBar && regions.mpBarRegion ? this.capture.captureRegion(regions.mpBarRegion) : null
    const textImage = regions.mpRegion ? this.capture.captureRegion(regions.mpRegion) : null
    if (!barImage && !textImage) {
      logger.warn('cap:mp', 'no MP capture (region null or frame not ready)')
      return
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
      let confidence = result.confidence
      if (v.max <= 0) {
        // No '/' was recognized → cur-only text parse. Structurally suspect (the HUD
        // always renders "cur/max"): drop implausible values against the known max
        // and dampen confidence for the rest so the tracker needs stronger evidence.
        const assess = assessNoSlashMp(v.cur, confidence, maxMp)
        if (!assess.ok) {
          logger.debug(
            'ocr:mp',
            `[${dims}] raw="${result.raw}" src=${result.source} no-slash cur=${v.cur} > max(${maxMp})×${MP_NO_SLASH_MAX_FACTOR} → 무효`
          )
          this.emit({ region: 'mp', raw: result.raw, accepted: false, value: null, posterior: 0, source: result.source, reason: 'implausible_no_slash', at: now })
          return
        }
        confidence = assess.confidence
      }
      const verdict = this.trackers.mp.observe({ cur: v.cur, max: v.max || maxMp }, confidence, now)
      if (verdict.accepted && verdict.value) {
        this.app.setMpConfig({ curMp: verdict.value.cur })
      }
      logger.debug('ocr:mp', `[${dims}] raw="${result.raw}" src=${result.source} conf=${confidence.toFixed(2)} → ${verdict.accepted ? 'ACCEPT' : 'reject'} cur=${verdict.value?.cur} post=${verdict.posterior.toFixed(2)} (${verdict.reason})`)
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
