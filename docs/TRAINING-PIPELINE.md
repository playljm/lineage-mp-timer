# 게임 폰트 traineddata 학습 파이프라인 (Windows)

> 작성일: 2026-05-02
> 목표: 리니지 클래식 픽셀 폰트 전용 `lineage.traineddata` 제작 → 휴리스틱 없이 95~99%+ OCR 정확도

---

## Phase 1: 학습 데이터 수집 (앱 내장 도구)

### 사용법
1. 앱 실행 후 **OCR · 아이템** 탭으로 이동
2. 자동 감지를 켜고 게임 화면이 4개 영역에 잘 잡히는지 확인 (미리보기 표시)
3. **"📸 학습 데이터 수집"** 섹션 펼치기
4. 4개 입력칸에 **사람 눈으로 직접 본 정답값** 입력:
   - **MP** 예: `229/235`
   - **경험치** 예: `25.6745`
   - **레벨** 예: `28`
   - **아데나** 예: `42402`
5. **"💾 4개 모두 저장"** 클릭 (또는 Enter 키)
6. 게임에서 값이 변할 때마다 (10초 간격 권장) 위 단계 반복

### 수집 목표
- **각 영역당 최소 200개**, 권장 500개
- **다양성** 확보:
  - 모든 자릿수 (1자리 ~ 5자리)
  - 모든 숫자 (0~9 골고루)
  - 특히 confusion pair: **0/8, 0/5, 3/9, 4/9, 6/8, 5/7**
  - 사냥 위치 (배경색) 다양화

### 저장 위치
```
%APPDATA%\LineageMPTimer\training-data\
├── mp\        # MP 영역 PNG + .gt.txt 페어
├── exp\       # 경험치
├── level\     # 레벨
└── adena\     # 아데나
```

각 샘플:
```
229of235_20260502_233512_847.png        # 이미지
229of235_20260502_233512_847.gt.txt     # ground truth ("229/235")
```

> **`.gt.txt`는 이미 Tesseract LSTM `lstm.train` 호환 포맷**입니다. 추가 변환 불필요.

---

## Phase 2: Tesseract 환경 셋업 (Windows)

