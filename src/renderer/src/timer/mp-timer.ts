/**
 * MP fill countdown controller — driven by a deterministic TICK MODEL.
 *
 * Lineage MP recovers in fixed discrete ticks (e.g. +N MP every 16/32/64s), so the
 * countdown must NOT be re-derived from every noisy per-frame OCR/bar reading. The
 * detector re-accepts a value ~every second and the bar-pixel measurement jitters
 * ±a few MP; anchoring `completion = now + ETA` on each of those made the visible
 * countdown bounce ("1초 줄었다 다시 늘고") and only net-progress when MP actually
 * ticked up. v3.1.7's exact-ETA guard didn't help because jitter crosses the 16s
 * tick buckets the ETA is quantised to.
 *
 * Instead we anchor once at (anchorMp, anchorAt) with the live recovery/tick rate
 * and PREDICT MP forward as `anchorMp + floor(elapsed/interval)*recovery`. The
 * completion timestamp is then fixed, so the countdown decreases a smooth 1s/s. A
 * reading only re-anchors when it deviates from the prediction by more than one tick
 * (a genuine event: MP used → drop, potion → jump). Clean forward ticks phase-lock
 * the anchor so the displayed MP matches the game's real tick cadence while keeping
 * the countdown monotone. Fires onComplete once when the bar reaches full.
 */
