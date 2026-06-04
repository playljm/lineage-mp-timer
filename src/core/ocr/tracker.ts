/**
 * Authoritative temporal validators for recognized region values (MP/EXP/Level/Adena).
 *
 * Port of the v2.x `src/js/bayesian-tracker.js` Bayesian temporal tracker, with one
 * decisive semantic change: in v2.x the tracker ran in DRY-RUN — it computed a
 * posterior and an `anomaly` flag but never actually vetoed a value (the legacy
 * pipeline only logged its verdict). Here the tracker is AUTHORITATIVE: `observe()`
 * returns `accepted: boolean`, and a rejected observation does not advance the anchor.
 *
 * The posterior is the same shape as v2.x:
 *
 *   posterior = sqrt(prior * (temporal * rate)) * ocrConfidence
 *
 * where
 *   - `prior`    — domain-plausibility of the value in isolation (cur<=max, EXP<100, …)
 *   - `temporal` — plausibility of the value given the last trusted value and elapsed time
 *   - `rate`     — adaptive EMA rate-of-change gate (neutral 1.0 until the EMA warms up)
 *   - `ocr`      — the OCR/voting confidence supplied by the caller
 *
 * Anomaly handling mirrors v2.x: an init-consistency gate bootstraps the first anchor,
 * and an anomaly-consistency gate force-promotes a genuinely-changed value once it
 * repeats N times (a misread rarely repeats identically). EXP and ADENA additionally
 * apply confusion-pair / digit-loss priors; ADENA detects Korean-unit (>=100k)
 * compression and shortens its anomaly-consistency gate while in that regime.
 *
 * PURITY: this module never reads the wall clock. Every observation's timestamp is
 * passed in as the `nowMs` argument. DOM-free and node-free.
 */
import type { RegionKind } from './types'

/** Outcome of a single authoritative `observe()` call. */
export interface ObserveResult<V> {
  /** Authoritative verdict: was this observation accepted as the new trusted value? */
  accepted: boolean
  /**
   * The value the tracker now trusts. When accepted, this is the observed value;
   * when rejected, this is the previously-trusted value (or `null` if none yet).
   */
  value: V | null
  /** Combined posterior in 0..1 — `sqrt(prior * temporal * rate) * ocrConfidence`. */
  posterior: number
  /** Provenance / decision branch, useful for the diagnostics drawer. */
  reason: ObserveReason
}

/** Why `observe()` returned the verdict it did. */
export type ObserveReason =
  | 'user_force' // caller forced the value (manual entry / tracker-now)
  | 'reject' // failed shape validation
  | 'init_pending' // no anchor yet, awaiting N consistent observations
  | 'init_consistency' // anchor bootstrapped after N consistent observations
  | 'normal' // accepted: posterior >= threshold
  | 'anomaly_consistency' // force-accepted: anomaly repeated N times -> real change
  | 'low_posterior' // rejected: posterior < threshold

/** Per-region temporal value shapes carried by the trackers. */
export interface MpValue {
  cur: number
  max: number
}
export type ExpValue = number
export type LevelValue = number
export type AdenaValue = number

export interface BaseTrackerOptions {
  /** Diagnostic label. */
  label?: string
  /** Ring-buffer length for the observation history. Default 20. */
  bufferSize?: number
  /** posterior < threshold marks an anomaly. Default 0.3. */
  posteriorThreshold?: number
  /** Consistent observations required to bootstrap the first anchor. Default 3. */
  initConsistencyThreshold?: number
  /** Consecutive consistent anomalies that force an anchor update. Default 5. */
  anomalyConsistencyThreshold?: number
  /** EMA weight on the newest rate sample. Default 0.3. */
  rateEmaAlpha?: number
}

/** Extra `observe()` controls. */
export interface ObserveOptions {
  /** Bypass all gates and force-accept the value (manual entry). */
  force?: boolean
  /** Per-call override of `posteriorThreshold`. */
  threshold?: number
}

interface HistoryEntry<V> {
  value: V
  ts: number
  ocrConfidence: number
  accepted: boolean
  posterior: number
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/**
 * Shared temporal-validation machinery. Subclasses supply the domain shape check,
 * the prior score, the temporal score, and the scalar projection used for the
 * adaptive rate gate.
 */
export abstract class BaseTracker<V> {
  readonly label: string
  protected readonly bufferSize: number
  protected readonly posteriorThreshold: number
  protected readonly initConsistencyThreshold: number
  protected anomalyConsistencyThreshold: number
  private readonly rateEmaAlpha: number

