# 세션 인수인계 — 2026-05-04 (compact)

> **다음 세션 시 가장 먼저 읽어야 할 문서**
> 이전 세션의 학습 시도 → 실패 → 복귀 전체 흐름과 다음 작업 시작점이 정리되어 있습니다.

---

## ⚡ TL;DR — 30초 요약

**현재 상태**: OCR 정확도는 **세션 시작 직전 수준** (베이스라인 휴리스틱). lineage.traineddata 학습과 template matching 모두 정확도를 악화시켜 비활성화.

**작동 중**: hybrid voting + per-digit voting + leading-digit-drop suffix-match + MP anchor=0 보호.

**비활성**: lineage.traineddata (오버피팅), Template Override (라벨링 노이즈).

**다음 시도 후보**: ① 재라벨링 후 템플릿 재구축 ② CNN 분류기 ③ ITEM DROPS 활용.

---

## 📊 이번 세션의 시도/결과 (정직 보고)

### 시도 1: lineage.traineddata 학습
- **결과**: ❌ 오버피팅 (LEVEL 41/42=`28`, MP 90%=`/235`, 5000 iter 과도)
- **증상**: 학습 후 인식이 학습 전보다 더 나빠짐 ("박살")
- **조치**: `eng+lineage` → `eng` 단독으로 복구 (커밋 `91bb29d`)
- **자산 보존**: WSL `/root/tesstrain/data/lineage/checkpoints/` 체크포인트 + `build/tessdata/lineage.traineddata` 파일 삭제 안 함

### 시도 2: Template Matching (Hamming distance)
- **계획**: 463개 라벨 데이터 → 자릿수 템플릿 492개 추출 → OCR 결과 검증
- **구현**: `src/js/template-matcher.js`, `src/js/digit-templates.json` (32KB)
- **결과**: ❌ False override 발생 — 정확한 OCR 결과(49065)를 잘못된 값(49051)으로 덮어씀
- **원인 추정**:
  1. Claude가 직접 라벨링한 데이터에 5/6/0/8 confusion 들어감
  2. 픽셀 폰트의 5/6 자체가 글리프 유사
  3. 16x24 binary 다운샘플링으로 미세한 차이 소실
- **조치**: Override 코드 비활성화 (정보 로그만 출력, 커밋 `8b956e5`)
- **자산 보존**: 템플릿 파일/모듈은 삭제 안 함 (재라벨링 후 재활성화 가능)

### 보너스 수정
- **MP anchor=0 첫 인식 보호** (커밋 `ae34156`): 앱 재시작 직후 anchor MP=0이면 paddle plausibility 체크 무력화되던 버그. `hasAnchor` 체크 추가.
- **앱 재시작 시 트래커 자동 일시정지** (커밋 `fd2584f`): 사용자 불만 해결. tracker.active=true 저장 상태로 재시작해도 startedAt 자동 reset.
- **컴팩트 모드 트래커 행 추가** (이전 세션 마무리): F3 단축키, 두 줄 레이아웃.

---

## 🛡️ 현재 활성 OCR 보정 스택

```
[1] Hybrid voting (paddle + tesseract)
[2] PSM 7/8/13 다수결
[3] 이중 캔버스 (preprocessed 12x + raw 16x) → 6개 결과
[4] Per-digit majority voting (4↔9, 6↔8 같은 단일 자리 confusion)
[5] Leading-digit-drop suffix-match (anchor 없어도 동작)
[6] Anti-stuck 휴리스틱 (한쪽 anchor 고정 시 forward 우선)
[7] MP anchor=0 첫 인식 보호 ← NEW
[8] Pad 10px 확장 (영역 잘림 보충)
```

비활성:
- Lineage traineddata (`build/tessdata/lineage.traineddata` 파일 보존, worker는 `eng`만 사용)
- Template override (`src/js/template-matcher.js` 코드 보존, ADENA OCR에서 호출 안 됨)

---

## 🎯 다음 시도 후보 (우선순위 순)

### A. 재라벨링 + 템플릿 재구축 (가장 현실적)
1. WSL `/root/tesstrain/data/lineage-ground-truth/` 463개 PNG 다시 검토
2. 의심 라벨 (특히 5/6, 8/3, 4/9) 수동 재검증
3. 검증된 라벨만으로 templates 재추출
4. Override threshold를 매우 보수적(90%+)으로 재활성화
5. 또는 paddle/tess 둘 다 동의하는 케이스에서만 추출 (high confidence ground truth만)

### B. 단일 자릿수 CNN 분류기 (대안 ML)
- 462개 자릿수 샘플 (글자별 30~50개) → 간단 CNN 학습
- TensorFlow.js 모델로 export → 32KB 이하 가능
- 추론 시 CPU 5ms 이내
- 라벨 노이즈에 더 robust (학습 시 오류 평균화)

### C. 데이터 다양화 후 traineddata 재학습
- 다양한 캐릭터(다른 MP max), 다양한 LEVEL(1~99), 다양한 ADENA 자릿수
- iteration 1500~2000으로 축소 (오버피팅 방지)
- Validation set 분리 + 조기 종료
- text2image로 합성 데이터 추가

### D. Tesseract 단독 정확도 개선
- LSTM beam_width 조정, lstm_choice_mode 조정
- 다른 PSM 모드 (10, 11) 시도
- 더 다양한 preprocessing variants (binarization, dilation, erosion)

### E. 사용자 워크플로우 우회
- ITEM DROPS 시스템: ADENA 수동 입력 (기존 기능, 이미 100% 정확)
- 사용자가 OCR misread 발견 시 트래커 NOW 직접 수정 → 5초 OCR skip

---

