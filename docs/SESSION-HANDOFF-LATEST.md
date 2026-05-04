# 세션 인수인계 — 2026-05-04 v4 (4자리 ADENA + EXP/MP phantom digit 차단)

> **다음 세션 시 가장 먼저 읽어야 할 문서**
> v3 빌드 사용자 테스트 후 발견된 잔여 misread 패턴 3건 (4자리 ADENA + 빨간 별 아이콘 / EXP phantom digit / MP slash-drop) 추가 차단.

---

## ⚡ TL;DR — 30초 요약

**이번 세션 시작 상태**: 베이스라인 휴리스틱만 활성. 5만→9만, 끝자리 phantom "1" 등 misread 빈번.

**현재 상태 (사용자 직접 평가)**:
> "점점 좋아지고 있어 아주 인식 잘하다가 중간중간 튀는 현상이 발생하고 있어 / 이제까지 제일 인식 잘 되고 있어"

**주요 성과**:
- MP/LEVEL: 안정적 (✅ 정상)
- EXP: 0.1%p 점프 검증 큐로 misread 거의 차단
- ADENA: cached anchor 자동 복구 + AutoTrim + 3-tier override

**남은 한계**:
- ADENA 가끔 phantom 추가 글자 (995897 같은)
- EXP/ADENA 가끔 spike (verification으로 대부분 흡수됨)
- 픽셀 폰트 OCR 본질적 한계 (특히 0/4/6/7/8/9 confusion)

---

## 📊 누적 commit (v3 9개 + v4 1개 = 10개)

```
v4 (이번 새션) — 사용자 추가 보고 패턴 차단
[NEW]   fix: 채도 기반 autoTrim + EXP/MP phantom digit sanity check

v3 (어제 새벽) — 9 commits
e3d58b5 docs: 세션 인수인계 v3
1976d61 fix: ADENA digit-add 방지 + cached anchor 복구 빠르게 (3→2회)
e3191cd fix: EXP 0.1%p 점프 임계값 + 검증 큐 (사용자 요청)
9bce20a fix: cached anchor 자동 복구 + Tier 임계값 grayscale 실측 보정
fdf9b4b feat: 캡처 영역 가장자리 artifact 자동 trim
20ddd12 diagnose: ADENA template 진단 정보 UI 로그 + Tier A 임계값 조정
5ef2582 fix: ADENA leading-digit unanimous misread 정정 (class-aware 3-tier)
e92708c docs: 세션 인수인계 v2
570a031 feat: Grayscale 16x24 템플릿 + template-matcher 동적 format
6a48ee8 feat: OCR 정확도 개선 — 전처리 다양성 + Hybrid per-digit override
```

**최신 빌드 (v4)**: `dist/LineageMPTimer-paddle-portable-1.2.0-paddle.exe` (128MB · **10:37**) ← 현재
**이전 빌드 (v3)**: 03:20 — 사용자 테스트 후 잔여 패턴 발견됨 (4자리 ADENA + EXP/MP phantom)

---

## 🔥 v4 변경 사항 — 사용자 보고 → 즉시 수정

### 사용자 보고 (v3 빌드 테스트 후)
1. **ADENA 4자리 + 뒷 그림**: 캡처 영역 78×22에 "5734" + 빨간 별 아이콘이 함께 들어가서 OCR 흔들림
2. **EXP 자꾸 mismatch**: paddle "51.84321" (5자리) vs 캡처 이미지 "51.0432" (anchor 4자리) — phantom "1" 추가
3. **MP slash-drop**: paddle "377235" (6자리) vs userMax 235 — slash 무시 misread

### 수정 내역

#### 1. autoTrim 채도 기반 검출 (`autoTrimEdgeArtifacts`)
**문제**: 빨간 별/스파클 아이콘은 `vRatio ≥ 0.6` (위아래 다 참) → 기존 geometric 조건 통과 못함
**해결**:
- 컬럼 그룹별 평균 채도(max−min RGB) 계산하는 `chromaScore(start, end)` 헬퍼 추가
- 게임 숫자: chroma < 10 (거의 무채색)
- 빨간 별: chroma ≥ 30 (높은 채도)
- 트리거 조건: `(geometric) OR (chroma ≥ 30 && gap ≥ 2)`
- 양 끝 group 모두 적용

