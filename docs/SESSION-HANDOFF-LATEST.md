# 세션 인수인계 — 2026-05-08 v13 (v1.5.0/v1.5.1 release + 학습 효과 분석)

> **다음 세션에서 가장 먼저 읽어야 할 문서**
> P2 학습 재수집 완료 (v1.5.0) + ROI fix (v1.5.1) + 학습 효과 정직한 분석

---

## ⚡ TL;DR — 30초 요약

**오늘 진행**:
1. P2 학습 데이터 재수집 (1,308개 _pending → 421 자동 채택)
2. tesstrain 재학습 → BCER 1.96% → **1.560%** (lineage_1.560_346_8600.checkpoint)
3. v1.5.0 빌드 + ZIP 배포
4. 사용자 진단 15-11-42에서 **expBar 짧은 후보 채택 issue** 발견 → v1.5.1 fix
5. 사용자 진단 15-24-11에서 ROI 정상 + OCR 인식률 정체 확인

**현재 상태**: v1.5.1 portable 빌드 완료. ROI 정상. 단 **OCR 인식률 큰 개선 없음** — 학습 데이터 다양성 부족이 원인.

**최신 빌드**:
- `dist/LineageMPTimer-1.5.1-portable.exe`
- `dist/LineageMPTimer-v1.5.1.zip` (127.62 MB)

**커밋**:
- `8d3bdec` fix(roi): v1.5.1 expBar width 최소 sanity
- `923c4a6` feat(v1.5.0): traineddata 재학습 — BCER 1.96% → 1.560%

---

## 🎯 사용자 핵심 질문 답변 — "학습을 더 하면 좋아지는가?"

**조건부 Yes**. 학습 양 단순 증가는 효과 미미. 핵심 3가지:

### 1. 데이터 **다양성**이 가장 중요
- 현재 분포 편향:
  - LEVEL: 7 unique 값 (1, 4, 12, 25, 28, 29, 31) — LV.1~99 일반화 불가능
  - EXP: 50%대 446개 (76% 편향) — 0/20/30/.../99 골고루 필요
  - ADENA: 5자리 124개 vs 4자리 210개 — 자릿수별 균등 필요
- v1.5.0 학습 데이터에서 **LV.7이 없었음** → 사용자 진단 15-24-11에서 LV.7 misread (V→W)

### 2. 라벨 **정확성** (quality)
- v1.5.0 자동 라벨링: acceptance 31.7%, ~5-10% 노이즈 가능
- 사용자가 라벨링 패널에서 직접 검증한 라벨이 quality 가장 높음

### 3. **어려운 case** 집중 수집
- v1.5.1 진단의 misread 케이스 = 학습 우선순위:
  - V → W (LEVEL "LV" → "LEW")
  - MP gauge 매우 짧을 때 cur/max confusion ("7/7" 같은 패턴)
  - ADENA 4자리 케이스 (5자리 학습 편중)

### 한계 — 학습으로 해결 불가능한 영역
- tesseract LSTM 모델 capacity (~95% 정확도가 현실 상한)
- 픽셀 폰트 본질적 ambiguity (사람도 0/8 구분 어려운 경우 있음)
- **OCR 후처리 / ensemble voting / anchor sanity** 휴리스틱 보완 필수

**결론**: 단순 학습 추가보다 **(a) 다양성 + (b) quality + (c) 어려운 case + (d) 후처리 휴리스틱** 4가지 균형이 효과적.

---

## 🔥 오늘 세션 결정적 발견

### 1. lineage 단독 모델 + 다중 PSM ensemble
- eng+lineage는 eng가 lineage 결과 오염 → eng 빠진 lineage 단독이 가장 정확
- PSM 7 (한 줄 텍스트)는 짧은 텍스트에 빈 결과 — PSM 8 (한 단어)가 픽셀 폰트에 best
- PSM 13은 다중 자릿수 케이스에서 자릿수별 결과 함께 출력 (예: ADENA "26450|26450")

