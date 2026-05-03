# OCR 정확도 개선 — 향후 계획

작성일: 2026-05-02
브랜치: `paddle-ocr`
상태: 휴리스틱 기반 hybrid voting까지 도달, 추가 개선 시 학습 기반으로 전환

---

## 현재 도달한 한계

### 도입한 메커니즘 (paddle-ocr 브랜치)
1. **PaddleOCR 통합** — paddle PP-OCRv2 모델 자동 감지 루프에 통합
2. **Hybrid voting** — paddle + tesseract 동시 실행 후 일치 시 채택
3. **영역별 휴리스틱**:
   - **MP**: anchor 대비 ±20 변화 + max 일치
   - **EXP**: 작은 전진(0~5%p) 또는 레벨업 점프(99→0)
   - **ADENA**: anchor 자릿수 매치 + ≥ anchor*0.5 가드 + agreement 우선
   - **둘 다 plausible**: anchor 대비 |delta| 작은 쪽 또는 agreement 높은 쪽
4. **Watchdog** — 10초 hang 감지 시 force unlock
5. **사용자 NOW 칸 편집 보호** — focus/input/keydown 후 5초 OCR skip
6. **Source-extending pad** — 사용자 영역 사방 N 픽셀 추가 캡처 (leading 글자 잘림 보호)
7. **In-UI Hybrid 결정 로그** — DevTools 안 열어도 진단 가능

### 관찰된 잔존 한계
- **paddle 6/8 confusion** — 6의 상단 갈고리와 8의 상단 루프가 픽셀 폰트에서 유사
- **둘 다 같은 misread 케이스** — paddle/tess가 동일한 자리 동일하게 misread (예: 8164 → 둘 다 5164 또는 둘 다 91584)
- **slashed-zero (0의 가운데 점/슬래시)** — paddle이 0을 8로 인식하는 경향 (1x raw로 우회되긴 함)
- **글리프 두께 비슷한 슬래시** — morphology opening으로 제거 시 글자도 손상

이는 모두 **사전훈련된 OCR 모델이 게임 픽셀 폰트 분포에 맞지 않아서** 발생하는 근본적 한계.

---

## 다음 단계: 게임 폰트 전용 traineddata 학습

휴리스틱으로 더 짜낼 카드가 없을 때 시도할 마지막 카드.

### Tesseract LSTM 학습 (권장 경로)

#### 1. 데이터 수집
- 리니지 클래식 화면 캡처 100~500장 수집
- MP/EXP/LEVEL/ADENA 각 영역별 다양한 값 (0~9 모든 글자 충분히 등장)
- 동일 폰트/배경/크기 조건

#### 2. 라벨링
- **jTessBoxEditor** 도구 사용
- 각 글자별 bounding box + 정답 텍스트 입력
- 슬래시드 제로(Ø-like) 같은 특수 글리프도 정확히 라벨

#### 3. 학습
```bash
# Tesseract LSTM 미세조정 (fine-tuning)
# 기반: eng.traineddata
# 추가 학습: lineage 게임 폰트
combine_tessdata -e eng.traineddata eng.lstm
lstmtraining \
  --model_output ./output/lineage \
  --continue_from ./eng.lstm \
  --traineddata ./eng.traineddata \
  --train_listfile ./training_files.txt \
  --max_iterations 10000

# 결과 추출
lstmtraining \
  --stop_training \
  --continue_from ./output/lineage_checkpoint \
  --traineddata ./eng.traineddata \
  --model_output ./lineage.traineddata
```

#### 4. 통합
- 결과물 `lineage.traineddata` (~10MB)
- `build/tessdata/`에 추가
- `package.json` extraResources 패턴 이미 `*.traineddata*` 매칭함
- tesseract 워커 init 시 `lang: 'lineage'` 또는 `'eng+lineage'` 지정

### PaddleOCR 학습 (대안)

paddle 쪽도 fine-tuning 가능하지만 도구 체인 복잡함:
- PaddleOCR 학습 환경 (Python + GPU 권장)
- ICDAR 형식 라벨링
- 학습 후 ONNX 변환 → paddlejs 모델 export

---

## 학습 시 우선순위 글리프

게임 폰트에서 확인된 confusion pair:
1. **0 ↔ 8** (slashed zero)
2. **0 ↔ 5**
3. **3 ↔ 9**
4. **4 ↔ 9** (2026-05-02 ADENA 영역에서 확인 — 34326 → 39326 misread)
5. **6 ↔ 8** (상단 갈고리 vs 닫힌 루프)
6. **5 ↔ 7** (드물지만 발생)
7. **1 인식 누락** (얇은 세로획)
8. **7 인식 누락** (얇은 가로획 + 대각선)

