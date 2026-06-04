import { describe, it, expect } from 'vitest'
import {
  MpTracker,
  ExpTracker,
  LevelTracker,
  AdenaTracker,
  type BaseTracker,
  type MpValue
} from '@core/ocr/tracker'

/**
 * Authoritative temporal-tracker suite, ported from the proven v2.x
 * test/bayesian.test.js. The posterior math and domain gates are carried over
 * verbatim; the assertions are re-expressed against the renewed AUTHORITATIVE API:
 *
 *   observe(value, ocrConfidence, nowMs, opts?) -> { accepted, value, posterior, reason }
 *
 * Mapping from the v2.x DRY-RUN API:
 *   anomaly === false  <->  accepted === true
 *   anomaly === true   <->  accepted === false
 *   trustedValue       <->  value
 *   source             <->  reason   ('user_force' | 'init_pending' | 'init_consistency'
 *                                      | 'reject' | 'normal' | 'low_posterior'
 *                                      | 'anomaly_consistency')
 *   tracker.lastTrusted  <->  tracker.trusted
 *
 * Every timestamp is passed in as the `nowMs` argument (the core never reads a clock).
 */

/**
 * Warm-up helper: feed `count` (default 3) identical observations so the
 * init-consistency gate bootstraps the anchor. The 4th observation onward is
 * validated against that anchor.
 */
function warmUp<V>(tracker: BaseTracker<V>, value: V, baseTs: number, conf = 0.9, count = 3): void {
  for (let i = 0; i < count; i++) {
    tracker.observe(value, conf, baseTs + i * 1000)
  }
}

// ─────────────────────────────────────────────────────────────
// A. MpTracker
// ─────────────────────────────────────────────────────────────
describe('[A] MpTracker', () => {
  it('A1: normal recovery cur 100->110 is accepted', () => {
    const tracker = new MpTracker({ maxAnchor: 242 })
    warmUp<MpValue>(tracker, { cur: 100, max: 242 }, 1000, 0.9)
    const r = tracker.observe({ cur: 110, max: 242 }, 0.9, 5000)
    expect(r.accepted).toBe(true)
    expect(r.value).toEqual({ cur: 110, max: 242 })
  })

  it('A2: continuous recovery 100->110->120 accepted stepwise', () => {
    const tracker = new MpTracker({ maxAnchor: 242 })
    warmUp<MpValue>(tracker, { cur: 100, max: 242 }, 1000, 0.9)
    tracker.observe({ cur: 110, max: 242 }, 0.9, 5000)
    const r = tracker.observe({ cur: 120, max: 242 }, 0.9, 7000)
    expect(r.accepted).toBe(true)
    expect(r.value).toEqual({ cur: 120, max: 242 })
  })

  it('A3: stale max=197 vs anchor 242 lowers posterior', () => {
    const tracker = new MpTracker({ maxAnchor: 242 })
    warmUp<MpValue>(tracker, { cur: 100, max: 242 }, 1000, 0.9)
    const rNormal = tracker.observe({ cur: 101, max: 242 }, 0.9, 5000)

    const tracker2 = new MpTracker({ maxAnchor: 242 })
    warmUp<MpValue>(tracker2, { cur: 100, max: 242 }, 1000, 0.9)
    const rStale = tracker2.observe({ cur: 101, max: 197 }, 0.9, 5000)

    expect(rStale.posterior).toBeLessThan(rNormal.posterior)
    expect(rStale.posterior).toBeLessThan(rNormal.posterior * 0.8)
  })

  it('A4: cur > max is a catastrophic anomaly (rejected)', () => {
    const tracker = new MpTracker({ maxAnchor: 242 })
    warmUp<MpValue>(tracker, { cur: 100, max: 242 }, 1000, 0.9)
    const r = tracker.observe({ cur: 300, max: 242 }, 0.9, 5000)
    expect(r.accepted).toBe(false)
  })

  it('A5: max anchor mismatch lowers posterior, force accepts', () => {
    const tracker = new MpTracker({ maxAnchor: 242 })
    warmUp<MpValue>(tracker, { cur: 100, max: 242 }, 1000, 0.9)

    const staleValue: MpValue = { cur: 100, max: 300 }
    const r = tracker.observe(staleValue, 0.9, 5000)
    expect(r.posterior).toBeLessThan(0.55)

    const forced = tracker.observe(staleValue, 0.9, 6000, { force: true })
    expect(forced.accepted).toBe(true)
    expect(forced.reason).toBe('user_force')
    expect(tracker.trusted).toEqual(staleValue)
  })

  it('A6: huge jump cur 100->250 in 0.1s is an anomaly (rejected)', () => {
    const tracker = new MpTracker({ maxAnchor: 242 })
    warmUp<MpValue>(tracker, { cur: 100, max: 242 }, 1000, 0.9)
    const r = tracker.observe({ cur: 250, max: 242 }, 0.9, 3100)
    expect(r.accepted).toBe(false)
  })

  it('A7: very low OCR confidence (0.25) produces an anomaly (rejected)', () => {
    const tracker = new MpTracker({ maxAnchor: 242 })
    warmUp<MpValue>(tracker, { cur: 100, max: 242 }, 1000, 0.9)
    const r = tracker.observe({ cur: 105, max: 242 }, 0.25, 5000)
    expect(r.accepted).toBe(false)
  })

  it('A8: force=true -> reason=user_force, accepted, anchor updated', () => {
    const tracker = new MpTracker({ maxAnchor: 242 })
    const forcedValue: MpValue = { cur: 50, max: 242 }
    const r = tracker.observe(forcedValue, 0.9, 1000, { force: true })
    expect(r.accepted).toBe(true)
    expect(r.reason).toBe('user_force')
    expect(r.value).toEqual(forcedValue)
    expect(tracker.trusted).toEqual(forcedValue)
  })

  it('A9: reset clears anchor, then 3 consistent observations re-learn it', () => {
    const tracker = new MpTracker({ maxAnchor: 242 })
    warmUp<MpValue>(tracker, { cur: 100, max: 242 }, 1000, 0.9)
    tracker.observe({ cur: 110, max: 242 }, 0.9, 5000)

    tracker.reset()
    expect(tracker.trusted).toBeNull()

    const newVal: MpValue = { cur: 50, max: 242 }
    const r1 = tracker.observe(newVal, 0.9, 10000)
    expect(r1.reason).toBe('init_pending')
    expect(tracker.trusted).toBeNull()

    const r2 = tracker.observe(newVal, 0.9, 11000)
    expect(r2.reason).toBe('init_pending')
    expect(tracker.trusted).toBeNull()

    const r3 = tracker.observe(newVal, 0.9, 12000)
    expect(r3.reason).toBe('init_consistency')
    expect(r3.value).toEqual(newVal)
    expect(tracker.trusted).toEqual(newVal)
  })
})