### 2. tesstrain `make lists` cache 함정
- Makefile target이 cache로 skip되면 list.train/eval 갱신 안 됨
- 학습 fail 후 file 제거해도 list에 path 그대로 → 같은 fail 반복
- 해결: 직접 sed로 list.train/eval 정리 + file 제거 + 학습 재시도 cycle

### 3. corrupted .lstmf size threshold 한계
- 일부 .lstmf 파일은 size 정상이지만 header invalid → deserialize fail
- size threshold (1000 byte)로는 못 잡음
- 학습 시도 → fail file 식별 → 직접 제거 → 재시도 cycle (max 5 retries)

### 4. expBar 짧은 후보 채택 issue
- v1.5.0에서 width=58px orange element가 expBar로 잘못 채택
- EXP/LEVEL textROI 모두 LV.29 박스 부분만 캡처 → "C", "???"
- v1.5.1 fix: posFilter `bw>=80` + validateROIs width sanity 3종

### 5. MSYS path 변환 트랩
- Git Bash가 `/root/...` 같은 unix path를 `C:/Program Files/Git/root/...`로 변환
- WSL 호출 시 `MSYS_NO_PATHCONV=1` 또는 `//root/...` 더블 슬래시 필수

### 6. bash -c '...' single quote 함정
- 환경에 따라 변수 expansion 안 됨
- script file로 wrap해서 wsl bash로 실행이 가장 robust

---

## 📊 학습 데이터 분포 (v1.5.0)

| Region | baseline | 신규 (v2 suffix) | 합계 | _rejected |
|---|---:|---:|---:|---:|
| MP | 111 | 183 | 293 | 35 sanity + ~120 voting |
| EXP | 203 | 114 | 317 | 29 sanity + 443 voting |
| ADENA | 107 | 124 | 230 | 20 sanity + 245 voting |
| LEVEL | 42 | 0 (제외) | 42 | (학습 미사용) |
| **합계 (학습)** | **463** | **421** | **840** | |

> ⚠ **LEVEL은 v1.5.0에서 제외**. 다양성 부족 (12 unique 값) — v1.5.2/v1.6.0에서 부캐 사냥으로 보강.

**남아있는 편향**:
- EXP 정수부 50%대 446개 (76%)
- ADENA 5자리 위주 (4자리 부족)
- MP cur 다양성 OK (0~210)

---

## 🚨 내일 우선 액션

### Priority 1: ADENA textROI 우측 정밀화 (v1.5.2)
- 현재 width=61px, frameW 클램프로 우측 끝까지 = 우측 공백/노이즈 포함
- 사용자 시각적 인식 부정적 ("우측을 더 많이 보고 있어")
- 수정: 세로 레이아웃 시 textROI width = `Math.min(adenaIcon.width + 30, frameW - x)` 정도로 좁힘
- `roi-detector.js` line 580 부근 (ADENA chosen 영역) 수정

### Priority 2: MP gauge 짧을 때 OCR 보강
- v1.5.1 진단: MP "7/7" misread (실제 7/242)
- gauge 매우 짧으면 max 부분 잘려 OCR이 cur/max 같은 값 출력
- 수정 방안:
  - mpBar.width 매우 작을 때 (< 30) hpBar 기반 textROI width 사용 (이미 v1.4.3 일부 적용)
  - max anchor와 OCR cur/max 비교 → max 변경 시 의심 (5회 검증)

### Priority 3: 학습 데이터 다양성 보강 plan
- 부캐 사냥으로 LEVEL 1/5/10/15/20/30/40/50/60/70/80/90/99 캡처
- ADENA 자릿수 3/6/7자리 의도적 캡처
- EXP 정수부 0/10/20/30/40/60/70/80/90 의도적 캡처 (50% 편향 회피)
- 1~2주 누적 후 v1.6.0 학습