## 🗂️ 핵심 자산 위치 (변경 없음, 보존 상태)

### Windows
| 자산 | 경로 | 상태 |
|------|------|------|
| 빌드 산출물 (최신) | `dist/LineageMPTimer-paddle-portable-1.2.0-paddle.exe` (134MB · 01:38) | 베이스라인 휴리스틱 |
| 학습 데이터 (라벨됨) | `%APPDATA%\Roaming\LineageMPTimer\training-data\` (463개) | 보존 |
| traineddata (비활성) | `build/tessdata/lineage.traineddata` (11.7MB) + `.gz` (6.3MB) | 보존, 미사용 |
| Templates JSON | `src/js/digit-templates.json` (32KB) | 보존, 호출 안 됨 |
| Template matcher 모듈 | `src/js/template-matcher.js` | 보존, override 비활성 |

### WSL Ubuntu (root)
| 자산 | 경로 | 상태 |
|------|------|------|
| 학습 환경 | `/root/tesstrain/`, `/root/lineage-train/` | 보존 |
| Ground truth | `/root/tesstrain/data/lineage-ground-truth/` (463 PNG+gt.txt) | 보존 |
| 학습 체크포인트 | `/root/tesstrain/data/lineage/checkpoints/` (BCER 1.96%) | 보존 |
| 추출된 raw 템플릿 PNG | `/root/templates/` (글자별 폴더) | 보존 |
| 헬퍼 스크립트 | `/root/setup_data.sh`, `/root/extract_templates.py`, `/root/build_templates_compact.py` | 보존 |

---

## 📚 관련 문서

| 문서 | 내용 |
|------|------|
| `CLAUDE.md` | 프로젝트 전체 컨텍스트 + WSL 환경 + 단축키 (F3 컴팩트) |
| `docs/OCR-FUTURE-PLAN.md` | OCR 개선 계획 + 사용자 지시 + 진행 history |
| `docs/TRAINING-PIPELINE.md` | WSL 학습 파이프라인 6단계 가이드 |
| `docs/SESSION-HANDOFF-LATEST.md` | 이 문서 (최신 세션 인수인계) |

---

## ⚠️ 함정 / 알려진 제약

### 라벨링 노이즈
- Claude가 463개 PNG를 직접 보고 라벨링 → 5/6/0/8 confusion 일부 들어갔을 가능성 높음
- 검증되지 않은 라벨 데이터로 ML/template은 위험
- 다음 시도 전 라벨 audit 필수

### 픽셀 폰트 글리프 유사성
- 게임 폰트 5와 6: 둘 다 위쪽 곡선 + 아래쪽 닫힌 루프 → 유사
- 4와 9: 위쪽 닫힌 모양 + 아래쪽 처짐 → 유사
- 8과 5/6: 안티앨리어싱으로 차이 흐려짐
- → 단순 이미지 비교는 한계, 컨텍스트(자릿수, anchor) 활용 중요

### Tesseract.js v5 + 다중 lang
- `eng+lineage` 사용 시 lineage가 우세하게 작용 가능 (확실치 않음)
- 안전하게 단일 lang(`eng`)만 사용 권장 — 현재 상태

### WSL shell escape
- `wsl.exe -- bash -c "..."` 시 변수 expand 잘못되는 케이스 존재
- 해결: 스크립트 파일로 작성 후 `wsl.exe -d Ubuntu -u root -- bash //path/to/script.sh` (앞에 `//` 두 개 필요, Git Bash 경로 변환 회피)

### Git
- Remote 미설정. push 하려면 GitHub repo 생성 후 `git remote add origin ...` 필요
- 브랜치: `paddle-ocr`

---

## 💬 사용자 컨텍스트

- 한국어 응답 선호
- 빠른 피드백 사이클 선호
- "정확도 박살나면 즉시 롤백" 요구함 (학습 전 수준 복귀를 우선시)
- ITEM DROPS 수동 입력보다 OCR 자동화 선호하지만, 정확도 저하 시 롤백 우선
- 진행률/상태 명확히 보고 받길 원함

---

## 🔁 다음 세션 시작 워크플로우

```
1. cd C:\dev\lineage-mp-timer
2. cat docs/SESSION-HANDOFF-LATEST.md          ← 이 문서 (가장 먼저)
3. git log --oneline -10                        ← 최근 커밋 확인
4. CLAUDE.md (프로젝트 구조 파악)
5. docs/OCR-FUTURE-PLAN.md (OCR 개선 계획 + history)
6. 사용자 요청 처리
```

---

## 📝 이번 세션 누적 커밋 (15개)

```
8b956e5 fix: ADENA template override 일시 비활성화 — 라벨링 노이즈로 false override
d70f985 fix: ADENA template matching 캔버스 불일치 + threshold 조정
33adf9c feat: ADENA template matching 가변 길이 (OCR digit-drop 대응)
ae34156 fix: MP hybrid voting — anchor=0 (첫 인식) 시 paddle plausibility 거부 버그
83f2d73 feat: 픽셀 폰트 Template Matching 시스템 추가 (학습 모델 폐기 대안)
91bb29d fix: lineage.traineddata 사용 보류 — 오버피팅으로 인식 정확도 악화
609da35 build: lineage.traineddata.gz 추가 (gzip 압축본)
fd2584f fix: 앱 재시작 시 세션 트래커 자동 일시정지
494f37c docs: 인수인계 문서 보강
ec51acb feat: 컴팩트 모드 + ADENA OCR 강화 + 게임 폰트 traineddata 통합
```

---

_Last updated: 2026-05-04 01:40 · 작성: Claude (Anthropic)_
_사용자 지시: "기록 남겨줘 compact하고 작업 다시 하려고해"_