### 2.1 Tesseract 설치
1. https://github.com/UB-Mannheim/tesseract/wiki 에서 **64-bit installer** 다운로드
2. 설치 경로: `C:\Program Files\Tesseract-OCR\` (기본)
3. 환경 변수 PATH 에 추가
4. 검증:
   ```cmd
   tesseract --version
   ```

### 2.2 학습 도구 (training tools)
일반 installer는 `lstmtraining.exe`, `combine_tessdata.exe` 등 학습 도구가 빠져있습니다.

**옵션 A**: Tesseract 빌드 + tools 별도 다운로드
- https://github.com/tesseract-ocr/tesseract/releases 에서 `*-src.tar.gz` 다운로드 후 빌드
- **너무 복잡** → WSL 권장

**옵션 B (권장)**: WSL2 + Ubuntu
```bash
# Ubuntu in WSL
sudo apt update
sudo apt install tesseract-ocr libtesseract-dev tesseract-ocr-eng
sudo apt install tesseract-ocr-script-latn
# 학습 도구
sudo apt install make automake libtool g++ pkg-config libpng-dev libjpeg-dev libtiff-dev zlib1g-dev libicu-dev libpango1.0-dev libcairo2-dev
git clone https://github.com/tesseract-ocr/tesseract.git
cd tesseract
./autogen.sh && ./configure && make
sudo make install
sudo make training
sudo make training-install
```

### 2.3 기존 traineddata 다운로드
```bash
mkdir -p ~/lineage-train
cd ~/lineage-train
# 베이스 모델 (영문 fast 또는 best)
wget https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata
```

---

## Phase 3: 학습 데이터 변환

### 3.1 데이터 복사
Windows의 `%APPDATA%\LineageMPTimer\training-data\`를 WSL로 복사:
```bash
mkdir -p ~/lineage-train/data
cp -r /mnt/c/Users/$USERNAME/AppData/Roaming/LineageMPTimer/training-data/* ~/lineage-train/data/
```

### 3.2 LSTMF 파일 생성
각 PNG → LSTMF (lstm 학습 단위):
```bash
cd ~/lineage-train/data

# 각 폴더(mp/exp/level/adena)별로 모든 PNG에 대해 lstmf 생성
for region in mp exp level adena; do
  cd $region
  for f in *.png; do
    base="${f%.png}"
    tesseract "$f" "$base" \
      --psm 7 \
      lstm.train
  done
  cd ..
done
```

> `--psm 7`: single text line. 우리 데이터는 모두 1줄 텍스트라 적합.

### 3.3 listfile 생성
모든 lstmf 파일 경로를 한 파일에 모음:
```bash
cd ~/lineage-train
find data -name "*.lstmf" > all_lstmf_files.txt

# 80/20 train/eval 분리 (선택)
shuf all_lstmf_files.txt > shuffled.txt
total=$(wc -l < shuffled.txt)
train_count=$((total * 80 / 100))
head -n $train_count shuffled.txt > train_files.txt
tail -n +$((train_count + 1)) shuffled.txt > eval_files.txt
```

### 3.4 LSTM 모델 추출
베이스 traineddata에서 LSTM 부분 추출:
```bash
combine_tessdata -e eng.traineddata eng.lstm
```

---

## Phase 4: Fine-tuning 학습

### 4.1 학습 실행
```bash
mkdir -p output
lstmtraining \
  --model_output output/lineage \
  --continue_from eng.lstm \
  --traineddata eng.traineddata \
  --train_listfile train_files.txt \
  --eval_listfile eval_files.txt \
  --max_iterations 10000 \
  --target_error_rate 0.01
```

진행 상황 모니터링:
- `BCER`: best character error rate (낮을수록 좋음, 0.01 이하 목표)
- 약 1~3시간 (CPU) 또는 10~30분 (GPU)

### 4.2 학습 결과 추출
```bash
lstmtraining \
  --stop_training \
  --continue_from output/lineage_checkpoint \
  --traineddata eng.traineddata \
  --model_output lineage.traineddata
```

결과: `~/lineage-train/lineage.traineddata` (~10MB)

---

## Phase 5: 앱에 통합

### 5.1 traineddata 배치
```bash
# WSL에서 Windows 프로젝트로 복사
cp lineage.traineddata /mnt/c/dev/lineage-mp-timer/build/tessdata/
```

### 5.2 코드 수정 (app.js)
worker init 시 `lang` 파라미터를 `'eng+lineage'`로 변경:

```javascript
// before
ocrWorker = await Tesseract.createWorker('eng', 1, opts);

// after — 게임 폰트에 fitted된 lineage 모델 우선 사용
ocrWorker = await Tesseract.createWorker('eng+lineage', 1, opts);
```

또는 ADENA만 lineage 사용:
```javascript
await w.setParameters({ tessedit_char_whitelist: '0123456789,', /* ... */ });
// language switch는 createWorker 시점에 결정 → 별도 worker 필요
```

### 5.3 빌드 설정 확인 (`package.json`)
이미 `extraResources` 패턴이 `*.traineddata*`를 매칭함:
```json
{
  "from": "build/tessdata",
  "to": "tesseract/tessdata",
  "filter": ["**/*.traineddata*"]
}
```
별도 수정 불필요. `npm run build` 만 실행.

---

## Phase 6: 검증 + 휴리스틱 단순화

### 6.1 정확도 측정
- 사냥 1시간 동안 ADENA misread 카운트
- 기존 4↔9, leading-digit-drop, per-digit voting 등 휴리스틱 → 우회 발생률
- 목표: < 1%

### 6.2 휴리스틱 정리 (선택)
정확도가 충분히 높으면:
- per-digit voting 제거 가능
- suffix-match digit-drop 제거 가능
- hybrid voting 단순화 또는 단일 엔진(tesseract+lineage)으로 전환 가능

코드 단순해지고 유지보수 비용 ↓.

---

## 주의사항

1. **샘플 다양성** > 샘플 수
   - 같은 값(34326)만 500개 모아도 의미 없음
   - 다양한 자릿수 × 다양한 숫자 × 다양한 배경

2. **라벨 정확성**
   - 정답값 오타 1개 = 학습 노이즈
   - 입력 시 한 번 더 확인

3. **GPU 추천**
   - CPU만으로 10000 iteration = 1~3시간
   - GPU(CUDA) = 10~30분

4. **점진적 업데이트**
   - 처음 200개로 1차 학습 → 정확도 80~90%
   - 부족한 confusion case 추가 수집 → 2차 학습 → 95%+

---

## 참고 자료

- [Tesseract LSTM 학습 공식 문서](https://tesseract-ocr.github.io/tessdoc/tess4/TrainingTesseract-4.00.html)
- [tessdata_best (베이스 모델)](https://github.com/tesseract-ocr/tessdata_best)
- [WSL2 설치](https://learn.microsoft.com/ko-kr/windows/wsl/install)
- [jTessBoxEditor (수동 라벨링이 필요할 때)](http://vietocr.sourceforge.net/training.html)