UI 로그: `✂️ AutoTrim R:Xpx (artifact 제거: ...)` + console 디버그 `chroma=ZZ`

#### 2. EXP phantom digit sanity (`ocrExpRegionHybrid`)
**문제**: paddle이 "51.0432" → "51.84321" 같은 디지트 추가 misread
**해결**:
- ocrExpRegionHybrid 진입 직후 paddle/tess 결과의 소수점 자릿수 검증
- 조건: 자릿수 `> anchor 자릿수` AND 값 차이 `> 0.3%p` → 해당 엔진 결과 폐기
- anchor 자릿수 ≥ 2일 때만 발동 (첫 인식 보호)

UI 로그: `EXP ❌ paddle phantom digit (자릿수 5 > anchor 4, Δ0.800%p): paddle 폐기`

#### 3. MP slash-drop sanity (`ocrMpRegionHybrid`)
**문제**: paddle이 "37/235" → "377235" 같은 slash 무시 misread
**해결**:
- ocrMpRegionHybrid 진입 직후 paddle/tess의 max 자릿수 검증
- 조건: max 자릿수 `≥ userMax 자릿수 + 2` → 해당 엔진 결과 폐기
- userMax > 0일 때만 발동

UI 로그: `MP ❌ paddle slash-drop 의심 (max=377235 >> userMax=235): paddle 폐기`

이렇게 하면 mismatch 표시가 줄어들고 single-source(다른 엔진)로 자연스럽게 전환됨.

---

## 🛡️ 현재 활성 OCR 보정 스택 (v4 — 17 layers)

```
[1]  Hybrid voting (paddle + tesseract)
[2]  PSM 7/8/13 다수결
[3]  4-canvas 다양성 (default 12x / soft 12x / otsu 12x / raw 16x+pad10)
[4]  Per-digit majority voting (4↔9, 6↔8 confusion)
[5]  Leading-digit-drop suffix-match
[6]  Anti-stuck 휴리스틱
[7]  MP anchor=0 첫 인식 보호
[8]  Pad 10px 확장
[9]  Class-aware 3-tier hybrid override (A-clean/A-extreme/B-clean/B-noisy)
[10] Grayscale 16x24 templates with Manhattan distance
[11] AutoTrim 가장자리 artifact 자동 제거 (geometric 양 끝 isolated narrow group)
[12] Cached anchor 자동 복구 (paddle 같은 값 2회 연속 → anchor 갱신)
[13] EXP 0.1%p 점프 임계값 + 검증 큐 (큰 변화는 2회 검증 후 accept)
[14] ADENA digit-add 방지 (자릿수 동률 시 짧은 길이 선호)
[15] AutoTrim 채도 기반 컬러 artifact 검출 ★v4 (빨간 별/아이콘 잡기, geometric OR chroma)
[16] EXP phantom digit sanity ★v4 (anchor 자릿수 +1 + Δ>0.3%p → 폐기)
[17] MP slash-drop sanity ★v4 (max 자릿수 ≥ userMax+2 → 폐기)
```

---

## 🆕 v3 핵심 추가 사항 상세

### A. 전처리 다양성 확장 (`src/js/app.js`)
- `preprocessCanvas(canvas, opts)` 모드 지원 (sharpen/binarize/contrastLo/contrastHi)
- `applyOtsuBinarization()` 신규
- `captureRegionToCanvas(region, mode)` modes: `default | soft | otsu | tight`
- ADENA OCR: 4 캔버스 × 3 PSM = 최대 12 결과
- MP OCR: 3 캔버스 × 2 PSM = 최대 6 결과

### B. Class-aware 3-tier hybrid override
WSL purity 리포트 기반 클래스 분류:
- **CLEAN** (positive avg purity): `1`, `2`, `3`, `5`, `/`, `.` — 라벨 노이즈 적음
- **NOISY** (negative avg purity): `0`, `4`, `6`, `7`, `8`, `9` — 라벨 노이즈 있음

