/**
 * dbg-live-tracker-freeze — "최초 인식 후 추적 정지" 근본 원인 계측 (읽기 전용 진단).
 *
 * 라이브 실측 조건을 재현한다:
 *   - 틱 1000ms (6/4 로그: 매초 1회)
 *   - base-template 텍스트 OCR conf: exp 0.72 / level 0.71 / mp 0.66 (로그 실측)
 *   - exp 실측 정확도 54% (나머지는 confusion/dropout 오인식)
 *
 * 검증 포인트 (2026-06-07 tracker freeze 수정 후 기대치 갱신 — before/after는 각 테스트 주석 참조):
 *   (A)  정상 변화(58.2000→58.2383)가 몇 프레임에 수락되는가 (수정 전후 동일)
 *   (B1) 부트스트랩 직후 상향 오염 2회 → before: 영구 freeze / after: dt-완화로 10프레임 자동 복구
 *   (B2) 54% 정확도 iid 노이즈 스트림 — 고착/복구 통계 (구조 단언만, 수치는 로그)
 *   (B3) 수동입력(force) → before: 10분 잠금 + 해제 후 영구 거부 / after: 90s 잠금 + OCR 일치 3회 조기 해제
 *   (B4) 결정적(같은 화면=같은 오인식) 모델 — 오인식이 일관 반복될 때의 거동
 *   (C)  레벨업 28→29 수락 여부 (1s/0.3s 틱, conf 스윕) (수정 전후 동일)
 *   (D)  conf × temporal band 수락 경계표 — dt=1s에서는 g=1이라 수정 전과 동일 경계
 *   (E)  ADENA rate-EMA 트랩 → before: idle 후 첫 픽업 6프레임 거부 / after: minRateFloor로 1프레임 수락
 *   (F)  MP 쓰레기 "000000" 부트스트랩 — conf 0.66 > init 게이트 0.5라 여전히 통과(설계대로, 주방어는 detection 입구 차단)
 *
 * src/ 무수정. AppData 미접근.
 */
import { describe, expect, it } from 'vitest'
import {
  AdenaTracker,
  ExpTracker,
  LevelTracker,
  MpTracker,
  createRegionTrackers,
  type ObserveReason
} from '@core/ocr/tracker'

const T0 = 1_000_000
const TICK = 1000
const CONF_EXP = 0.72 // 6/4 라이브 로그 실측
const CONF_LEVEL = 0.71
const CONF_MP = 0.66
const THRESHOLD = 0.3 // tracker.ts:139 default posteriorThreshold

// ── helpers ──────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 부트스트랩: 같은 값 3회 → init_consistency. 반환 시점의 rateEma는 아직 null. */
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

const fmtExp = (v: number): string => v.toFixed(4)

/** 실측 confusion 이력 기반 오인식 모델 (docs/OCR-FUTURE-PLAN confusion pairs). */
const CONFUSION: Record<string, string[]> = {
  '0': ['8'],
  '8': ['0', '5', '6'],
  '5': ['8'],
  '6': ['1', '8'],
  '1': ['6', '7'],
  '7': ['1'],
  '4': ['9'],
  '9': ['4']
}

/** true 문자열("58.2383")을 1회 오염시킨다. null = 파싱 실패(observe 미호출). */
function corruptExpString(s: string, rnd: () => number): number | null {
  const chars = s.split('')
  const digitIdx = chars.map((c, i) => (c >= '0' && c <= '9' ? i : -1)).filter((i) => i >= 0)
  const roll = rnd()
  let out: string
  if (roll < 0.2) {
    // 글리프 누락 (segmentation dropout, "30..75"류)
    const i = digitIdx[Math.floor(rnd() * digitIdx.length)]!
    out = s.slice(0, i) + s.slice(i + 1)
  } else if (roll < 0.92) {
    // 디지트 confusion 치환
    const i = digitIdx[Math.floor(rnd() * digitIdx.length)]!
    const d = chars[i]!
    const cands = CONFUSION[d] ?? [String((Number(d) + 3) % 10)]
    chars[i] = cands[Math.floor(rnd() * cands.length)]!
    out = chars.join('')
  } else {
    return null // 인식 자체 실패
  }
  const v = Number(out)
  if (!Number.isFinite(v) || v < 0 || v >= 100) return null // parser가 거른다 → observe 안 됨
  return v
}

