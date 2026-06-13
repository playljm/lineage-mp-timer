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

/** Buffed config → recovery 12/tick (base 2 + potion 5 + meditation 5), interval 16s,
 *  so a realistic per-tick gain gives a ±jitter band wide enough to test sub-tick noise. */
function cfgBuffed(curMp: number, maxMp = 327): MpConfigState {
  return { ...cfg(curMp, maxMp), useBluePotion: true, useMeditation: true }
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

  it('counts down smoothly while MP is stable — recompute each tick must not reset it', () => {
    const t = new MpTimer()
    const t0 = 6_000_000
    const stable = cfg(140) // below full → a real countdown
    t.start(stable, t0)
    const r0 = t.remainingSeconds(stable, t0)
    expect(r0).toBeGreaterThan(10)
    // Simulate app.ts: a store write (recompute) every ~1s with the SAME MP, plus the
    // render poll (remainingSeconds). The remaining must keep DECREASING ~1s/s, not
    // reset to r0 on each recompute.
    let prev = r0
    for (let i = 1; i <= 8; i++) {
      const now = t0 + i * 1000
      t.recompute(stable, now) // same MP re-accepted — must not re-anchor
      const r = t.remainingSeconds(stable, now)
      expect(r).toBeLessThan(prev) // strictly decreasing
      expect(Math.abs(r - (r0 - i))).toBeLessThan(0.05) // ~1s per second
      prev = r
    }
  })

  it('re-anchors when MP actually changes (ETA jumps to the new value)', () => {
    const t = new MpTimer()
    const t0 = 6_500_000
    t.start(cfg(140), t0)
    const at140 = t.remainingSeconds(cfg(140), t0 + 5000)
    // MP rises a tick → ETA shorter → countdown drops to the new (smaller) value.
    t.recompute(cfg(160), t0 + 6000)
    const at160 = t.remainingSeconds(cfg(160), t0 + 6000)
    expect(at160).toBeLessThan(at140)
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

/**
 * Tick-model regression (v3.1.8). The countdown is driven by a deterministic recovery
 * model (anchorMp + floor(elapsed/interval)*recovery), not by every noisy per-frame
 * reading — the root cause of "1초 줄었다 다시 늘고" was re-anchoring on bar/OCR jitter.
 * The displayed MP follows the same model so it shows the game's discrete ticks
 * instead of measurement noise.
 */
describe('MpTimer tick model', () => {
  it('displayMp advances by exactly one recovery tick per interval', () => {
    const t = new MpTimer()
    const t0 = 7_000_000
    const c = cfg(100) // recovery 2/tick, 16s interval
    t.start(c, t0)
    expect(t.displayMp(c, t0)).toBe(100)
    expect(t.displayMp(c, t0 + 16_000 - 1)).toBe(100) // just before the first tick
    expect(t.displayMp(c, t0 + 16_000)).toBe(102) // tick 1
    expect(t.displayMp(c, t0 + 32_000)).toBe(104) // tick 2
  })

  it('displayMp caps at maxMp (never predicts beyond full)', () => {
    const t = new MpTimer()
    const t0 = 7_050_000
    const c = cfgBuffed(320) // recovery 12 → would overshoot in 1 tick
    t.start(c, t0)
    expect(t.displayMp(c, t0 + 16_000 * 5)).toBe(327)
  })

  it('countdown stays smooth (monotone ~1s/s) through sub-tick OCR jitter', () => {
    const t = new MpTimer()
    const t0 = 7_100_000
    const c = cfgBuffed(140) // recovery 12 → ±3 jitter is well within one tick
    t.start(c, t0)
    const r0 = t.remainingSeconds(c, t0)
    expect(r0).toBeGreaterThan(20)
    const jitter = [0, 3, -3, 2, -2, 1, -1, 3, -3, 0]
    let prev = r0
    for (let i = 1; i <= 10; i++) {
      const now = t0 + i * 1000
      const noisy = cfgBuffed(140 + jitter[i - 1]!)
      t.recompute(noisy, now) // sub-tick noise must NOT re-anchor
      const r = t.remainingSeconds(noisy, now)
      expect(r).toBeLessThanOrEqual(prev) // never bounces back up
      expect(Math.abs(r - (r0 - i))).toBeLessThan(0.5) // ~1s per second
      prev = r
    }
  })

  it('re-anchors (countdown jumps UP) when MP is actually used — drop beyond one tick', () => {
    const t = new MpTimer()
    const t0 = 7_200_000
    const near = cfgBuffed(300)
    t.start(near, t0)
    const before = t.remainingSeconds(near, t0)
    const drained = cfgBuffed(100) // −200 ≫ one tick → genuine use
    t.recompute(drained, t0 + 1000)
    const after = t.remainingSeconds(drained, t0 + 1000)
    expect(after).toBeGreaterThan(before)
  })

  it('re-anchors (countdown jumps DOWN) on a potion jump — rise beyond one tick', () => {
    const t = new MpTimer()
    const t0 = 7_300_000
    const low = cfgBuffed(100)
    t.start(low, t0)
    const before = t.remainingSeconds(low, t0)
    const potioned = cfgBuffed(250) // +150 ≫ one tick → genuine jump
    t.recompute(potioned, t0 + 1000)
    const after = t.remainingSeconds(potioned, t0 + 1000)
    expect(after).toBeLessThan(before)
  })

  it('re-anchors when the recovery rate changes (buff toggled mid-charge)', () => {
    const t = new MpTimer()
    const t0 = 7_400_000
    const slow = cfg(100) // recovery 2
    t.start(slow, t0)
    const before = t.remainingSeconds(slow, t0)
    const fast = cfgBuffed(100) // same MP, recovery 12 → much shorter ETA
    t.recompute(fast, t0 + 500)
    const after = t.remainingSeconds(fast, t0 + 500)
    expect(after).toBeLessThan(before)
  })
})
