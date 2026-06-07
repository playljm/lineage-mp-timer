/**
 * Tracker-freeze regression suite — "최초 인식 후 추적 정지" (라이브 진단
 * .omc/research/ocr-diagnosis-live.json findings[0]) 수정에 대한 회귀 단언.
 *
 * 수정 6종 (src/core/ocr/tracker.ts):
 *   1. anomaly 경로 record-before-check (off-by-one 제거: 승급 N+1 → N프레임)
 *   2. stale-anchor 재부트스트랩 (수락 없이 low_posterior 45s 지속 → 앵커 무효화
 *      → init_pending 회귀, reason='stale_anchor_rebootstrap')
 *   3. Exp/Level temporalScore dt-완화 (EXP g=max(1, 0.2·dt) band 스케일,
 *      LEVEL 분당 +1 레벨 budget) — freeze가 시간으로 풀리게 함
 *   4. manualLockMs 600_000 → 90_000 + 잠금 중 OCR ±1%p 3연속 일치 시 조기 해제
 *   5. init 부트스트랩 conf 게이트 (conf < 0.5는 일관성 카운트 제외)
 *   6. rate-EMA 상한 하한 minRateFloor() 훅 (ADENA max(5000, |앵커|·0.5)/s)
 *
 * 핵심 단언: 진단 시나리오 B1(앵커 오염)·B3(수동입력 잠금 체인)이 사냥 지속
 * 중에도 45초 내 복구된다. (before: 양쪽 모두 영구 freeze — 200/200, 120/120 거부)
 */
import { describe, expect, it } from 'vitest'
import {
  AdenaTracker,
  ExpTracker,
  MpTracker,
  createRegionTrackers,
  type ObserveReason
} from '@core/ocr/tracker'

const T0 = 1_000_000
const TICK = 1000
const CONF_EXP = 0.72 // 6/4 라이브 로그 실측 base-template conf

function bootExp(anchor: number, conf = CONF_EXP): { t: ExpTracker; now: number } {
  const t = new ExpTracker()
  let now = T0
  let last: ObserveReason = 'init_pending'
  for (let i = 0; i < 3; i++) {
    last = t.observe(anchor, conf, now).reason
    now += TICK
  }
  expect(last).toBe('init_consistency')
  return { t, now }
}

