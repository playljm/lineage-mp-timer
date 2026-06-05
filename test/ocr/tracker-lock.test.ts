/**
 * Manual-input lock tests.
 *
 * When the user types a value (`observe(..., {force:true})`), it must be pinned for
 * `manualLockMs` so a subsequent (possibly misread) OCR observation cannot overwrite
 * it. MP omits the lock (its bar-pixel source is accurate and MP changes constantly);
 * EXP/level/adena pin manual values via createRegionTrackers.
 */
import { describe, it, expect } from 'vitest'
import { ExpTracker, createRegionTrackers } from '@core/ocr/tracker'

describe('manual-input lock', () => {
  it('pins a forced value and rejects OCR within the lock window', () => {
    const t = new ExpTracker({ manualLockMs: 600_000 })
    const t0 = 1_000_000

    const forced = t.observe(80.5, 1, t0, { force: true })
    expect(forced.accepted).toBe(true)
    expect(forced.reason).toBe('user_force')

    // OCR tries a different (misread) value 1s later — must be ignored.
    const locked = t.observe(88.4, 0.9, t0 + 1000)
    expect(locked.accepted).toBe(false)
    expect(locked.reason).toBe('user_locked')
    expect(locked.value).toBe(80.5) // still the pinned value

    // Even high-confidence repeats stay rejected while locked.
    expect(t.observe(88.4, 0.95, t0 + 2000).reason).toBe('user_locked')
    expect(t.trusted).toBe(80.5)
  })

  it('resumes normal OCR after the lock window expires', () => {
    const t = new ExpTracker({ manualLockMs: 600_000 })
    const t0 = 1_000_000
    t.observe(80.5, 1, t0, { force: true })
    // Same value after the lock expires → normal accept (no longer 'user_locked').
    const after = t.observe(80.5, 0.9, t0 + 600_001)
    expect(after.reason).not.toBe('user_locked')
    expect(after.accepted).toBe(true)
  })

  it('createRegionTrackers locks exp/level/adena but NOT mp', () => {
    const tr = createRegionTrackers()
    const t0 = 2_000_000

    tr.exp.observe(50, 1, t0, { force: true })
    expect(tr.exp.observe(61, 0.9, t0 + 1000).reason).toBe('user_locked')

    tr.level.observe(40, 1, t0, { force: true })
    expect(tr.level.observe(41, 0.9, t0 + 1000).reason).toBe('user_locked')

    tr.adena.observe(1000, 1, t0, { force: true })
    expect(tr.adena.observe(2000, 0.9, t0 + 1000).reason).toBe('user_locked')

    // MP has no lock — a fresh OCR value flows through the normal pipeline.
    tr.mp.observe({ cur: 300, max: 320 }, 1, t0, { force: true })
    expect(tr.mp.observe({ cur: 301, max: 320 }, 0.95, t0 + 1000).reason).not.toBe('user_locked')
  })
})