샘플 수집 시 위 confusion pair 글자가 명확히 등장하는 케이스 다수 포함 필요.

---

## 사용자 지시 (2026-05-02)

> "추후에는 개선이 안된다면 학습 시켜서 하는 방향으로 할게 기록 남겨줘"

**합의된 진행 방향**:
1. **1차 시도**: 휴리스틱 기반 개선 (preprocessing, voting, anchor heuristic 등)
2. **1차 실패 시**: 학습 기반 traineddata 제작으로 즉시 전환 (위 § "다음 단계: 게임 폰트 전용 traineddata 학습" 참조)

휴리스틱은 게임 픽셀 폰트의 분포 한계 때문에 일정 수준 이상 개선되지 않는다. 같은 confusion pair가 반복적으로 나타나면 학습 단계로 escalate 한다. 동일 이슈로 3회 이상 휴리스틱 패치를 추가했는데도 재발한다면 자동으로 학습 전환 검토 trigger.

**진행 history**:
- 2026-05-02 ADENA 4↔9 confusion 보고 — per-digit voting 추가 시도 (1차)
- 2026-05-02 ADENA leading-digit-drop 보고 (41293 → 1293) — pad 10px 확장 + suffix-match 휴리스틱 추가 (1차)
- 2026-05-02 ADENA 복합 오인식 보고 (42402 → 2202): 앞자리 누락 + 중간 4→2 동시 발생
  - 위 두 패치로도 해결 안 됨 — **휴리스틱 한계 도달** ⚠️
  - 사용자 지시("개선 안되면 학습")에 의거 **학습 단계 escalate trigger 발동**

- 2026-05-03 **lineage.traineddata 학습 시도 (Phase 2)**:
  - 463개 라벨 데이터 수집 (Claude가 직접 라벨링)
  - WSL Ubuntu + tesstrain Makefile + Tesseract LSTM fine-tuning
  - 5000 iter → BCER 4.02% → 1.96% (학습 데이터 기준 양호)
  - **결과: 실전 적용 시 인식 더 악화 (오버피팅)** ❌
  - 원인: 학습 데이터 편향 (LEVEL 41/42=`28`, MP 90%=`/235`, EXP 27~32% 좁은 구간)
  - 조치: `eng+lineage` → `eng` 단독 복구 (커밋 `91bb29d`)
  - 자산 보존: WSL 체크포인트 + `build/tessdata/lineage.traineddata` 보존, 미사용

- 2026-05-04 **Template Matching 시도 (학습 모델 대안)**:
  - 동일 463개 라벨 데이터에서 자릿수 템플릿 492개 추출 (글자별 30~50개)
  - Hamming distance 기반 16x24 binary 매칭 → 32KB JSON
  - 가변 길이 매칭 (1~7자리) 추가
  - **결과: False override 발생, 정확한 OCR을 잘못 덮어씀** ❌
  - 사례: 49065 (정확) → 49051 (틀림, 80% 확신)
  - 원인: 라벨링 노이즈 (5/6/0/8 confusion 들어갔을 가능성) + 픽셀 폰트 글리프 유사성
  - 조치: Override 비활성, 정보 로그만 출력 (커밋 `8b956e5`)
  - 자산 보존: `digit-templates.json`, `template-matcher.js` 보존

