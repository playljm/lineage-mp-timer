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
  | 'user_locked' // rejected: a manual value is still pinned (within the lock window)
  | 'reject' // failed shape validation
  | 'init_pending' // no anchor yet, awaiting N consistent observations
  | 'init_consistency' // anchor bootstrapped after N consistent observations
  | 'normal' // accepted: posterior >= threshold
  | 'anomaly_consistency' // force-accepted: anomaly repeated N times -> real change
  | 'low_posterior' // rejected: posterior < threshold
  | 'stale_anchor_rebootstrap' // anchor invalidated after prolonged rejection — back to init

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
  /**
   * After a manual (`force`) observation, ignore OCR observations for this many ms
   * so a user-typed value is not immediately overwritten by a (possibly misread)
   * auto value. 0 = no lock (default). MP uses 0 (its bar-pixel source is accurate
   * and MP changes constantly); EXP/level/adena use a lock so a typed value
   * sticks where auto-ROI is unreliable. While locked, OCR observations agreeing
   * with the pinned value (within `manualUnlockTolerance`) 3 consecutive times
   * release the lock early — auto-recognition has proven it reads the same number.
   */
  manualLockMs?: number
  /**
   * Stale-anchor re-bootstrap window: when no observation has been accepted and
   * `low_posterior` rejections have persisted for this many ms, the anchor itself
   * is presumed wrong/stale, is invalidated, and the tracker falls back to the
   * init bootstrap (N consecutive identical observations — misread defence kept).
   * Default 45_000.
   */
  staleAnchorMs?: number
  /**
   * Minimum OCR confidence for an observation to participate in the init
   * bootstrap consistency window. Garbage reads (e.g. an uncalibrated "000000"
   * text fallback) must not seed the anchor. Low-confidence observations are
   * neither counted nor recorded pre-anchor, so they don't break the window
   * either. Default 0.5.
   */
  initMinConfidence?: number
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