// ─────────────────────────────────────────────────────────────
// B. ExpTracker
// ─────────────────────────────────────────────────────────────
describe('[B] ExpTracker', () => {
  it('B1: normal hunting 50.0001->50.0050->50.0100 accepted', () => {
    const tracker = new ExpTracker()
    warmUp<number>(tracker, 50.0001, 1000, 0.9)
    tracker.observe(50.005, 0.9, 5000)
    const r = tracker.observe(50.01, 0.9, 7000)
    expect(r.accepted).toBe(true)
    expect(r.value).toBe(50.01)
  })

  it('B2: big jump (50->60) is accepted but with a reduced posterior', () => {
    const tracker = new ExpTracker()
    warmUp<number>(tracker, 50.0, 1000, 0.9)
    const r = tracker.observe(60.0, 0.9, 5000)
    expect(r.accepted).toBe(true)
    expect(r.value).toBe(60.0)
    expect(r.posterior).toBeLessThan(0.85)
  })

  it('B3: death drop -8% (50->42) yields a reduced posterior', () => {
    const tracker = new ExpTracker()
    warmUp<number>(tracker, 50.0, 1000, 0.9)
    const r = tracker.observe(42.0, 0.9, 5000)
    expect(typeof r.accepted).toBe('boolean')
    expect(r.posterior).toBeLessThan(0.7)
  })

  it('B4: catastrophic digit loss (50.86->0.86) is an anomaly (rejected)', () => {
    const tracker = new ExpTracker()
    warmUp<number>(tracker, 50.86, 1000, 0.9)
    const r = tracker.observe(0.86, 0.9, 5000)
    expect(r.accepted).toBe(false)
  })

  it('B5: 0.0 and 99.9999 pass shape check', () => {
    const tracker = new ExpTracker()
    const r1 = tracker.observe(0.0, 0.9, 1000)
    expect(r1.reason).not.toBe('reject')

    const tracker2 = new ExpTracker()
    const r2 = tracker2.observe(99.9999, 0.9, 1000)
    expect(r2.reason).not.toBe('reject')
  })

  it('B6: 100.0% fails shape check -> reject', () => {
    const tracker = new ExpTracker()
    const r = tracker.observe(100.0, 0.9, 1000)
    expect(r.reason).toBe('reject')
    expect(r.accepted).toBe(false)
  })

  it('B7: integer-part confusion (50.0100->58.0100) reduces posterior', () => {
    const tracker = new ExpTracker()
    warmUp<number>(tracker, 50.01, 1000, 0.9)
    const r = tracker.observe(58.01, 0.9, 5000)
    expect(r.posterior).toBeLessThan(0.65)
    expect(typeof r.accepted).toBe('boolean')
  })
})

