# 세션 인수인계 — 2026-05-06 v10 (v1.4.1 자동 모드 EXP=0% root cause + LV 텍스트 직접 검출)

> **다음 세션에서 가장 먼저 읽어야 할 문서**
> v1.4.0 자동 모드의 마지막 잔여 root cause(EXP=0% 케이스) 해결. LV 텍스트 직접 검출로 진행 막대 의존 제거.

---

## ⚡ TL;DR — 30초 요약

**현재 상태**: v1.4.1 자동 모드가 사용자 게임에서 **MP/EXP/Level 정상 동작 검증됨**. ADENA만 template matching 진행 중 (점진 안정).

**최신 빌드**: `dist/LineageMPTimer-1.4.1-portable.exe` + `dist/LineageMPTimer-v1.4.1.zip` (커밋 `ca40b74` 시점, 2026-05-06 23:39)

**핵심 발견 (이번 세션 가장 중요)**:
- 어제(2026-05-05)는 자동 모드 잘 됐는데 오늘은 안 됐음 — **사용자 게임 환경 차이**가 아니라 **EXP 진행 막대 가시성** 차이가 원인.
- EXP가 16.8%일 땐 막대가 168x27 큰 영역으로 잘 탐지. EXP가 0.17%면 막대 거의 안 채워져 다른 노이즈를 EXP로 오인.
- 해결: 막대 의존 제거 → LV 텍스트 자체를 검출 (`findLevelTextLines`)

**남은 이슈**:
- ADENA OCR이 일부 캡처에서 "???" — template matching이 자가 안정화 중. width 113px가 너무 넓을 수 있음 (텍스트 60px + 검정 53px). 사용자가 "잘 되는거 같다"고 평가.

---

## 🔥 이번 세션 발견·수정한 root cause 7종 (시간순)

진단 캡처 13개 분석 + 픽셀 레벨 검증으로 발견:

### 1. setupCaptureStreams가 gameRegion 누락 (`1cb81bd`)
- 자동 모드에서 mp/mpBar/exp/level/adena의 sourceId만 등록, gameRegion은 빠짐
- gameRegion.sourceId가 stale legacy region과 다른 모니터일 때 캡처 스트림 무한 실패
- 수정: 모드별 분기. 자동 → gameRegion만, 수동 → 5개 영역

### 2. multi-candidate combinatorial search (`af05598`)
- 기존: HP[0] + EXP[0] 단일 best 후보로 layout 검증 1회만 시도
- 비표준 UI(파티 HP 바, 채팅 빨간 텍스트)에서 첫 후보가 layout 위반 → 즉시 fail
- 수정: HP×MP×EXP×ADENA top-K (5×3×5×5) 조합 순회, 첫 통과 tuple 채택
- 추가: `findHpBarCandidates`, `findMpBarCandidates`, `findExpBarCandidates`, `findAdenaIconCandidates` API

### 3. EXP-above-HP layout 지원 (`4707fff`)
- 기존: `expBar.y > hpBar.y` 절대 가정 (EXP 항상 HP 아래)
- 사용자 게임 layout: 캐릭터 정보 패널에 EXP가 HP 위 8px (705 vs 713)
- 수정: `Math.abs(exp.y - hp.y) <= (hp.h + exp.h) * 4 + 30` 인접도 검증으로 완화
- 3개 코드 경로 (validateROIs, detectGameUI 조합 루프, tupleFound) 일관 변경

### 4. EXP/Level ROI 막대 위/아래 자동 + ADENA stale 자동 해제 (`53d0155`)
- 기존: `expBar.y` 자체에 height=6 ROI → 텍스트 없는 빈 영역 OCR
- 수정: 막대 height<12px 시 위/아래 후보(text height 18~24px) 만들고 inkScore 비교
- ADENA: `_adenaManualOverride=true` + adenaRegion.sourceId !== gameRegion.sourceId 시 자동 해제 + 재할당

