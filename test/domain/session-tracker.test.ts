import { describe, it, expect } from 'vitest'
import {
  SessionTracker,
  computeSessionStats,
  totalExpProgress,
  activeElapsedMs,
  etaSecondsForPct,
  type SessionSample
} from '@core/domain/session-tracker'

/**
 * Tracker math, verified against the v2.x app.js formulas:
 *   - totalExpProgress = (level - startLevel) * 100 + (exp - startExp)
 *   - rate/h           = progress / (elapsedMs / 3_600_000)
 *   - levelUpEta(s)    = (100 - exp) / expPerHour * 3600
 *   - next1PctEta(s)   = 1 / expPerHour * 3600
 * All timestamps are passed IN; the core never reads the wall clock.
 */

const HOUR = 3_600_000

function sample(t: number, expPct: number, adena: number, level = 1): SessionSample {
  return { t, expPct, adena, level }
}

describe('totalExpProgress', () => {
  it('within a single level is a plain delta', () => {
    expect(totalExpProgress({ level: 1, expPct: 10 }, { level: 1, expPct: 25.5 })).toBeCloseTo(15.5, 6)
  })
  it('adds 100 per level-up boundary', () => {
    // crossed one level: 90% -> (next level) 10% == 20% total gain
    expect(totalExpProgress({ level: 5, expPct: 90 }, { level: 6, expPct: 10 })).toBeCloseTo(20, 6)
  })
  it('handles multi-level jumps', () => {
    expect(totalExpProgress({ level: 1, expPct: 0 }, { level: 3, expPct: 50 })).toBeCloseTo(250, 6)
  })
})

describe('etaSecondsForPct', () => {
  it('1% at 10%/h -> 360s', () => {
    expect(etaSecondsForPct(1, 10)).toBeCloseTo(360, 6)
  })
  it('non-positive rate -> Infinity', () => {
    expect(etaSecondsForPct(5, 0)).toBe(Infinity)
    expect(etaSecondsForPct(5, -1)).toBe(Infinity)
  })
  it('already there -> 0', () => {
    expect(etaSecondsForPct(0, 10)).toBe(0)
  })
})

describe('exp/h and adena/h over a window', () => {
  it('computes a clean per-hour rate from a 1h span', () => {
    const samples = [sample(0, 50, 1000, 7), sample(HOUR, 60, 4000, 7)]
    const s = computeSessionStats(samples)
    expect(s.expPerHour).toBeCloseTo(10, 6) // +10% in 1h
    expect(s.adenaPerHour).toBeCloseTo(3000, 6) // +3000 in 1h
    expect(s.elapsed).toBe(3600)
  })

  it('scales a 30-minute span to per-hour', () => {
    const samples = [sample(0, 20, 0, 7), sample(HOUR / 2, 25, 1500, 7)]
    const s = computeSessionStats(samples)
    expect(s.expPerHour).toBeCloseTo(10, 6) // +5% in 0.5h -> 10%/h
    expect(s.adenaPerHour).toBeCloseTo(3000, 6) // +1500 in 0.5h -> 3000/h
  })

  it('counts level-ups in the exp rate', () => {
    // 90% -> level up -> 10%, in 1h == +20%/h
    const samples = [sample(0, 90, 0, 7), sample(HOUR, 10, 0, 8)]
    const s = computeSessionStats(samples)
    expect(s.expPerHour).toBeCloseTo(20, 6)
  })
})

describe('level-up and next-1% ETA', () => {
  it('derives both ETAs from the measured rate', () => {
    // +10%/h, currently at 50% -> 50% remain
    const samples = [sample(0, 40, 0, 7), sample(HOUR, 50, 0, 7)]
    const s = computeSessionStats(samples)
    expect(s.expPerHour).toBeCloseTo(10, 6)
    // levelUp: (100 - 50)/10 * 3600 = 18000s
    expect(s.levelUpEta).toBeCloseTo(18000, 3)
    // next 1%: 1/10 * 3600 = 360s
    expect(s.next1PctEta).toBeCloseTo(360, 6)
  })

  it('zero/negative exp rate yields Infinity ETAs', () => {
    const samples = [sample(0, 50, 0, 7), sample(HOUR, 50, 1000, 7)]
    const s = computeSessionStats(samples)
    expect(s.expPerHour).toBeCloseTo(0, 6)
    expect(s.levelUpEta).toBe(Infinity)
    expect(s.next1PctEta).toBe(Infinity)
  })
})

