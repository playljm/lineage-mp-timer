# 세션 인수인계 — 2026-05-04 v6 (친구 배포 v1.3.14 + OCR anchor 영구 보호)

> **다음 세션 시 가장 먼저 읽어야 할 문서**
> 이번 세션에서 v1.3.0 → v1.3.14 까지 빌드 사이클을 거치며 친구 배포용 안정 버전 완성.

---

## ⚡ TL;DR — 30초 요약

**친구 배포 최종**: `dist/LineageMPTimer-v1.3.14.zip` (128MB · 23:36)

**핵심 보호 계층 (지금 활성)**:
1. EXP `±5%p` 큰 점프 영원히 거부 → anchor 영구 보호 (★ v1.3.14 핵심)
2. EXP/MP/ADENA 정수부 자릿수 sanity → paddle/tess misread 자동 차단
3. ADENA anchor 자동 복구 (자릿수 mismatch 시 2초)
4. 60초 user-edit lock + verify queue 동적 횟수 + chroma masking
5. 진단 리포트 원클릭 (`%APPDATA%/LineageMPTimer/diagnostic/`)

**남은 한계**:
- paddle 1배 raw 캔버스에서 게임 픽셀 폰트 misread 잦음 (모델 한계)
- tess가 7↔1, 6↔8 confusion 가끔 발생 (큰 점프 거부로 차단됨)
- adenaStart가 잘못 굳으면 ADENA/H 계산 영향 (사용자 트래커 RESET 권장)

---

## 📊 이번 세션 누적 commit (v1.3.0 → v1.3.14, 15개)

```
1de534b fix: v1.3.14 — EXP 큰 점프(±5%p) 영원히 거부 (anchor 영구 보호) ★
cc1202c fix: v1.3.13 — ADENA anchor 자동 복구 (자릿수 mismatch 케이스)
6cfa514 fix: v1.3.12 — EXP 정수부 자릿수 sanity (paddle 1자리 misread 차단)
0a10677 diagnose: v1.3.11 — EXP loop 진입 카운터 로그 추가
a077d7d fix: v1.3.10 — isUserEditing 체크 위치 변경 (OCR 호출 → anchor 갱신만 차단)
206abff fix: v1.3.9 — EXP 진행 막대 → 흰색 강제 (maskColor: 255)
205bf85 fix: v1.3.8 — EXP white-extraction → chroma masking T=130
0b6a8e2 fix: v1.3.7 — white-extraction 임계값 200 → 150 (회색 글자 보존)
6c865dd feat: v1.3.6 — 🩺 진단 리포트 생성 버튼 (원클릭 캡처+로그 자동 저장) ★
de7775c feat: v1.3.5 — EXP 영역 white-extraction (진행 막대 색상 차단)
68ea09e fix: v1.3.4 — anchor 편집 OCR pause 5초 → 60초
841a440 fix: v1.3.3 — anchor 편집 시 verify queue + stability 리셋
6d6d9bf fix: v1.3.2 — EXP chroma masking 제거 (부작용 rollback)
81b392c fix: v1.3.1 — EXP 영역 chroma mask + 핀 버튼 always-on-top 강화
52d07c5 release: v1.3.0 — 친구 배포용 + 사용 설명서
```

이전 세션 (v3까지) commit은 `git log --oneline -50` 참조.

---

## 🛡️ 활성 OCR 보호 스택 (v1.3.14 — 누적 25+ layers)

### 영역별 전처리

| 영역 | chroma masking | 추가 처리 |
|------|---------------|----------|
| MP | ❌ 안 함 | preprocess + autoTrim |
| EXP | ✅ `T=130, maskColor=255` (흰 배경 강제) | preprocess + autoTrim |
| LEVEL | ❌ 안 함 | preprocess + autoTrim |
| ADENA | ✅ `T=100, gateRatio=1%` (자동 maskColor) | preprocess + autoTrim |

### Sanity 가드

```
[1]  MP slash-drop max 자릿수 ≥ userMax+2 → paddle/tess 폐기
[2]  MP cur 자릿수 ≥ userMax+2 → paddle/tess 폐기 (v13)
[3]  MP userMax < 10 → sanity 비활성 (v14, INPUTS 잘못 입력 보호)
[4]  EXP paddle phantom digit (자릿수 over + Δ>0.3%p) → paddle 폐기
[5]  EXP 정수부 자릿수 mismatch → 해당 엔진 폐기 (v1.3.12)
[6]  EXP ±5%p 큰 점프 영원히 거부 — 사용자 직접 보정만 통과 (v1.3.14) ★
[7]  ADENA tess override 자릿수 mismatch → tess 폐기 (v15)
[8]  ADENA anchor 자릿수 > OCR 자릿수 + 2회 연속 → 자동 복구 (v1.3.13) ★
```

