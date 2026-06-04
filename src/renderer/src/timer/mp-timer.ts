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
  private notified = false
  running = false
  onComplete: (() => void) | null = null

  start(cfg: MpConfigState, nowMs: number): void {
    this.running = true
    this.recompute(cfg, nowMs)
  }

  pause(): void {
    this.running = false
    this.completionAt = null
  }

  /** Re-anchor the completion time when the config or current MP changes. */
  recompute(cfg: MpConfigState, nowMs: number): void {
    if (!this.running) {
      this.completionAt = null
      return
    }
    const secs = calculateFullMpTime(cfg.curMp, cfg.maxMp, toMpConfig(cfg))
    this.completionAt = Number.isFinite(secs) ? nowMs + secs * 1000 : null
    this.notified = false
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