interface StreamStats {
  frames: number
  observed: number
  accepted: number
  rejected: number
  maxRejectRun: number
  rejectRunAtEnd: number
  promotions: number // anomaly_consistency 횟수
  pollutions: number // |수락값 - true| > 1.0 인 수락 (앵커 오염)
  maxDivergence: number // 부트스트랩 후 |trusted - true| 최대
  finalDivergence: number
}

function runExpStream(
  t: ExpTracker,
  startNow: number,
  reads: Array<{ trueVal: number; read: number | null }>,
  conf = CONF_EXP
): StreamStats {
  let now = startNow
  const s: StreamStats = {
    frames: reads.length,
    observed: 0,
    accepted: 0,
    rejected: 0,
    maxRejectRun: 0,
    rejectRunAtEnd: 0,
    promotions: 0,
    pollutions: 0,
    maxDivergence: 0,
    finalDivergence: 0
  }
  let run = 0
  for (const { trueVal, read } of reads) {
    if (read != null) {
      s.observed++
      const v = t.observe(read, conf, now)
      if (v.accepted) {
        s.accepted++
        run = 0
        if (v.reason === 'anomaly_consistency') s.promotions++
        if (Math.abs((v.value as number) - trueVal) > 1.0) s.pollutions++
      } else {
        s.rejected++
        run++
        if (run > s.maxRejectRun) s.maxRejectRun = run
      }
    }
    const trusted = t.trusted
    if (trusted != null) {
      const div = Math.abs(trusted - trueVal)
      if (div > s.maxDivergence) s.maxDivergence = div
      s.finalDivergence = div
    }
    now += TICK
  }
  s.rejectRunAtEnd = run
  return s
}

// ─────────────────────────────────────────────────────────────────────────────

