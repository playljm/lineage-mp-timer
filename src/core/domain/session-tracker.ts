/**
 * Session hunt tracker — EXP/h, ADENA/h, level-up + next-1% ETA.
 *
 * Pure, dependency-free, DOM-free AND node-free. Behaviour-preserving port of
 * the v2.x app.js tracker math (`totalExpProgress`, the `dExp / hours` rates and
 * the `remainingPct / expRatePerHour * 3600` ETAs).
 *
 * Wall-clock independence: the core never reads `Date.now()` itself. Every
 * sample carries its own timestamp (`t`, ms epoch) supplied by the caller, and
 * "now" for derived ETAs is likewise passed in. This keeps the math fully
 * deterministic and unit-testable.
 *
 * EXP model (carried verbatim from v2.x):
 * - `expPct` is the 0..100 progress *within the current level*.
 * - Cumulative progress across level-ups is
 *     `(level - startLevel) * 100 + (expPct - startExpPct)`
 *   i.e. each level-up contributes a full 100 "percent" of progress.
 * - Rates are a linear fit over a sliding time window: total progress in the
 *   window divided by window duration, scaled to per-hour.
 *
 * Idle handling: gaps between consecutive samples longer than `idleGapMs` are
 * treated as AFK and excluded from elapsed/active time so they do not deflate
 * the measured rates.
 */

/** One timestamped observation of the player's session counters. */
export interface SessionSample {
  /** Epoch milliseconds the sample was observed. Supplied by the caller. */
  t: number
  /** EXP progress within the current level, 0..100 (e.g. 58.6840). */
  expPct: number
  /** Adena balance / accumulated adena at this instant. */
  adena: number
  /** Character level (1..). */
  level: number
}

/** Tunables for the tracker. All optional; sensible defaults applied. */
export interface SessionTrackerOptions {
  /**
   * Sliding window width in milliseconds. Rates are computed over at most this
   * much of the most-recent history. `0`/non-finite -> use the full session.
   * Default: full session (Infinity).
   */
  windowMs?: number
  /**
   * Minimum active elapsed time (ms) before rates/ETAs are emitted. Mirrors the
   * v2.x "30초 이후부터 표시" guard that avoids absurd rates from tiny denominators.
   * Default: 30_000.
   */
  minElapsedMs?: number
  /**
   * Gaps between consecutive samples longer than this (ms) are considered idle
   * (AFK) and excluded from active elapsed time. `0`/non-finite -> disabled.
   * Default: disabled (0).
   */
  idleGapMs?: number
}

/** Derived session metrics. Rates/ETAs are `null` until enough data exists. */
export interface SessionStats {
  /** EXP percent gained per hour (across level-ups), or null if not yet measurable. */
  expPerHour: number | null
  /** Adena gained per hour, or null if not yet measurable. */
  adenaPerHour: number | null
  /** Seconds until the next level-up, or null/Infinity when not derivable. */
  levelUpEta: number | null
  /** Seconds until the next whole +1% of EXP, or null/Infinity when not derivable. */
  next1PctEta: number | null
  /** Active elapsed time in seconds (idle gaps excluded when configured). */
  elapsed: number
  /** Total cumulative EXP progress over the window, in "percent" units. */
  expProgress: number
  /** Total adena gained over the window. */
  adenaProgress: number
  /** Number of samples currently retained. */
  sampleCount: number
}

const DEFAULT_MIN_ELAPSED_MS = 30_000
const MS_PER_HOUR = 3_600_000

/**
 * Cumulative EXP progress between two points, in "percent" units, treating each
 * level boundary as +100. Port of v2.x `totalExpProgress`.
 */
export function totalExpProgress(
  start: { level: number; expPct: number },
  end: { level: number; expPct: number }
): number {
  return (end.level - start.level) * 100 + (end.expPct - start.expPct)
}

/**
 * Active elapsed milliseconds across an ordered sample list, optionally
 * excluding idle gaps longer than `idleGapMs`. With idle handling disabled this
 * is simply `last.t - first.t`.
 */
export function activeElapsedMs(samples: readonly SessionSample[], idleGapMs = 0): number {
  if (samples.length < 2) return 0
  const idleEnabled = Number.isFinite(idleGapMs) && idleGapMs > 0
  if (!idleEnabled) {
    return Math.max(0, samples[samples.length - 1]!.t - samples[0]!.t)
  }
  let active = 0
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i]!.t - samples[i - 1]!.t
    if (dt > 0 && dt <= idleGapMs) active += dt
  }
  return active
}

/**
 * Convert a per-hour rate of EXP-percent into seconds to gain `pct` more
 * percent. Returns `Infinity` for a non-positive rate, mirroring v2.x where a
 * zero rate yields the "--:--:--" placeholder upstream.
 */
export function etaSecondsForPct(remainingPct: number, expPerHour: number): number {
  if (!Number.isFinite(expPerHour) || expPerHour <= 0) return Infinity
  if (remainingPct <= 0) return 0
  return (remainingPct / expPerHour) * 3600
}

/**
 * Compute session statistics from an ordered (ascending `t`) sample list.
 * Pure: callers pass timestamps in; nothing here reads the wall clock.
 */