### Verify Queue 동적 횟수

| 영역 | 점프 | 필요 횟수 |
|------|------|----------|
| EXP | 0.1~1%p | 2회 |
| EXP | 1~3%p | 3회 |
| EXP | 3~5%p | 5회 (10회 이전, 10%p+는 영구 거부 — v1.3.14에서 5%p로 강화됨) |
| EXP | 5%p+ | **영구 거부** ★ |
| ADENA | 1k~5k | 2회 |
| ADENA | 5k~30k | 3회 |
| ADENA | 30k~100k | 5회 |
| ADENA | 100k+ | 10회 |

### 사용자 보호

```
- 60초 user-edit lock (markUserEdit 발동 시 OCR 결과 anchor 갱신 차단)
- isUserEditing 체크 위치: OCR 호출 후 (미리보기/로그는 갱신, anchor만 보호)
- verify queue + stability counter 리셋 (사용자 편집 시)
- Anti-stuck 휴리스틱 (anchor 정확 일치 vs 전진 결과)
- Cached anchor 자동 복구 (paddle 같은 값 N회 연속)
```

---

## 🆕 v1.3.x 핵심 변경 사항 상세

### v1.3.14 ★ — EXP ±5%p 큰 점프 영원히 거부
- 사용자 케이스: anchor `70.1122` → tess `10.1122` (7↔1 misread, 자릿수 매치)
- 정상 사냥 1초당 EXP 변화는 0.001~0.1%p
- 5%p+ 변화는 misread 확률 압도적
- 레벨업 예외 (anchor>95 + val<5) 그대로 통과
- 위치: `ocrExpRegionHybrid` 의 paddle/tess 일치 분기 진입 직후

### v1.3.13 — ADENA anchor 자동 복구
- 사용자 케이스: anchor `238571` (잘못 굳음) vs OCR `24258` (정상)
- anchor 자릿수 > OCR 자릿수 + OCR ≥4자리 + 같은 값 2회 연속 → 자동 복구
- 위치: `ocrAdenaRegionHybrid` 의 paddle/tess 일치 분기 진입 직후
- `_matchRecover` 카운터 추가

### v1.3.12 — EXP 정수부 자릿수 sanity
- ADENA의 자릿수 sanity 패턴을 EXP에도 적용
- paddle/tess 정수부 자릿수 != anchor 자릿수 + 레벨업 아님 → 폐기
- 사용자 케이스: paddle `2.9461` (1자리) vs anchor `12.47` (2자리) → paddle 폐기

### v1.3.10 — isUserEditing 체크 위치 변경
- 기존: `ocrXxxRegion()` 진입 직후 → OCR 호출 자체 안 됨 → 미리보기 갱신 X
- 신: OCR 호출 *후* → `parsed=null` 로 anchor 갱신만 차단
- 효과: 미리보기/로그 갱신 + anchor 보호 동시
- 적용: `ocrLevelRegion`, `ocrAdenaRegion`, `ocrExpRegion`

### v1.3.9 — EXP 진행 막대 → 흰색 강제
- `maskChromaPixels(canvas, { threshold: 130, maskColor: 255 })`
- 게임 EXP 글자가 검은색이라 진행 막대 색상을 흰 배경으로 변환해야 OCR 인식
- ADENA 동작은 변경 없음 (maskColor 자동)
- `maskChromaPixels` 시그니처에 `opts.maskColor` 인자 추가

### v1.3.6 — 🩺 진단 리포트 생성 버튼 ★
- 원클릭으로 캡처 4개 + 메타데이터 폴더 자동 저장 + 폴더 열기
- 위치: `%APPDATA%/LineageMPTimer/diagnostic/YYYY-MM-DD_HH-mm-ss/`
- 파일: `mp.png`, `exp.png`, `level.png`, `adena.png`, `report.json`
- IPC: `app:save-diagnostic-report` (electron/main.js)
- API: `api.saveDiagnosticReport({ imageBuffers, report })`
- 사용자 진단 사이클 시간 절약 (매번 캡처할 필요 없음)

### v1.3.4 — user-edit OCR pause 5초 → 60초
- 사용자 anchor 보정 후 OCR이 5초만에 통과해 덮어쓰는 문제 차단
- `markUserEdit(key)` 의 `userEditUntil[key] = Date.now() + 60000`

