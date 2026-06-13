/**
 * MP fill countdown controller. Computes the full-charge ETA from the live MP
 * config (via the pure engine) and counts down to a fixed completion timestamp,
 * so OCR/manual updates to `curMp` re-anchor the countdown cleanly. Fires
 * onComplete once when the bar reaches full while running.
 */
import { calculateFullMpTime, type MpConfig } from '@core/domain/mp-engine'
import type { MpConfigState } from '@core/domain/storage-schema'

export function toMpConfig(s: MpConfigState): MpConfig {
  return {
    wis: s.wis,
    useBluePotion: s.useBluePotion,
    useMeditation: s.useMeditation,
    hasCrystalStaff: s.hasCrystalStaff,
    location: s.location,
    customLocationBonus: s.customLocationBonus,
    state: s.state
  }
}

export class MpTimer {
  private completionAt: number | null = null
  /** ETA (seconds) the current `completionAt` was anchored to — used to avoid
   *  re-anchoring (and thus resetting the visible countdown) when nothing changed. */
  private anchorSecs: number | null = null
  private notified = false
  running = false
  onComplete: (() => void) | null = null

  start(cfg: MpConfigState, nowMs: number): void {
    this.running = true
    // Suppress an immediate "완충" alert when starting already-full: the alert is
    // for RECOVERING to full, not for being full at start (the user pressed start
    // with a full bar — nothing recovered). It re-arms once MP is actually used.
    this.notified = cfg.curMp >= cfg.maxMp
    this.anchorSecs = null // force a fresh anchor on start
    this.recompute(cfg, nowMs)
  }

  pause(): void {
    this.running = false
    this.completionAt = null
    this.anchorSecs = null
  }

  /** Re-anchor the completion time when the config or current MP changes. */
  recompute(cfg: MpConfigState, nowMs: number): void {
    if (!this.running) {
      this.completionAt = null
      this.anchorSecs = null
      return
    }
    const secs = calculateFullMpTime(cfg.curMp, cfg.maxMp, toMpConfig(cfg))
    // Re-arm the completion alert ONLY when MP has dropped MEANINGFULLY below full —
    // i.e. the user actually used MP. A bare `secs > 0` test re-armed on a single-unit
    // bar-measurement flicker near full (327→326→327, where 326 is one recovery tick
    // away): each flicker re-armed and the next 327 re-fired "완충" forever. Requiring
    // a margin beyond pixel jitter means exactly one alert per real refill cycle, and
    // — with start() suppressing the at-full case — no spam while resting at full MP.
    const rearmMargin = Math.max(2, Math.ceil(cfg.maxMp * 0.02))
    if (cfg.curMp <= cfg.maxMp - rearmMargin) this.notified = false

    // Only RE-ANCHOR the countdown when the ETA actually changes. app.ts calls
    // recompute() on EVERY store write (the detector re-accepts the same MP every
    // ~1s, plus EXP/adena samples), so anchoring to `now + secs` each time pinned the
    // visible remaining at the full ETA — it ticked down for ~1s then jumped back,
    // only making net progress when MP actually rose a tick. Keeping the existing
    // `completionAt` while the ETA is unchanged lets the countdown decrease smoothly;
    // a genuine MP change (new ETA) re-anchors to the new value.
    if (this.completionAt != null && this.anchorSecs === secs) return
    this.anchorSecs = secs
    this.completionAt = Number.isFinite(secs) ? nowMs + secs * 1000 : null
  }

  /** Seconds remaining; static ETA when paused. Fires onComplete on first zero. */
  remainingSeconds(cfg: MpConfigState, nowMs: number): number {
    if (this.running && this.completionAt != null) {
      const r = Math.max(0, (this.completionAt - nowMs) / 1000)
      if (r <= 0 && !this.notified) {
        this.notified = true
        this.onComplete?.()
      }
      return r
    }
    return calculateFullMpTime(cfg.curMp, cfg.maxMp, toMpConfig(cfg))
  }
}