export function computeSessionStats(
  samples: readonly SessionSample[],
  options: SessionTrackerOptions = {}
): SessionStats {
  const windowMs =
    options.windowMs != null && Number.isFinite(options.windowMs) && options.windowMs > 0
      ? options.windowMs
      : Infinity
  const minElapsedMs = options.minElapsedMs ?? DEFAULT_MIN_ELAPSED_MS
  const idleGapMs = options.idleGapMs ?? 0

  const empty: SessionStats = {
    expPerHour: null,
    adenaPerHour: null,
    levelUpEta: null,
    next1PctEta: null,
    elapsed: 0,
    expProgress: 0,
    adenaProgress: 0,
    sampleCount: samples.length
  }
  if (samples.length < 2) return empty

  // Restrict to the sliding window relative to the most-recent sample.
  const last = samples[samples.length - 1]!
  const cutoff = Number.isFinite(windowMs) ? last.t - windowMs : -Infinity
  let startIdx = 0
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i]!.t < cutoff) {
      startIdx = i + 1
      break
    }
  }
  const windowed = samples.slice(startIdx)
  if (windowed.length < 2) return empty

  const first = windowed[0]!
  const activeMs = activeElapsedMs(windowed, idleGapMs)
  const elapsed = Math.floor(activeMs / 1000)

  const expProgress = totalExpProgress(first, last)
  const adenaProgress = last.adena - first.adena

  // Guard tiny denominators exactly as v2.x: below the floor, no rates emitted.
  if (activeMs < minElapsedMs || activeMs <= 0) {
    return { ...empty, elapsed, expProgress, adenaProgress }
  }

  const hours = activeMs / MS_PER_HOUR
  const expPerHour = expProgress / hours
  const adenaPerHour = adenaProgress / hours

  const remainingPct = 100 - last.expPct
  const levelUpEta =
    expPerHour > 0 && remainingPct > 0 ? etaSecondsForPct(remainingPct, expPerHour) : Infinity
  const next1PctEta = expPerHour > 0 ? etaSecondsForPct(1, expPerHour) : Infinity

  return {
    expPerHour,
    adenaPerHour,
    levelUpEta,
    next1PctEta,
    elapsed,
    expProgress,
    adenaProgress,
    sampleCount: windowed.length
  }
}

/**
 * Stateful accumulator over timestamped session samples. Pure with respect to
 * the wall clock — feed samples via {@link ingest} (each carrying its own `t`)
 * and read derived metrics via {@link stats}.
 *
 * Samples are kept in ascending timestamp order; out-of-order timestamps are
 * inserted at the correct position so late OCR results do not corrupt the fit.
 * History older than `windowMs` (relative to the newest sample) is pruned.
 */
export class SessionTracker {
  private readonly options: Required<SessionTrackerOptions>
  private samples: SessionSample[] = []

  constructor(options: SessionTrackerOptions = {}) {
    this.options = {
      windowMs:
        options.windowMs != null && Number.isFinite(options.windowMs) && options.windowMs > 0
          ? options.windowMs
          : Infinity,
      minElapsedMs: options.minElapsedMs ?? DEFAULT_MIN_ELAPSED_MS,
      idleGapMs: options.idleGapMs ?? 0
    }
  }

  /** Drop all retained samples. */
  reset(): void {
    this.samples = []
  }

  /** Number of retained samples. */
  get size(): number {
    return this.samples.length
  }

  /** Timestamp of the most recent sample, or null if empty. */
  get lastTimestamp(): number | null {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1]!.t : null
  }

  /**
   * Ingest one sample. Inserts in ascending `t` order and prunes history that
   * falls outside the sliding window relative to the newest sample.
   */
  ingest(sample: SessionSample): void {
    if (!Number.isFinite(sample.t)) return
    const s = this.samples
    if (s.length === 0 || sample.t >= s[s.length - 1]!.t) {
      s.push(sample)
    } else {
      let lo = 0
      let hi = s.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (s[mid]!.t <= sample.t) lo = mid + 1
        else hi = mid
      }
      s.splice(lo, 0, sample)
    }
    this.prune()
  }

  /** Convenience: ingest many samples at once. */
  ingestAll(samples: readonly SessionSample[]): void {
    for (const sample of samples) this.ingest(sample)
  }

  /** Current derived statistics over the retained window. */
  stats(): SessionStats {
    return computeSessionStats(this.samples, this.options)
  }

  /** Defensive copy of the retained samples (ascending by `t`). */
  getSamples(): SessionSample[] {
    return this.samples.slice()
  }

  private prune(): void {
    const { windowMs } = this.options
    if (!Number.isFinite(windowMs) || this.samples.length === 0) return
    const cutoff = this.samples[this.samples.length - 1]!.t - windowMs
    // Keep one sample at/just-before the cutoff so the window spans it fully.
    let firstInside = 0
    for (let i = this.samples.length - 1; i >= 0; i--) {
      if (this.samples[i]!.t < cutoff) {
        firstInside = i
        break
      }
    }
    if (firstInside > 0) this.samples = this.samples.slice(firstInside)
  }
}