위치별 결정 트리 (grayscale 실측 score 0.60-0.80 기준 보정됨):
```
Tier A-clean    score≥0.74, gap≥0.04, best=clean class    → DECISIVE
Tier A-extreme  score≥0.80, gap≥0.08                       → DECISIVE
Tier B-clean    voting weak + score≥0.70, gap≥0.025        → RECOVERY
Tier B-noisy    voting weak + score≥0.74, gap≥0.04         → RECOVERY
```

안전 장치: 한 번에 2개 이상 위치 동시 override는 template hallucination 의심 → reject

### C. Grayscale 16x24 templates
- 16x24 binary (48 bytes) → 16x24 grayscale (384 bytes)
- Distance: Hamming → Manhattan (sum-abs-diff, anti-alias 정보 보존)
- Inter-class purity rank-based filter
- `digit-templates.json`: 268KB, 529 templates
- `template-matcher.js`: format 자동 감지 (`json.format === 'grayscale'`)

### D. AutoTrim 가장자리 artifact 자동 제거
함수: `autoTrimEdgeArtifacts(canvas, side)` in `app.js`

알고리즘:
1. 컬럼 ink density 분석 (명/암 자동 감지)
2. ink groups 식별
3. 양 끝 그룹 검사:
   - width < median × 25%
   - gap ≥ 3px
   - vertical extent < 60%
4. 위 3조건 모두 충족 → trim

호출 위치: `captureRegionToCanvas` + `captureRegionToRawCanvas` 둘 다

UI 로그: `✂️ AutoTrim L:Xpx+R:Ypx (artifact 제거: oldW→newW px)`

### E. EXP 0.1%p 점프 임계값 + 검증 큐
사용자 요청: "한틱에 5%는 너무 높고.. 0.1% 이상도 막아줘"

`ocrExpRegionHybrid()` 변경:
- `isPlausibleForward`: 5%p → ±0.1%p
- 둘 다 일치 시에도 anchor 대비 >0.1%p 점프면 검증 큐
- 검증 큐: 같은 값 2회 연속 + 1회 ACCEPT (총 3회)
- 레벨업 예외 (anchor>95% AND val<5%) → 즉시 허용

UI 로그:
- `EXP ⏳ 검증 시작 (점프 0.250%p > 0.1%p): 50.7723`
- `EXP ⏳ 검증중 (2/3) 점프 ...`
- `EXP 🟢 검증 통과`

### F. ADENA cached anchor 자동 복구
`ocrAdenaRegionHybrid` "둘 다 digit-drop" 분기 강화:
- 같은 paddle 값이 **2회 연속** rejected → 자동 anchor 갱신
- 조건: paddle 4+자리 + anchor보다 1자리 적음 + 같은 값 2회

UI 로그: `🔓 ADENA cached anchor 복구: 586391 → 58039 (2회 연속)`

### G. 자릿수 동률 시 짧은 길이 선호 (digit-add 방지)
`ocrAdenaRegionTesseract` voting:
- 풀-넘버 majority: "59897"(6표) vs "995897"(6표) 동률 → 짧은 "59897"
- 자릿수 길이 majority: 5자리(6표) vs 6자리(6표) 동률 → 5자리

---

## 🎯 내일 작업 후보 (우선순위 순)

### 🟢 P1 — 안전, 영향 큼

#### 1. ADENA 큰 점프 검증 큐 (EXP와 동일 패턴)
- 현재: ADENA는 stability check만 있음 (사용자 설정 N회 연속)
- 추가: anchor 대비 큰 점프(예: ±50% 이상) 시 명시적 verification queue
- 이점: 가끔 발생하는 ADENA spike (995897 같은) 더 적극적으로 차단
- 위치: `ocrAdenaRegionHybrid` `voteHybrid` 호출 직전에 anchor-jump check