  protected history: HistoryEntry<V>[] = []
  protected lastTrusted: V | null = null
  protected lastTrustedTs = 0
  protected anomalyStreak = 0

  private rateEma: number | null = null
  private rateVar: number | null = null

  protected constructor(opts: BaseTrackerOptions = {}) {
    this.label = opts.label ?? 'unknown'
    this.bufferSize = opts.bufferSize ?? 20
    this.posteriorThreshold = opts.posteriorThreshold ?? 0.3
    this.initConsistencyThreshold = opts.initConsistencyThreshold ?? 3
    this.anomalyConsistencyThreshold = opts.anomalyConsistencyThreshold ?? 5
    this.rateEmaAlpha = opts.rateEmaAlpha ?? 0.3
  }

  /** The currently trusted value, or `null` if no anchor has been established. */
  get trusted(): V | null {
    return this.lastTrusted
  }

  /**
   * Authoritatively validate one observation.
   *
   * @param value          region value (shape is subclass-specific)
   * @param ocrConfidence  OCR/voting confidence in 0..1
   * @param nowMs          observation timestamp in ms — ALWAYS passed in, never read here
   * @param opts           force / threshold overrides
   */
  observe(
    value: V,
    ocrConfidence: number,
    nowMs: number,
    opts: ObserveOptions = {}
  ): ObserveResult<V> {
    // Manual entry bypasses every gate and force-updates the anchor.
    if (opts.force) {
      this.updateRateEma(value, nowMs)
      this.commit(value, nowMs, ocrConfidence, true, 1.0)
      this.anomalyStreak = 0
      return { accepted: true, value, posterior: 1.0, reason: 'user_force' }
    }

    if (value == null || !this.isValueShape(value)) {
      return { accepted: false, value: this.lastTrusted, posterior: 0, reason: 'reject' }
    }

    const prior = this.priorScore(value)
    const temporal = this.temporalScore(value, nowMs)
    const rate = this.rateScore(value, nowMs)
    const ocr = clamp01(ocrConfidence)

    // Independence approximation: rate is folded into temporal as a multiplicative
    // penalty (neutral 1.0), then geometric-mean with the prior, scaled by OCR trust.
    const temporalCombined = temporal * rate
    const posterior = Math.sqrt(prior * temporalCombined) * ocr

    const threshold = opts.threshold != null ? opts.threshold : this.posteriorThreshold
    const anomaly = posterior < threshold

    // No anchor yet: bootstrap once `initConsistencyThreshold` identical values land.
    if (this.lastTrusted == null) {
      this.record(value, nowMs, ocr, false, posterior)
      if (this.isConsistentRecent(value, this.initConsistencyThreshold)) {
        this.updateRateEma(value, nowMs)
        this.commit(value, nowMs, ocr, true, posterior)
        this.anomalyStreak = 0
        return { accepted: true, value, posterior, reason: 'init_consistency' }
      }
      return { accepted: false, value: null, posterior, reason: 'init_pending' }
    }

    if (anomaly) {
      this.anomalyStreak++
      // A real change (vs a misread) repeats identically; promote after N consistent.
      if (
        this.anomalyStreak >= this.anomalyConsistencyThreshold &&
        this.isConsistentRecent(value, this.anomalyConsistencyThreshold)
      ) {
        this.updateRateEma(value, nowMs)
        this.commit(value, nowMs, ocr, true, posterior)
        this.anomalyStreak = 0
        return { accepted: true, value, posterior, reason: 'anomaly_consistency' }
      }
      this.record(value, nowMs, ocr, false, posterior)
      return { accepted: false, value: this.lastTrusted, posterior, reason: 'low_posterior' }
    }

    // Normal acceptance.
    this.anomalyStreak = 0
    this.updateRateEma(value, nowMs)
    this.commit(value, nowMs, ocr, true, posterior)
    return { accepted: true, value, posterior, reason: 'normal' }
  }

