# 세션 인수인계 — 2026-05-07 v11 (v1.4.3 OCR 안정화 7종)

> **다음 세션에서 가장 먼저 읽어야 할 문서**
> v1.4.2 자동 모드 회귀 fix + MP textROI 게이지 종속 해제 + LEVEL 다수결 미달 fallback

---

## ⚡ TL;DR — 30초 요약

**현재 상태**: v1.4.3 빌드. 사용자 진단 7라운드(08:07 ~ 12:47) 점진 개선으로 MP/ADENA/EXP/LEVEL 모두 안정 동작 검증.

**최신 빌드**: `dist/LineageMPTimer-1.4.1-portable.exe` + ZIP (커밋 `d60d35c` 시점)

**가장 결정적 발견 (사용자가 알려줌)**:
- "MP 뒤에 파란색이 좌→우로 차오르는 시스템" → **mpBar.width=채워진 부분만**
- MP 적을수록 textROI 좁음 → "MP : 71"만 캡처되어 OCR 매번 misread
- 해결: max(mpBar.width, hpBar.width, 200) 사용 — HP/MP 게이지 폭 동일 가정

**남은 이슈**:
- 던전 알림 등 일시 텍스트 misread → Phase 5 fallback으로 7~10회 strict 차단
- paddle/tess 픽셀 폰트 사전훈련 한계 → P2 traineddata 재학습 필요 (`.omc/plans/v1.5.0-training-data-recollection.md`)

---

## 🔥 이번 세션 발견·수정한 root cause 7종 (시간순)

### 1. ADENA frameW 클램프 (Phase 3a)
- 자동 detect ADENA textROI가 gameRegion 우측 끝을 113px 넘어감
- 사용자 환경: 모니터 자체가 게임창 우측 끝과 동일 → 100px이 검정 픽셀
- 기존 v1.4.0 b20407a 가정("captureStream이 모니터 전체") 깨짐
- 수정: 모든 ROI를 frameW 내 클램프, ADENA-only issue를 valid 결정에서 제외

### 2. MP paddle max anchor 자동 복구 (Phase 3b)
- 사용자 anchor mpMax="197" 잘못 입력 → paddle.max=242 매번 폐기
- ADENA v1.3.13 `_matchRecover` 패턴을 MP에 도입
- paddle 5회 일관 + max in [50,9999] → INPUTS 자동 갱신

### 3. ADENA invalid 회귀 fix (Phase 3c)
- Phase 3a 부작용: validateROIs valid=false → 자동 모드 전체 OCR 막힘
- 진단 11-46-28 hybridLog 20슬롯 모두 ADENA 실패 메시지로 도배
- 수정: 필수 ROI 검증에서 ADENA 제거 + 30초 메시지 throttle

### 4. Stability 디폴트 3 (P0)
- storage.js stabilityRequired: 1 → 3
- getStabilityRequired 0~5 허용
- checkStability에 requiredOverride 인자

### 5. Confusion-aware verification (P1)
- `_CONFUSION_PAIRS = ['08','80','58','85','68','86','49','94','17','71','79','97']`
- `isConfusionMisread(anchor, val)` — 1자리 차이 + pair 매칭
- MP/ADENA voting에서 confusion 의심 시 stability +1 추가 요구

### 6. **(핵심) MP textROI 폭 게이지 종속 해제** (Phase 4a)
- 사용자 알려줌: MP 게이지가 좌→우로 채워짐 (MP 비율만큼)
- mpBar detect는 채워진 파란 부분만 잡음 → MP 적을수록 textROI 좁음
- "MP : 113/242" 중 좌측 일부만 캡처 → OCR "71" misread
- 수정: `max(mpBar.width, hpBar?.width, 200)` 사용
- 검증: MP "32/242 ×5" tess 단독 채택 정상 (12-18-16)

### 7. LEVEL 다수결 미달 fallback (Phase 5)
- LEVEL ROI(61×19) 작아 canvas ensemble 다수결 1/1 미달
- OCR이 정확히 29 읽어도 anchor 갱신 안 됨, 이전 misread "5" 굳음
- 다수결 미달이어도 7회(정상)/10회(점프) 일관 시 fallback 통과
- `🔓 LEVEL anchor 자동 복구` 메시지 출력

---

## 📊 사용자 진단 7라운드 점진 개선

```
08-07-39 (v1.4.1, 수동 모드, mpMax=197) → ADENA 12px root cause 발견 → Phase 3a
08-17-51 (자동 detect 후 수동 전환)     → MP paddle 정확/tess 깨짐 → Phase 3b
11-46-28 (Phase 3a 부작용)             → 자동 OCR 전체 막힘 회귀 → Phase 3c
12-00-18 (Phase 3b/3c 적용)            → MP anchor 197→242 자동 복구 ✅
12-09-05 (사용자 게임화면 정보 제공)     → MP textROI 게이지 종속 발견 → Phase 4a
12-18-16 (Phase 4a 적용 후)            → MP "32/242 ×5" 완벽 동작 ✅
12-47-24 (ADENA 정상 + LEVEL "5" 굳음) → LEVEL 다수결 미달 fallback → Phase 5
```