#### 2. Per-canvas outlier detection
- 현재: 12개 결과 전체에서 majority voting
- 추가: canvas별 (default/soft/otsu/raw) 결과 클러스터링 → outlier canvas 무시
- 사례: raw 캔버스가 일관되게 다른 길이 결과 생성 시 outlier로 처리
- 위치: `ocrAdenaRegionTesseract` results 분석 단계

#### 3. EXP 검증 큐 tolerance 재조정
- 현재: tol=0.001 (50.5223 vs 50.5224 매칭)
- 고려: tol=0.01 (50.5223 vs 50.5113 같은 OCR jitter도 매칭)
- 위험: 너무 관대하면 misread 통과 가능

### 🟡 P2 — 효과 불확실, 시간 투자 큼

#### 4. ADENA 영역 한 번에 여러 캡처 후 평균 (anti-flicker)
- ADENA 화면이 살짝 깜박이면 OCR 결과 흔들림
- 100ms 간격 3번 캡처 → 평균
- 단점: OCR cycle 시간 ↑

#### 5. Tesseract LSTM 단독 정확도 개선
- `lstm_choice_mode = 2` 같은 파라미터 튜닝
- 다른 PSM 모드 추가 (10, 11)

#### 6. 신뢰도 가중 voting
- 각 OCR 결과의 `confidence` 값 활용
- 현재: 모든 결과 동등 가중치
- 새: `confidence > 70`인 결과에 1.5x 가중

### 🔴 P3 — 큰 변경, 위험 높음

#### 7. 자릿수별 CNN 분류기 (실패한 traineddata 대체)
- 463 라벨 데이터 → 단일 자리 CNN 학습
- TensorFlow.js로 export → 32KB 이하
- 추론 5ms 이내
- 라벨 노이즈에 더 robust
- 위험: 학습 환경 + 시간 투자 큼, 또 실패 가능성

#### 8. ADENA 영역 자동 fine-tune
- 영역을 ±1px씩 nudge하면서 OCR 일관성 측정
- 가장 일관된 영역으로 auto-correct
- 위험: 사용자 의도와 충돌 가능

### 🚪 우회 옵션 (정확도가 정 안되면)

- **ITEM DROPS 워크플로우**: ADENA OCR 끄고 수동 입력 (100% 정확)
- 사용자 트래커 NOW 칸 직접 편집 (5초 OCR pause 자동)

---

## 🗂️ 핵심 자산 위치

### Windows
| 자산 | 경로 | 상태 |
|------|------|------|
| 빌드 | `dist/LineageMPTimer-paddle-portable-1.2.0-paddle.exe` (134MB · 03:20) | 최신 (v3) |
| 학습 데이터 | `%APPDATA%/Roaming/LineageMPTimer/training-data/` (463개) | 보존 |
| traineddata (비활성) | `build/tessdata/lineage.traineddata` (11.7MB) | 보존, 미사용 |
| 현재 templates | `src/js/digit-templates.json` (268KB grayscale) | 활성 |
| Template matcher | `src/js/template-matcher.js` | 활성 |
| Template rebuild report | `build/tessdata/template-rebuild-report.txt` | 진단용 |
| Python builders | `scripts/training/build_templates_grayscale.py` etc | 보존 |

### WSL Ubuntu (root)
| 자산 | 경로 | 상태 |
|------|------|------|
| Ground truth | `/root/tesstrain/data/lineage-ground-truth/` (463 PNG+gt.txt) | 보존 |
| Templates raw PNG | `/root/templates/` (글자별 폴더) | 보존 |
| Template builders | `/root/build_templates_grayscale.py` etc | 보존 |

---

## ⚠️ 알려진 제약 / 함정

### Grayscale 템플릿의 점수 범위
- **Manhattan distance 기준 score는 0.60~0.80 범위**가 정상
- Binary Hamming의 0.85~0.95와 다르므로 임계값 헷갈리지 말 것
- Tier A clean threshold = 0.74 (이전 0.93은 도달 불가능했던 값)

### 라벨 노이즈
- 463개 PNG 라벨링이 Claude 직접 작업 → 5/6, 8/3, 4/9 confusion 들어감
- 0/4/6/7/8/9 클래스는 negative purity → 템플릿 변별력 낮음
- Tier A는 clean class에서만 발동, noisy class는 자동 비활성화