/** Consecutive agreeing OCR observations that release a manual lock early. */
const MANUAL_AGREE_RELEASE_COUNT = 3

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
  private readonly manualLockMs: number
  private readonly staleAnchorMs: number
  private readonly initMinConfidence: number

  protected history: HistoryEntry<V>[] = []
  protected lastTrusted: V | null = null
  protected lastTrustedTs = 0
  protected anomalyStreak = 0
  /** Epoch ms until which OCR observations are ignored (set by a manual force). */
  protected manualLockUntilMs = 0
  /** Timestamp of the first `low_posterior` rejection since the last acceptance (0 = none). */
  protected rejectStreakStartMs = 0
  /** Consecutive locked OCR observations agreeing with the pinned manual value. */
  private manualAgreeStreak = 0

  private rateEma: number | null = null
  private rateVar: number | null = null

  protected constructor(opts: BaseTrackerOptions = {}) {
    this.label = opts.label ?? 'unknown'
    this.bufferSize = opts.bufferSize ?? 20
    this.posteriorThreshold = opts.posteriorThreshold ?? 0.3
    this.initConsistencyThreshold = opts.initConsistencyThreshold ?? 3
    this.anomalyConsistencyThreshold = opts.anomalyConsistencyThreshold ?? 5
    this.rateEmaAlpha = opts.rateEmaAlpha ?? 0.3
    this.manualLockMs = opts.manualLockMs ?? 0
    this.staleAnchorMs = opts.staleAnchorMs ?? 45_000
    this.initMinConfidence = opts.initMinConfidence ?? 0.5
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
    // Manual entry bypasses every gate, force-updates the anchor, and pins the
    // value: for the next `manualLockMs` ms, OCR observations are ignored so a
    // (possibly misread) auto value cannot overwrite what the user just typed.
    if (opts.force) {
      this.updateRateEma(value, nowMs)
      this.commit(value, nowMs, ocrConfidence, true, 1.0)
      this.anomalyStreak = 0
      this.manualLockUntilMs = this.manualLockMs > 0 ? nowMs + this.manualLockMs : 0
      this.manualAgreeStreak = 0
      return { accepted: true, value, posterior: 1.0, reason: 'user_force' }
    }

    // A freshly-typed value is pinned for the lock window — reject OCR until it
    // expires. EARLY RELEASE: when OCR repeatedly reads a value agreeing with the
    // pinned one (within the per-region tolerance, 3 consecutive times), auto
    // recognition has proven it tracks the same number — release the lock now and
    // process the current observation normally instead of sitting out the window.
    if (this.manualLockUntilMs > nowMs) {
      if (value != null && this.isValueShape(value) && this.manualAgrees(value)) {
        this.manualAgreeStreak++
        if (this.manualAgreeStreak < MANUAL_AGREE_RELEASE_COUNT) {
          return { accepted: false, value: this.lastTrusted, posterior: 0, reason: 'user_locked' }
        }
        this.manualLockUntilMs = 0
        this.manualAgreeStreak = 0
        // fall through — the 3rd agreeing observation is evaluated normally below
      } else {
        this.manualAgreeStreak = 0
        return { accepted: false, value: this.lastTrusted, posterior: 0, reason: 'user_locked' }
      }
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
      // Bootstrap conf gate: garbage reads (e.g. an uncalibrated "000000" text
      // fallback) must not seed the anchor. Below-gate observations are not
      // recorded, so they neither count toward nor break the consistency window.
      if (ocr < this.initMinConfidence) {
        return { accepted: false, value: null, posterior, reason: 'init_pending' }
      }
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
      // Record BEFORE the consistency check — same order as the init path — so the
      // current observation participates in the N-window. The previous
      // check-before-record order cost one extra frame (off-by-one): promotion
      // needed N+1 identical frames instead of the designed N.
      this.record(value, nowMs, ocr, false, posterior)
      if (
        this.anomalyStreak >= this.anomalyConsistencyThreshold &&
        this.isConsistentRecent(value, this.anomalyConsistencyThreshold)
      ) {
        this.updateRateEma(value, nowMs)
        this.commit(value, nowMs, ocr, true, posterior)
        this.anomalyStreak = 0
        return { accepted: true, value, posterior, reason: 'anomaly_consistency' }
      }
      // Stale-anchor re-bootstrap: rejections persisting `staleAnchorMs` without a
      // single acceptance mean the anchor itself is wrong/stale (e.g. polluted by a
      // misread, or a manual value the game has long moved past). Drop it and fall
      // back to the init bootstrap — its N-consecutive-identical gate (plus the
      // conf gate) keeps the misread defence intact.
      if (this.rejectStreakStartMs === 0) {
        this.rejectStreakStartMs = nowMs
      } else if (nowMs - this.rejectStreakStartMs >= this.staleAnchorMs) {
        this.invalidateAnchor()
        return { accepted: false, value: null, posterior, reason: 'stale_anchor_rebootstrap' }
      }
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
    this.manualLockUntilMs = 0
    this.rejectStreakStartMs = 0
    this.manualAgreeStreak = 0
  }

  /** Forget all state. */
  reset(): void {
    this.history = []
    this.lastTrusted = null
    this.lastTrustedTs = 0
    this.anomalyStreak = 0
    this.rateEma = null
    this.rateVar = null
    this.manualLockUntilMs = 0
    this.rejectStreakStartMs = 0
    this.manualAgreeStreak = 0
  }

  /**
   * Drop a stale anchor and return to the init-bootstrap phase. History is kept so
   * recent (rejected) observations can immediately count toward re-bootstrapping.
   */
  private invalidateAnchor(): void {
    this.lastTrusted = null
    this.lastTrustedTs = 0
    this.anomalyStreak = 0
    this.rateEma = null
    this.rateVar = null
    this.rejectStreakStartMs = 0
  }

  /** Does an OCR value agree with the pinned manual value (early lock release)? */
  private manualAgrees(value: V): boolean {
    if (this.lastTrusted == null) return false
    const a = this.extractScalar(value)
    const b = this.extractScalar(this.lastTrusted)
    if (a == null || b == null) return false
    return Math.abs(a - b) <= this.manualUnlockTolerance(b)
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
    const effectiveUpper = Math.max(upper, this.rateEma * 3, this.minRateFloor())
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
    this.rejectStreakStartMs = 0 // any acceptance ends the stale-anchor countdown
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
  /**
   * Absolute floor (units/sec) for the adaptive rate-gate upper bound. The default
   * 1.0 suits %-scale regions (EXP) and levels; ADENA overrides it because its
   * scalar moves by thousands per pickup — a 1 unit/sec floor made the first
   * pickup after idle always trip the rate gate.
   */
  protected minRateFloor(): number {
    return 1.0
  }
  /**
   * Agreement tolerance for early manual-lock release, in scalar units around the
   * pinned value. Default: 1% of the pinned scalar (relative). EXP overrides with
   * ±1 percentage point; LEVEL requires an exact match.
   */
  protected manualUnlockTolerance(pinnedScalar: number): number {
    return 0.01 * Math.abs(pinnedScalar)
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

  protected temporalScore(value: ExpValue, nowMs: number): number {
    if (this.lastTrusted == null) return 0.7
    // Elapsed-time relaxation (cf. MP's rate=|Δ|/dt): while the anchor is stale
    // (rejections stop it from advancing) the legitimate hunting delta keeps
    // growing, so the bands widen with dt at ~0.2 %p/s. g==1 (dt<=5s) reproduces
    // the original instantaneous bands at the live 1s tick; a Δ>10 jump becomes
    // correctable once 10·g catches up — the old dt-blind bands made a >10%p
    // divergence permanently unrecoverable at live conf 0.72.
    const dt = Math.max(0.1, (nowMs - this.lastTrustedTs) / 1000)
    const g = Math.max(1, 0.2 * dt)
    const delta = value - this.lastTrusted
    if (delta >= 0 && delta <= 1.0 * g) return 1.0 // normal hunting gain
    if (delta > 1.0 * g && delta <= 10 * g) return 0.4 // big jump (post-levelup anchor stale?)
    if (delta > 10 * g) return 0.15 // very big jump (catastrophic misread)
    if (delta < 0 && delta >= -10 * g) return 0.5 // small decrease (death)
    if (delta < -10 * g) return 0.1 // catastrophic digit loss
    return 0.6
  }

  /** ±1 percentage point on the 0..100 EXP scale (not relative to the value). */
  protected override manualUnlockTolerance(_pinnedScalar: number): number {
    return 1.0
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

  protected temporalScore(value: LevelValue, nowMs: number): number {
    if (this.lastTrusted == null) return 0.7
    // Elapsed-time relaxation: a stale anchor must accept the extra level-ups that
    // legitimately happened while it was frozen (budget ~1 level / minute). For
    // dt < 60s the budget is 1 — identical to the original dt-blind bands.
    const dt = Math.max(0.1, (nowMs - this.lastTrustedTs) / 1000)
    const budget = 1 + Math.floor(dt / 60)
    const delta = value - this.lastTrusted
    if (delta === 0) return 1.0
    if (delta >= 1 && delta <= budget) return 0.85 // normal level-up(s)
    if (delta === budget + 1) return 0.3 // fast 2-level-up possible (low level)
    if (delta > budget + 1) return 0.1 // jump (suspect)
    if (delta < 0) return 0.02 // level-down (impossible)
    return 0.5
  }

  /** Levels are integers — only an exact match counts as manual-lock agreement. */
  protected override manualUnlockTolerance(_pinnedScalar: number): number {
    return 0
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

  /**
   * ADENA moves thousands of units per pickup; the base 1 unit/sec floor made the
   * first pickup after idle (rateEma≈0) always trip the rate gate (diagnosis
   * scenario E: +500 pickup rejected for 6 frames). Floor scales with the anchor.
   */
  protected override minRateFloor(): number {
    return Math.max(5000, Math.abs(this.lastTrusted ?? 0) * 0.5)
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
  // MP omits the lock — its bar-pixel source is accurate and MP changes constantly.
  // EXP/level/adena pin a manually-typed value for 90s (auto-ROI can be unreliable).
  // Was 10 min: long enough for EXP to legitimately progress >10%p, which chained
  // into a permanent low_posterior freeze after unlock (live diagnosis B3). 90s
  // still blocks an immediate misread overwrite, and the lock releases early when
  // OCR agrees with the typed value 3 consecutive times.
  const MANUAL_LOCK_MS = 90_000
  return {
    // MP changes fast in combat (a single cast drops it a lot). The bar-pixel source
    // is high-confidence, so promote a genuinely-changed value after 3 consistent
    // reads (~3s) instead of the default 5 — the displayed MP tracks reality sooner.
    mp: new MpTracker({ anomalyConsistencyThreshold: 3, ...opts?.mp }),
    exp: new ExpTracker({ manualLockMs: MANUAL_LOCK_MS, ...opts?.exp }),
    level: new LevelTracker({ manualLockMs: MANUAL_LOCK_MS, ...opts?.level }),
    adena: new AdenaTracker({ manualLockMs: MANUAL_LOCK_MS, ...opts?.adena })
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
