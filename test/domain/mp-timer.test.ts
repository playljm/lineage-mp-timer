/**
 * MpTimer completion-alert regression (v3.1.3 / v3.1.5).
 *
 * v3.1.3: the "MP 완충" toast fired continuously while MP sat at full, because
 *   recompute() cleared `notified` on every call and app.ts calls it on every store
 *   change. Fixed by only re-arming for a real countdown.
 * v3.1.5: two residual field cases —
 *   (a) pressing Start while ALREADY full fired an immediate (useless) 완충 alert;
 *   (b) a 1-unit bar-measurement flicker near full (327→326→327) re-armed the alert
 *       and re-fired it every cycle. Fixed by suppressing the at-full start alert and
 *       re-arming only when MP drops MEANINGFULLY below full (beyond pixel jitter).
 * The invariant preserved throughout: exactly one alert per genuine refill cycle.
 */
import { describe, it, expect } from 'vitest'
import { MpTimer } from '../../src/renderer/src/timer/mp-timer'
import type { MpConfigState } from '@core/domain/storage-schema'

function cfg(curMp: number, maxMp = 327): MpConfigState {
  return {
    curMp,
    maxMp,
    wis: 15,
    useBluePotion: false,
    useMeditation: false,
    hasCrystalStaff: false,
    location: 'field',
    customLocationBonus: 0,
    state: 'standing',
    targetPct: 100
  }
}

describe('MpTimer completion alert', () => {
  it('does NOT alert when starting already-full (no recovery happened)', () => {
    const t = new MpTimer()
    let fires = 0
    t.onComplete = () => fires++
    const full = cfg(327)
    const t0 = 1_000_000
    t.start(full, t0)
    // Tracker writes (recompute) + 250ms render poll (remainingSeconds), 20 ticks.
    for (let i = 0; i < 20; i++) {
      t.recompute(full, t0 + i * 250)
      t.remainingSeconds(full, t0 + i * 250)
    }
    expect(fires).toBe(0)
  })

  it('ignores a 1-unit bar flicker near full (327→326→327) — no repeat alert', () => {
    const t = new MpTimer()
    let fires = 0
    t.onComplete = () => fires++
    const t0 = 1_500_000
    // Start below full so a genuine recovery fires once.
    t.start(cfg(300), t0)
    let now = t0
    // MP rises to full → one alert.
    now += 1000
    t.recompute(cfg(327), now)
    t.remainingSeconds(cfg(327), now)
    expect(fires).toBe(1)
    // Now flicker 327↔326↔327 for many ticks (326 is within the jitter margin).
    for (let i = 0; i < 30; i++) {
      now += 250
      const v = i % 2 === 0 ? 326 : 327
      t.recompute(cfg(v), now)
      t.remainingSeconds(cfg(v), now)
    }
    expect(fires).toBe(1) // no re-fire from jitter
  })

  it('re-arms and fires again after MP is actually used and refills', () => {
    const t = new MpTimer()
    let fires = 0
    t.onComplete = () => fires++
    const t0 = 2_000_000
    t.start(cfg(300), t0)
    let now = t0 + 1000
    t.recompute(cfg(327), now)
    t.remainingSeconds(cfg(327), now)
    expect(fires).toBe(1) // recovered to full → alert #1

    // Real MP use: drops well below full (beyond jitter margin) → re-arms.
    now += 1000
    const drained = cfg(120)
    for (let i = 0; i < 4; i++) {
      now += 250
      t.recompute(drained, now)
      t.remainingSeconds(drained, now)
    }
    expect(fires).toBe(1) // still charging, no fire

    // Refilled to full → alert #2.
    now += 100_000
    t.recompute(cfg(327), now)
    t.remainingSeconds(cfg(327), now)
    expect(fires).toBe(2)
  })

  it('does not fire while charging (MP below full)', () => {
    const t = new MpTimer()
    let fires = 0
    t.onComplete = () => fires++
    const t0 = 3_000_000
    const charging = cfg(50)
    t.start(charging, t0)
    for (let i = 0; i < 10; i++) {
      t.recompute(charging, t0 + i * 250)
      t.remainingSeconds(charging, t0 + i * 250)
    }
    expect(fires).toBe(0)
  })

  it('never fires when recovery is blocked (ETA infinite)', () => {
    const t = new MpTimer()
    let fires = 0
    t.onComplete = () => fires++
    const t0 = 4_000_000
    const blocked: MpConfigState = { ...cfg(100), state: 'blocked' }
    t.start(blocked, t0)
    for (let i = 0; i < 10; i++) {
      t.recompute(blocked, t0 + i * 250)
      t.remainingSeconds(blocked, t0 + i * 250)
    }
    expect(fires).toBe(0)
  })

  it('fires once when a countdown reaches completion, no re-fire after', () => {
    const t = new MpTimer()
    let fires = 0
    t.onComplete = () => fires++
    const t0 = 5_000_000
    t.start(cfg(300), t0) // below full → armed
    expect(t.remainingSeconds(cfg(300), t0)).toBeGreaterThan(0)
    expect(fires).toBe(0)
    // MP reaches full → fires once.
    const t1 = t0 + 1000
    t.recompute(cfg(327), t1)
    t.remainingSeconds(cfg(327), t1)
    expect(fires).toBe(1)
    // Subsequent full-state ticks do not re-fire.
    for (let i = 1; i <= 5; i++) {
      t.recompute(cfg(327), t1 + i * 250)
      t.remainingSeconds(cfg(327), t1 + i * 250)
    }
    expect(fires).toBe(1)
  })
})