### v1.3.1 — 핀 버튼 always-on-top 강화
- `setAlwaysOnTop(true, 'screen-saver')` — 가장 높은 z-order
- `moveTop()` + `focus()` 즉시 호출
- 게임 fullscreen/borderless 위에 떠 있게

---

## 🎯 다음 세션 작업 후보 (우선순위)

### 🟢 P1 — 안전 + 효과 큼

#### 1. ADENA/H 계산 보정 (adenaStart 잘못 굳은 경우)
- 현재: `adenaStart` 가 misread 결과로 굳을 수 있음 → ADENA/H 잘못 계산
- 개선: 트래커 RESET 시 자동으로 anchorStart도 정상 OCR 결과로 갱신
- 또는: ADENA verify queue 통과 시 adenaStart도 동시 갱신 옵션

#### 2. EXP 영역 자동 fine-tune
- ±1px씩 영역 nudge 하면서 OCR 일관성 측정
- 가장 일관된 위치로 영역 자동 보정
- 사용자 영역 지정 부정확해도 자동 회복

#### 3. UI 개선 — anchor 잠금 명시 토글
- "EXP OCR 끔" 옵션 (수동 입력 only)
- 영역 삭제 버튼 (현재 영역 재지정만 가능)

### 🟡 P2 — 효과 불확실

#### 4. tess `lstm_choice_mode = 2` + PSM 10/11 추가
- tesseract 정확도 추가 향상 시도

#### 5. confidence 가중 voting
- 현재 모든 결과 동등 가중치
- conf > 70 인 결과에 1.5x 가중

### 🔴 P3 — 큰 변경, 위험 높음

#### 6. CNN 단일 자릿수 분류기 (재시도)
- 463 라벨 데이터 → TensorFlow.js 모델
- 32KB 이하, 추론 5ms
- 라벨 노이즈에 robust
- 이전 traineddata 시도 실패한 적 있음

#### 7. paddle 캔버스 12배 업스케일 시험
- 현재 paddle은 1배 raw (자연 이미지 OCR 가정)
- 게임 픽셀 폰트는 작은 raw에서 misread 잦음
- 12배 upscale + maskChromaPixels 시도

### 🚪 우회 옵션

- **ITEM DROPS 워크플로우**: ADENA OCR 끄고 수동 입력 (100% 정확)
- **EXP 수동 입력**: 사냥 시작/종료 시 사용자 직접 입력 → EXP/H 자동 계산

---

## 🗂️ 핵심 자산 위치

### Windows (현재 worktree)
| 자산 | 경로 | 상태 |
|------|------|------|
| 빌드 v1.3.14 portable | `dist/LineageMPTimer-1.3.14-portable.exe` (128MB · 23:35) | 친구 배포용 |
| 빌드 v1.3.14 setup | `dist/LineageMPTimerPaddle Setup 1.3.14.exe` (128MB · 23:35) | 설치형 |
| 친구 배포 zip | `dist/LineageMPTimer-v1.3.14.zip` (128MB · 23:36) | portable + 사용설명서 |
| 사용설명서 | `사용설명서.md` | 친구용 한국어 가이드 |
| 진단 리포트 폴더 | `%APPDATA%/LineageMPTimer/diagnostic/` | 사용자 진단 자동 저장 |
| 학습 데이터 | `%APPDATA%/Roaming/LineageMPTimer/training-data/` (463개) | 보존, 미사용 |
| traineddata (비활성) | `build/tessdata/lineage.traineddata` (11.7MB) | 보존, 비활성 |
| Templates | `src/js/digit-templates.json` (268KB grayscale) | 활성 (ADENA only) |
| Template matcher | `src/js/template-matcher.js` | 활성 |

### 핵심 코드 위치 (`src/js/app.js`)
| 함수/섹션 | 라인 | 역할 |
|----------|------|------|
| `maskChromaPixels(canvas, opts)` | 1801~ | 색상 픽셀 마스킹 (T/maskColor/gateRatio 옵션) |
| `applyWhiteExtraction(canvas, threshold)` | 1845~ | 흰색만 추출 (현재 미사용, 함수만 있음) |
| `autoTrimEdgeArtifacts(canvas, side)` | 1880~ | 가장자리 artifact 자동 trim |
| `captureRegionToCanvas(region, mode, opts)` | 2030~ | 12배 업스케일 + 전처리 + autoTrim |
| `ocrExpRegionHybrid()` | 4046~ | EXP hybrid voting + sanity + verify queue |
| `ocrAdenaRegionHybrid()` | 3778~ | ADENA hybrid + anchor 자동 복구 |
| `ocrMpRegionHybrid()` | 3640~ | MP hybrid + slash-drop sanity |
| `markUserEdit(key)` | 234~ | 60초 lock + verify queue/stability 리셋 |
| `ocrXxxRegion()` 디스패처 | 3760~ | isUserEditing 체크 위치 (호출 후) |
| 진단 리포트 핸들러 | 5060~ | btn-diagnostic-report click |