// ─────────────────────────────────────────────────────────────
// C. LevelTracker
// ─────────────────────────────────────────────────────────────
describe('[C] LevelTracker', () => {
  it('C1: same level (Lv.29 held) is accepted', () => {
    const tracker = new LevelTracker()
    warmUp<number>(tracker, 29, 1000, 0.9)
    const r = tracker.observe(29, 0.9, 5000)
    expect(r.accepted).toBe(true)
    expect(r.value).toBe(29)
  })

  it('C2: normal level-up (29->30) is accepted', () => {
    const tracker = new LevelTracker()
    warmUp<number>(tracker, 29, 1000, 0.9)
    const r = tracker.observe(30, 0.9, 5000)
    expect(r.accepted).toBe(true)
    expect(r.value).toBe(30)
  })

  it('C3: 2-level jump (29->31) is less confident than a 1-level up', () => {
    const tracker = new LevelTracker()
    warmUp<number>(tracker, 29, 1000, 0.9)
    const r2 = tracker.observe(31, 0.9, 5000)

    const tracker2 = new LevelTracker()
    warmUp<number>(tracker2, 29, 1000, 0.9)
    const r1 = tracker2.observe(30, 0.9, 5000)

    expect(r2.posterior).toBeLessThan(r1.posterior)
    expect(r2.posterior).toBeLessThan(r1.posterior * 0.85)
  })

  it('C4: large jump (29->50) is an anomaly (rejected)', () => {
    const tracker = new LevelTracker()
    warmUp<number>(tracker, 29, 1000, 0.9)
    const r = tracker.observe(50, 0.9, 5000)
    expect(r.accepted).toBe(false)
  })

  it('C5: level-down (29->23) is an anomaly (rejected)', () => {
    const tracker = new LevelTracker()
    warmUp<number>(tracker, 29, 1000, 0.9)
    const r = tracker.observe(23, 0.9, 5000)
    expect(r.accepted).toBe(false)
  })

  it('C6: range check — 0 and 100 rejected; 1 and 99 pass shape', () => {
    expect(new LevelTracker().observe(0, 0.9, 1000).reason).toBe('reject')
    expect(new LevelTracker().observe(100, 0.9, 1000).reason).toBe('reject')
    expect(new LevelTracker().observe(1, 0.9, 1000).reason).not.toBe('reject')
    expect(new LevelTracker().observe(99, 0.9, 1000).reason).not.toBe('reject')
  })
})

// ─────────────────────────────────────────────────────────────
// D. AdenaTracker
// ─────────────────────────────────────────────────────────────
describe('[D] AdenaTracker', () => {
  it('D1: monotonic increase (1000->1500->2000) accepted', () => {
    const tracker = new AdenaTracker()
    warmUp<number>(tracker, 1000, 1000, 0.9)
    tracker.observe(1500, 0.9, 5000)
    const r = tracker.observe(2000, 0.9, 7000)
    expect(r.accepted).toBe(true)
    expect(r.value).toBe(2000)
  })

  it('D2: natural +1 digit (9000->12000) accepted', () => {
    const tracker = new AdenaTracker()
    warmUp<number>(tracker, 9000, 1000, 0.9)
    const r = tracker.observe(12000, 0.9, 5000)
    expect(r.accepted).toBe(true)
    expect(r.value).toBe(12000)
  })

  it('D3: catastrophic digit -2 (98913->185) is an anomaly (rejected)', () => {
    const tracker = new AdenaTracker()
    warmUp<number>(tracker, 98913, 1000, 0.9)
    const r = tracker.observe(185, 0.9, 5000)
    expect(r.accepted).toBe(false)
  })

  it('D4: Korean-unit detection — 100k+ then digit -5 flags suspect', () => {
    const tracker = new AdenaTracker()
    warmUp<number>(tracker, 100000, 1000, 0.9)
    tracker.observe(1, 0.9, 5000)
    expect(tracker.isKoreanUnitSuspect()).toBe(true)
  })

  it('D5: leading-digit loss (98913->8913) yields low posterior', () => {
    const tracker = new AdenaTracker()
    warmUp<number>(tracker, 98913, 1000, 0.9)
    const r = tracker.observe(8913, 0.9, 5000)
    expect(r.posterior).toBeLessThan(0.4)
  })

  it('D6: large jump >5x (1000->6001) yields reduced posterior', () => {
    const tracker = new AdenaTracker()
    warmUp<number>(tracker, 1000, 1000, 0.9)
    const r = tracker.observe(6001, 0.9, 5000)
    expect(r.posterior).toBeLessThan(0.55)
  })

  it('D7: small penalty decrease (10000->9000) accepted', () => {
    const tracker = new AdenaTracker()
    warmUp<number>(tracker, 10000, 1000, 0.9)
    const r = tracker.observe(9000, 0.9, 5000)
    expect(r.accepted).toBe(true)
    expect(r.value).toBe(9000)
  })

  it('D8: value=0 passes shape check', () => {
    const tracker = new AdenaTracker()
    const r = tracker.observe(0, 0.9, 1000)
    expect(r.reason).not.toBe('reject')
  })

  it('D9: force=true sets anchor directly, accepted', () => {
    const tracker = new AdenaTracker()
    const r = tracker.observe(500000, 0.9, 1000, { force: true })
    expect(r.accepted).toBe(true)
    expect(r.reason).toBe('user_force')
    expect(r.value).toBe(500000)
    expect(tracker.trusted).toBe(500000)
  })
})