### Cached anchor 함정
- ADENA misread가 anchor에 캐시되면 OCR 결과 영구 거부됨
- 자동 복구 로직 (2회 연속 같은 paddle 값) 있으나 극단 케이스 발생 가능
- 수동 escape: "최근 아데나" 칸 직접 편집 → 5초 OCR pause

### Git remote 미설정
- `git push` 불가 — 로컬 commit만 누적됨
- 필요 시: `git remote add origin <URL>` 후 push

### WSL shell escape
- `wsl.exe -- bash -c "..."` 시 변수 expand 깨짐
- 해결: 스크립트 파일 작성 후 `wsl.exe -d Ubuntu -u root -- bash //path/to/script.sh` (앞 `//` 두 개 필수)

---

## 💬 사용자 컨텍스트

- 한국어 응답 선호
- 빠른 피드백 사이클 선호 ("점점 좋아지고 있어")
- "정확도 박살나면 즉시 롤백" 요구 (학습 전 수준 복귀를 우선시)
- 직접 라벨링 작업 등 손이 많이 가는 작업은 거부 → 코드 중심 해결 선호
- ITEM DROPS 수동 입력보다 OCR 자동화 선호 (정확도 가능한 한)
- 임계값 등 구체적 숫자 지시 가능 (예: "0.1% 이상도 막아줘")

---

## 🔁 다음 세션 시작 워크플로우

```
1. cd C:\dev\lineage-mp-timer
2. cat docs/SESSION-HANDOFF-LATEST.md          ← 이 문서 (가장 먼저)
3. git log --oneline -10                        ← 최근 9개 commit 확인
4. CLAUDE.md (프로젝트 구조)
5. docs/OCR-FUTURE-PLAN.md (OCR 개선 history)
6. 사용자 요청 처리

테스트 이어가려면:
  dist/LineageMPTimer-paddle-portable-1.2.0-paddle.exe 실행
  Hybrid 결정 로그에서 새 메시지 패턴 확인:
    ✅ Template 529개 로드
    ✂️ AutoTrim L:Xpx+R:Ypx
    🔍 ADENA template ... vs OCR ...
    🔧 ADENA per-digit override
    🔓 ADENA cached anchor 복구
    EXP ⏳ 검증중
    EXP 🟢 검증 통과
```

---

## 📈 진척 측정 (사용자 평가)

| 시점 | 사용자 평가 |
|------|------------|
| 세션 시작 | "5만 아데나를 9만 아데나로 인식해" / "포기하는게 맞을까??" |
| AutoTrim 추가 후 | (테스트) |
| Cached anchor 복구 후 | (테스트) |
| EXP 0.1% 임계값 후 | "점점 좋아지고 있어 / 이제까지 제일 인식 잘 되고 있어" |
| v3 빌드 (03:20) | "아데나 4자리되면 뒤에 그림 때문에 탐지 오류 / 경험치도 자꾸 오류" |
| **v4 빌드 (10:37)** | **테스트 대기 중** — 채도 trim + EXP/MP phantom digit sanity |

---

## 🎯 내일 시작 시 첫 액션

1. 사용자에게 어제 빌드(03:20) 추가 테스트 결과 물어보기
2. 결과 따라 다음 결정:
   - **잘 되면**: P3-7 (CNN 분류기) 또는 finalize/release
   - **여전히 spike 발생**: P1-1 (ADENA 큰 점프 검증) 적용
   - **새 misread 패턴**: 진단 데이터 분석 후 fix

3. 경우에 따라 OCR-FUTURE-PLAN.md 진척 history도 갱신

---

_Last updated: 2026-05-04 10:40 (v4) · 작성: Claude (Anthropic)_
_v3 사용자 지시: "내일 추가 작업하려고해 문서 작업 남겨줘"_
_v4 사용자 지시: "아데나 4자리되면 뒤에 그림 때문에 탐지 오류 / 경험치도 자꾸 오류"_
