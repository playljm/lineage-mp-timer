/**
 * MpTimer completion-alert regression (v3.1.3).
 *
 * Field bug: the "MP 완충" toast fired continuously (every ~250ms) and kept firing
 * after MP was used / after the window was closed. Root cause: recompute() cleared
 * `notified` on EVERY call, and app.ts calls recompute on every store change — while
 * MP is full (ETA 0) the session tracker writes a sample each tick, re-arming the
 * alert so the render loop re-fired it forever. Fix: only re-arm for a genuine
 * countdown (secs > 0), preserving exactly one alert per refill cycle.
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
  it('fires exactly once while MP stays full, even as recompute is hammered each tick', () => {
    const t = new MpTimer()
    let fires = 0
    t.onComplete = () => fires++
    const full = cfg(327)
    const t0 = 1_000_000
    t.start(full, t0)
    // Simulate the per-tick store writes (tracker samples) → recompute, plus the
    // 250ms render poll → remainingSeconds, for 20 ticks.
    for (let i = 0; i < 20; i++) {
      t.recompute(full, t0 + i * 250)
      t.remainingSeconds(full, t0 + i * 250)
    }
    expect(fires).toBe(1)
  })

  it('re-arms and fires again after MP is used and refills (one alert per refill)', () => {
    const t = new MpTimer()
    let fires = 0
    t.onComplete = () => fires++
    const t0 = 2_000_000
    t.start(cfg(327), t0)
    t.remainingSeconds(cfg(327), t0) // full → fire #1
    expect(fires).toBe(1)

    // MP used → drops below full. Genuine countdown re-arms the alert.
    const drained = cfg(100)
    t.recompute(drained, t0 + 1000)
    // Several ticks while still charging must NOT fire.
    for (let i = 1; i <= 5; i++) {
      t.recompute(drained, t0 + 1000 + i * 250)
      t.remainingSeconds(drained, t0 + 1000 + i * 250)
    }
    expect(fires).toBe(1)

    // Refilled to full → fires once more.
    const refilled = cfg(327)
    const t2 = t0 + 100_000
    t.recompute(refilled, t2)
    t.remainingSeconds(refilled, t2)
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
    const charging = cfg(320) // close to full → short ETA
    t.start(charging, t0)
    // Before completion.
    expect(t.remainingSeconds(charging, t0)).toBeGreaterThan(0)
    expect(fires).toBe(0)
    // Far past completion — fires once.
    const late = t0 + 10_000_000
    t.remainingSeconds(charging, late)
    expect(fires).toBe(1)
    // Subsequent ticks (with tracker recomputes) do not re-fire.
    for (let i = 1; i <= 5; i++) {
      t.recompute(charging, late + i * 250)
      t.remainingSeconds(charging, late + i * 250)
    }
    expect(fires).toBe(1)
  })
})