  /** Directly set the anchor (e.g. when the user enters a tracker-NOW value). */
  setAnchor(value: V, nowMs: number): void {
    this.lastTrusted = value
    this.lastTrustedTs = nowMs
    this.anomalyStreak = 0
    this.rateEma = null
    this.rateVar = null
  }

  /** Forget all state. */
  reset(): void {
    this.history = []
    this.lastTrusted = null
    this.lastTrustedTs = 0
    this.anomalyStreak = 0
    this.rateEma = null
    this.rateVar = null
  }

  // ── Adaptive rate EMA ───────────────────────────────────────────────────────

  /** Update the rate EMA whenever a value is committed (rate = |Δscalar| / Δt). */
  private updateRateEma(value: V, nowMs: number): void {
    if (this.lastTrusted == null || this.lastTrustedTs === 0) return
    const dt = Math.max(0.1, (nowMs - this.lastTrustedTs) / 1000)
    const scalar = this.extractScalar(value)
    const lastScalar = this.extractScalar(this.lastTrusted)
    if (scalar == null || lastScalar == null) return
    const rate = Math.abs(scalar - lastScalar) / dt
    const alpha = this.rateEmaAlpha
    if (this.rateEma == null) {
      this.rateEma = rate
      this.rateVar = 0
    } else {
      const diff = rate - this.rateEma
      this.rateEma += alpha * diff
      this.rateVar = (1 - alpha) * ((this.rateVar ?? 0) + alpha * diff * diff)
    }
  }

  /**
   * Penalize observations whose rate exceeds the learned EMA ± 2σ. Neutral (1.0)
   * until the EMA has warmed up, since rate validation only makes sense post-learning.
   */
  private rateScore(value: V, nowMs: number): number {
    if (this.lastTrusted == null || this.rateEma == null) return 1.0
    const dt = Math.max(0.1, (nowMs - this.lastTrustedTs) / 1000)
    const scalar = this.extractScalar(value)
    const lastScalar = this.extractScalar(this.lastTrusted)
    if (scalar == null || lastScalar == null) return 0.8
    const rate = Math.abs(scalar - lastScalar) / dt
    const sigma = Math.sqrt(Math.max(0, this.rateVar ?? 0))
    const upper = this.rateEma + 2 * sigma
    const effectiveUpper = Math.max(upper, this.rateEma * 3, 1.0)
    if (rate <= effectiveUpper) return 1.0
    const excess = (rate - effectiveUpper) / Math.max(effectiveUpper, 1.0)
    if (excess < 1) return 0.5
    if (excess < 3) return 0.25
    return 0.1
  }

  // ── History helpers ─────────────────────────────────────────────────────────

  private commit(value: V, nowMs: number, conf: number, accepted: boolean, posterior: number): void {
    this.lastTrusted = value
    this.lastTrustedTs = nowMs
    this.record(value, nowMs, conf, accepted, posterior)
  }

  private record(value: V, nowMs: number, conf: number, accepted: boolean, posterior: number): void {
    this.history.push({ value, ts: nowMs, ocrConfidence: conf, accepted, posterior })
    if (this.history.length > this.bufferSize) this.history.shift()
  }

  /**
   * True when the last `n` recorded values all equal `value`. The current
   * observation is already appended to history before this is called, so a run of
   * `n` identical entries means `n` consistent observations.
   */
  protected isConsistentRecent(value: V, n: number): boolean {
    if (n <= 0) return false
    const recent = this.history.slice(-n)
    if (recent.length < n) return false
    return recent.every((h) => this.valueEquals(h.value, value))
  }

  // ── Subclass extension points ───────────────────────────────────────────────