describe('minimum elapsed guard', () => {
  it('suppresses rates below the 30s floor (v2.x behaviour)', () => {
    const samples = [sample(0, 10, 0, 7), sample(10_000, 11, 100, 7)] // 10s span
    const s = computeSessionStats(samples)
    expect(s.expPerHour).toBeNull()
    expect(s.adenaPerHour).toBeNull()
    expect(s.levelUpEta).toBeNull()
    expect(s.next1PctEta).toBeNull()
    // progress is still reported even when rates are withheld
    expect(s.expProgress).toBeCloseTo(1, 6)
    expect(s.adenaProgress).toBe(100)
  })

  it('emits rates once past the floor', () => {
    const samples = [sample(0, 10, 0, 7), sample(60_000, 11, 100, 7)] // 60s span
    const s = computeSessionStats(samples)
    expect(s.expPerHour).not.toBeNull()
  })

  it('honours a custom minElapsedMs', () => {
    const samples = [sample(0, 10, 0, 7), sample(5_000, 11, 0, 7)]
    expect(computeSessionStats(samples, { minElapsedMs: 1_000 }).expPerHour).not.toBeNull()
    expect(computeSessionStats(samples, { minElapsedMs: 10_000 }).expPerHour).toBeNull()
  })
})

describe('idle gap handling', () => {
  it('excludes long AFK gaps from active elapsed', () => {
    // 60s active, then a 1h idle gap, then 60s active.
    const samples = [
      sample(0, 0, 0, 7),
      sample(60_000, 2, 0, 7),
      sample(60_000 + HOUR, 2, 0, 7), // idle: no progress during the gap
      sample(120_000 + HOUR, 4, 0, 7)
    ]
    const activeMs = activeElapsedMs(samples, 5 * 60_000) // 5-min idle threshold
    expect(activeMs).toBe(120_000) // two 60s active segments, gap excluded
  })

  it('idle exclusion lifts the measured rate vs naive wall span', () => {
    const samples = [
      sample(0, 0, 0, 7),
      sample(60_000, 2, 0, 7),
      sample(60_000 + HOUR, 2, 0, 7),
      sample(120_000 + HOUR, 4, 0, 7)
    ]
    // total exp progress = 4%; active time = 120s -> 4% / (120/3600)h = 120%/h
    const idle = computeSessionStats(samples, { idleGapMs: 5 * 60_000 })
    expect(idle.expPerHour).toBeCloseTo(120, 4)
    // without idle handling the denominator is ~1h2m -> a far smaller rate
    const naive = computeSessionStats(samples)
    expect(naive.expPerHour!).toBeLessThan(5)
  })
})

describe('sliding window', () => {
  it('limits the rate fit to the most recent window', () => {
    // Slow first hour (+2%), fast last 10 min (+5%). A 10-min window sees only the fast part.
    const samples = [
      sample(0, 0, 0, 7),
      sample(HOUR, 2, 0, 7),
      sample(HOUR + 10 * 60_000, 7, 0, 7)
    ]
    const s = computeSessionStats(samples, { windowMs: 10 * 60_000 })
    // +5% in 10min -> 30%/h
    expect(s.expPerHour).toBeCloseTo(30, 4)
  })
})

describe('SessionTracker class', () => {
  it('ingests samples and computes stats incrementally', () => {
    const trk = new SessionTracker()
    trk.ingest(sample(0, 50, 1000, 7))
    trk.ingest(sample(HOUR, 60, 4000, 7))
    expect(trk.size).toBe(2)
    const s = trk.stats()
    expect(s.expPerHour).toBeCloseTo(10, 6)
    expect(s.adenaPerHour).toBeCloseTo(3000, 6)
  })

  it('orders out-of-order timestamps', () => {
    const trk = new SessionTracker()
    trk.ingest(sample(HOUR, 60, 4000, 7))
    trk.ingest(sample(0, 50, 1000, 7)) // arrives late
    const ordered = trk.getSamples().map((x) => x.t)
    expect(ordered).toEqual([0, HOUR])
    expect(trk.stats().expPerHour).toBeCloseTo(10, 6)
  })

  it('prunes history outside the window', () => {
    const trk = new SessionTracker({ windowMs: HOUR })
    trk.ingest(sample(0, 0, 0, 7))
    trk.ingest(sample(HOUR, 5, 0, 7))
    trk.ingest(sample(3 * HOUR, 20, 0, 7)) // newest; window cutoff = 2h
    // the t=0 sample is now far outside the window and should be dropped
    const ts = trk.getSamples().map((x) => x.t)
    expect(ts).not.toContain(0)
  })

  it('reset clears retained samples', () => {
    const trk = new SessionTracker()
    trk.ingestAll([sample(0, 0, 0, 7), sample(HOUR, 5, 0, 7)])
    trk.reset()
    expect(trk.size).toBe(0)
    expect(trk.stats().expPerHour).toBeNull()
  })

  it('reports null rates with fewer than two samples', () => {
    const trk = new SessionTracker()
    trk.ingest(sample(0, 10, 0, 7))
    const s = trk.stats()
    expect(s.expPerHour).toBeNull()
    expect(s.sampleCount).toBe(1)
  })
})
