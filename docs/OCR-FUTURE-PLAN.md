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
4. **6 ↔ 8** (상단 갈고리 vs 닫힌 루프)
5. **5 ↔ 7** (드물지만 발생)
6. **1 인식 누락** (얇은 세로획)
7. **7 인식 누락** (얇은 가로획 + 대각선)

샘플 수집 시 위 confusion pair 글자가 명확히 등장하는 케이스 다수 포함 필요.

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