### Priority 4: 사용자 직접 라벨링 권장
- 자동 라벨링 (voting)은 ~5-10% 노이즈
- 사용자가 라벨링 패널에서 batch 검증한 라벨이 highest quality
- 사용자 시간 부담 큼 → 우선순위 낮은 case (어려운 confusion)만 사용자 검증

### Priority 5: OCR 후처리 휴리스틱 강화
- Confusion pair 추가 (V↔W, MP cur≈max 의심 등)
- 시간순 monotonicity (EXP 단조 증가)
- 학습 외 후처리도 미세 조정 가능

---

## 🛠 새 도구 (오늘 추가)

`scripts/`:
- **wsl-tesseract-batch.sh** — WSL tesseract ensemble OCR batch (3 PSM × 1308 PNG)
- **wsl-tesseract-vote.js** — 4-way voting + 자동 라벨링 + fs 이동 (Node.js)
- **wsl-sync-groundtruth.sh** — Windows training-data → WSL ground-truth sync
- **wsl-train.sh** — 단순 학습 wrapper
- **wsl-robust-train.sh** — sync + make lists + corrupted 자동 cleanup + iterative training
- **wsl-cleanup-and-resume.sh** — list.train/eval sed 정리 + 학습 재개
- **wsl-clean-and-train.sh** — 이전 시도 (deprecated, 참고용)

---

## 📝 빌드/배포 절차

```bash
cd C:\dev\lineage-mp-timer
# 1. 사용자 portable 종료
# 2. 빌드
npm run build      # NSIS + portable
# 3. dist
npm run dist       # ZIP 패키징
# 4. 산출물:
#    dist/LineageMPTimer-1.5.1-portable.exe
#    dist/LineageMPTimer-v1.5.1.zip
```

⚠️ `npm run dist` 단독으로는 코드 변경 안 반영. 반드시 `npm run build` 먼저.

---

## 🎓 오늘 메타 교훈

1. **사용자 위임 시 끝까지 처리**: 사용자가 "끝까지 처리해줘" 하면 나에게 떠넘기지 말고 자동화 구현. WSL tesseract ensemble + voting으로 사용자 시간 0 자동화 성공.

2. **학습 양 vs 다양성**: 463 → 884 (91% 증가)했지만 BCER만 0.4%p 개선, 실제 인식률 미미. **다양성**이 진정한 개선 키.

3. **OCR 후처리 휴리스틱은 필수**: 모델 학습만으로 100% 정확도 불가능. anchor sanity, confusion-aware verification, 시간순 monotonicity 등 휴리스틱 layer 필요.

4. **체크포인트 이어 학습 압도적 효율**: v1.4.x baseline 체크포인트 (BCER 1.96%) 이어 학습 → 90초만에 1.560% 도달. 처음부터는 1시간+.

5. **ROI fix는 사후 검증 + 후보 단계 필터 둘 다**: validateROIs는 사후 검증 (cache invalid 트리거), candidate posFilter는 사전 차단. 둘 다 적용해야 robust.

6. **사용자 인지 vs 실측 다름**: 사용자 "1293개 쌓이고 있어" → 실제 1305 (오차 1%). "ADENA 우측 더 많이" → 사실은 정확하나 frameW 클램프로 깔끔 X. 진단 PNG로 검증 필수.

---

## 📂 plan 문서

```
.omc/plans/v1.4.2-auto-stabilization.md       — Phase 3 (3a/3b/3c, 이전 세션)
.omc/plans/v1.4.3-confusion-defense.md        — P0 + P1 (이전 세션)
.omc/plans/v1.5.0-training-data-recollection.md — P2 학습 재수집 (오늘 실행 완료)
.omc/plans/v1.5.2-improvement.md              — 다음 단계 plan (작성 예정)
```

---

_Last updated: 2026-05-08 v13 · Claude (Anthropic) · v1.5.0+v1.5.1 release + 학습 효과 분석_