### 5. EXP/Level이 HP 바와 겹치는 후보 자동 제외 (`e2129ff`)
- 기존 4번 fix의 부작용: below 후보(y=712~736)가 HP 바(y=713~735)와 겹쳐 inkScore가 HP 텍스트를 EXP로 오인
- exp.png에 "HP : 209/242" 텍스트 캡처 사례
- 수정: `overlapsHp(roiY, roiH)` 헬퍼 추가 + HP 겹침 후보 자동 제외

### 6. EXP/Level 다중 후보 inkScore 검색 (`7fc2fe4`)
- 기존 5번 fix 후에도 ROI가 채팅창 영역 잡음 (HP 너머 ink density 가장 높음)
- 픽셀 분석에서 채팅 메시지가 EXP보다 ink density 더 높았음
- 수정: 막대 위 -3*TEXT_H ~ 아래 +4*TEXT_H step=TEXT_H/3 후보들 모두 시도

### 7. **(핵심) findLevelTextLines — LV 텍스트 직접 검출** (`503795d`)
- **모든 이전 fix의 한계 인정** — 진행 막대 의존 SPEC는 EXP %에 따라 깨짐
- 픽셀 분석으로 진짜 LV/EXP 텍스트 위치 식별:
  - 사용자 게임의 좌측 미니 패널 (x_rel 0~0.20, y_rel 0.75~0.95)
  - 흰/베이지 픽셀(lum>180, sat<0.35) 가로 라인 검출
  - 첫 번째 라인의 좌측 cluster=Level, 우측 cluster=EXP%
- 수정: `findLevelTextLines(imageData, w, h)` 함수 추가
  - 행별 텍스트 픽셀 카운트 → 라인 그룹화 (count>=15 + 인접 행)
  - 각 라인에서 가로 cluster 검출 (인접 column gap≤3px 무시)
- `deriveTextROIs`: 막대 얇음(<12px) + 라인 검출 시 우선 사용, 미검출 시 inkScore fallback
- 막대 두꺼움(>=12px) 케이스는 기존 동작 유지 (어제 케이스 회귀 방지)

**검증**:
- 12-58-51 (어제, EXP 16%, expBar 168x27): 기존 막대 사용 → 회귀 없음 ✅
- 13-37-58 (오늘, EXP 0.17%, expBar 187x6): LV 라인 검출 → "LEV: 29" + "12.5187%" 정확 캡처 ✅

---

## 🛠 진단 도구 (다음 세션 즉시 활용 가능)

`scripts/` 디렉터리에 다음 도구 추가:

| 도구 | 용도 |
|------|------|
| `analyze-game-capture.js <PNG>` | HP/MP/EXP/ADENA 후보 위치/크기/HSV 모두 출력. 위치 필터 적용 전후 비교. |
| `test-detect.js <PNG>` | detectGameUI 결과(valid, anchors, textROIs) 빠른 검증 |
| `test-text-rois.js <PNG>` | deriveTextROIs 결과 + EXP 영역 above/below ink density 비교 |
| `find-text-around-expbar.js <PNG>` | expBar 주변 dy=-60~+60 (step 6) 위치별 ink/white pixel 분포 |
| `find-exp-on-left.js <PNG>` | 좌측 영역(x<15%) 오렌지/빨강/파랑 작은 blob 모두 출력 |
| `analyze-lv-text.js <PNG>` | 좌측 미니 패널 텍스트 라인 + 가로 cluster 시각화 |
| `crop-roi.js <PNG> x y w h <out>` | 임의 영역 잘라서 PNG 저장 (시각 확인용) |

**사용 흐름** (사용자 진단 받았을 때):
1. `node scripts/test-detect.js <game-region-raw.png>` → valid 여부 + anchor 위치 빠른 확인
2. valid=false면 → `analyze-game-capture.js` 로 후보 분포 분석
3. EXP/Level OCR 실패면 → `test-text-rois.js` + `crop-roi.js` 로 ROI 영역 시각 확인
4. ROI 위치가 잘못이면 → `analyze-lv-text.js` 로 진짜 텍스트 위치 픽셀 분석

---

## 🚨 다음 세션 우선 액션