import {
  calculateFullMpTime,
  calculateTickRecovery,
  calculateTickInterval,
  type MpConfig
} from '@core/domain/mp-engine'
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
  /** Absolute ms timestamp the bar is predicted to reach full; null = no countdown. */
  private completionAt: number | null = null
  // ── tick-model anchor: predicted MP = anchorMp + floor((t-anchorAt)/intervalMs)*recovery ──
  private anchorMp: number | null = null
  private anchorAt: number | null = null
  private anchorMax = 0
  private anchorRecovery = 0 // MP gained per tick at the anchor's config
  private anchorIntervalMs = 0 // ms per tick at the anchor's config
  /** MP to DISPLAY — the measured value tracked as a high-water mark within a charge
   *  cycle (rises with real recovery, ignores downward jitter, drops only on a genuine
   *  re-anchor). Decoupled from the floored tick prediction, which lagged the real MP
   *  by up to half a tick and read consistently ~6 low. */
  private displayedMp: number | null = null
  private notified = false
  running = false
  onComplete: (() => void) | null = null

  start(cfg: MpConfigState, nowMs: number): void {
    this.running = true
    // Suppress an immediate "완충" alert when starting already-full: the alert is for
    // RECOVERING to full, not for being full at start. It re-arms once MP is used.
    this.notified = cfg.curMp >= cfg.maxMp
    this.anchorTo(cfg, nowMs)
  }

  pause(): void {
    this.running = false
    this.completionAt = null
    this.anchorMp = null
    this.anchorAt = null
    this.displayedMp = null
  }

  /** (Re)seat the tick model on the current reading and rebuild the completion time. */
  private anchorTo(cfg: MpConfigState, nowMs: number): void {
    const m = toMpConfig(cfg)
    this.anchorMp = Math.max(0, Math.min(cfg.curMp, cfg.maxMp))
    this.anchorAt = nowMs
    this.anchorMax = cfg.maxMp
    this.anchorRecovery = calculateTickRecovery(m)
    this.anchorIntervalMs = calculateTickInterval(cfg.state) * 1000
    // Re-anchoring is a genuine MP event (start, use, potion, buff change) — reseat the
    // displayed value to the measured MP too (a drop lowers it; a jump raises it).
    this.displayedMp = this.anchorMp
    const secs = calculateFullMpTime(this.anchorMp, cfg.maxMp, m)
    this.completionAt = Number.isFinite(secs) ? nowMs + secs * 1000 : null
  }

  /** Tick-model predicted MP at `nowMs` (the in-between value the game actually shows). */
  private predictedMp(cfg: MpConfigState, nowMs: number): number {
    if (this.anchorMp == null || this.anchorAt == null) {
      return Math.max(0, Math.min(cfg.curMp, cfg.maxMp))
    }
    if (this.anchorRecovery <= 0 || this.anchorIntervalMs <= 0) return this.anchorMp
    const elapsed = nowMs - this.anchorAt
    if (elapsed <= 0) return this.anchorMp
    const ticks = Math.floor(elapsed / this.anchorIntervalMs)
    return Math.min(this.anchorMax, this.anchorMp + ticks * this.anchorRecovery)
  }

  /**
   * MP to DISPLAY. While running: the measured value tracked as a per-cycle high-water
   * mark (accurate to the game's real MP, with downward jitter filtered) — NOT the
   * floored tick prediction, which lagged ~half a tick and read consistently low. While
   * stopped: the raw measured value.
   */
  displayMp(cfg: MpConfigState, _nowMs: number): number {
    const measured = Math.max(0, Math.min(cfg.curMp, cfg.maxMp))
    if (this.running && this.displayedMp != null) return Math.round(this.displayedMp)
    return measured
  }

  /**
   * Reconcile a (possibly noisy) measured MP with the tick model. Re-anchors only on a
   * genuine deviation; otherwise holds the smooth countdown. app.ts calls this on every
   * store write — the deadband is what keeps the countdown from bouncing.
   */
  recompute(cfg: MpConfigState, nowMs: number): void {
    if (!this.running) {
      this.completionAt = null
      this.anchorMp = null
      this.anchorAt = null
      return
    }

    // Re-arm the completion alert only when MP dropped MEANINGFULLY below full (a real
    // use), not on a single-unit bar flicker near full — exactly one alert per refill.
    const rearmMargin = Math.max(2, Math.ceil(cfg.maxMp * 0.02))
    if (cfg.curMp <= cfg.maxMp - rearmMargin) this.notified = false

    // First reading, or the recovery rate / tick interval / max changed (buff, state,
    // location, WIS) → reseat the model.
    const recovery = calculateTickRecovery(toMpConfig(cfg))
    const intervalMs = calculateTickInterval(cfg.state) * 1000
    if (
      this.anchorMp == null ||
      this.anchorAt == null ||
      recovery !== this.anchorRecovery ||
      intervalMs !== this.anchorIntervalMs ||
      cfg.maxMp !== this.anchorMax
    ) {
      this.anchorTo(cfg, nowMs)
      return
    }

    const predicted = this.predictedMp(cfg, nowMs)
    const delta = cfg.curMp - predicted
    // One tick of slack absorbs bar/OCR jitter AND the unknown real-tick phase (our
    // anchor's tick boundary can be up to one interval off the game's).
    const tol = Math.max(2, recovery)

    if (delta > tol || delta < -tol) {
      // Genuine event: MP jumped (potion / resync) or dropped (skill cast) → re-anchor.
      this.anchorTo(cfg, nowMs)
      return
    }

    // Within tolerance: the reading confirms the model.
    const measured = Math.max(0, Math.min(cfg.curMp, cfg.maxMp))
    // Track the DISPLAYED MP up to the measured value (high-water mark): MP only rises
    // while charging, so a reading below the displayed value is downward jitter and is
    // ignored, while a reading above it is real recovery and is shown immediately. This
    // keeps the number accurate to the game without the floored-prediction lag.
    if (this.displayedMp == null || measured > this.displayedMp) this.displayedMp = measured
    // Phase-lock the COUNTDOWN model ONLY on a clean forward tick advance (filters
    // downward noise), pulling the completion EARLIER if the advance proves we were
    // lagging — never later (that would re-introduce the bounce).
    if (cfg.curMp >= this.anchorMp + recovery) {
      const secs = calculateFullMpTime(cfg.curMp, cfg.maxMp, toMpConfig(cfg))
      const newCompletion = Number.isFinite(secs) ? nowMs + secs * 1000 : null
      this.anchorMp = measured
      this.anchorAt = nowMs
      if (newCompletion != null && (this.completionAt == null || newCompletion <= this.completionAt)) {
        this.completionAt = newCompletion
      }
    }
    // else: sub-tick jitter — hold the countdown model so it stays smooth.
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