- 2026-05-04 v3 **3단계 종합 개선 + UI 진단 + 검증 시스템** (commit 6a48ee8 ~ 1976d61):

  **A. 전처리 다양성 확장**
  - `preprocessCanvas` 모드 (sharpen/binarize 옵션) + Otsu 이진화 추가
  - 4 캔버스 변형 (default/soft/otsu/raw) × 3 PSM = 12 결과
  - MP에도 3 캔버스 적용
  - agreement-misread (양쪽 엔진 동시 misread) 깨질 확률 ↑

  **B. Class-aware 3-tier hybrid override**
  - WSL purity 리포트 → CLEAN(1,2,3,5,/,.) vs NOISY(0,4,6,7,8,9) 분류
  - Tier A-clean: score≥0.74/gap≥0.04 → DECISIVE override (unanimous misread도 정정)
  - Tier A-extreme: score≥0.80/gap≥0.08 → DECISIVE
  - Tier B (voting weak): clean ≥0.70/0.025, noisy ≥0.74/0.04
  - 안전 장치: 2개 이상 위치 동시 override는 reject

  **C. Grayscale 16x24 templates**
  - 16x24 binary (48B/48KB) → 16x24 grayscale (384B/268KB)
  - Hamming → Manhattan distance (anti-alias 정보 보존)
  - Inter-class purity rank-based filter (top 50 per class)
  - `template-matcher.js` format 자동 감지 (`json.format === 'grayscale'`)

  **D. AutoTrim 가장자리 artifact 자동 제거**
  - `autoTrimEdgeArtifacts()` 함수 신규 (column ink density 분석)
  - 양 끝 isolated narrow group 감지 → trim
  - 보호 조건: width<25%, gap≥3, vertical<60% (real "1" 디짓 보존)
  - 명/암 자동 감지 (preprocessed/raw 둘 다 지원)
  - 사용자가 영역을 정확히 못 그려도 자동 보정

  **E. Cached anchor 자동 복구**
  - 동일 paddle 값이 2회 연속 digit-drop으로 거부되면 anchor 자동 갱신
  - 잘못된 cached anchor에서 자동 탈출 (586391 → 58039)

  **F. EXP 0.1%p 점프 임계값 + 검증 큐**
  - 사용자 요청: "한틱에 5%는 너무 높고.. 0.1% 이상도 막아줘"
  - ±0.1%p만 즉시 허용, 그 이상은 2회 연속 같은 값 검증
  - 레벨업 (anchor>95% → val<5%) 예외

  **G. 자릿수 동률 시 짧은 길이 선호**
  - 풀-넘버 majority 동률 → 짧은 자릿수 우선 ("59897" vs "995897" → "59897")
  - digit-add (phantom 글자) 자동 방지

  **H. UI 진단 강화**
  - `pushHybridLog`로 모든 override/AutoTrim/검증 결정 노출
  - F12 안 열어도 사용자가 OCR 결정 흐름 실시간 확인 가능

  **결과 (사용자 평가)**:
  > "점점 좋아지고 있어 아주 인식 잘하다가 중간중간 튀는 현상이 발생하고 있어"
  > "이제까지 제일 인식 잘 되고 있어"

  **남은 한계**:
  - ADENA digit-add 케이스 (995897 같은) 가끔 발생
  - EXP/ADENA spike 가끔 발생 (verification으로 대부분 흡수)
  - 픽셀 폰트 OCR 본질적 한계 (특히 0/4/6/7/8/9 confusion)

- 2026-05-04 **현재 상태 (v3)**:
  - 9개 commit 누적, 빌드 `dist/LineageMPTimer-paddle-portable-1.2.0-paddle.exe` (134MB · 03:20)
  - 사용자 평가: "이제까지 제일 인식 잘 되고 있어"
  - 다음 시도 후보: `docs/SESSION-HANDOFF-LATEST.md` § "내일 작업 후보" 참조
    P1: ADENA 큰 점프 검증 큐 / Per-canvas outlier / EXP tolerance 재조정
    P2: anti-flicker 다중 캡처 / Tesseract LSTM 튜닝 / 신뢰도 가중 voting
    P3: CNN 분류기 / 영역 자동 fine-tune

---

## 학습 결과 통합 후 기대 효과

- 정확도 95~99%+ (게임 폰트에 fitted)
- hybrid voting 불필요해질 수 있음 (단일 엔진 신뢰도 ↑)
- 휴리스틱 단순화 가능 (false-positive 적음)

다만 학습 자체가 **1~2주 노가다** (수집 + 라벨링 + 학습 + 검증). 시간 투자할 가치 판단 필요.

---

## 임시 회피책 (학습 전까지)

학습 못 해도 다음 방법으로 일상 사용 가능:

### 1. ITEM DROPS 시스템 활용
- ADENA OCR 안 쓰고 사냥 시작 시 수동 입력
- 드랍 아이템 수량 입력 → "💰 아데나에 더하기" 버튼
- 100% 정확

### 2. 트래커 NOW 칸 수동 보정
- 가끔 misread 발견 시 직접 입력 (5초 OCR skip 자동)
- EXP/H 측정엔 큰 영향 없음

### 3. 영역 정확히 캡처
- ADENA: 코인 아이콘 빼고 숫자만
- 화살표 키 미세 조정으로 1~2 픽셀 단위 정확히
- 좌우 1~2 픽셀 여유 두기

---

## 참고 자료

- [Tesseract LSTM 학습 공식 문서](https://tesseract-ocr.github.io/tessdoc/tess4/TrainingTesseract-4.00.html)
- [PaddleOCR 학습 문서](https://github.com/PaddlePaddle/PaddleOCR/blob/main/doc/doc_en/training_en.md)
- jTessBoxEditor: GUI 라벨링 도구
- 컴퓨팅 리소스: GPU 1대 (학습 시 필수, CPU만으론 시간 너무 오래)