### Priority 1: 사용자 ADENA OCR 안정화 검증
- 14-36-39 진단에서 ADENA "???" — template matching 진행 중
- 사용자가 사냥 좀 한 후에도 안 풀리면 추가 fix 필요
- 의심 원인: ADENA ROI width=113px (텍스트 약 60px + 검정 53px) → OCR 노이즈
- fix 후보:
  - inkScore로 ADENA 영역의 우측 빈 영역 자동 trim
  - 또는 ADENA ROI width를 더 좁게 (max 80px)
- 진단 시 `node scripts/crop-roi.js <raw> 1259 850 113 32 /tmp/adena.png` 으로 시각 확인

### Priority 2: 막대 두꺼움(>=12px) 케이스도 LV 텍스트 라인 적용 검토
- 현재 막대 height>=12면 자체 사용 (어제 케이스 회귀 방지)
- 하지만 EXP 99% 가까이 채워져 막대가 두껍게 잡혀도 진짜 텍스트는 별도 위치일 수 있음
- 안전한 방법: LV 라인 detect 시도 → 발견되면 우선 사용 (라인 없으면 fallback to 막대)

### Priority 3: ADENA 가로 / 세로 자동 감지 + 폭 trim 통합
- v1.4.0 Phase 1에서 inkScore 비교 도입 (a638042)
- 추가 trim: 검출된 cluster의 우측 끝까지로 width 자동 축소
- ADENA "39131만" 같은 한글 단위 처리 검토

### Priority 4: 단순 OCR confusion pair 추적
- EXP "93.9614" → "93.9615" (4↔5) 사용자 평가 "이정도는 괜찮다"
- 누적 시 학습 데이터 보강 (training 파이프라인은 `docs/TRAINING-PIPELINE.md`)

---

## 📝 빌드/배포 절차 (낚시 함정 주의)

```bash
cd C:\dev\lineage-mp-timer
# 1. 사용자가 portable 실행 중이면 종료 요청 (덮어쓰기 락)
# 2. 빌드 (필수)
npm run build      # electron-builder, NSIS + portable
# 3. dist (ZIP 패키징, 빌드 안 함!)
npm run dist       # build-distribute.ps1
# 4. 산출물:
#    dist/LineageMPTimer-1.4.1-portable.exe (포터블)
#    dist/LineageMPTimerPaddle Setup 1.4.1.exe (NSIS 설치형)
#    dist/LineageMPTimer-v1.4.1.zip (친구 배포용 — portable + 설명서 + 변경내역)
```

**⚠️ 절대 잊지 말 것**:
- `npm run dist` 단독으로는 코드 변경이 반영 안 됨 (ZIP만 재패키징). **반드시 `npm run build` 먼저 실행**.
- 사용자 진단 보낸 후 `cachedROIs`가 5분 TTL이라 새 빌드 받자마자 `🔄 재탐지` 버튼 눌러야 새 코드 동작.

---

## 🎓 이번 세션의 메타 교훈

1. **사용자가 옳을 가능성을 항상 고려**: "어제는 잘 됐다" 라고 했을 때 "환경 변화" 또는 "코드 회귀" 양쪽 다 검증. 결국 사용자 말이 맞았음 (게임 EXP % 차이).

2. **빠른 빌드 반복은 신뢰 떨어뜨림**: 6번 빌드/패치 반복 끝에 진짜 root cause 발견. 픽셀 분석으로 정확히 찾고 1번에 수정하는 게 더 효율적.

3. **진행 막대 의존 SPEC의 한계**: 게임 상태(EXP %)에 따라 막대 픽셀 가시성이 변함. 텍스트 자체 검출이 더 안정.

4. **inkScore 단독 사용 위험**: 채팅창, HP 바 등이 ink density 더 높을 수 있음. **위치 검증 + 영역 제외**와 함께 써야.

5. **진단 도구 작성에 시간 투자 가치 높음**: pngjs로 PNG 직접 분석하는 스크립트 7개 추가. 다음 세션에서 즉시 활용 가능.

---

_Last updated: 2026-05-06 v10 · Claude (Anthropic) · v1.4.1 자동 모드 root cause 7종 + LV 텍스트 직접 검출_