describe('dbg-live-tracker-freeze', () => {
  it('(A) 정상 시나리오: 58.2000 앵커 후 58.2383 변화 — 1프레임 수락', () => {
    const { t, now } = bootExp(58.2)
    const v = t.observe(58.2383, CONF_EXP, now)
    console.log(`[A] Δ=+0.0383 conf=${CONF_EXP} → ${v.reason} post=${v.posterior.toFixed(3)}`)
    expect(v.accepted).toBe(true)
    expect(v.reason).toBe('normal')
    // posterior = sqrt(1.0*1.0*1.0)*0.72 = 0.72
    expect(v.posterior).toBeCloseTo(0.72, 2)

    // 연속 사냥 300프레임(매 6프레임 +0.0383) 무노이즈 → 전부 수락이어야 정상
    let cur = 58.2383
    let acc = 0
    let nn = now + TICK
    for (let f = 0; f < 300; f++) {
      if (f % 6 === 5) cur = Number((cur + 0.0383).toFixed(4))
      if (t.observe(cur, CONF_EXP, nn).accepted) acc++
      nn += TICK
    }
    console.log(`[A] 무노이즈 사냥 300프레임: 수락 ${acc}/300`)
    expect(acc).toBe(300)
  })

  it('(B1) 부트스트랩 직후 상향 오염 2회 → [수정 후] dt-완화로 사냥 중 10프레임 자동 복구', () => {
    const { t, now } = bootExp(58.2383)
    // rate EMA는 이 시점 null(commit 시 lastTrusted==null이라 EMA 미갱신)
    // → 첫 관측의 rateScore는 무조건 1.0
    const p1 = t.observe(67.8489, CONF_EXP, now) // 오인식 +9.61 (confusion-gap 9 ∉ {8,3,5} → prior 1.0)
    const p2 = t.observe(77.4595, CONF_EXP, now + TICK) // 두 번째 +9.61 (rateEma=9.61로 초기화돼 upper=28.8)
    console.log(
      `[B1] 오염1: ${p1.reason} post=${p1.posterior.toFixed(3)} / 오염2: ${p2.reason} post=${p2.posterior.toFixed(3)} → 앵커=${t.trusted}`
    )
    expect(p1.accepted).toBe(true) // Δ∈(1,10] band 0.4 → sqrt(0.4)*0.72=0.455 ≥ 0.3 (수정 전후 동일)
    expect(p2.accepted).toBe(true)
    expect(t.trusted).toBe(77.4595) // true=58.24인데 앵커 +19.2 오염

    // 사냥 지속: 진짜 값이 매 프레임 미세 증가(킬마다 변화) → 5회 동일값이 안 나옴.
    // BEFORE(수정 전): Δ≈-19 → temporal 0.1 고정(dt 무시) → 200/200 영구 거부, 앵커 고착.
    // AFTER(수정 후): ExpTracker.temporalScore가 g=max(1, 0.2·dt)로 band를 완화 —
    //   |Δ|=19.2 ≤ 10g가 dt=10s(f=9)에 성립 → death band 0.5 → sqrt(0.5)*0.72=0.509 수락.
    let nn = now + 2 * TICK
    let rejected = 0
    let firstAcceptAt = -1
    let lastReason: ObserveReason = 'normal'
    for (let f = 0; f < 200; f++) {
      const trueVal = Number((58.2466 + f * 0.0064).toFixed(4)) // 매 프레임 고유값
      const v = t.observe(trueVal, CONF_EXP, nn)
      if (!v.accepted) rejected++
      else if (firstAcceptAt < 0) firstAcceptAt = f + 1
      lastReason = v.reason
      nn += TICK
    }
    console.log(
      `[B1] 사냥 200프레임(매 프레임 고유값): 거부 ${rejected}/200, 첫 수락 ${firstAcceptAt}프레임, 마지막 reason=${lastReason}, 앵커=${t.trusted}`
    )
    expect(firstAcceptAt).toBe(10) // before: -1 (200프레임 전부 거부)
    expect(rejected).toBe(9) // before: 200
    expect(t.trusted).toBe(59.5202) // 진짜 값 추적 재개 (before: 77.4595 고착)
    expect(lastReason).toBe('normal')

    // 복구 후 idle 동일값은 즉시 수락 (before: 앵커 고착 상태에서 6프레임 필요 —
    // 설계 5 + check-before-record off-by-one. off-by-one은 record-before-check로 교정됨,
    // 회귀 단언은 test/ocr/tracker-freeze-regression.test.ts 참조).
    const idleVal = 59.53
    const v = t.observe(idleVal, CONF_EXP, nn)
    console.log(`[B1] 복구 후 idle 1프레임: ${v.reason} post=${v.posterior.toFixed(3)}`)
    expect(v.accepted).toBe(true)
  })

  it('(B2) 54% 정확도 iid 노이즈 스트림 600프레임 — 고착/복구 통계', () => {
    const rnd = mulberry32(20260607)
    const { t, now } = bootExp(58.2383)
    let trueVal = 58.2383
    const reads: Array<{ trueVal: number; read: number | null }> = []
    for (let f = 0; f < 600; f++) {
      if (f % 6 === 5) trueVal = Number((trueVal + 0.0383).toFixed(4)) // ~6초당 1킬
      const correct = rnd() < 0.54
      const read = correct ? trueVal : corruptExpString(fmtExp(trueVal), rnd)
      reads.push({ trueVal, read })
    }
    const s = runExpStream(t, now, reads)
    console.log(
      `[B2] iid 노이즈: 관측 ${s.observed}/600, 수락 ${s.accepted}, 거부 ${s.rejected}, ` +
        `최장 연속거부 ${s.maxRejectRun}프레임, 오염수락 ${s.pollutions}회, ` +
        `anomaly승급 ${s.promotions}회, 최대이탈 ${s.maxDivergence.toFixed(3)}%p, 종료이탈 ${s.finalDivergence.toFixed(3)}%p`
    )
    // 통계는 로그로 산출 — 여기서는 구조적 성질만 단언:
    expect(s.observed).toBeGreaterThan(400)
    expect(s.accepted).toBeGreaterThan(0)
  })

  it('(B3) 수동입력(적용&학습 버튼) → [수정 후] 90s 잠금 + OCR 일치 3회 조기 해제 — freeze 체인 소멸', () => {
    // detection.ts forceValue ← setup.ts (적용&학습 버튼)
    // BEFORE(수정 전): createRegionTrackers exp manualLockMs=600_000(10분) →
    //   599/600프레임 user_locked, 해제 후 Δ=+12 → 120/120 영구 거부, 앵커 50.0 고착.
    // AFTER(수정 후): manualLockMs=90_000 + 잠금 중 OCR이 입력값 ±1%p 내로 3회 연속
    //   일치하면 조기 해제. 이 시나리오(수동값이 정확, OCR이 진행분 ±1%p 내 추적)에서는
    //   3프레임째 잠금이 풀리고 그 관측부터 정상 추적이 재개된다.
    const tr = createRegionTrackers()
    const t = tr.exp
    t.observe(50.0, 1, T0, { force: true })

    let locked = 0
    let firstAcceptAt = -1
    for (let f = 1; f <= 600; f++) {
      const v = t.observe(Number((50 + f * 0.02).toFixed(4)), CONF_EXP, T0 + f * TICK)
      if (v.reason === 'user_locked') locked++
      else if (v.accepted && firstAcceptAt < 0) firstAcceptAt = f
    }
    console.log(
      `[B3] 600프레임: user_locked ${locked}/600 (before: 599), 첫 수락 f${firstAcceptAt}, 최종 앵커=${t.trusted}`
    )
    expect(locked).toBe(2) // f1(50.02)·f2(50.04)만 잠금 — 둘 다 ±1%p 일치로 streak 적립
    expect(firstAcceptAt).toBe(3) // 3회째 일치에서 조기 해제 + 그 관측을 정상 수락
    expect(t.trusted).toBe(62.0) // 600프레임 내내 추적 (before: 50.0 영구 고착)

    // 수동값과 OCR이 ±1%p 밖으로 어긋나는 경우(잠금이 실제로 유지되는 케이스)는
    // test/ocr/tracker-freeze-regression.test.ts에서 단언: 90s 후 해제 + dt-완화 1프레임 복구.
  })

  it('(B4) 결정적 오인식 모델(같은 값=같은 오독) — 오독이 5회 반복되면 오값이 승급된다', () => {
    const rnd = mulberry32(777)
    const { t, now } = bootExp(58.2383)
    let trueVal = 58.2383
    const memo = new Map<string, number | null>() // 같은 화면 → 항상 같은 인식결과
    const reads: Array<{ trueVal: number; read: number | null }> = []
    for (let f = 0; f < 600; f++) {
      if (f % 8 === 7) trueVal = Number((trueVal + 0.0383).toFixed(4)) // 8초당 1킬 → 킬 사이 7프레임 동일
      const key = fmtExp(trueVal)
      if (!memo.has(key)) {
        memo.set(key, rnd() < 0.54 ? trueVal : corruptExpString(key, rnd))
      }
      reads.push({ trueVal, read: memo.get(key)! })
    }
    const s = runExpStream(t, now, reads)
    console.log(
      `[B4] 결정적 오독: 수락 ${s.accepted}/${s.observed}, 최장 연속거부 ${s.maxRejectRun}, ` +
        `오염수락 ${s.pollutions}회, anomaly승급 ${s.promotions}회, 최대이탈 ${s.maxDivergence.toFixed(3)}%p, 종료이탈 ${s.finalDivergence.toFixed(3)}%p, 종료 연속거부 ${s.rejectRunAtEnd}`
    )
    expect(s.observed).toBeGreaterThan(0)
  })

  it('(C) 레벨업 28→29: 1s 틱 conf 0.71 → 1프레임 수락 / 0.3s 틱 저conf → 거부 후 dt 성장으로 복구', () => {
    // 1s 틱
    {
      const t = new LevelTracker()
      let now = T0
      for (let i = 0; i < 3; i++) {
        t.observe(28, CONF_LEVEL, now)
        now += TICK
      }
      for (let i = 0; i < 10; i++) {
        t.observe(28, CONF_LEVEL, now) // rate EMA를 0으로 워밍업
        now += TICK
      }
      const v = t.observe(29, CONF_LEVEL, now)
      console.log(`[C] 1s틱 28→29 conf0.71: ${v.reason} post=${v.posterior.toFixed(3)}`)
      expect(v.accepted).toBe(true) // temporal 0.85, rate=1.0/s ≤ effectiveUpper 1.0 → sqrt(0.85)*0.71=0.654
    }
    // 0.3s 틱(detection.ts:263 최소 인터벌) + conf 스윕
    for (const conf of [0.71, 0.66, 0.6]) {
      const t = new LevelTracker()
      let now = T0
      for (let i = 0; i < 13; i++) {
        t.observe(28, conf, now)
        now += 300
      }
      const frames: string[] = []
      let acceptedAt = -1
      for (let f = 1; f <= 6; f++) {
        const v = t.observe(29, conf, now)
        frames.push(`f${f}:${v.reason}@${v.posterior.toFixed(3)}`)
        if (v.accepted && acceptedAt < 0) acceptedAt = f
        now += 300
      }
      console.log(`[C] 0.3s틱 28→29 conf${conf}: ${frames.join(' ')} → 수락 ${acceptedAt}프레임`)
      expect(acceptedAt).toBeGreaterThan(0)
      expect(acceptedAt).toBeLessThanOrEqual(3)
    }
  })

  it('(D) conf × temporal-band 수락 경계표 — conf<0.775면 |Δ|>10 교정은 구조적으로 불가능', () => {
    // posterior = sqrt(prior*temporal*rate)*conf ≥ 0.3  ⇔  conf ≥ 0.3/sqrt(s)
    const bands: Array<[string, number]> = [
      ['EXP Δ∈[0,+1] (정상사냥, t=1.0)', 1.0],
      ['EXP Δ∈(+1,+10] (점프, t=0.4)', 0.4],
      ['EXP Δ>+10 (대점프, t=0.15)', 0.15],
      ['EXP Δ∈[-10,0) (사망, t=0.5)', 0.5],
      ['EXP Δ<-10 (자릿수손실, t=0.1)', 0.1],
      ['EXP confusion(prior 0.3)×사망(0.5)', 0.15],
      ['LEVEL Δ=+1 (t=0.85)', 0.85],
      ['LEVEL Δ=+2 (t=0.3)', 0.3],
      ['LEVEL Δ<0 (t=0.02)', 0.02],
      ['MP rate>100/s (t=0.05)', 0.05],
      ['ADENA rate게이트 0.1 (t=1.0×r=0.1)', 0.1]
    ]
    console.log('[D] band(s값) → 수락에 필요한 최소 conf = 0.3/sqrt(s):')
    for (const [name, s] of bands) {
      const minConf = THRESHOLD / Math.sqrt(s)
      console.log(
        `    ${name.padEnd(40)} s=${s.toFixed(2)} → conf ≥ ${minConf > 1 ? `${minConf.toFixed(2)} (불가능)` : minConf.toFixed(3)}`
      )
    }
    // 실측 검증: Δ>10 band는 conf 0.77에서 거부, 0.78에서 수락 (이론 경계 0.775)
    {
      const a = bootExp(50.0, 0.77)
      const v1 = a.t.observe(65.0, 0.77, a.now)
      const b = bootExp(50.0, 0.78)
      const v2 = b.t.observe(65.0, 0.78, b.now)
      console.log(
        `[D] 실측 Δ=+15: conf0.77→${v1.reason}(${v1.posterior.toFixed(3)}) / conf0.78→${v2.reason}(${v2.posterior.toFixed(3)})`
      )
      expect(v1.accepted).toBe(false)
      expect(v2.accepted).toBe(true)
    }
    // Δ<-10 band는 conf 0.94에서도 거부 (경계 0.949 — 현실 conf로 도달 불가)
    {
      const a = bootExp(70.0, 0.94)
      const v = a.t.observe(55.0, 0.94, a.now)
      console.log(`[D] 실측 Δ=-15 conf0.94 → ${v.reason}(${v.posterior.toFixed(3)})`)
      expect(v.accepted).toBe(false)
    }
    // 라이브 conf 0.72 기준 수락창: Δ∈[-10,+10]만 통과
    {
      const cases: Array<[number, boolean]> = [
        [58.2 + 0.5, true],
        [58.2 + 9.9, true],
        [58.2 + 10.1, false],
        [58.2 - 9.9, true],
        [58.2 - 10.1, false]
      ]
      for (const [val, want] of cases) {
        const a = bootExp(58.2, CONF_EXP)
        const v = a.t.observe(Number(val.toFixed(4)), CONF_EXP, a.now)
        console.log(`[D] conf0.72 Δ=${(val - 58.2).toFixed(1)} → ${v.reason}(${v.posterior.toFixed(3)})`)
        expect(v.accepted).toBe(want)
      }
    }
  })

  it('(E) ADENA rate-EMA 트랩: [수정 후] minRateFloor(max(5000, |앵커|·0.5)/s)로 idle 후 첫 픽업 1프레임 수락', () => {
    const t = new AdenaTracker()
    let now = T0
    for (let i = 0; i < 3; i++) {
      t.observe(5000, 0.7, now)
      now += TICK
    }
    for (let i = 0; i < 60; i++) {
      t.observe(5000, 0.7, now) // idle 60초 → rateEma=0, σ=0
      now += TICK
    }
    const frames: string[] = []
    let acceptedAt = -1
    for (let f = 1; f <= 8; f++) {
      const v = t.observe(5500, 0.7, now)
      frames.push(`f${f}:${v.reason}@${v.posterior.toFixed(3)}`)
      if (v.accepted && acceptedAt < 0) {
        acceptedAt = f
        break
      }
      now += TICK
    }
    console.log(`[E] idle→+500 픽업: ${frames.join(' ')} → 수락 ${acceptedAt}프레임`)
    // BEFORE(수정 전): effectiveUpper 절대 하한 1.0(EXP %p/s 스케일) → rate=500/s가
    //   rateScore 0.1 → sqrt(0.1)*0.7=0.221 < 0.3 → f1-f5 거부, f6 anomaly_consistency
    //   (설계 5 + off-by-one). 픽업 간격 <6s면 동일값 연속이 깨져 무기한 지연.
    // AFTER(수정 후): AdenaTracker.minRateFloor() = max(5000, 5000*0.5) = 5000/s →
    //   rate 500 ≤ 5000 → rateScore 1.0 → posterior 0.7 → 첫 프레임 normal 수락.
    expect(acceptedAt).toBe(1)
  })

  it('(F) MP: 쓰레기 "000000"(cur=0) 부트스트랩 → 실값 208 점프는 conf=1.0로도 통과 불가', () => {
    // 6/4 라이브: mp raw="000000" conf 0.66 ACCEPT cur=0 (src=base-template)
    const t = new MpTracker({ anomalyConsistencyThreshold: 3 }) // createRegionTrackers와 동일 (tracker.ts:686)
    let now = T0
    let bootReason: ObserveReason = 'init_pending'
    for (let i = 0; i < 3; i++) {
      bootReason = t.observe({ cur: 0, max: 230 }, CONF_MP, now).reason
      now += TICK
    }
    console.log(`[F] 쓰레기 0 부트스트랩: ${bootReason} (init conf 게이트 0.5 < 0.66이라 통과 — 주방어는 detection 입구 차단)`)
    expect(bootReason).toBe('init_consistency') // conf 0.66 쓰레기는 conf 게이트(0.5)를 넘어 여전히 앵커가 된다

    // 실제 MP 208 등장 — conf 1.0이어도 첫 프레임은 rate>100/s band(0.05) → sqrt(0.05)=0.224 < 0.3
    const real = t.observe({ cur: 208, max: 230 }, 1.0, now)
    console.log(`[F] 0→208 conf1.0 (dt=1s): ${real.reason} post=${real.posterior.toFixed(3)}`)
    expect(real.accepted).toBe(false)

    // 단 MP temporalScore는 rate=|Δ|/dt (tracker.ts:395-397) — 앵커가 멈춰 dt가 자라면
    // 같은 점프도 rate가 줄어 몇 프레임 내 수락된다 (EXP/LEVEL temporal은 dt 무시 — 대조적).
    const fr: string[] = []
    let recAt = -1
    const vals = [207, 205, 206, 204, 207]
    for (let i = 0; i < vals.length; i++) {
      now += TICK
      const v = t.observe({ cur: vals[i]!, max: 230 }, CONF_MP, now)
      fr.push(`f${i + 1}:${v.reason}@${v.posterior.toFixed(3)}`)
      if (v.accepted && recAt < 0) {
        recAt = i + 1
        break
      }
    }
    console.log(`[F] 변동 MP(매 프레임 다른 값): ${fr.join(' ')} → ${recAt}프레임에 dt-감쇠로 복구`)
    expect(recAt).toBeGreaterThan(0)
    expect(recAt).toBeLessThanOrEqual(3) // rate=cur/dt가 50/s 아래로 내려오는 시점

    // F2: 역방향이 치명적 — 정상 앵커 208이 있어도 쓰레기 "000000"이 지속되면
    // 같은 dt-감쇠로 3프레임 만에 cur=0이 앵커를 탈취한다.
    const t2 = new MpTracker({ anomalyConsistencyThreshold: 3 })
    let n2 = T0
    for (let i = 0; i < 3; i++) {
      t2.observe({ cur: 208, max: 230 }, 0.95, n2) // 정상 부트스트랩 (bar-pixel 수준 conf)
      n2 += TICK
    }
    const fr2: string[] = []
    let captured = -1
    for (let f = 1; f <= 6; f++) {
      const v = t2.observe({ cur: 0, max: 230 }, CONF_MP, n2) // 텍스트 OCR 쓰레기 "000000" 반복
      fr2.push(`f${f}:${v.reason}@${v.posterior.toFixed(3)}`)
      if (v.accepted && captured < 0) {
        captured = f
        break
      }
      n2 += TICK
    }
    console.log(`[F2] 정상앵커 208 vs 쓰레기 0 반복: ${fr2.join(' ')} → ${captured}프레임에 0이 앵커 탈취`)
    expect(captured).toBeGreaterThan(0)
    expect(captured).toBeLessThanOrEqual(4)
    expect(t2.trusted).toEqual({ cur: 0, max: 230 })
  })
})