---

## 🛠 진단 도구 (이전 세션과 동일, 그대로 사용 가능)

`scripts/` 디렉터리:
- `analyze-game-capture.js`, `test-detect.js`, `test-text-rois.js`
- `find-text-around-expbar.js`, `find-exp-on-left.js`
- `analyze-lv-text.js`, `crop-roi.js`

**v1.4.3 추가 진단 흐름**:
1. mp.png 직접 열어서 텍스트 영역이 잘 캡처됐는지 확인 (Phase 4a 검증)
2. hybridLog에서 "MP 🟢 ... 단독 채택" / "🔓 MP anchor max 자동 복구" / "🔓 LEVEL anchor 자동 복구" 메시지 확인
3. cachedROIs.textROIs.mp.width — 200+ 정상, 81 같으면 Phase 4a 미적용

---

## 🚨 다음 세션 우선 액션

### Priority 1: P2 traineddata 재학습 (장기, 1~3주)
- 현 inventory: 463개 (이전 학습과 동일, 새 데이터 0)
- 목표: 1500~2000개, 다양성 보장
- 단계:
  1. **자동 캡처 토글 활성화 확인** — 사용자에게 토글 ON 상태인지 확인 권장
  2. 사용자 평소 사냥 + 다른 캐릭 사냥 1~2주
  3. inventory 점검 후 라벨링
  4. WSL 학습 (BCER <1%, 학습-검증 차이 <0.5%)
  5. A/B 빌드 + 사용자 1주 평가
- 상세: `.omc/plans/v1.5.0-training-data-recollection.md`

### Priority 2: Stability 마이그레이션 (선택)
- 기존 사용자 storage stabilityRequired=1 또는 2 그대로
- 새 빌드 적용 시 자동 3으로 마이그레이션 검토 (단 invasive)

### Priority 3: 자동 캡처 진단 출력 추가
- 진단 리포트에 자동 캡처 토글 상태 / 누적 PNG 갯수 출력
- 사용자가 P2 데이터 수집 진행도 빠르게 확인 가능

### Priority 4: LEVEL ROI 자동 확장
- 61×19가 작아 다수결 미달 빈번
- ROI 양 옆에 padding 추가하여 80~100px 폭 확장 검토
- 단 다른 영역 침범 위험 검증 필요

---

## 📝 빌드/배포 절차 (변동 없음)

```bash
cd C:\dev\lineage-mp-timer
# 1. 사용자 portable 종료
# 2. 빌드
npm run build      # NSIS + portable
# 3. dist
npm run dist       # ZIP 패키징
# 4. 산출물:
#    dist/LineageMPTimer-1.4.1-portable.exe
#    dist/LineageMPTimer-v1.4.1.zip
```

⚠️ `npm run dist` 단독으로는 코드 변경 안 반영 (ZIP만 재패키징). 반드시 `npm run build` 먼저.

---

## 🎓 이번 세션의 메타 교훈

1. **사용자 게임 시스템 정보가 결정적**: "MP 뒤 파란색 좌→우 차오름" 한 마디가 6라운드 디버깅 후 진짜 root cause 노출. 다음에 비슷한 정체 시 사용자에게 게임 시스템 직접 물어보기.

2. **Fix가 회귀를 일으킬 수 있다**: Phase 3a가 자동 모드 전체 OCR 막은 회귀. validateROIs valid=false의 전파를 미리 검토 못함. 다음에 fix 작성 시 호출 측 영향까지 trace.

3. **hybridLog 도배는 사용자 가시성 죽임**: 매초 같은 메시지 → 다른 메시지 묻힘. 메시지 throttle 디폴트로 적용 권장.

4. **ROI 동적 detect의 함정**: 게이지 채워짐 비율이 detect 결과를 바꾸는 시스템. 게임마다 다른 디자인 패턴 학습 필요.

5. **점진 분석의 가치**: 7라운드 진단으로 매번 다른 root cause 발견. 한 번에 해결하려 하지 말고 each round에 한 가지씩.

6. **다수결 미달 영원 미반영**: agreement 미달이면 stability tracking 시작도 안 함 → anchor 영원 굳음. fallback stability 패턴 추가가 의외로 큰 영향.

---

## 📂 생성된 plan 문서

```
.omc/plans/v1.4.2-auto-stabilization.md       — Phase 3 (3a/3b/3c)
.omc/plans/v1.4.3-confusion-defense.md        — P0 + P1
.omc/plans/v1.5.0-training-data-recollection.md — P2 학습 재수집 plan (장기)
```

---

_Last updated: 2026-05-07 v11 · Claude (Anthropic) · v1.4.3 OCR 안정화 7종_