describe('tracker-freeze-regression', () => {
  it('R1(=진단 B1): 앵커 오염(+19.2) 후 사냥 지속 — 45초 내(실측 10프레임) 자동 복구', () => {
    // 부트스트랩 직후 rate-EMA 미가동 창에서 +9.61 오독 2연속 수락 → 앵커 77.4595 오염.
    const { t, now } = bootExp(58.2383)
    expect(t.observe(67.8489, CONF_EXP, now).accepted).toBe(true)
    expect(t.observe(77.4595, CONF_EXP, now + TICK).accepted).toBe(true)
    expect(t.trusted).toBe(77.4595)

    // 사냥 지속: 진짜 값은 매 프레임 고유(킬마다 변화) → 동일값 5연속 승급 불가 조건.
    // before: temporal band가 dt를 무시해 Δ≈-19가 영구 0.1 band → 200/200 거부.
    // after: g=max(1, 0.2·dt) 완화로 |Δ|=19.2 ≤ 10g가 dt=10s에 성립 → 복구.
    let nn = now + 2 * TICK
    let firstAcceptAt = -1
    for (let f = 0; f < 60; f++) {
      const trueVal = Number((58.2466 + f * 0.0064).toFixed(4))
      if (t.observe(trueVal, CONF_EXP, nn).accepted && firstAcceptAt < 0) firstAcceptAt = f + 1
      nn += TICK
    }
    expect(firstAcceptAt).toBe(10) // 실측 복구 프레임 (1s 틱 → 10초)
    expect(firstAcceptAt).toBeLessThanOrEqual(45) // 핵심 요구: 45초 내 복구
    expect(t.trusted).toBe(Number((58.2466 + 59 * 0.0064).toFixed(4))) // 이후 정상 추적
  })

  it('R2(=진단 B3 worst-case): 수동입력이 실값과 ±1%p 밖 — 잠금은 90s(10분 아님), 해제 직후 1프레임 복구', () => {
    const tr = createRegionTrackers()
    const t = tr.exp
    t.observe(50.0, 1, T0, { force: true }) // 수동값 50.0, 실제 게임은 이미 62.02

    // OCR이 매초 진짜 값(62.02+)을 읽음 — 수동값과 12%p 차이라 조기 해제 불성립.
    let locked = 0
    let firstAcceptAt = -1
    for (let f = 1; f <= 120; f++) {
      const trueVal = Number((62.02 + (f - 1) * 0.0064).toFixed(4))
      const v = t.observe(trueVal, CONF_EXP, T0 + f * TICK)
      if (v.reason === 'user_locked') locked++
      else if (v.accepted && firstAcceptAt < 0) firstAcceptAt = f
    }
    // before: 10분 잠금(599프레임) + 해제 후 Δ>10 → 120/120 영구 거부 (앵커 50.0 고착).
    // after: 90s 잠금(89프레임) → 해제 첫 프레임에서 dt=90s → g=18 → Δ=12.6 ≤ g
    //        → temporal 1.0 → posterior 0.72 → 즉시 수락.
    expect(locked).toBe(89)
    expect(firstAcceptAt).toBe(90) // 잠금 해제 후 1프레임 만에 복구 (≤ 45s 요구 충족)
    expect(firstAcceptAt - 89).toBeLessThanOrEqual(45)
    expect(t.trusted).toBe(Number((62.02 + 119 * 0.0064).toFixed(4)))
  })

  it('R3: 잠금 중 OCR이 입력값 ±1%p 내로 3연속 일치하면 조기 해제 (불일치는 streak 리셋)', () => {
    const tr = createRegionTrackers()
    const t = tr.exp
    t.observe(70.0, 1, T0, { force: true })

    // 일치(streak1) → 불일치(리셋) → 일치×3 → 해제
    expect(t.observe(70.5, CONF_EXP, T0 + 1 * TICK).reason).toBe('user_locked') // streak 1
    expect(t.observe(71.5, CONF_EXP, T0 + 2 * TICK).reason).toBe('user_locked') // |Δ|=1.5 > 1.0 → 리셋
    expect(t.observe(70.2, CONF_EXP, T0 + 3 * TICK).reason).toBe('user_locked') // streak 1
    expect(t.observe(70.3, CONF_EXP, T0 + 4 * TICK).reason).toBe('user_locked') // streak 2
    const release = t.observe(70.4, CONF_EXP, T0 + 5 * TICK) // streak 3 → 해제 + 정상 처리
    expect(release.accepted).toBe(true)
    expect(release.reason).toBe('normal')
    expect(t.trusted).toBe(70.4)

    // 해제 이후에는 잠금이 다시 걸리지 않는다 (force 없이는).
    expect(t.observe(70.45, CONF_EXP, T0 + 6 * TICK).reason).not.toBe('user_locked')
  })

  it('R3b: LEVEL은 정확 일치만 조기 해제로 인정 (±1 레벨 오독으로 해제되지 않음)', () => {
    const tr = createRegionTrackers()
    const t = tr.level
    t.observe(40, 1, T0, { force: true })
    // 41(오독 가능)이 3연속 와도 해제되지 않는다 — 정확 일치(40)만 streak 적립.
    for (let f = 1; f <= 5; f++) {
      expect(t.observe(41, 0.9, T0 + f * TICK).reason).toBe('user_locked')
    }
    expect(t.trusted).toBe(40)
    // 정확 일치 3연속이면 해제.
    expect(t.observe(40, 0.9, T0 + 6 * TICK).reason).toBe('user_locked')
    expect(t.observe(40, 0.9, T0 + 7 * TICK).reason).toBe('user_locked')
    const rel = t.observe(40, 0.9, T0 + 8 * TICK)
    expect(rel.accepted).toBe(true)
    expect(rel.reason).toBe('normal')
  })

  it('R4: off-by-one 교정 — anomaly_consistency가 설계값 N프레임에 정확히 발동', () => {
    // EXP (threshold 5): Δ=+15는 conf 0.72에서 anomaly (sqrt(0.15)*0.72=0.279 < 0.3).
    // dt≤5s 동안 g=1이라 dt-완화도 미발동 → 순수하게 동일값 승급 경로만 측정.
    // before: 6프레임 (check-before-record off-by-one) / after: 5프레임.
    {
      const { t, now } = bootExp(50.0)
      let acceptedAt = -1
      let reason: ObserveReason | null = null
      for (let f = 1; f <= 8; f++) {
        const v = t.observe(65.0, CONF_EXP, now + (f - 1) * TICK)
        if (v.accepted) {
          acceptedAt = f
          reason = v.reason
          break
        }
      }
      expect(acceptedAt).toBe(5)
      expect(reason).toBe('anomaly_consistency')
    }
    // ADENA 한국단위 regime (threshold 2): 100k+ 앵커에서 자릿수 -4 동일값 반복.
    // before: 3프레임 / after: 2프레임.
    {
      const t = new AdenaTracker()
      let now = T0
      for (let i = 0; i < 3; i++) {
        t.observe(150000, 0.9, now)
        now += TICK
      }
      let acceptedAt = -1
      let reason: ObserveReason | null = null
      for (let f = 1; f <= 5; f++) {
        const v = t.observe(23, 0.9, now + (f - 1) * TICK)
        if (v.accepted) {
          acceptedAt = f
          reason = v.reason
          break
        }
      }
      expect(acceptedAt).toBe(2)
      expect(reason).toBe('anomaly_consistency')
      expect(t.isKoreanUnitSuspect()).toBe(true)
    }
  })

  it('R5: stale-anchor 재부트스트랩 백스톱 — dt-완화·동일값 승급이 모두 막힌 극단 이탈도 ~48s에 복구', () => {
    // |Δ|≈95 (앵커 96 오염 vs 실값 1.x): 10g ≥ 95는 dt≈47.5s에야 성립하고,
    // 킬이 3프레임마다 일어나 동일값 5연속(승급)도 불가 — 두 빠른 경로가 모두 막힘.
    // 이때 low_posterior가 45s 지속되면 앵커를 버리고 init으로 회귀해야 한다.
    const { t, now } = bootExp(96.0, CONF_EXP)
    let nn = now
    let rebootstrapAt = -1
    let recoveredAt = -1
    let recoveredReason: ObserveReason | null = null
    for (let k = 1; k <= 60; k++) {
      const trueVal = Number((1.0 + 0.0064 * Math.floor((k - 1) / 3)).toFixed(4))
      const v = t.observe(trueVal, CONF_EXP, nn)
      if (v.reason === 'stale_anchor_rebootstrap' && rebootstrapAt < 0) {
        rebootstrapAt = k
        expect(t.trusted).toBeNull() // 앵커 무효화 확인
      }
      if (v.accepted && recoveredAt < 0) {
        recoveredAt = k
        recoveredReason = v.reason
      }
      nn += TICK
    }
    // 첫 거부 k=1(rejectStreak 시작) → 45s 경과 k=46에 재부트스트랩 →
    // 3연속 동일(킬 간 정지값)로 k=48에 재앵커. (before: 60프레임 전부 거부, 영구 freeze)
    expect(rebootstrapAt).toBe(46)
    expect(recoveredAt).toBe(48)
    expect(recoveredReason).toBe('init_consistency')
    // 재앵커(k=48, 1.096) 이후에도 계속 추적 — 루프 종료(k=60) 시점 실값과 일치.
    expect(t.trusted).toBe(1.1216)
  })

  it('R6: init 부트스트랩 conf 게이트 — conf<0.5는 일관성 카운트에서 제외(끊지도 않음)', () => {
    // 저신뢰 쓰레기만으로는 영원히 앵커가 생기지 않는다.
    {
      const t = new MpTracker()
      let now = T0
      for (let i = 0; i < 10; i++) {
        const v = t.observe({ cur: 0, max: 230 }, 0.4, now)
        expect(v.reason).toBe('init_pending')
        now += TICK
      }
      expect(t.trusted).toBeNull()
    }
    // 고신뢰 3회 사이에 저신뢰가 끼어도 카운트를 끊지 않는다 (제외만 됨).
    {
      const t = new ExpTracker()
      expect(t.observe(50.0, 0.66, T0).reason).toBe('init_pending') // 카운트 1
      expect(t.observe(50.0, 0.3, T0 + TICK).reason).toBe('init_pending') // 게이트 미달 — 제외
      expect(t.observe(50.0, 0.66, T0 + 2 * TICK).reason).toBe('init_pending') // 카운트 2
      const v = t.observe(50.0, 0.66, T0 + 3 * TICK) // 카운트 3 → 부트스트랩
      expect(v.reason).toBe('init_consistency')
      expect(t.trusted).toBe(50.0)
    }
  })

  it('R7: 수동 잠금 길이는 정확히 90_000ms (불일치 OCR 기준 경계 검증)', () => {
    const tr = createRegionTrackers()
    const t = tr.exp
    t.observe(30.0, 1, T0, { force: true })
    // 불일치 값(±1%p 밖)이라 조기 해제 없음 — 시간 만료만 검증.
    expect(t.observe(45.0, 0.9, T0 + 89_999).reason).toBe('user_locked')
    const after = t.observe(45.0, 0.9, T0 + 90_000)
    expect(after.reason).not.toBe('user_locked')
  })

  it('R8: ADENA minRateFloor — idle 후 첫 픽업 1프레임 수락, EXP는 하한 1.0 유지(오독 방어 보존)', () => {
    // ADENA: idle 60s(rateEma→0) 후 +500 픽업 → before: 6프레임 거부 / after: 1프레임.
    {
      const t = new AdenaTracker()
      let now = T0
      for (let i = 0; i < 63; i++) {
        t.observe(5000, 0.7, now)
        now += TICK
      }
      const v = t.observe(5500, 0.7, now)
      expect(v.accepted).toBe(true)
      expect(v.reason).toBe('normal')
    }
    // EXP: 하한 1.0(%p/s) 그대로 — idle 후 +9.9 점프는 rate 게이트가 여전히 잡는다.
    {
      const t = new ExpTracker()
      let now = T0
      for (let i = 0; i < 63; i++) {
        t.observe(50.0, 0.9, now)
        now += TICK
      }
      const v = t.observe(59.9, 0.9, now) // rate 9.9/s ≫ floor 1.0 → rateScore 0.1
      expect(v.accepted).toBe(false) // sqrt(0.4*0.1)*0.9 = 0.18 < 0.3
    }
  })
})