  /** Validate the structural shape / range of a region value. */
  protected abstract isValueShape(value: V): boolean
  /** Domain-plausibility of the value in isolation, 0..1. */
  protected abstract priorScore(value: V): number
  /** Plausibility given the last trusted value and elapsed time, 0..1. */
  protected abstract temporalScore(value: V, nowMs: number): number
  /** Project the value to a scalar for the rate gate, or `null` to skip. */
  protected abstract extractScalar(value: V): number | null
  /** Structural equality used by the consistency gates. */
  protected valueEquals(a: V, b: V): boolean {
    return a === b
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MpTracker — value: { cur, max }
// Domain: 0 <= cur <= max, max tracks the user anchor, cur change-rate < ~50/sec.
// ─────────────────────────────────────────────────────────────────────────────

export interface MpTrackerOptions extends BaseTrackerOptions {
  /** Expected MP `max`; observed `max` deviating >5% is penalized. */
  maxAnchor?: number | null
}

export class MpTracker extends BaseTracker<MpValue> {
  private maxAnchor: number | null

  constructor(opts: MpTrackerOptions = {}) {
    super({ label: 'MP', ...opts })
    this.maxAnchor = opts.maxAnchor ?? null
  }

  setMaxAnchor(max: number): void {
    this.maxAnchor = max
  }

  protected isValueShape(v: MpValue): boolean {
    return (
      v != null &&
      typeof v.cur === 'number' &&
      typeof v.max === 'number' &&
      v.cur >= 0 &&
      v.max > 0 &&
      Number.isFinite(v.cur) &&
      Number.isFinite(v.max)
    )
  }

  protected valueEquals(a: MpValue, b: MpValue): boolean {
    return a.cur === b.cur && a.max === b.max
  }

  protected extractScalar(value: MpValue): number | null {
    return typeof value.cur === 'number' ? value.cur : null
  }

  protected priorScore(value: MpValue): number {
    const { cur, max } = value
    if (cur > max) return 0.05 // impossible (catastrophic)
    if (cur < 0) return 0.01
    let score = 1.0
    if (this.maxAnchor && this.maxAnchor > 0) {
      const ratio = Math.abs(max - this.maxAnchor) / this.maxAnchor
      if (ratio > 0.05) score *= 0.3 // max anchor mismatch (5% tolerance)
    }
    const pct = cur / max
    if (pct < 0 || pct > 1.05) score *= 0.2
    return score
  }

  protected temporalScore(value: MpValue, nowMs: number): number {
    if (this.lastTrusted == null) return 0.7
    const dt = Math.max(0.1, (nowMs - this.lastTrustedTs) / 1000)
    const delta = value.cur - this.lastTrusted.cur
    const rate = Math.abs(delta) / dt // MP/sec
    // Natural recovery ~0.1-0.6 MP/sec; use/recovery bursts up to ~30 MP/sec.
    if (rate > 100) return 0.05 // catastrophic jump
    if (rate > 50) return 0.3
    if (rate > 20) return 0.7
    return 1.0
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ExpTracker — value: number (0..99.9999%)
// Domain: 0 <= % < 100, monotonic increase (death may decrease).
// Confusion-aware: integer-part misreads (0<->8, 5<->8, 6<->1) with a near-preserved
// fractional part are penalized via the prior.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Known integer-level OCR confusion pairs (per house confusion table): 0<->8, 5<->8,
 * 6<->1. Used to flag EXP misreads where the integer part jumps by a confusion-pair
 * difference while the fractional part is largely preserved.
 */
export const EXP_CONFUSION_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 8],
  [8, 0],
  [5, 8],
  [8, 5],
  [6, 1],
  [1, 6]
]

/**
 * Heuristic: does `current` look like an integer-digit confusion of `last`?
 * Criterion: integer-part difference equals one of the confusion-pair gaps AND the
 * fractional part is nearly preserved (|Δfrac| < 0.15).
 */
export function isExpConfusion(last: number, current: number): boolean {
  if (typeof last !== 'number' || typeof current !== 'number') return false
  const lastInt = Math.floor(last)
  const curInt = Math.floor(current)
  const intDiff = Math.abs(curInt - lastInt)
  if (intDiff === 0) return false
  const isPair = EXP_CONFUSION_PAIRS.some(([a, b]) => Math.abs(a - b) === intDiff)
  if (!isPair) return false
  const lastFrac = last - Math.floor(last)
  const curFrac = current - Math.floor(current)
  return Math.abs(curFrac - lastFrac) < 0.15
}

export class ExpTracker extends BaseTracker<ExpValue> {
  constructor(opts: BaseTrackerOptions = {}) {
    super({ label: 'EXP', ...opts })
  }

  protected isValueShape(v: ExpValue): boolean {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100
  }

  protected extractScalar(value: ExpValue): number | null {
    return value
  }

  protected priorScore(value: ExpValue): number {
    if (value < 0 || value >= 100) return 0.01
    if (this.lastTrusted != null && isExpConfusion(this.lastTrusted, value)) {
      return 0.3 // confusion-misread suspected — lower posterior so anomaly is easier
    }
    return 1.0
  }

  protected temporalScore(value: ExpValue, _nowMs: number): number {
    if (this.lastTrusted == null) return 0.7
    const delta = value - this.lastTrusted
    if (delta >= 0 && delta <= 1.0) return 1.0 // normal hunting gain
    if (delta > 1.0 && delta <= 10) return 0.4 // big jump (post-levelup anchor stale?)
    if (delta > 10) return 0.15 // very big jump (catastrophic misread)
    if (delta < 0 && delta >= -10) return 0.5 // small decrease (death)
    if (delta < -10) return 0.1 // catastrophic digit loss
    return 0.6
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LevelTracker — value: integer 1..99
// Domain: monotonic increase (delta 0 or +1 normal; otherwise suspect).
// ─────────────────────────────────────────────────────────────────────────────

export class LevelTracker extends BaseTracker<LevelValue> {
  constructor(opts: BaseTrackerOptions = {}) {
    super({ label: 'LEVEL', ...opts })
  }

  protected isValueShape(v: LevelValue): boolean {
    return Number.isInteger(v) && v >= 1 && v <= 99
  }

  protected extractScalar(value: LevelValue): number | null {
    return value
  }

  protected priorScore(value: LevelValue): number {
    if (!Number.isInteger(value) || value < 1 || value > 99) return 0.01
    return 1.0
  }

  protected temporalScore(value: LevelValue, _nowMs: number): number {
    if (this.lastTrusted == null) return 0.7
    const delta = value - this.lastTrusted
    if (delta === 0) return 1.0
    if (delta === 1) return 0.85 // normal level-up
    if (delta === 2) return 0.3 // fast 2-level-up possible (low level)
    if (delta > 2) return 0.1 // jump (suspect)
    if (delta < 0) return 0.02 // level-down (impossible)
    return 0.5
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AdenaTracker — value: integer (>=0)
// Domain: monotonic increase (penalties excepted), stable digit count, with
// Korean-unit (>=100k "X만") compression detection.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdenaTrackerOptions extends BaseTrackerOptions {
  /** Anchor value at/above which Korean-unit compression is suspected. Default 100000. */
  koreanThreshold?: number
}

export class AdenaTracker extends BaseTracker<AdenaValue> {
  private koreanUnitSuspect = false
  private koreanUnitSuspectAt = 0
  private catastrophicStreak = 0
  private catastrophicValue: number | null = null
  private readonly koreanThreshold: number

  constructor(opts: AdenaTrackerOptions = {}) {
    super({ label: 'ADENA', ...opts })
    this.koreanThreshold = opts.koreanThreshold ?? 100000
  }

  protected isValueShape(v: AdenaValue): boolean {
    return Number.isInteger(v) && v >= 0 && v < 1e10
  }

  protected extractScalar(value: AdenaValue): number | null {
    return value
  }

  protected priorScore(value: AdenaValue): number {
    if (!Number.isInteger(value) || value < 0) return 0.01
    if (value > 1e9) return 0.1 // >1 billion unrealistic
    return 1.0
  }

  protected temporalScore(value: AdenaValue, nowMs: number): number {
    const last = this.lastTrusted
    if (last == null) return 0.7
    const delta = value - last
    const lastDigits = last === 0 ? 0 : String(last).length
    const newDigits = value === 0 ? 0 : String(value).length
    const digitDiff = newDigits - lastDigits

    // Catastrophic digit drop (e.g. 5 digits -> 1-3 digits).
    if (digitDiff <= -2) {
      if (last >= this.koreanThreshold) this.trackCatastrophic(value, nowMs)
      return 0.03
    }
    // Single digit drop (leading-digit-loss suspected — anchor may be stale).
    if (digitDiff === -1) {
      if (last >= 10000) return 0.15
      return 0.4
    }
    // Natural +1 digit growth (normal hunting progress).
    if (digitDiff === 1 && value >= last * 1.0) return 0.95
    // +2 digits (suspect — very large jump).
    if (digitDiff >= 2) return 0.2

    // Same digit count.
    this.catastrophicStreak = 0
    this.catastrophicValue = null

    if (delta === 0) return 1.0
    if (delta > 0 && delta < last * 5) return 1.0 // monotonic increase
    if (delta > last * 5 && last > 0) return 0.3 // big jump
    if (delta < 0 && Math.abs(delta) < last * 0.3) return 0.6 // small penalty/decrease
    if (delta < 0) return 0.2
    return 0.5
  }

  /**
   * While anchored at >=100k, two consecutive catastrophic digit-loss observations
   * (values may differ — the digit-count loss is what matters) immediately flag a
   * Korean-unit-suspect, well before the slow 5x anomaly-consistency gate would fire.
   */
  private trackCatastrophic(value: AdenaValue, nowMs: number): void {
    const last = this.lastTrusted ?? 0
    const newDigits = value === 0 ? 0 : String(value).length
    const lastDigits = last === 0 ? 0 : String(last).length
    if (this.catastrophicValue != null) {
      const prevDigits = this.catastrophicValue === 0 ? 0 : String(this.catastrophicValue).length
      if (newDigits <= lastDigits - 2 && prevDigits <= lastDigits - 2) {
        this.catastrophicStreak++
        if (this.catastrophicStreak >= 2 && !this.koreanUnitSuspect) {
          this.koreanUnitSuspect = true
          this.koreanUnitSuspectAt = nowMs
        }
      } else {
        this.catastrophicStreak = 0
      }
    } else {
      this.catastrophicStreak = 1
    }
    this.catastrophicValue = value

    // First catastrophic at >=100k already marks suspect (matches v2.x behaviour).
    if (!this.koreanUnitSuspect) {
      this.koreanUnitSuspect = true
      this.koreanUnitSuspectAt = nowMs
    }
  }

  /** While anchored at >=100k, shorten the anomaly-consistency gate to 2. */
  private effectiveAnomalyConsistencyThreshold(): number {
    if (this.lastTrusted != null && this.lastTrusted >= this.koreanThreshold) return 2
    return this.anomalyConsistencyThreshold
  }

  override observe(
    value: AdenaValue,
    ocrConfidence: number,
    nowMs: number,
    opts: ObserveOptions = {}
  ): ObserveResult<AdenaValue> {
    const original = this.anomalyConsistencyThreshold
    this.anomalyConsistencyThreshold = this.effectiveAnomalyConsistencyThreshold()
    try {
      return super.observe(value, ocrConfidence, nowMs, opts)
    } finally {
      this.anomalyConsistencyThreshold = original
    }
  }

  isKoreanUnitSuspect(): boolean {
    return this.koreanUnitSuspect
  }

  resetKoreanUnit(): void {
    this.koreanUnitSuspect = false
    this.koreanUnitSuspectAt = 0
    this.catastrophicStreak = 0
    this.catastrophicValue = null
  }

  override reset(): void {
    super.reset()
    this.koreanUnitSuspect = false
    this.koreanUnitSuspectAt = 0
    this.catastrophicStreak = 0
    this.catastrophicValue = null
  }

  override setAnchor(value: AdenaValue, nowMs: number): void {
    super.setAnchor(value, nowMs)
    this.catastrophicStreak = 0
    this.catastrophicValue = null
  }
}

/** All region trackers indexed by `RegionKind`, for convenient orchestration. */
export interface RegionTrackers {
  mp: MpTracker
  exp: ExpTracker
  level: LevelTracker
  adena: AdenaTracker
}

/** Construct a fresh tracker for each region. */
export function createRegionTrackers(opts?: {
  mp?: MpTrackerOptions
  exp?: BaseTrackerOptions
  level?: BaseTrackerOptions
  adena?: AdenaTrackerOptions
}): RegionTrackers {
  return {
    mp: new MpTracker(opts?.mp),
    exp: new ExpTracker(opts?.exp),
    level: new LevelTracker(opts?.level),
    adena: new AdenaTracker(opts?.adena)
  }
}

/** Narrow a `RegionKind` to its tracker type — handy in generic call sites. */
export type TrackerForRegion<R extends RegionKind> = R extends 'mp'
  ? MpTracker
  : R extends 'exp'
    ? ExpTracker
    : R extends 'level'
      ? LevelTracker
      : R extends 'adena'
        ? AdenaTracker
        : never
