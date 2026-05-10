// bayesian-tracker.js — Bayesian Temporal Tracker for OCR Validation
// v2.0.0 P1.T1.1 + T1.2 (스캐폴드 + 4종 Tracker 클래스)
//         P1.T1.3 (도메인 prior 정교화: adaptive rate, Kalman smoothing,
//                  Adena 한글 단위 조기 감지 강화, EXP confusion-aware)
//
// 역할: voteHybrid 결과를 시계열 + 도메인 prior로 검증해 trustedValue 채택.
//       기존 _verifyQueue/_paddleConsistency 등 ad-hoc 카운터를 통합 대체.
//
// API:
//   const t = new MpTracker({ maxAnchor: 242 });
//   const r = t.observe({ cur: 131, max: 242 }, Date.now(), 0.85);
//   // → { trustedValue, posterior, anomaly, source, reason?, smoothedValue? }
//
// 통합 위치 (T1.4): src/js/app.js voteHybrid(...) 4곳 후단 (MP/EXP/LEVEL/ADENA)
//
// 의존성: 없음 (Node + browser 양쪽 동작, DOM/Electron 의존 0)

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BayesianTrackers = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────
  // BaseTracker — 모든 region tracker의 공통 베이스
  // ─────────────────────────────────────────────────────────────────
  class BaseTracker {
    constructor(opts = {}) {
      this.label = opts.label || 'unknown';
      this.bufferSize = opts.bufferSize || 20;
      this.history = []; // [{value, ts, ocrConfidence, accepted, posterior}]
      this.lastTrusted = null;
      this.lastTrustedTs = 0;
      this.anomalyStreak = 0;
      // 일관 anomaly가 N회 연속이면 강제 anchor 갱신 (misread는 N회 일관 어려움)
      this.anomalyConsistencyThreshold = opts.anomalyConsistencyThreshold || 5;
      // posterior < threshold이면 anomaly로 판단 — region별 override 가능
      this.posteriorThreshold = opts.posteriorThreshold || 0.3;
      // anchor 없을 때 초기 학습 게이트 (3회 일관)
      this.initConsistencyThreshold = opts.initConsistencyThreshold || 3;

      // ── T1.3 추가: 적응형 rate EMA ──────────────────────────────
      // EMA(지수 이동 평균) for rate (scalar delta / dt)
      // α = 0.3 — 최근 관찰에 30% 가중, 과거에 70% 유지
      this._rateEmaAlpha = opts.rateEmaAlpha || 0.3;
      this._rateEma = null;   // EMA of rate (scalar/sec)
      this._rateVar = null;   // EMA of rate variance (for σ)
      // Kalman-style smoothing 계수 기본값 (동적 조정됨)
      this._kalmanAlphaBase = opts.kalmanAlphaBase || 0.6;
    }

    /**
     * @param {*} value - region별 값 (number 또는 {cur, max})
     * @param {number} ts - 관찰 시각 (ms)
     * @param {number} ocrConfidence - 0~1 OCR voting confidence
     * @param {object} opts - { force: boolean, threshold?: number }
     * @returns {{trustedValue, posterior, anomaly, source, reason?, smoothedValue?}}
     */
    observe(value, ts = Date.now(), ocrConfidence = 1.0, opts = {}) {
      // 사용자 직접 입력은 무조건 통과 (anchor 강제 갱신)
      if (opts.force) {
        this._updateRateEma(value, ts);
        this._commit(value, ts, ocrConfidence, true, 1.0);
        this.anomalyStreak = 0;
        return { trustedValue: value, posterior: 1.0, anomaly: false, source: 'user_force' };
      }

      // shape 검증
      if (value == null || !this._isValueShape(value)) {
        return {
          trustedValue: this.lastTrusted,
          posterior: 0,
          anomaly: true,
          source: 'reject',
          reason: 'invalid_shape'
        };
      }

      const prior = this._priorScore(value);          // 도메인 prior (0~1)
      const temporal = this._temporalScore(value, ts); // 시계열 일관성 (0~1)
      const rate = this._rateScore(value, ts);         // 적응형 rate anomaly (0~1)
      const ocr = clamp01(ocrConfidence);

      // 독립 가정 곱: rate는 temporal에 단순 페널티(중립=1.0)
      // posterior = sqrt(prior * temporal_with_rate) * ocr
      const temporalCombined = temporal * rate;
      const posterior = Math.sqrt(prior * temporalCombined) * ocr;

      // Kalman-style smoothed value 계산
      const smoothedValue = this._kalmanSmooth(value, ts, ocr, posterior);

      const threshold = opts.threshold != null ? opts.threshold : this.posteriorThreshold;
      const anomaly = posterior < threshold;

      // 첫 관찰 (anchor 없음) — initConsistencyThreshold 회 일관 시 학습
      if (this.lastTrusted == null) {
        this._record(value, ts, ocrConfidence, false, posterior);
        if (this._isConsistentRecent(value, this.initConsistencyThreshold)) {
          this._updateRateEma(value, ts);
          this._commit(value, ts, ocrConfidence, true, posterior);
          this.anomalyStreak = 0;
          return { trustedValue: value, posterior, anomaly: false, source: 'init_consistency', smoothedValue };
        }
        return { trustedValue: null, posterior, anomaly: true, source: 'init_pending', reason: 'awaiting_consistency', smoothedValue };
      }

      if (anomaly) {
        this.anomalyStreak++;
        // anomaly가 연속 동일 값으로 N회 → 진짜 변화로 인정 (anchor 강제 갱신)
        if (this.anomalyStreak >= this.anomalyConsistencyThreshold &&
            this._isConsistentRecent(value, this.anomalyConsistencyThreshold)) {
          this._updateRateEma(value, ts);
          this._commit(value, ts, ocrConfidence, true, posterior);
          this.anomalyStreak = 0;
          return { trustedValue: value, posterior, anomaly: false, source: 'anomaly_consistency', smoothedValue };
        }
        this._record(value, ts, ocrConfidence, false, posterior);
        return {
          trustedValue: this.lastTrusted,
          posterior,
          anomaly: true,
          source: 'low_posterior',
          reason: this._anomalyReason(value, prior, temporal, rate),
          smoothedValue
        };
      }

      // 정상 채택
      this.anomalyStreak = 0;
      this._updateRateEma(value, ts);
      this._commit(value, ts, ocrConfidence, true, posterior);
      return { trustedValue: value, posterior, anomaly: false, source: 'normal', smoothedValue };
    }

    // ── T1.3: 적응형 Rate EMA 업데이트 ─────────────────────────────
    /**
     * 신뢰된 값이 채택될 때마다 rate EMA를 갱신한다.
     * rate = |scalar(value) - scalar(lastTrusted)| / dt (scalar/sec)
     */
    _updateRateEma(value, ts) {
      if (this.lastTrusted == null || this.lastTrustedTs === 0) return;
      const dt = Math.max(0.1, (ts - this.lastTrustedTs) / 1000);
      const scalar = this._extractScalar(value);
      const lastScalar = this._extractScalar(this.lastTrusted);
      if (scalar == null || lastScalar == null) return;
      const rate = Math.abs(scalar - lastScalar) / dt;
      const alpha = this._rateEmaAlpha;
      if (this._rateEma == null) {
        this._rateEma = rate;
        this._rateVar = 0;
      } else {
        const diff = rate - this._rateEma;
        this._rateEma = this._rateEma + alpha * diff;
        // EMA of variance (Welford-style online)
        this._rateVar = (1 - alpha) * (this._rateVar + alpha * diff * diff);
      }
    }

    /**
     * 현재 observe의 rate가 EMA ± 2σ 밖이면 anomaly 페널티 반환.
     * EMA 미학습 시 중립 1.0 (rate 검증은 학습 후에만 의미 있음).
     * @returns {number} 0~1 (낮을수록 anomaly)
     */
    _rateScore(value, ts) {
      if (this.lastTrusted == null || this._rateEma == null) return 1.0;
      const dt = Math.max(0.1, (ts - this.lastTrustedTs) / 1000);
      const scalar = this._extractScalar(value);
      const lastScalar = this._extractScalar(this.lastTrusted);
      if (scalar == null || lastScalar == null) return 0.8;
      const rate = Math.abs(scalar - lastScalar) / dt;
      const sigma = Math.sqrt(Math.max(0, this._rateVar));
      const upper = this._rateEma + 2 * sigma;
      // EMA가 거의 0에 가까울 때는 최소 threshold 1.0 적용 (division guard)
      const effectiveUpper = Math.max(upper, this._rateEma * 3, 1.0);
      if (rate <= effectiveUpper) return 1.0;
      // 2σ 초과 비율에 따라 페널티
      const excess = (rate - effectiveUpper) / Math.max(effectiveUpper, 1.0);
      if (excess < 1) return 0.5;
      if (excess < 3) return 0.25;
      return 0.1; // 극단적 anomaly
    }

    // ── T1.3: Kalman-style smoothing ────────────────────────────────
    /**
     * smoothed = α × observed + (1-α) × predicted
     * predicted = lastTrusted + rate × dt (scalar 기준)
     * α는 ocrConfidence × posterior 기반으로 동적 조정.
     * 반환: smoothed value (subclass가 scalar→value 재구성 담당)
     */
    _kalmanSmooth(value, ts, ocr, posterior) {
      if (this.lastTrusted == null) return value;
      const dt = Math.max(0.1, (ts - this.lastTrustedTs) / 1000);
      const scalar = this._extractScalar(value);
      const lastScalar = this._extractScalar(this.lastTrusted);
      if (scalar == null || lastScalar == null) return value;
      // predicted scalar: lastTrusted + signed rate × dt
      const rate = this._rateEma != null ? this._rateEma : 0;
      const signedDelta = scalar - lastScalar;
      const sign = signedDelta >= 0 ? 1 : -1;
      const predictedScalar = lastScalar + sign * rate * dt;
      // α: 높을수록 observed에 가까움. OCR 신뢰도 + posterior 높을수록 높음
      const alpha = clamp01(this._kalmanAlphaBase * ocr * Math.sqrt(Math.max(0, posterior)));
      const smoothedScalar = alpha * scalar + (1 - alpha) * predictedScalar;
      return this._reconstructValue(value, smoothedScalar);
    }

    /**
     * 값에서 단일 스칼라를 추출 (rate 계산용).
     * 서브클래스에서 override: MpTracker → cur, 나머지 → 값 자체.
     * null 반환 시 rate 계산 스킵.
     */
    _extractScalar(value) {
      if (typeof value === 'number') return value;
      return null;
    }

    /**
     * smoothedScalar → 원본 value 형태로 재구성.
     * 서브클래스 override 가능. 기본은 number 그대로 반환.
     */
    _reconstructValue(originalValue, smoothedScalar) {
      if (typeof originalValue === 'number') return smoothedScalar;
      return originalValue; // 재구성 불가 시 원본 반환
    }

    _commit(value, ts, conf, accepted, posterior) {
      this.lastTrusted = value;
      this.lastTrustedTs = ts;
      this._record(value, ts, conf, accepted, posterior);
    }

    _record(value, ts, conf, accepted, posterior) {
      this.history.push({ value, ts, ocrConfidence: conf, accepted, posterior });
      if (this.history.length > this.bufferSize) this.history.shift();
    }

    _isConsistentRecent(value, n) {
      // BUG-2 fix (T1.6): 현재 observe의 value는 이미 _record로 history 말미에 들어가 있음.
      // 따라서 마지막 n개를 가져와서 모두 동일한지 비교 (N회 일관 = N개 모두 같음).
      if (n <= 0) return false;
      const recent = this.history.slice(-n);
      if (recent.length < n) return false;
      return recent.every(h => this._valueEquals(h.value, value));
    }

    _anomalyReason(value, prior, temporal, rate) {
      if (prior < 0.2) return `prior=${prior.toFixed(2)}`;
      if (temporal < 0.2) return `temporal=${temporal.toFixed(2)}`;
      if (rate < 0.2) return `rate_anomaly=${rate.toFixed(2)}`;
      return `prior=${prior.toFixed(2)},temporal=${temporal.toFixed(2)},rate=${rate.toFixed(2)}`;
    }

    _valueEquals(a, b) { return a === b; }
    _isValueShape(v) { return v != null; }
    _priorScore(_value) { return 1.0; }            // subclass override
    _temporalScore(_value, _ts) { return 1.0; }    // subclass override

    reset() {
      this.history = [];
      this.lastTrusted = null;
      this.lastTrustedTs = 0;
      this.anomalyStreak = 0;
      this._rateEma = null;
      this._rateVar = null;
    }

    /** 외부 setter (사용자가 트래커 NOW 입력 시 anchor 직접 설정) */
    setAnchor(value, ts = Date.now()) {
      this.lastTrusted = value;
      this.lastTrustedTs = ts;
      this.anomalyStreak = 0;
      // anchor 직접 설정 시 rate EMA 리셋 (이전 rate 기반 추정 무효)
      this._rateEma = null;
      this._rateVar = null;
    }

    /** 디버그 / 진단 리포트용 직렬화 */
    serialize() {
      return {
        label: this.label,
        lastTrusted: this.lastTrusted,
        lastTrustedTs: this.lastTrustedTs,
        anomalyStreak: this.anomalyStreak,
        historyLen: this.history.length,
        recentPosteriors: this.history.slice(-5).map(h => h.posterior),
        rateEma: this._rateEma != null ? parseFloat(this._rateEma.toFixed(4)) : null,
        rateSigma: this._rateVar != null ? parseFloat(Math.sqrt(this._rateVar).toFixed(4)) : null
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // MpTracker — value: { cur, max }
  // 도메인: 0 ≤ cur ≤ max, max는 사용자 anchor와 일치, cur 변화율 < 50/sec
  // ─────────────────────────────────────────────────────────────────
  class MpTracker extends BaseTracker {
    constructor(opts = {}) {
      super(Object.assign({ label: 'MP' }, opts));
      this.maxAnchor = opts.maxAnchor || null;
    }

    setMaxAnchor(max) { this.maxAnchor = max; }

    _isValueShape(v) {
      return v && typeof v.cur === 'number' && typeof v.max === 'number' &&
             v.cur >= 0 && v.max > 0 &&
             Number.isFinite(v.cur) && Number.isFinite(v.max);
    }

    _valueEquals(a, b) { return a.cur === b.cur && a.max === b.max; }

    // MP의 scalar = cur (rate 계산에 사용)
    _extractScalar(value) {
      if (value && typeof value.cur === 'number') return value.cur;
      return null;
    }

    // smoothedScalar → {cur: smoothed, max: original.max}
    _reconstructValue(originalValue, smoothedScalar) {
      if (originalValue && typeof originalValue.max === 'number') {
        return { cur: Math.max(0, Math.min(originalValue.max, Math.round(smoothedScalar))), max: originalValue.max };
      }
      return originalValue;
    }

    _priorScore(value) {
      const { cur, max } = value;
      if (cur > max) return 0.05;              // 불가능 (catastrophic)
      if (cur < 0) return 0.01;
      let score = 1.0;
      if (this.maxAnchor && this.maxAnchor > 0) {
        const ratio = Math.abs(max - this.maxAnchor) / this.maxAnchor;
        if (ratio > 0.05) score *= 0.3;        // max anchor 불일치 (5% 허용)
      }
      // cur/max 비율 sanity (0~100% 사이)
      const pct = cur / max;
      if (pct < 0 || pct > 1.05) score *= 0.2;
      return score;
    }

    _temporalScore(value, ts) {
      if (this.lastTrusted == null) return 0.7;
      const dt = Math.max(0.1, (ts - this.lastTrustedTs) / 1000);
      const delta = value.cur - this.lastTrusted.cur;
      const rate = Math.abs(delta) / dt; // MP/sec
      // 정상 회복: WIS 별 1~10 MP/tick × tick 16~64s → ~0.1~0.6 MP/sec
      // 사용/회복 burst: 최대 ~30 MP/sec
      if (rate > 100) return 0.05;             // 매우 큰 점프 (catastrophic 의심)
      if (rate > 50) return 0.3;
      if (rate > 20) return 0.7;
      return 1.0;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // ExpTracker — value: number (0~99.9999%)
  // 도메인: 0 ≤ % < 100, 단조증가 (사망 시 감소 가능),
  //         정수부 자릿수 1~2 (LEV<10 → 1자리, LEV≥10 → 2자리 — 게임 화면 따라 다름)
  //
  // T1.3: EXP confusion-aware — 0↔8, 5↔8, 6↔1 같은 자릿수 OCR misread 감지.
  //   패턴: 정수부(floor)는 일치하나 소수부가 크게 다름 → confusion 의심.
  //   confusion 의심 시 posterior를 추가로 낮춤 (prior 페널티 적용).
  // ─────────────────────────────────────────────────────────────────

  // 알려진 confusion pair (CLAUDE.md 기준)
  // 정수 단위로 misread 유발: 0↔8(8차), 5↔8(3차), 6↔1(1차 misread)
  // 자릿수 내 digit confusion → 정수부가 다를 수 있음
  // 여기서는 소수부 confusion 감지: intPart 동일 + fracPart 크게 다름
  const EXP_CONFUSION_PAIRS = [
    [0, 8], [8, 0],
    [5, 8], [8, 5],
    [6, 1], [1, 6],
  ];

  /**
   * lastTrusted와 value를 비교해 EXP confusion misread 의심 여부 반환.
   * 기준: 정수부 차이 = confusion pair 값 + 소수부 차이 크지 않음 (또는 소수부가 거의 같고 정수부만 pair 차이)
   * 더 단순한 heuristic: intPart 차이가 confusion pair 중 하나 + |fracDiff| < 0.2
   */
  function _isExpConfusion(last, current) {
    if (typeof last !== 'number' || typeof current !== 'number') return false;
    const lastInt = Math.floor(last);
    const curInt = Math.floor(current);
    const intDiff = Math.abs(curInt - lastInt);
    if (intDiff === 0) return false; // 정수부 같으면 이 감지 불필요
    // confusion pair 중 intDiff가 pair 차이와 일치하는지 확인
    const isPair = EXP_CONFUSION_PAIRS.some(([a, b]) => Math.abs(a - b) === intDiff);
    if (!isPair) return false;
    // 소수부 차이가 작으면 confusion 가능성 높음 (소수부가 거의 보존된 채 정수부만 바뀜)
    const lastFrac = last - Math.floor(last);
    const curFrac = current - Math.floor(current);
    const fracDiff = Math.abs(curFrac - lastFrac);
    return fracDiff < 0.15; // 소수부 0.15 미만 차이면 confusion 의심
  }

  class ExpTracker extends BaseTracker {
    constructor(opts = {}) {
      super(Object.assign({ label: 'EXP' }, opts));
    }

    _isValueShape(v) {
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100;
    }

    _priorScore(value) {
      if (value < 0 || value >= 100) return 0.01;
      // T1.3: confusion-aware prior 페널티
      if (this.lastTrusted != null && _isExpConfusion(this.lastTrusted, value)) {
        // confusion misread 의심 — posterior를 더 낮춰 anomaly 판단 쉽게
        return 0.3;
      }
      return 1.0;
    }

    _temporalScore(value, ts) {
      if (this.lastTrusted == null) return 0.7;
      const delta = value - this.lastTrusted;
      // 정상 사냥: +0.0001 ~ +0.5%/observe (1초당)
      if (delta >= 0 && delta <= 1.0) return 1.0;
      // 큰 점프 (+1~+10%): 레벨업 직후 anchor stale 가능 — 의심하나 검증 가능
      if (delta > 1.0 && delta <= 10) return 0.4;
      // 매우 큰 점프 (+10%+): catastrophic misread 또는 anchor stale 큼
      if (delta > 10) return 0.15;
      // 작은 감소 (사망 추정 -1~-10%)
      if (delta < 0 && delta >= -10) return 0.5;
      // 큰 감소 (-10%+ 또는 catastrophic 자릿수 손실)
      if (delta < -10) return 0.1;
      return 0.6;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // LevelTracker — value: integer 1~99
  // 도메인: 정수 1~99, 단조증가 (델타 0 또는 +1 정상, 그 외 의심)
  // ─────────────────────────────────────────────────────────────────
  class LevelTracker extends BaseTracker {
    constructor(opts = {}) {
      super(Object.assign({ label: 'LEVEL' }, opts));
    }

    _isValueShape(v) {
      return Number.isInteger(v) && v >= 1 && v <= 99;
    }

    _priorScore(value) {
      if (!Number.isInteger(value) || value < 1 || value > 99) return 0.01;
      return 1.0;
    }

    _temporalScore(value, ts) {
      if (this.lastTrusted == null) return 0.7;
      const delta = value - this.lastTrusted;
      if (delta === 0) return 1.0;
      if (delta === 1) return 0.85;            // 정상 레벨업
      if (delta === 2) return 0.3;             // 빠른 2 레벨업 가능 (저레벨)
      if (delta > 2) return 0.1;               // 점프 (의심)
      if (delta < 0) return 0.02;              // 레벨 다운 (불가능)
      return 0.5;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // AdenaTracker — value: integer (≥0)
  // 도메인: 단조증가 (페널티 제외), 자릿수 stable, 100k+ 한글 단위 진입 감지
  //
  // T1.3: 한글 단위 진입 자동 감지 강화
  //   - 기존: 5회 일관 후 anomaly_consistency 채택 (너무 느림)
  //   - 신규: 100k+ anchor 진입 시 anomalyConsistencyThreshold를 2로 낮춤
  //           + lastTrusted 기반 catastrophic 자릿수 손실 2회 일관 → 즉시 koreanUnitSuspect 마킹
  // ─────────────────────────────────────────────────────────────────
  class AdenaTracker extends BaseTracker {
    constructor(opts = {}) {
      super(Object.assign({ label: 'ADENA' }, opts));
      this.koreanUnitSuspect = false;          // 100k+ "X만" 압축 진입 의심
      this.koreanUnitSuspectAt = 0;
      // T1.3: 한글 단위 진입 후 조기 감지를 위한 catastrophic 연속 카운터
      this._catastrophicStreak = 0;
      this._catastrophicValue = null;
      // T1.3: 100k+ 진입 시 anomalyConsistencyThreshold를 낮출 임계
      this._koreanThreshold = opts.koreanThreshold || 100000;
    }

    _isValueShape(v) {
      return Number.isInteger(v) && v >= 0 && v < 1e10;
    }

    _priorScore(value) {
      if (!Number.isInteger(value) || value < 0) return 0.01;
      if (value > 1e9) return 0.1;             // 10억 초과 비현실적
      return 1.0;
    }

    _temporalScore(value, ts) {
      if (this.lastTrusted == null) return 0.7;
      const delta = value - this.lastTrusted;
      const lastDigits = this.lastTrusted === 0 ? 0 : String(this.lastTrusted).length;
      const newDigits = value === 0 ? 0 : String(value).length;
      const digitDiff = newDigits - lastDigits;

      // catastrophic 자릿수 감소 (5자리 → 1~3자리)
      if (digitDiff <= -2) {
        // T1.3: 100k+ anchor → koreanUnitSuspect 조기 마킹 + catastrophic 스트리크 추적
        if (this.lastTrusted >= this._koreanThreshold) {
          this._trackCatastrophic(value, ts);
        }
        return 0.03;
      }
      // 자릿수 감소 1 (leading-digit-loss 의심) — anchor stale 가능
      if (digitDiff === -1) {
        if (this.lastTrusted >= 10000) return 0.15;
        return 0.4;
      }
      // 자릿수 자연 증가 +1 (정상 사냥 progress)
      if (digitDiff === 1 && value >= this.lastTrusted * 1.0) return 0.95;
      // 자릿수 +2 (의심 — 매우 큰 점프)
      if (digitDiff >= 2) return 0.2;

      // 동일 자릿수
      // catastrophic 스트리크 정상화 (자릿수 회복)
      this._catastrophicStreak = 0;
      this._catastrophicValue = null;

      if (delta === 0) return 1.0;             // 변화 없음 (정상)
      if (delta > 0 && delta < this.lastTrusted * 5) return 1.0;  // 단조증가
      if (delta > this.lastTrusted * 5 && this.lastTrusted > 0) return 0.3; // 큰 점프
      // 감소 (페널티/리셋 가능)
      if (delta < 0 && Math.abs(delta) < this.lastTrusted * 0.3) return 0.6;
      if (delta < 0) return 0.2;
      return 0.5;
    }

    /**
     * T1.3: 100k+ anchor 상태에서 catastrophic 자릿수 감소가 연속 발생 시
     * 2회 일관이면 즉시 koreanUnitSuspect 마킹 (기존 5회 → 2회 단축).
     * 값이 다르더라도 자릿수 손실이 일관되면 OK (misread 값은 매번 다를 수 있음).
     */
    _trackCatastrophic(value, ts) {
      const newDigits = value === 0 ? 0 : String(value).length;
      const lastDigits = this.lastTrusted === 0 ? 0 : String(this.lastTrusted).length;
      // 자릿수 기준으로 일관성 체크 (값이 달라도 자릿수 손실이 지속되면 감지)
      if (this._catastrophicValue != null) {
        const prevDigits = this._catastrophicValue === 0 ? 0 : String(this._catastrophicValue).length;
        if (newDigits <= lastDigits - 2 && prevDigits <= lastDigits - 2) {
          // 2회 연속 catastrophic 자릿수 손실 → 즉시 한글 단위 의심 마킹
          this._catastrophicStreak++;
          if (this._catastrophicStreak >= 2 && !this.koreanUnitSuspect) {
            this.koreanUnitSuspect = true;
            this.koreanUnitSuspectAt = ts;
          }
        } else {
          // 자릿수 패턴이 달라지면 스트리크 리셋
          this._catastrophicStreak = 0;
        }
      } else {
        this._catastrophicStreak = 1;
      }
      this._catastrophicValue = value;

      // 기존 동작도 유지: 첫 번째 catastrophic에서도 100k+ 이면 suspect 마킹
      if (!this.koreanUnitSuspect) {
        this.koreanUnitSuspect = true;
        this.koreanUnitSuspectAt = ts;
      }
    }

    /** T1.3: observe() 전에 100k+ anchor 상태이면 anomalyConsistencyThreshold를 2로 조정 */
    _effectiveAnomalyConsistencyThreshold() {
      if (this.lastTrusted != null && this.lastTrusted >= this._koreanThreshold) {
        return 2; // 한글 단위 진입 후 2회 일관이면 즉시 강제 anchor 갱신 허용
      }
      return this.anomalyConsistencyThreshold;
    }

    /**
     * observe를 override해 anomalyConsistencyThreshold를 동적으로 조정.
     * 나머지 로직은 BaseTracker.observe() 위임.
     */
    observe(value, ts = Date.now(), ocrConfidence = 1.0, opts = {}) {
      // 100k+ anchor이면 threshold를 임시로 낮춤
      const originalThreshold = this.anomalyConsistencyThreshold;
      this.anomalyConsistencyThreshold = this._effectiveAnomalyConsistencyThreshold();
      const result = super.observe(value, ts, ocrConfidence, opts);
      this.anomalyConsistencyThreshold = originalThreshold;
      return result;
    }

    isKoreanUnitSuspect() { return this.koreanUnitSuspect; }
    resetKoreanUnit() {
      this.koreanUnitSuspect = false;
      this.koreanUnitSuspectAt = 0;
      this._catastrophicStreak = 0;
      this._catastrophicValue = null;
    }

    reset() {
      super.reset();
      this.koreanUnitSuspect = false;
      this.koreanUnitSuspectAt = 0;
      this._catastrophicStreak = 0;
      this._catastrophicValue = null;
    }

    setAnchor(value, ts = Date.now()) {
      super.setAnchor(value, ts);
      // anchor 직접 설정 시 catastrophic 스트리크도 리셋
      this._catastrophicStreak = 0;
      this._catastrophicValue = null;
    }

    serialize() {
      return Object.assign(super.serialize(), {
        koreanUnitSuspect: this.koreanUnitSuspect,
        koreanUnitSuspectAt: this.koreanUnitSuspectAt,
        catastrophicStreak: this._catastrophicStreak,
        effectiveAnomalyThreshold: this._effectiveAnomalyConsistencyThreshold()
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 유틸
  // ─────────────────────────────────────────────────────────────────
  function clamp01(x) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return 0;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  return { BaseTracker, MpTracker, ExpTracker, LevelTracker, AdenaTracker };
}));