---

## ⚠️ 알려진 제약 / 함정

### OCR 모델 본질적 한계
- paddle: 1배 raw 캔버스에서 게임 픽셀 폰트 약함 → 자릿수 잘못 인식 잦음
- tess: 7↔1, 6↔8 confusion 가끔 — v1.3.14의 ±5%p 큰 점프 거부로 차단
- 사용자 한 번 정확한 anchor 입력하면 사냥 끝까지 보호됨

### Anchor 오염 패턴
- 이전 빌드에서 OCR misread → verify queue 통과 → anchor 잘못 굳음
- v1.3.14에서 EXP는 영구 보호 (5%p+ 거부)
- ADENA는 v1.3.13 자동 복구 (자릿수 mismatch 시)

### Git remote 미설정
- `git push` 불가 — 로컬 commit만 누적
- 필요 시: `git remote add origin <URL>` 후 push

### Windows zip lock
- portable.exe 실행 중에는 zip 만들 수 없음 (file lock)
- 사용자가 빌드 종료 후 zip 재제작

---

## 🔁 다음 세션 시작 워크플로우

```
1. cd C:\dev\lineage-mp-timer
2. cat docs/SESSION-HANDOFF-LATEST.md          ← 이 문서 (가장 먼저)
3. git log --oneline -20                        ← 최근 commit 확인
4. CLAUDE.md (프로젝트 구조)
5. docs/OCR-FUTURE-PLAN.md (OCR 개선 history)
6. 사용자 요청 처리

테스트 이어가려면:
  dist/LineageMPTimer-1.3.14-portable.exe 실행
  자동 감지 ON 후 진단 리포트 생성으로 디버깅:
    🩺 진단 리포트 생성 → %APPDATA%/LineageMPTimer/diagnostic/{날짜시간}/
    5개 파일 (mp/exp/level/adena.png + report.json) 채팅에 드래그
```

---

## 💬 사용자 컨텍스트

- 한국어 응답 선호
- 빠른 피드백 사이클 + 진단 리포트로 효율 ↑
- 친구에게 빌드 배포 (v1.3.14가 최종)
- "정확도 박살나면 즉시 롤백" 우선시
- 직접 라벨링 거부 → 코드 중심 해결 선호
- ITEM DROPS 수동 입력보다 OCR 자동화 선호 (가능한 한)
- 사용 환경: 1920×1080 모니터 (LG ULTRAGEAR), Windows 11 64bit

### 사용자 게임 환경
- 리니지 클래식, 캐릭터 LV 28, MP 235
- EXP 글자: 회색/outline 폰트 (chroma masking T=130 + maskColor=255 적합)
- EXP 진행 바: 주황/노랑 색상 채워짐 (영역의 67% 정도)
- ADENA 슬롯: 노란 금화 그래픽 + 흰 글자
- MP 영역 108×25, EXP 영역 110×23, LEVEL 영역 37×24, ADENA 영역 78×22

---

## 📈 진척 측정 (사용자 평가)

| 시점 | 사용자 평가 |
|------|------------|
| v1.3.0 | "친구한테 주려고해" — 배포 시작 |
| v1.3.1~v1.3.5 | 여러 misread 패턴 발견 (4자리 ADENA, 67→1, EXP 색상 영향) |
| v1.3.6 | 🩺 진단 리포트로 진단 사이클 효율화 |
| v1.3.9~v1.3.13 | 사용자 "답답해 ㅠㅠㅠ" — anchor 자꾸 잘못 굳음 |
| v1.3.14 | EXP 5%p+ 영구 거부 → anchor 영구 보호 (★ 최종) |

---

## 🎯 다음 세션 시작 시 첫 액션

1. 사용자에게 v1.3.14 추가 테스트 결과 묻기
2. 친구가 사용해보고 피드백 줬는지 확인
3. 결과에 따라:
   - **잘 동작**: 다음 작업 후보 (P1) 또는 finalize/release
   - **새 misread 패턴**: 진단 리포트 분석 → 추가 sanity
   - **친구 피드백**: UX 개선 또는 사용설명서 보강

---

_Last updated: 2026-05-04 23:40 (v6) · 작성: Claude (Anthropic)_
_세션 누적 commit: v1.3.0 → v1.3.14 (15 commits)_
_친구 배포 zip: `dist/LineageMPTimer-v1.3.14.zip`_
