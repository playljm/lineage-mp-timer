# Lineage MP Timer — Project Context

> Electron 기반 리니지 클래식 MP 자연회복 타이머. 게임 중 MP가 채워지는 시간을 계산·카운트다운하고 완료 시 토스트+사운드 알림.
>
> 다음 세션에서 이 프로젝트를 이어서 작업할 때 이 문서를 먼저 읽어서 컨텍스트를 파악하세요.

---

## 📍 위치
- 프로젝트 루트: `C:\dev\lineage-mp-timer`
- Git: 로컬 repo (remote 없음)
- 빌드 산출물: `dist/` (`LineageMPTimer Setup 1.0.0.exe`, `LineageMPTimer-portable-1.0.0.exe`)

## 🚀 명령어

```bash
cd C:\dev\lineage-mp-timer
npm install        # 의존성 설치 (최초 1회)
npm start          # 개발 실행 (--dev 시 DevTools 자동 오픈)
npm test           # 엔진 유닛 테스트 (36 케이스)
npm run build      # Windows NSIS + portable exe 빌드
```

> ⚠️ 빌드 전에 **사용자가 포터블 exe를 실행 중이면 종료** 필요 (덮어쓰기 락).

## 📁 파일 구조

```
lineage-mp-timer/
├── electron/
│   ├── main.js         # BrowserWindow + Tray + 글로벌 단축키 + IPC
│   └── preload.js      # contextBridge로 window.api 노출
├── src/
│   ├── index.html      # 전체 UI 마크업
│   ├── styles/
│   │   └── neon.css    # 네오 다크 + 6색 테마 + 스크롤바/체크박스 커스텀
│   ├── js/
│   │   ├── engine.js   # 순수 MP 계산 (DOM/Electron 의존성 X, Node 테스트 가능)
│   │   ├── storage.js  # localStorage wrapper (프리셋/설정/트래커/핫키)
│   │   └── app.js      # 렌더러 컨트롤러 (메인 로직 — UI 이벤트, 세그먼트 시뮬, 알림)
│   └── assets/
├── test/
│   └── engine.test.js  # 엔진 유닛 테스트
├── build/
│   └── icon.svg        # 앱 아이콘 SVG (ICO 미생성, electron-builder default 사용)
├── package.json        # electron-builder NSIS+portable 설정 포함
└── README.md
```

## 📐 MP 회복 공식 (engine.js 기준, 리니지 클래식)

| 요소 | 값 |
|---|---|
| 기본 틱 주기 | 정지 **16s** · 이동 32s · 전투 64s |
| 블록 상태 | 배고픔/무게 50%↑ = 회복 0 |
| WIS 기본 회복량 | 14↓=1, 15-16=2, 17-18=3, 이후 WIS 2당 +1 |
| 파란물약 | +max(1, WIS-10) MP/틱, 지속 600s (자동 갱신 가정) |
| 메디테이션 | +5 MP/틱, 지속 640s, **정지 상태만** |
| 여관 / 아가타 | +2 MP/틱 |
| 법사 30Q 던전 | -3 MP/틱 (페널티) |
| 수정 지팡이 | +10 MP/틱 |

> 현재 UI에서는 검증된 위치(필드/여관/던전/직접입력)만 노출. 아가타/싱잉/히든밸리는 검증 실패로 제거됨.

## ⚙️ 핵심 아키텍처

### 1. 세그먼트 기반 실시간 시뮬레이션 (app.js)
실행 중 버프/위치/상태 변경 시 **정확한 시간 재계산**을 위해 세그먼트 방식 사용:

```
startMp (타이머 시작 시점 MP)
  + accumulatedMp (이전 세그먼트들에서 누적된 MP)
  + 현재 세그먼트 진행분 (prevConfigSnapshot 기준)
  = 현재 시뮬레이션 MP
```

- `cfgAffectsRecovery()` — 회복량에 실제 영향 있는 속성만 감지 (wis, buffs, location, state)
- 영향 있는 변경 시 `commitSegment()` → `accumulatedMp`에 이전 구간 누적 → 새 세그먼트 시작
- `targetPct` / `maxMp` 변경은 **회복량 영향 없음** → snapshot만 갱신 후 `tickMp()` 즉시 호출

### 2. Pause / Resume
- PAUSE: `commitSegment()` 후 running=false, paused=true
- START 다시 누르면 resume (startMp 유지, 새 세그먼트 시작)
- RESET만 완전 초기화

### 3. Electron IPC (window.api)
```js
setAlwaysOnTop, getAlwaysOnTop, minimizeToTray,
setMinimizeOnClose, notifyComplete, setGlobalHotkeys,
getGlobalHotkeys, resetWindowSize, quit,
onAlwaysOnTopChanged (event callback)
```

### 4. 단축키
- **글로벌** (게임 중에도 동작): F1 항상 위, F2 창 숨기기
- **창 내부** (앱 활성 시): Space Start/Pause, R Reset
- 키 재바인딩·ON/OFF 가능, 중복/충돌 감지, localStorage 저장

### 5. 테마 (6색)
- `green` (기본) · `cyan` · `pink` · `yellow` · `purple` · `red`
- CSS 변수 `--neon`, `--neon-dim`, `--neon-soft`, `--bg-glow-1/2`, `--shadow-neon`
- 클릭 즉시 적용, 0.25s 부드러운 전환

### 6. 데이터 저장
| 데이터 | 위치 |
|---|---|
| 프리셋 / 설정 / 마지막 입력값 / 트래커 / 핫키 / 자동감지 영역 | `localStorage` (key prefix `lmp.*`) |
| 창 위치·크기 | `%APPDATA%\Roaming\LineageMPTimer\window-bounds.json` |
| 학습 데이터 (PNG + .gt.txt) | `%APPDATA%\Roaming\LineageMPTimer\training-data\{mp,exp,level,adena}\` |
| 미라벨 캡처 (자동 캡처 큐) | `%APPDATA%\Roaming\LineageMPTimer\training-data\_pending\{region}\` |
| 게임 폰트 traineddata | `build\tessdata\lineage.traineddata` (빌드 자동 포함) |

### 7. 단축키 추가
- **F3**: 컴팩트 모드 ON/OFF (작은 창 + 트래커 두 줄 핵심 stats)
- **F12**: DevTools (디버깅용)

## 📦 빌드 설정 (package.json)

- Electron 33.4.x
- electron-builder 24.13.x
- `productName: LineageMPTimer`, `appId: com.lineage.mptimer`
- Windows targets: `nsis` (설치형), `portable`
- 아이콘: `build/icon.ico` 없으면 default Electron 아이콘

## ✅ 완료된 주요 기능

- [x] WIS/버프/위치/상태 기반 MP 회복 계산 엔진 (36 테스트 통과)
- [x] 실시간 카운트다운 + MP 게이지
- [x] 완료 시 Windows 토스트 + Web Audio 합성 사운드 + flashFrame
- [x] 세션 트래커 (레벨/경험치/아데나 + 시간당 효율)
- [x] 글로벌/창 단축키 (재바인딩 + ON/OFF)
- [x] 6색 테마
- [x] 프리셋 저장/불러오기
- [x] 창 크기·위치 자동 복원
- [x] 항상 위 + 트레이 최소화
- [x] 실행 중 설정 변경 실시간 재계산 (세그먼트)
- [x] Pause/Resume
- [x] 목표 MP % 알림 (50/80/100 빠른 선택)
- [x] 커스텀 체크박스 스타일 (테마 연동)

## 📜 버전 히스토리

### v1.8.0 (2026-05-09) — User Template 즉시 학습 (과거 픽셀 매칭 방식 도입) ⭐⭐⭐⭐⭐
사용자 절절한 답답함: "과거 10년 전 프로그램도 잘 됐는데 왜 못하나" — ML OCR 한계 인정 + template matching 도입.

**핵심 통찰**: 과거 프로그램 = 단일 폰트 픽셀 매칭. 우리는 ML OCR (paddle/tess) → 사용자 폰트에 약함.
**해결**: 사용자가 한 번만 정답 입력 → 자동으로 픽셀 패턴 학습 → 이후 OCR 100% 정확.

**HIGH-1 TemplateMatcher User API** (`template-matcher.js:262~`)
- `registerUserTemplate(canvas, label, region)` — 사용자 정답 라벨로 자릿수 분리 → 픽셀 signature 추출 → localStorage 저장
- `matchUser(canvas, expectedLength, region, allowedChars)` — 사용자 template 우선 매칭 (fallback to base TEMPLATES)
- `userTemplateStats()` / `clearUserTemplates(region)` — 상태/초기화 API
- localStorage key: `lmp.userTemplate` (region별 자릿수 signature 저장)

**HIGH-2 UI — 사용자 폰트 즉시 학습 섹션** (`index.html:480~`)
- OCR · 아이템 탭에 새 섹션 (open by default)
- "📌 현재 ADENA 캡처를 template으로 학습" 버튼
- 트래커 NOW에 정확값 입력 후 클릭 → 자동 등록
- 등록 자릿수 / sig 개수 실시간 표시

**HIGH-3 ADENA OCR 통합** (`app.js:4287~`)
- ocrAdenaRegionHybrid 시작 부분에 user template matching 우선 분기
- 5+ 자릿수 + 5+ sig 등록 시 ML OCR 우회
- pad:3 white-extracted invert canvas 빌드 → variable length 3~7 시도 → best confidence
- confidence ≥ 0.85 → 즉시 채택 (paddle/tess skip)
- "🎯 ADENA user template 채택" hybridLog

**Phase 외 — v2 voting 290장 채택 (이전 19장)** (`scripts/wsl-tesseract-vote-v2.js`)
- paddle dominant + 자릿수 sanity 휴리스틱
- 학습 acceptance 3.1% → 47.8% (16배 증가)
- 다만 학습 결과 BCER 1.177 유지 (paddle 라벨 noise)

**파일 변경**: `template-matcher.js` (+150 LOC), `app.js` (+90 LOC), `index.html` (+20 LOC), `scripts/wsl-tesseract-vote-v2.js` (신규 +180 LOC), `package.json` version, `CLAUDE.md` history.

**검증**: npm test 36/36, node --check OK.

**사용법** (사용자 한 번만 실행):
1. 앱 실행 → ADENA OCR 한 사이클 돌림 (캡처 미리보기 생성)
2. 트래커 NOW에 정확한 ADENA 값 입력 (예: "67144")
3. OCR · 아이템 탭 → "🎯 사용자 폰트 즉시 학습" 섹션 → "📌 학습" 클릭
4. 이후 모든 ADENA OCR이 사용자 폰트로 정확 인식

### v1.7.1 (2026-05-09) — EXP 자릿수 mismatch 검증 8→3 추가 단축 ⭐
사용자 진단 2026-05-09T14-22-11 (v1.7.0): EXP "3.0878%" OCR 정확하나 anchor 59.46 stale → 자릿수 mismatch 9회 검증 대기 9초.

**LOW-1 EXP 자릿수 mismatch 검증 8→3** (`app.js:4651`)
- 1자리 OCR이 매번 일관 → 3회(3초) 일관이면 misread 거의 불가
- 사망/리셋 즉시 흡수, 사용자 답답 해소

**알려진 한계** (코드로 해결 불가):
- ADENA 6↔1 confusion: 사용자 게임 폰트의 "6"이 traineddata에서 "1"로 misread (예: "67144" → "17144")
- 학습 +8000 iter 추가해도 BCER 1.177 유지 (데이터 한계 도달)
- 자동 voting acceptance 3.1% (사용자 데이터 OCR 매우 어려움)
- **권장 솔루션**: 사용자가 _pending 614장 → 라벨링 시작 버튼으로 직접 라벨링 → v1.8.0 재학습

**파일 변경**: `app.js` 1곳, `package.json`, `CLAUDE.md`. ~5 LOC.

**검증**: npm test 36/36, node --check OK.

### v1.7.0 (2026-05-09) — 사용자 데이터 633장 자동 라벨링 + 재학습 + EXP 검증 단축 ⭐⭐⭐⭐
사용자 진단 2026-05-09T14-04-28 (v1.6.6): MP "MP:196/242" 미리보기 깨끗하나 OCR "2/3 ×30" stale, EXP "1.9319%" anchor 59.46 큰 점프 검증 21회 너무 김, ADENA "59819" ROI 정상 but OCR "???".

**Phase A — 자동 라벨링 633장**:
- _pending: mp 235 + exp 116 + adena 256 (level 26 제외)
- 4-way voting acceptance: 19장 (3.1%) — 사용자 데이터 OCR 매우 어려움
- 채택분 → training-data sync, 폐기분 → _rejected_voting

**Phase B — 재학습**: lineage_checkpoint(BCER 1.177) → MAX_ITERATIONS 16600→24600 (+8000 iter)
- 학습 시간 ~17분 (986 sample, skip ratio ~47%)
- 최종 BCER **1.177** (v1.6.0 best 유지, 추가 진전은 사용자 데이터 어려움 한계)
- 새 sample 통합으로 0/9, 5/8, 1/7 confusion 보강

**Phase C — 코드 fix**:
- EXP 자릿수 mismatch 검증 횟수 20→8 (`app.js:4651`) — 8초 후 자동 흡수, misread 거의 불가
- 매번 일관 misread 케이스에서 anchor 갱신 빠름

**Phase D — 빌드**: traineddata 복사, package.json 1.7.0, dist v1.6.6 정리, npm run build && dist.

**파일 변경**: `app.js` 1곳, `build/tessdata/lineage.traineddata` 갱신, `package.json`, `CLAUDE.md`. ~5 LOC + 11.7MB traineddata.

**검증**: npm test 36/36, node --check OK, 학습 완료, 빌드 성공.

**한계**: 사용자 환경 OCR 매우 어려움 (paddle/tess 매번 일관 misread). 향후 학습 데이터 더 누적 후 v1.8.0 재학습 권장.

### v1.6.6 (2026-05-09) — ADENA misread "3" 영원 굳음 차단 (초기 anchor + 자릿수 catastrophic 보강) ⭐⭐⭐
사용자 스크린샷 (2026-05-09 21:19): 미리보기 "30093" 깨끗 ✅, but OCR UI "3 ×3" → 영원 굳음.

**Root cause**:
- 사용자가 트래커 시작 시 anchor=0
- 첫 사이클 OCR misread "3" → anchorAd === 0이라 v1.6.0 catastrophic 거부 가드 통과
- voteHybrid → anchor=3 갱신
- 다음 사이클: paddle/tess 둘 다 "3" 일관 misread → anchor=3 유지 굳음
- v1.5.5 E fix(자릿수 +2 이상 5회 일관)는 매 사이클 결과 변동(30093 ↔ 3) 시 5회 일관 어려움
- "30093" 정확 OCR이 voteHybrid 자릿수 매치 분기에서 anchor 1자리와 매치 안 되어 폐기

**HIGH-1 anchor=0 초기 1~2자리 5회 일관 검증** (`app.js:4392~`)
- anchor=0 + valBoth<100 → `_initVerify` 5회 카운터
- misread "3"이 매번 같은 값으로 5회 연속이 어려움 → 진짜 1~2자리 ADENA만 통과
- 5회 일관 후 자동 통과 (게임 초반 정상 1~2자리 케이스)

**HIGH-2 anchor ≥100 + val<100 catastrophic 거부 보강** (`app.js:4401~`)
- v1.6.0 자릿수 차이 ≥3 거부와 별도로 anchor ≥100 + val<100 자체 거부
- anchor=99(2자리) → val=3(1자리) 같은 케이스도 차단 (자릿수 차이 1~2지만 catastrophic)

**파일 변경**: `app.js` 1곳 (~22 LOC), `package.json` version, `CLAUDE.md` history.

**검증**: npm test 36/36, node --check OK.

### v1.6.5 (2026-05-09) — ADENA 자릿수 +1 즉시 신뢰 + 큰 점프 검증 횟수 완화 ⭐⭐
사용자 스크린샷 (2026-05-09 21:08): 미리보기 + OCR 모두 "28,674" 정확 ✅. but UI에 "(검증 4/5) 점프" 5초 대기 → 사용자 체감 "인식 못 함".

**Root cause**:
- anchor 8913 (4자리, 이전 stale) → OCR 28674 (5자리, 정상 사냥 progress)
- 자릿수 +1 + value 증가는 정상 사냥인데 큰 점프 분기로 5회 검증
- 5초 대기는 사용자가 인식 실패로 오인

**HIGH-1 자릿수 +1 자연 증가 즉시 신뢰** (`app.js:4437~`)
- 조건: anchor>0 + valDigits === anchorDigits+1 + valBoth >= anchor*0.5 (오버플로 방어)
- 정상 사냥 progress (4자리 → 5자리, 9k → 28k) → 즉시 voteHybrid 통과
- _verifyQueue 자동 리셋

**HIGH-2 큰 점프 검증 횟수 완화** (`app.js:4441~`)
- 1k~5k: 2회 (유지)
- 5k~30k: 3 → **2회** (3초→2초)
- 30k~100k: 5 → **3회** (5초→3초)
- 100k+: 10 → **5회** (10초→5초)
- misread 방어와 사용자 체감 사이 균형, 절반 감소

**파일 변경**: `app.js` 1곳 (~12 LOC), `package.json` version, `CLAUDE.md` history.

**검증**: npm test 36/36, node --check OK.

### v1.6.4 (2026-05-09) — ADENA ROI height 축소 (글자만 노출, 다음 UI 라인 제외) ⭐⭐
사용자 스크린샷 2026-05-09 20:59 (v1.6.3): 게임 "27963" 정확 인식 ✅, but 미리보기에 글자 + 다음 UI 라인 가로선 잔상.

**Root cause**:
- v1.6.3 height *0.75 → icon height 31 * 0.75 = 23px (글자 ~14px + 9px 여유)
- 9px 여유에 다음 UI 라인의 가로선 포함됨
- trimPreviewVertical은 가로선도 검은 픽셀이라 trim 안 됨

**HIGH-1 belowCand height 축소 + y 미세** (`roi-detector.js:664~`)
- height: max(22, *0.75) → max(18, *0.55) (~17px, 글자 한 줄만)
- y: *0.88 → *0.83 (윗쪽 1.5px 더 안전 마진)
- x는 -20 유지

**v1.6.4 ROI 캐시 자동 invalidate** (`storage.js:191~`)
- `_roiInvalidatedFor164` 플래그로 1회 무효화

**파일 변경**: `roi-detector.js` 1곳, `storage.js` 1곳, `package.json` version, `CLAUDE.md` history. ~10 LOC.

**검증**: npm test 36/36, node --check OK.

### v1.6.3 (2026-05-09) — ADENA 텍스트 윗쪽 잘림 fix (y *0.88 + height *0.75) ⭐⭐
사용자 진단 2026-05-09T11-53-46 (v1.6.2): 미리보기 "78913" 윗쪽 잘림 + OCR "78913" → "8913" 4자리만 인식 (anchor 98913→8913 자릿수 -1 굳음).

**Root cause**:
- v1.6.2 belowCand y *0.85→*0.95 (아이콘 끝 877과 거의 일치) → 글자 윗부분 ROI 경계 밖
- height *0.7→*0.65 축소 → ROI 더 작아져 글자 위아래 모두 빠듯

**HIGH-1 belowCand y/height 재조정** (`roi-detector.js:664~`)
- y: icon.height * 0.95 → 0.88 (3px 위로 회복, 윗쪽 안전 마진)
- height: max(20, height * 0.65) → max(22, height * 0.75) (글자 + 위아래 padding)
- x는 -20 유지 (좌측 시프트는 효과적, 첫 자리 안전)

**v1.6.3 ROI 캐시 자동 invalidate** (`storage.js:184~`)
- `_roiInvalidatedFor163` 플래그로 1회 무효화

**파일 변경**: `roi-detector.js` 1곳, `storage.js` 1곳, `package.json` version, `CLAUDE.md` history. ~12 LOC.

**검증**: npm test 36/36, node --check OK.

### v1.6.2 (2026-05-09) — ADENA 시각 미세 조정 (좌측 -5px 추가 + 미리보기 vertical trim) ⭐
사용자 진단 2026-05-09T11-42-02 (v1.6.1): OCR 정확 ✅ (anchor 자동 복구 13→98,913, EXP paddle 채택). 사용자 시각 요청만.

**v1.6.1 효과 검증**:
- `🔓 ADENA anchor 자동 복구 (tess 5회 일관 + 자릿수 2→5): 13 → 98,913` ✅
- `EXP 🟡 paddle 채택 (delta 0.0000 < tess 0.0420): 57.1533` ✅
- adAdenaLast `✅ 98,913 ×5`, adExpLast `✅ 57.1533%`

**LOW-1 belowCand 좌측 -15→-20 + y/height 미세** (`roi-detector.js:664~`)
- 좌측 5px 추가 시프트 → 캡처 미리보기 첫 자리 안전 마진 ↑
- y: icon.y + height*0.85 → 0.95 (ROI 위쪽이 텍스트에 더 가까이)
- height: max(20, height*0.7) → max(18, height*0.65) (불필요한 하단 여유 축소)

**LOW-2 미리보기 vertical content-trim** (`app.js:2634~`)
- 신규 `trimPreviewVertical(canvas, padPx)` 헬퍼: 어두운 픽셀 행 검출 → bounding box [y0..y1] + 4px padding crop
- ADENA preview 캔버스에 적용 → 글자 영역만 노출 (상/하 공백 자동 제거)
- 글자 검출 실패 시 원본 반환 (안전 가드)

**LOW-3 v1.6.2 ROI 캐시 자동 invalidate** (`storage.js:178~`)
- `_roiInvalidatedFor162` 플래그로 1회 무효화 → 사용자 재탐지 불필요

**파일 변경**: `roi-detector.js` 1곳, `app.js` 2곳 (헬퍼 + 호출), `storage.js` 1곳, `package.json` version, `CLAUDE.md` history. ~70 LOC.

**검증**: npm test 36/36, node --check OK.

### v1.6.1 (2026-05-09) — EXP DISAGREE paddle 우선 + ADENA _clipped flashHint ⭐⭐⭐
사용자 진단 2026-05-09T11-26-34 (v1.6.0): ADENA "8913" 캡처(intended 115 → 83 클램프), EXP "57.1533" paddle 정확 vs tess 11회 "57.1953" misread → DISAGREE 폐기 → anchor 47.91 영원 stale.

**HIGH-1 EXP DISAGREE 큰 점프 paddle 일관 검증** (`app.js:4830~`)
- 진단: paddle=57.1533 (1회) vs tess=57.1953 (11회 misread, 5↔9 confusion)
- 기존: 둘 다 isPlausibleForward 미통과(>0.1%p 점프) → voteHybrid → DISAGREE 폐기
- 원인: v1.5.7 큰 점프 검증은 parsedMatches 일치할 때만 발동, DISAGREE에는 안 걸림
- 해결: 정수부 일치 + paddle delta ≤ tess delta + paddle 5회 일관 → paddle 단독 채택 (tess confusion 의심)
- 새 카운터 `_paddleConsistency` (val/count) — 일관성 깨지면 자동 리셋

**HIGH-2 ADENA _clipped flashHint 강력 안내** (`app.js:5119~`)
- 기존: width<50일 때만 안내 — 진단 width=83(intended 115, _clipped)는 안내 발동 X
- 해결: _clipped + width<90 + intended-width 차이 ≥10px → flashHint 30s throttle
- 메시지: "⚠️ ADENA ROI Xpx 잘림 — 게임 영역 우측 Y px+ 확장 필요"
- 사용자가 게임 영역 우측 확장을 즉시 인지 가능 (코드 fix만으로 풀 수 없는 환경 제약)

**파일 변경**: `app.js` 2곳 (~70 LOC), `package.json` version, `CLAUDE.md` history.

**검증**: npm test 36/36, node --check OK.

### v1.6.0 (2026-05-09) — ADENA leading-digit-loss fix + traineddata 재학습 (BCER 1.560→1.177) ⭐⭐⭐⭐
사용자 진단 2026-05-09T10-57-47 (v1.5.13): "78835" → ROI 캡처 "8835" (첫 자리 7 손실), anchor=18674 → 185 굳음, EXP 9.20%p 점프 검증 16회 대기 길음.

**HIGH-1 ADENA belowCand 좌측 -5→-15 + width 80→100** (`roi-detector.js:664~`)
- 진단: cachedROIs.textROIs.adena.x=1209, adenaIcon.x=1214 → ROI가 아이콘 좌측 5px부터 시작
- AutoTrim L:10px 와 겹쳐 첫 글자 "7" 잘림 → "78835" → "8835" misread
- 해결: `belowCand.x = adenaIcon.x - 15` (좌측 10px 더 확장 → "7" 캡처 보장)
- width: `max(80, icon*1.8)` → `max(100, icon*2.8)` (5자리/6자리 콤마 모두 보장)
- rightCand width도 90→100 동기 상향

**HIGH-2 ADENA 자릿수 catastrophic 보호** (`app.js:4343~`)
- v1.5.5 E fix는 자릿수 **증가**(778→10778) 케이스만 — anchor 18674(5자리) → OCR 185(3자리) 자릿수 감소 catastrophic 케이스 미보호
- 자릿수 -1 (정상 leading-drop): 2회 일관 (기존 유지)
- 자릿수 -2 (5→3 등 catastrophic): **10회 강력 검증** (신규)
- 자릿수 -3+: **영원 거부** (ROI 결함 의심, 사용자 안내)

**MED-1 EXP 큰 점프 검증 15→8 단축** (`app.js:4684`)
- 진단: anchor 47.91 → OCR 57.10, intDiff=10 (비-confusion), 9.20%p 점프 → 16회(16초) 대기 너무 김
- confusion 케이스(intDiff 5/9, 매번 일관 misread 위험)는 30회 유지
- 일반 점프는 8회 → 8초 후 자동 흡수, misread는 거의 불가능

**LOW-1 v1.6.0 ROI 캐시 자동 invalidate** (`storage.js:170~`)
- v1.5.x → v1.6.0 업그레이드 시 cachedROIs 1회 무효화 → 사용자가 🔄 재탐지 안 눌러도 새 ROI 알고리즘 적용
- `_roiInvalidatedFor160` 플래그로 1회만 실행

**P2 traineddata 재학습 — BCER 1.560 → 1.177 (24.5% 개선)**
- 신규 _pending: mp 114, exp 171, adena 215 = 500장
- 자동 라벨링 (4-way voting): 130장 acceptance (mp 0, exp 44, adena 86) — MP는 max=235/242 sanity로 reject
- 학습 데이터: 882 → 1,010장 → corrupted .lstmf 정리 후 654장
- MAX_ITERATIONS 8600 → 16600 (+8000), 학습 시간 2분 27초
- 최종 BCER **1.177%** (v1.5.0 1.560 → 24.5% 개선)
- 신규 데이터로 0/9, 5/8, 7/1, 4/9 confusion pair 보강

**파일 변경**: `roi-detector.js` 1곳, `app.js` 2곳, `storage.js` 1곳, `build/tessdata/lineage.traineddata` 갱신, `package.json` version, `CLAUDE.md` history. ~85 LOC.

**검증**: npm test 36/36, node --check OK.

### v1.5.13 (2026-05-09) — ADENA 미리보기 상하 공백 fix (pad:3 전용 캔버스) ⭐
사용자 진단 2026-05-09T10-43-50: ADENA 미리보기 상하 공백 과다 + EXP만큼 깨끗하지 않음.

**Root cause**:
- OCR용 `buildWhiteCanvas`는 `pad: 10` (v1.2.0-paddle leading-digit-drop 보호 위해 4→10).
- 미리보기에 OCR 캔버스 `canvasWhite`(pad:10)를 그대로 노출 → 12x scale 시 상/하 120px 흰 여백.
- ADENA 글자가 캔버스의 51%만 차지 (EXP는 pad:3 → 76%) → 상하 공백 ~3.3배.

**HIGH-1 미리보기 전용 pad:3 캔버스 분리** (`app.js:3324~`)
- OCR 캔버스 7종(`canvas`/`canvasSoft`/`canvasOtsu`/`canvasRaw`/`canvasWhite/Soft/Deep`)은 그대로 pad:10 유지 → OCR 정확도 무영향.
- 신규 `canvasPreview` 추가: `captureRegionToRawCanvas(adenaRegion, 12, { pad: 3 })` + `applyWhiteExtraction(140, RGB)` + invert.
- `updatePreview(dom.adAdenaPreview, canvasPreview || canvasWhite || canvasWhiteSoft)` — fallback 체인 유지.
- 결과: ADENA 미리보기가 EXP와 동일한 시각 비율로 노출 (글자 76% 차지).

**파일 변경**: `src/js/app.js` 1곳 (~22 LOC), `package.json` version, `CLAUDE.md` history.

**검증**: npm test 36/36, node --check OK.

### v1.5.12 (2026-05-09) — Tesseract recognize 30s timeout + ADENA white-extraction 다단계 ⭐⭐⭐
사용자 진단 2026-05-08T16-01-51 (v1.5.11): MP/EXP/LEVEL/ADENA(수동) ✅ but 두 가지 잔여 문제.
1. "업데이트도 멈추고" — `recognizing text 11% (+1281s)` 21분 Tesseract worker hang.
2. "아데나 폰트가 깨져 보여, 경험치처럼 깨끗하게" — ADENA 미리보기 노이즈/픽셀화.

**HIGH-1 Tesseract recognize 30s timeout + auto-restart** (`app.js:1775~`)
- 진단 timing 비일관 (+44s 0%, +572s 100%, +1281s 11%) — recognize 호출 자체가 가끔 hang.
- 해결: `recognizeWithTimeout(worker, canvas, label)` helper. 30s timeout race.
- timeout 시 worker terminate + ocrInitPromise=null → 다음 사이클에 자동 재초기화.
- 적용 위치 4곳: MP/LEVEL/ADENA/EXP `await w.recognize()` 전부 교체.
- pushHybridLog: `⚠️ Tesseract recognize timeout (label) — worker 재시작`

**HIGH-2 ADENA white-extraction 다단계** (`app.js:3251`)
- 기존: T=120 lum 단일 (1캔버스)
- 변경: EXP의 buildWhiteCanvas 헬퍼 패턴 도입 — T=140 RGB + T=120 lum + T=70 lum (3캔버스)
- 캔버스 5종 → 7종 × PSM 3 = 최대 21 results (이전 15)
- 미리보기 캔버스도 white140 우선 노출 → 사용자가 "EXP처럼 깨끗하게" 보임
- 다양한 글자 색상/대비 환경에 robust 추출

**파일 변경**: `src/js/app.js` 3곳 (helper + ADENA + recognize 4곳 wrap), `package.json` version, ~75 LOC.

**검증**: npm test 36/36, node --check OK.

### v1.5.11 (2026-05-09) — ADENA rightCand 중심 시작 + 임계 80→50 완화 (사용자 "중앙으로" 요청) ⭐⭐
사용자 진단 2026-05-08T15-28-12 (v1.5.10): MP/EXP/LEVEL ✅ but ADENA OCR skip 발동, anchor=39517 보호 정상.
사용자 의견: "아데나 기준을 중앙으로 잡아야 할 거 같아.. 우측 빈 공간이 너무 심해."

**root cause 종합**:
- adenaIcon.x=1218, frameW=1282 → 아이콘 우측 22px만 남음 (현재 시작점 icon.x+icon.width+3=1263)
- 의도 width 105px 중 19px만 캡처 → frame 우측 클램프 86px
- 5자리 콤마없음 게임 환경 (39517) — 60~70px ROI 충분
- 사용자 환경 콤마있는 6자리 케이스(22,974) 아님

**HIGH-1 rightCand x 시작점 아이콘 중심으로** (`roi-detector.js:633`)
- `icon.x + icon.width + 3` → `icon.x + icon.width * 0.5` (아이콘 중심)
- 동일 frameW에서 우측 여유 ~2배 확보 (22→43px)
- 사용자 "중앙으로" 의도 직접 반영
- white-extraction OCR이 아이콘 노란 픽셀 자연 차단 → 노이즈 영향 미미

**HIGH-2 width 임계 80→50 완화** (`roi-detector.js:693` + `app.js:4998` + `app.js:5485`)
- 5자리 콤마없음 (39517) = 60~70px 충분 → 50 임계로 충분히 통과
- 6자리 콤마있음 (22,974) 케이스는 _clipped 메시지로 별도 안내 (정확한 확장 px)
- v1.5.10 OCR skip 가드도 50으로 동기화

**파일 변경**: `src/js/roi-detector.js` 2곳, `src/js/app.js` 2곳, `package.json` version, ~12 LOC.

**검증**: npm test 36/36, node --check OK.

### v1.5.10 (2026-05-09) — ADENA region.width<80 시 OCR skip + 사용자 명확 안내 ⭐⭐
사용자 진단 2026-05-08T15-14-29 (v1.5.9 빌드): MP/EXP/LEVEL ✅ but ADENA "36891"을 "1" 로 misread.

**root cause**:
- `regions.adena.width=64px` 영원 굳음 (이전 사이클 클램프 결과 + v1.5.9 textROIs.adena=null로 갱신 skip 작동)
- 64px ROI 안에 5자리 "36891" 못 들어가 우측 끄트머리 "1"만 OCR
- anchor=35852 vs OCR=1 → 큰 점프 검증 무한 발동 → adAdenaLast UI는 "🔄 1 (검증 1/5) 🚧 점프" 만 노출 → 사용자가 무엇이 문제인지 인지 불가
- 사용자 게임 영역(녹화 캡처) 우측이 모니터 끝에 가까워 ADENA 텍스트 영역(의도 90px+) 못 담음

**CRITICAL-1 region.width<80 시 OCR skip** (`app.js:5485`)
- OCR 호출 전 region.width 가드 → 부족 시 skip (anchor 보호 강화)
- pushHybridLog: `⚠️ ADENA OCR skip (region 64px<80px) — 게임 영역을 우측으로 26px 확장 필요`
- flashHint: 토스트로 1.5초 노출 (30s throttle)
- adAdenaLast UI: `⚠️ ROI 64px<80px — 게임 영역 우측 확장 필요`
- v1.5.8 임계 80px와 동일 기준 — 5자리+콤마 보장

**파일 변경**: `src/js/app.js` 1곳, `package.json` version, ~18 LOC.

**검증**: npm test 36/36, node --check OK.

### v1.5.9 (2026-05-08) — EXP/LEVEL ROI 겹침 fix + LEVEL sanity + EXP anchor=0 stale 보호 ⭐⭐⭐
사용자 진단 2026-05-08T14-41-55 (v1.5.7): MP/ADENA 일부 진전 but EXP/LEVEL 한글 시스템 텍스트 캡처.

**CRITICAL-1 EXP/LEVEL ROI 영역 겹침 fix** (`roi-detector.js` + `app.js`)
- 진단: textROIs.level=[3-86], textROIs.exp=[23-86] 동일 영역 → 좌측 한글 글자 동시 캡처.
- root cause: roi-detector.js:524 `expStart_x<0` 폴백이 `rightMost.xStart` 사용 — rightMost는 이미 LEVEL cluster에 통합된 마지막 cluster → EXP가 LEVEL 안 좌표 가리킴.
- fix1 (`roi-detector.js`): cluster 분리 gap 10→20 (보수화). expStart_x 미발견 시 `rois.exp = null` 반환.
- fix2 (`app.js`): `result.textROIs.exp` 필수 검증 제거. exp=null 시 `expRegion` 갱신 skip + 30s throttled 안내. clamp loop / overlay draw / toAbsRegion 호출에 null 가드.

**CRITICAL-2 LEVEL OCR 1~99 sanity** (`app.js`)
- 진단: ROI에 한글 잡혔지만 anchor=12 굳음 → paddle/tess가 비숫자 패턴에서 우연히 숫자 추출.
- fix: `r.parsed.level` 이 1~99 정수 아니면 `r.parsed=null` 처리 → anchor 보호 + else 분기로 자연 진입.

**HIGH-1 EXP anchorEXP=0 stale 5회 일관 검증** (`app.js`)
- 진단: anchorEXP=0 + ROI 한글 캡처 → OCR 결과 영원 anchor 영원 0.
- root cause: `if (anchorBoth > 0)` 분기 외 케이스에서 즉시 통과 → 첫 misread 굳음 위험.
- fix: v1.5.5 A++ MP anchor 양방향 stale 패턴을 EXP에 확장. 5회 일관(약 5초)일 때만 anchor 갱신. paddle/tess 동시 misread 5회 일관 매우 어려움.

**MED-1 findLevelTextLines cluster 통합 검증 강화** (`roi-detector.js`)
- 진단: cluster 2+개 검출되었지만 모두 25px 이내 인접 → lvlEnd로 통합 → 단일 단어 layout.
- fix: cluster 사이 최대 gap > 20px 게이트 추가 → 미달 시 lvLine 후보 폐기 → 막대 기반 fallback 진입.

**파일 변경**: `src/js/roi-detector.js` 3곳, `src/js/app.js` 5곳, `package.json` version, ~95 LOC.

**검증**: npm test 36/36, node --check 양호.

**상세**: `.omc/plans/v1.5.9-exp-level-roi-overlap.md`

**v1.5.8 + v1.5.9 통합 빌드**:
- `npm run build && npm run dist` (사용자가 portable 종료 후)
- ZIP 단독으로는 빌드 안 됨 — build 먼저 필수.
- v1.5.7 → v1.5.9 누적 변경: ADENA clamp 인지(80px), MP DISAGREE paddle 우선, EXP 사망 토스트, paddleDebug 정리, EXP/LEVEL ROI 분리, LEVEL 1~99 sanity, EXP anchor=0 보호.

### v1.5.8 (2026-05-08) — Adena ROI clamp 인지 + MP DISAGREE paddle 우선 + EXP 사망 토스트 ⭐⭐⭐
사용자 진단 2026-05-08T14-05-41 (v1.5.7): MP/ADENA 동시 OCR 실패 + EXP 큰 감소 (사망 추정).

**HIGH-1 ADENA ROI 우측 클램프 인지 + 임계값 50→80** (`roi-detector.js`)
- 진단: `cachedROIs.textROIs.adena.width=64px` (frameW=1278에 클램프됨) → "22,974"를 "2,274"로 자릿수 손실 misread.
- rightCand width 103px → frame 경계 1278에서 64px로 잘림 (실측). belowCand 74px → 64px 잘림.
- 임계값 50px는 4자리 ADENA 기준 — 5자리+콤마(22,974) 보장 위해 80px로 상향.
- belowCand 기본 폭 50→80 동시 상향 (회귀 위험 최소화).
- 클램프 발생 시 `_clipped`/`_intendedWidth` 플래그 → "ADENA ROI 우측 클램프 (의도 103px → 64px) — 게임 영역 우측으로 49px 이상 확장" 명시 메시지.
- `app.js:4952` 사용자 안내 메시지도 동기화.

**HIGH-2 MP DISAGREE paddle 우선 채택 휴리스틱** (`app.js:4037 voteHybrid`)
- 진단: `paddle=177/242 (정확) vs tess=2/242 (5회 중 3회 일관 misread)` → DISAGREE 영원 폐기 → MP "???".
- 5조건 동시 만족 시 paddle 단독 채택:
  1) `label==='MP'`
  2) max 일치
  3) paddle.cur 1~max 합리
  4) tess.cur 자릿수 손실 의심 (paddle*0.2 미만, OR 한자릿수 vs 두자릿수+ 격차)
  5) userMax sanity (≥10 + paddle.max 일치)
- v1.5.5 D fix(LEVEL paddle 우선) 패턴을 MP cur로 확장. anchor 보호되면서 일관 misread 회피.

**MED-1 EXP 큰 감소 사망 추정 토스트** (`app.js:4605`)
- 진단: 49.99% → 41.60% (-8.39%p) — 큰 점프 검증은 정상 작동하나 사용자가 misread/리셋/사망 인지 불가.
- 큰 점프 검증 통과 시점에 `deltaBoth < -5` 이면 `flashHint('⚠️ EXP -X.XX%p — 사망 또는 트래커 리셋?')` 발동.
- 60초 throttle, `localStorage.lmp.expDeathToast` 로 끄기 가능 (기본 ON).

**LOW-1 paddleDebug placeholder 정리** (`app.js:6244`)
- 진단 리포트 `paddleDebug` 가 실제 결과 없을 때 `"테스트 버튼 클릭 시 표시"` 직렬화 → 자동화 파싱 노이즈.
- placeholder 또는 빈 문자열이면 null 반환.

**파일 변경**: `src/js/roi-detector.js` 2곳, `src/js/app.js` 4곳, `package.json` version, ~83 LOC.

**검증**: npm test 36/36, node --check 양호.

**상세**: `.omc/plans/v1.5.8-roi-clamp-and-mp-disagree.md`

### v1.5.7 (2026-05-08) — EXP 0↔9 confusion 안정화 (H1+H2+H3) ⭐⭐
사용자 진단 2026-05-08T13-51-20 (v1.5.6): LEVEL ✅ G fix 작동 확인. EXP "40.8843%"가 OCR에서 "49.8843%"로 매번 misread (0↔9 confusion, traineddata 학습 한계).

**H1 EXP 점프 검증 confusion 케이스 강화** (`app.js:4555`)
- 정수부 차이 5/9 + |delta| 패턴 일치 시 confusion 의심 → requiredJumpCount 15→30회.
- 매번 일관 misread 케이스에서 anchor stale 굳기 직전까지 시간 ↑.

**H2 사용자 anchor 직접 입력 보호 60초→180초** (`app.js:253 markUserEdit`)
- 사용자가 trkExpNow 직접 수정 후 OCR이 60초 후 덮어쓰던 부담 완화.
- 3분 동안 OCR 자동 갱신 무시 → 짧은 사냥 도중 anchor 보호 유지.

**H3 EXP/LEVEL textROI PAD_X 2→4** (`roi-detector.js`)
- cluster 분리 결과의 좌우 padding ↑ → 글자 안티앨리어싱 영향 ↓ → OCR 정확도 미세 향상.

**검증**: npm test 36/36, node --check OK

**알려진 한계**: 0↔9 confusion 자체는 traineddata 학습 한계. 코드 fix는 우회 휴리스틱이며 100% 해결 X. v1.6.0 학습 데이터 보강 (EXP 40대 케이스) 후 근본 해결 가능.

### v1.5.6 (2026-05-08) — LEVEL anchor stale 자동 복구 (G fix) ⭐⭐
사용자 진단 2026-05-08T13-37-57 (v1.5.5): MP/EXP/ADENA 진전 ✅ but LEVEL anchor=23 stale로 굳어 D fix 발동 못함.

**G fix LEVEL paddle 3회 일관 + anchor 자동 복구** (`app.js:4157`)
- v1.5.5 D fix 한계: `paddle === anchor` 만 채택 → anchor stale 23 + paddle 29 시 발동 못함.
- 추가: paddle 1~99 sanity + 3회 연속 일관 + anchor 다름 → anchor 자동 복구 + paddle 채택.
- 3회 검증으로 paddle 자체 misread 차단.

**검증**: npm test 36/36, node --check OK

### v1.5.5 (2026-05-08) — anchor stale 양방향 자동 복구 + LEVEL paddle 우선 ⭐⭐⭐
사용자 진단 2026-05-08T13-19-43 (v1.5.4): EXP 정상 인식 ✅ but MP/LEVEL/ADENA paddle 정확 결과가 anchor stale + voting 정책으로 매번 폐기.

**A++ MP anchor 양방향 stale** (`app.js:4081`)
- v1.5.4 게이트 `pmx >= um*2` 가 mpMax=292 stale(paddle 242, 차이 50)을 막음.
- 변경: `Math.abs(pmx-um) / max(pmx,um) >= 0.1` (10% 차이) → stale 의심.
- 5회 일관 시 max+cur 동시 복구.

**D LEVEL paddle 우선** (`app.js:4157`)
- tess가 매번 LV.29를 "23"으로 misread → voteHybrid disagree 폐기.
- paddle.level 1~99 sanity 통과 + 트래커 anchor와 일치 → paddle 단독 채택.

**E ADENA anchor 자릿수 부족 자동 복구** (`app.js:4181`)
- anchor=778(3자리) stale + tess=10778(5자리) 정확 + paddle=778 catastrophic misread.
- tess 자릿수가 anchor +2 이상 + tess 5회 일관 → anchor 자동 복구 + tess 단독 채택.

**F (보류)**: autoStartTracker 첫 사이클 sanity. 추가 분석 후 v1.5.6 검토.

**파일 변경**: `src/js/app.js` 3곳, ~50 LOC.

**검증**: npm test 36/36, node --check OK.

### v1.5.4 (2026-05-08) — EXP 막대 없는 UI 대응 + MP anchor stale 동시 복구 ⭐⭐⭐
사용자 진단 2026-05-08T12-58-41 (v1.5.3) + 게임 스크린샷:
- LEVEL `LLEW`, EXP `???`, MP `3/8 ×3` (실제 화면 LV.29 + 39.6107% + 131/242)
- v1.5.3 mpBar stale 자동 무효화 작동 확인 (mpBar=null + displayCheck OK)

**P0 EXP 진행 막대 없는 게임 UI 대응** (`roi-detector.js`)
- 게임 화면 분석: 이 게임은 EXP 진행 막대(progress bar)가 없고 "LEV:29 [아바타] 39.6107%" 텍스트만 표시
- expBar 후보 자동 탐지가 노란/오렌지 톤 "LEV:29" 텍스트 글자 자체를 막대로 false-positive 채택 (width 85, height 26, avgHue 28)
- deriveTextROIs "막대 두꺼움" 분기(height≥12)가 단순 0.4/0.55 분할로 LV:29 글자를 가운데로 절단 → LEVEL "LEW", EXP ":29"

**B fix**: 막대 두꺼움 분기에서도 `findLevelTextLines` 우선 시도. cluster 2개 이상 + gap>20px 명확 분리 시 텍스트 라인 ROI 채택. 실패 시 단순 분할 fallback.
**C fix**: `findExpBarCandidates`에 aspect 기반 우선순위 — 얇은 가로 막대(aspect≥5, height≤12)를 우선, 두꺼운 후보(텍스트 의심)는 후순위. 완전 reject 아닌 ordering으로 false negative 위험 회피.

**P0 MP anchor cur+max 동시 stale 복구** (`app.js:4081`)
- 진단 anchor mpCur=3, mpMax=8 (사용자 잘못 입력 또는 stale 굳음)
- 화면 실제 131/242 → paddle/tess 매번 폐기 (max 불일치) → tess "3/8" misread만 anchor와 일치해 통과
- v1.4.2 mpMax 자동 복구의 게이트 `um >= 10`이 mpMax=8을 막아 영영 복구 안 됨

**A fix**: 게이트 변경 — `pmx >= um*2`(stale 의심) 또는 `um===0` 시 발동. 5회 일관 시 max+cur 동시 복구.

**파일 변경**: `src/js/app.js` 1곳, `src/js/roi-detector.js` 2곳, ~80 LOC.

**검증**: npm test 36/36 통과 + node --check 3 파일 OK.

**상세**: `.omc/plans/v1.5.4-exp-bar-absent-ui.md` (작성 예정)

### v1.5.3 (2026-05-08) — v1.5.2 회귀 fix + 창 크기 모니터 클램프 ⭐⭐
사용자 진단 2026-05-08T12-41-24 (v1.5.2): MP 여전히 `???`, adInitStatus "시작값 자동 설정 LEVEL 5/5 실패", 창 처음 실행 시 모니터 밖.

**P0 v1.5.2 회귀 — Fix #4 revert** (`app.js:4651`)
- `autoDetect.active`는 코드에서 단 한 번도 set되지 않는 변수 (grep `\.active\s*=` 결과 `tracker.active`/`trainLabeling.active`만 존재).
- v1.5.2 Fix #4가 이 변수를 게이트로 사용 → 항상 falsy → ensureAutoModeROIs 영영 막힘 → 새 ROI 탐지 0회 + Fix #1(stale 무효화) 도달 못 함.
- v1.5.2에서 OCR이 도는 것처럼 보인 건 이전 v1.5.1 세션의 cachedROIs storage 잔존 덕분 (운).

**P1 Fix #1 위치 이동** (`app.js:4651`)
- v1.5.2에 추가한 mpBarRegion stale 검사를 toAbsRegion 직후(새 탐지 사이클 끝)에 두어 cacheHit 분기에서 도달 못 함.
- ensureAutoModeROIs 진입부(gameRegion 검증 직후)로 이동 → 모든 호출 경로에서 1회 stale 검사.
- 진단 mpBar.sourceId=screen:0:0 → 자동 무효화 → useMpBar=false 저장 → 다음 사이클부터 MP 텍스트 OCR 정상.

**P2 창 크기 fix** (`electron/main.js`)
- 사용자 보고: 처음 실행 시 화면이 너무 커 모니터 밖에까지 나감.
- 원인 1: 기존 `isWithinDisplay(x, y)`가 좌상단만 검증 → 창 우측이 밖이어도 통과.
- 원인 2: ready-to-show에서 size만 보정, position은 유지 → bounds 복원 시 클램프 안 됨.
- 원인 3: default 1280x900이 1080p workArea(1920x1040)에서 chrome 합산 시 빠듯.
- 수정:
  - `isWithinDisplay(x, y, w, h)` 창 전체 검증 + workArea 사용
  - `clampToNearestDisplay(x, y, w, h)` — 가장 가까운 모니터 workArea로 강제 끌어옴
  - default 1100x820 (보수적)
  - createMainWindow + ready-to-show 모두 클램프 적용

**파일 변경**: `src/js/app.js` 2곳, `electron/main.js` 1곳, ~50 LOC.

**v1.5.2 평가**:
| Fix | 결과 |
|---|---|
| #1 mpBarRegion stale 무효화 | ❌ 미작동 (위치 잘못) → v1.5.3에서 진입부 이동으로 해결 |
| #2 ADENA template 신뢰 거부 | ✅ 작동 (진단 `🔒 일치율 0% 거부` 확인) |
| #3 expW_bar clamp + throttle | ⚠️ 미검증 (이번엔 EXP 메시지 자체 없음) |
| #4 active=false 시 skip | 🚨 회귀 → v1.5.3에서 revert |
| #5 displayCheck mpBar 포함 | ✅ 작동 (진단 `displayid_cached_mismatch` 보고) |

**검증**: npm test 36/36 통과 + node --check 양호 (3 파일).

### v1.5.2 (2026-05-08) — 자동 인식 회로 root cause 5종 fix ⭐⭐⭐
사용자 진단 2026-05-08T12-21-25 (v1.5.1): MP 영원 `???` (anchor 8/8 stale) + ADENA 마지막 자리 변형 25399→25297 + hybridLog 도배.

**Root cause + fix**:
1. **mpBarRegion stale sourceId** (P0) — `regions.mpBar.sourceId=screen:0:0` 인데 `gameRegion=screen:1:0` → captureStream 없음 → MP gauge 검증 throw → MP "???" 영원. v1.4.0+ ADENA stale 해제 패턴(line 4877)을 mpBarRegion에도 확장 (`app.js:~4882`).
2. **ADENA template catastrophic mismatch** (P1) — template "96097" vs OCR "25399" 자릿수 일치 1/5=20% 인데도 B-noisy tier가 마지막 자리 9→7 변형. `tplOcrMatchRate < 0.4` 시 per-digit override 전체 skip (`app.js:3505`).
3. **EXP textROI<50 sanity 도배** (P2) — `expBar.width=82 → 0.55*82=45 → invalid` 무한 반복. roi-detector.js의 `expW_bar = Math.max(50, ...)` clamp + throttle 키를 `issues.sort()[0]` 정규화로 변경.
4. **autoDetect.active=false 시 자동 ROI 사이클** (P3) — 트래커 PAUSE 중인데 hybridLog 도배. ensureAutoModeROIs 진입부에 `!active && !opts.force` skip 추가.
5. **displayCheck mpBar 누락** (P4) — `_diagRegions`에 mpBar 추가 → 사용자 진단 시 sourceId mismatch 자체 진단 가능.

**파일 변경**: `src/js/app.js` 4곳, `src/js/roi-detector.js` 1곳, 총 ~50 LOC.

**검증**: npm test 36/36 통과 + node --check 양호.

**상세**: `.omc/plans/v1.5.2-auto-recognition-fix.md`

### v1.5.1 (2026-05-08) — expBar 후보 width 최소 sanity (EXP/LEVEL ROI 잘못 잡힘 fix) ⭐⭐
사용자 진단 2026-05-07T15-11-42 (v1.5.0 빌드 사용 시): expBar.width=58px 짧은 후보 채택 → EXP textROI w=32, LEVEL textROI w=23 → 둘 다 LV.29 박스 부분만 캡처 → OCR catastrophic ("C", "???").

**원인**: `findExpBarCandidates` posFilter에 width 최소값 없음 → 다른 짧은 orange element (LV 인디케이터 등)가 expBar로 채택. 그 결과 textROI 도출 시 expBar.x ± width*0.4/0.55로 분할 → EXP/LEVEL 모두 같은 LV 박스 영역 분리.

**수정** (`roi-detector.js`):
- `findExpBarCandidates` posFilter에 `bw >= 80` 추가 (정상 expBar 100~250)
- `validateROIs` cross-check에 sanity 추가:
  - expBar.width < 80 → invalid
  - EXP textROI width < 50 → invalid
  - LEVEL textROI width < 30 → invalid

**결과**: 짧은 orange 후보 차단 → 정상 expBar 또는 v1.4.1 `findLevelTextLines` fallback 동작.

### v1.5.0 (2026-05-08) — traineddata 재학습 — BCER 1.96% → 1.560% ⭐⭐⭐⭐⭐
P2 학습 재수집 plan 실행. 사용자가 라벨링을 위임 → AI가 ensemble OCR + voting 자동 처리 → 학습 + 빌드까지 자동.

**핵심 결과**:
- baseline 463 라벨 → **신규 884 라벨** (91% 증가)
- **best BCER 1.560%** (이전 1.96% → 0.4%p 개선, lineage_1.560_346_8600.checkpoint)
- v1.4.3 휴리스틱 + v1.5.0 모델 정확도 향상 = 시너지

**자동 라벨링 파이프라인** (사용자 시간 0):
1. **sanity reject** (84개): MP cur>max 또는 max≠235/242 (35), EXP 정수부≥100 (29), ADENA 1~2자리 (20)
2. **WSL tesseract ensemble OCR** (1,308 PNG × 3 PSM = 3,924 OCR call):
   - 핵심 발견: `lineage` **단독** + 다중 PSM이 가장 정확. eng 섞으면 결과 오염.
   - PSM 7/8/13 ensemble
3. **4-way voting** (paddle/tess + lineage psm7/8/13):
   - unanimous_4 + consensus_3 + two_only_2 → 채택
   - majority_2 (4 valid 중 2 vs 2 split, 50% disagreement) → 폐기 (학습 노이즈 위험)
   - **421 채택 (acceptance 31.7%)**, 909 폐기 (`_rejected_voting/` 보존)
4. **자동 fs 이동**: 본 폴더 + .gt.txt 생성, _pending 삭제
5. **WSL 학습**: 체크포인트 이어 학습 (90초), iterative cycle (corrupted .lstmf 자동 식별 + sed로 list.train/eval 정리)

**LEVEL 제외**: 다양성 부족 (12 unique 값) — v1.5.1에서 부캐 사냥 후 보강.

**낚시 함정**:
- `make lists` cache로 list.train 갱신 안 됨 → 직접 sed 필수
- bash -c '...' single quote에서 변수 expansion 안 됨 → script file로 wrap
- MSYS path 변환 → `MSYS_NO_PATHCONV=1` 또는 `//root/...` 더블 슬래시
- corrupted .lstmf size threshold로 못 잡힘 → iterative training cycle (max 5 retries)

**산출물**:
- `dist/LineageMPTimer-1.5.0-portable.exe`
- `dist/LineageMPTimer-v1.5.0.zip` (127.61 MB)
- `build/tessdata/lineage.traineddata` (11.7MB, BCER 1.560%)

**새 도구** (`scripts/`):
- `wsl-tesseract-batch.sh` — ensemble OCR batch
- `wsl-tesseract-vote.js` — 4-way voting + auto-labeling (Node)
- `wsl-sync-groundtruth.sh` — Windows → WSL sync
- `wsl-robust-train.sh` — sync + make lists + corrupted cleanup + iterative training
- `wsl-cleanup-and-resume.sh` — list.train/eval sed 정리 + 학습 재개

상세: `docs/SESSION-HANDOFF-LATEST.md` v12, `.omc/plans/v1.5.0-training-data-recollection.md`

### v1.4.3 (2026-05-07) — OCR 안정화 7종 + MP textROI 게이지 종속 해제 ⭐⭐⭐⭐
사용자 진단 7라운드 분석으로 root cause 7종 해결. v1.4.2 자동 모드 회귀 fix 포함.

**핵심 발견 (이번 세션 가장 중요)**:
- **MP 게이지가 좌→우로 차오르는 시스템** → mpBar.width = 채워진 부분만 → MP 적을수록 textROI 좁음
- MP=113/242일 때 textROI=81px → "MP : 71"만 캡처 → OCR 매번 misread
- 해결: HP/MP 게이지 영역 폭 동일 가정 → max(mpBar, hpBar, 200)

수정 commit:
- `d60d35c` `fix(ocr): v1.4.3 자동 모드 안정화 + MP ROI/anchor 자동 복구`

적용된 fix 7종:

1. **[Phase 3a] ADENA frameW 클램프** (`roi-detector.js`)
   - 게임창 우측 가장자리 ADENA가 frameW 밖 100px → 검정 픽셀 캡처 → OCR "???"
   - 모든 ROI를 frameW 내 클램프, ADENA-only issue를 valid 결정에서 제외

2. **[Phase 3b] MP paddle max anchor 자동 복구** (`app.js`)
   - userMax 잘못 입력(197) vs 화면 max(242) → paddle 결과 매번 폐기
   - paddle 5회 연속 같은 max + 합리적 범위 → INPUTS 자동 갱신
   - ADENA v1.3.13 `_matchRecover` 패턴을 MP에 도입

3. **[Phase 3c] ADENA invalid 회귀 fix** (`app.js`)
   - 3a 부작용: validateROIs valid=false → 전체 OCR 호출 안 됨
   - 필수 ROI 검증에서 ADENA 제거 (mp/exp/level만 필수)
   - ADENA width<50 시 textROIs.adena=null + 30s throttled 안내

4. **[P0] Stability 디폴트 3** (`storage.js` + `app.js`)
   - 1회 misread 자동 흡수
   - getStabilityRequired 0~5 허용

5. **[P1] Confusion-aware verification** (`app.js`)
   - 픽셀 폰트 confusion: 0↔8, 5↔8, 6↔8, 4↔9, 7↔1, 9↔7
   - `isConfusionMisread(anchor, val)` helper — 1자리 차이 + pair 매칭
   - MP voting + ADENA voting에 적용 (정상 변화 +1 stability)

6. **[Phase 4a] MP textROI 폭 게이지 종속 해제** (`roi-detector.js`)
   - mpBar.width(파란 채워진 부분)에 종속되면 MP 적을수록 텍스트 일부만 캡처
   - max(mpBar.width, hpBar?.width, 200) — HP/MP 게이지 폭 동일 가정

7. **[Phase 5] LEVEL 다수결 미달 fallback** (`app.js`)
   - LEVEL ROI(61×19) 작아 canvas ensemble 다수결 1/1 영원 미달
   - OCR이 정확히 29 읽어도 anchor 갱신 안 됨, 이전 misread "5" 굳음
   - 다수결 미달이어도 7회(정상)/10회(점프) 일관 시 fallback 통과
   - `🔓 LEVEL anchor 자동 복구` 메시지로 사용자에게 노출

**검증 (사용자 진단 7라운드 점진 개선)**:
- 08-07-39 (수동, mpMax=197 잘못) → ADENA 12px root cause 발견
- 08-17-51 (자동 detect 후 수동 전환) → MP paddle 정확/tess 깨짐
- 11-46-28 (Phase 3a 부작용) → 자동 OCR 전체 막힘 회귀
- 12-00-18 (Phase 3b/3c 적용) → MP anchor 197→242 자동 복구 ✅
- 12-09-05 (사용자 게임화면 + ADENA "14") → MP textROI 게이지 종속 발견
- 12-18-16 (Phase 4a 적용 후) → MP "32/242 ×5" 완벽 동작 ✅
- 12-47-24 (ADENA 정상 + LEVEL anchor 굳음) → Phase 5 LEVEL fallback 추가

**남은 한계 (P2 traineddata 재학습으로 해결 — `.omc/plans/v1.5.0-training-data-recollection.md`)**:
- 던전 알림 등 일시 텍스트 misread (Phase 5 fallback strict로 차단되지만 본질적 해결 X)
- paddle/tess 픽셀 폰트 사전훈련 분포 한계 (0/8/5/6 confusion)

### v1.4.1 (2026-05-06) — 자동 모드 root cause 7종 + LV 텍스트 직접 검출 ⭐⭐⭐
사용자 진단 13개 캡처 + 픽셀 레벨 분석으로 v1.4.0 자동 모드의 모든 잔여 root cause 해결.
**핵심 발견**: EXP %가 0% 가까우면(레벨업 직후) 진행 막대가 거의 비어 자동 탐지 깨짐 → LV 텍스트 자체를 직접 검출하는 방식으로 막대 의존도 제거.

수정 commit 시간순:
1. `1cb81bd` setupCaptureStreams gameRegion 누락 — 자동 모드에서 캡처 스트림 미생성으로 ROI 캡처 무한 실패. 모드별 분기로 자동 모드 → gameRegion만, 수동 모드 → 5개 영역.
2. `af05598` multi-candidate combinatorial search — HP/MP/EXP/ADENA 각 top-K 후보 간 layout 검증 통과 tuple 채택. 파티 HP 바, 채팅 빨간 텍스트 등 비표준 UI 회피.
3. `4707fff` EXP-above-HP layout 지원 — 사용자 캐릭터 정보 패널은 EXP가 HP 위에 있는 경우 있음. 절대 가정 → 인접도 검증으로 완화.
4. `53d0155` EXP/Level ROI 막대 위/아래 자동 + ADENA stale override 자동 해제 — 막대 height < 12px 시 inkScore 비교, ADENA sourceId stale 시 manual override 자동 무효화.
5. `e2129ff` EXP/Level이 HP 바와 겹치는 후보 자동 제외 — `overlapsHp` 헬퍼로 HP 텍스트 오인 차단.
6. `7fc2fe4` EXP/Level 다중 후보 inkScore 검색 — 막대 위 -3*TEXT_H ~ 아래 +4*TEXT_H 범위 후보 + HP 겹침 제외 + 최고 점수 채택.
7. **`503795d` (핵심) `findLevelTextLines` — 좌측 미니 패널 LV 텍스트 직접 검출**. 흰/베이지 픽셀(lum>180, sat<0.35) 가로 라인 + cluster 분리. Level=좌측 cluster, EXP=우측 cluster. EXP %와 무관하게 작동.

**검증** (사용자 진단 14-36-39):
- ✅ MP 0/242 ×13
- ✅ EXP 16.8151% · 90%
- ✅ Level Lv.7 (3/3 일치) ×12
- ⚠ ADENA template matching 진행 중 (점진 안정)

**진단 도구 추가**:
- `scripts/analyze-game-capture.js` — pngjs 픽셀 분석으로 HP/MP/EXP/ADENA 후보 시각화
- `scripts/test-detect.js` — detectGameUI 결과 빠른 검증
- `scripts/test-text-rois.js` — deriveTextROIs ROI 위치 검증 + ink density 비교
- `scripts/find-text-around-expbar.js` — expBar 주변 ink/white pixel 분포 분석
- `scripts/find-exp-on-left.js` — 좌측 미니 패널 색상 blob 검출
- `scripts/analyze-lv-text.js` — LV 텍스트 라인 + 가로 cluster 픽셀 분석
- `scripts/crop-roi.js` — game-region에서 임의 영역 잘라서 PNG 저장 (시각 확인용)

**낚시 함정 (이번 세션 학습)**:
- 진행 막대 의존 SPEC는 막대가 비어있으면(EXP=0%) 다른 픽셀을 오인. 텍스트 자체 검출이 더 안정.
- inkScore 단독 비교는 채팅창 텍스트나 HP 바 자체를 EXP로 오인할 수 있음. **HP 겹침 제외 + 영역 위치 검증 필수**.
- `cachedROIs` 5분 TTL 때문에 새 빌드 직후엔 사용자가 `🔄 재탐지` 버튼 눌러야 새 코드 적용됨.

### v1.4.0+ post-release fixes (2026-05-05) — 사용자 게임 실측 기반 root cause 5종 수정 ⭐⭐
실제 사용자 환경 테스트 중 발견된 5가지 root cause 순차 수정 (모두 동일 v1.4.0 빌드 내):
1. SPEC rev1 임계값 완화 (`2dc5422`) — 사용자 화면 hue 12/248/28 등 SPEC 범위 밖
2. **`preprocessCanvas` 그레이스케일 변환** (`f79f8e5`) — 가장 치명적. captureRegionToCanvas('soft')도 색 사라짐 → captureRegionToRawCanvas로 전환
3. `list-displays` sourceId 인덱스 fallback 버그 (`f79f8e5`) — start-region-select와 동일한 3-tier 매칭 적용
4. `captureRegionToRawCanvas`의 autoTrim이 ADENA 잘라먹음 (`203ff3a`) — opts.noTrim 추가
5. ADENA 텍스트 ROI 우측 클램프 (`b20407a`) — width = max(90, iconWidth*2.5), 우측 overflow 허용
**추가 기능**:
- ADENA 수동 override (`588adb2`) — `📌 ADENA 직접 지정` 버튼 + `_adenaManualOverride` 플래그
- ADENA 가로/세로 레이아웃 자동 감지 (`a638042`, Phase 1) — `inkScore` 헬퍼로 두 후보 영역 텍스트 밀도 비교
- 진단 스냅샷 자동 저장 (`b6977e2`) — game-region-raw.png + overlay.png
**중요 발견**: Lineage Classic 표준 UI는 [icon] / [digits] **세로** 레이아웃 (기존 가로 default가 잘못된 가정).
**낚시 함정**: `npm run dist`는 빌드 안 함 (ZIP만) → 코드 변경 후 `npm run build && npm run dist` 필수.

### v1.4.0 (2026-05-05) — 자동 ROI 탐지 + Phase A 안전망 통합 ⭐
- **자동 ROI 탐지 모듈 도입** (`src/js/roi-detector.js`, 499 LOC)
  - HSV 변환 + 4-connectivity Connected Component Labeling (Union-Find rank+path compression)
  - HP 바 (빨강) / MP 바 (파랑) / EXP 바 (오렌지) / ADENA 아이콘 (노랑) 4개 anchor 자동 탐지
  - Hue wrap-around (0/360 경계) atan2 원형 평균
  - Negative space validation (HP/MP 사이 황금 해골 프레임 검증 — false positive 차단)
  - 텍스트 ROI 도출 (mpText=막대 자체, expText=우측 절반, levelText=좌측, adenaText=아이콘 우측)
  - DOM 의존성 0, ImageData 입력만 — 단독 테스트 가능
- **자동 모드 통합** (`storage.js` + `app.js`)
  - `autoDetect.mode = 'manual'|'auto'` 토글, 기본 'manual' (기존 사용자 영향 0)
  - `ensureAutoModeROIs()` (app.js:4565) — gameRegion 캡처 → RoiDetector → textROIs 절대 좌표 변환 → autoDetect.{mp,exp,level,adena}Region 동적 할당
  - 캐시 정책: 300초 만료 + 5회 연속 OCR 실패 시 무효화 + 사용자 직접 편집 시 무효화
  - **기존 OCR 함수 무수정** — autoDetect.mpRegion 등 동적 갱신만으로 hybrid voting/stability/template matching 그대로 재사용
- **UI 모드 토글 + UX 개선** (index.html + neon.css + app.js)
  - 자동 모드 NEW 배지 (펄스 애니메이션) + 첫 진입 시 3단계 온보딩 모달
  - ROI 상태 패널 실시간 갱신 (HP/MP/EXP/ADENA + 캐시 잔여 시간)
  - ROI 오버레이 프리뷰 캔버스 (4개 anchor + 텍스트 ROI 시각화)
  - "🔄 재탐지" 버튼 — 캐시 즉시 무효화
  - 기존 ad-region-grid (4개 영역 버튼)는 ad-manual-section으로 wrap만 (자식 요소 무수정)
- **Phase A 안전망 통합 (수동 모드 사용자도 보호)**
  - **EXP 자릿수 mismatch 영원 폐기 → 20회 일관 검증 흡수** (`app.js:4276~`)
    - 사용자 진단 (2026-05-05T10-03-19): "88.3623"를 paddle "8.3628"/tess "3.2523" 1자리 misread → 영원 폐기 → anchor 영원 차단
    - 큰 점프와 동일 패턴: 같은 값 20회(약 20초) 일관 시에만 흡수, misread는 절대 20회 일관 X
  - **영역 height < 18px 경고** (`onPickRegion`) — EXP height=17px 글자 잘림 misread 차단
- **디버그 도구** (`src/debug/roi-debug.html`, 422 LOC)
  - 스탠드얼론 (CDN/npm 의존성 X), 드래그 드롭 + HSV 슬라이더 라이브 튜닝
- **친구 배포 ZIP 자동화** (`scripts/build-distribute.ps1` + `npm run dist`)
  - portable.exe + 사용설명서.md + 처음시작.txt + 변경내역.txt → `LineageMPTimer-v1.4.0.zip`
- **진단 리포트 확장**: `report.autoDetect`에 mode/gameRegion/cachedROIs/연속실패 카운터 포함
- **사용설명서.md v1.4.0 갱신**: 자동 모드 1분 셋업을 메인으로, 수동 모드는 fallback

### v1.3.21 (2026-05-05) — displayId 일치 검증 (멀티 모니터 anchor 오염 차단)
- **영역 지정 시 + 진단 리포트 시 displayId 일치 자동 검증**
  - 사용자 진단 (2026-05-04T16-41-16): EXP 영역만 displayId 다른 모니터에 cached → 26분간 사냥 후 anchor 17.99로 오염
  - 두 가지 모순 케이스 감지:
    1. **다른 displayLabel** → 진짜 다른 모니터 (강한 경고 + flashHint)
    2. **같은 displayLabel + 다른 displayId** → Windows monitor handle 변경 cached (정보 경고 + 재지정 권장)
- **검증 위치**:
  - 영역 지정 직후 (onPickRegion): flashHint + hybridLog
  - 진단 리포트 생성 시: `report.displayCheck` 필드에 status/detail/advice 자동 포함
- **v1.4.0 자동 탐지 SPEC 작성 시작** (별도 — 큰 영역 1개 → 시스템 자동 ROI 탐지)

### v1.3.20 (2026-05-05) — ADENA 휘도 white-extraction (paddle leading-digit 안정화)
- **ADENA에 휘도 mode white-extraction 캔버스 추가** (T=120 + raw pad:10)
  - 사용자 진단 (2026-05-04T16-09-12): paddle "1317" (4자리) vs tess "10317" (5자리) — paddle 앞 "1" 누락 빈발
  - 원인: paddle은 자연 이미지 학습 분포라 흰글자/베이지 글자에 약함, leading 글자 가장자리 손실
  - 해결: EXP에서 검증된 휘도 mode 도입 — 베이지 글자도 robust 추출
  - ADENA 캔버스 5종(pp + soft + otsu + raw + white) × PSM 3 = 최대 15 results

### v1.3.19 (2026-05-05) — 휘도 기반 추출 모드 (베이지 글자 대응)
- **applyWhiteExtraction에 `luminance` 옵션 추가** — `(R+G+B)/3 ≥ T`
  - 사용자 진단 (2026-05-04T15-34-02): "74.1354%"의 "74."가 T=110도 통과 못 함 → OCR ".1354"
  - **결정적 단서**: 사용자 게임 화면 분석 결과 EXP 글자가 **흰색이 아니라 베이지(R≈250, G≈230, B≈180)**
  - 기존 R/G/B 모두 ≥T 방식은 흰글자(R=G=B)에 최적, **베이지 + 진행 막대 합성 픽셀(R=180,G=160,B=100)에서 B 채널 fail**
  - 해결: 휘도 mode 도입. 같은 픽셀 휘도 평균 147 → T=140 통과, 막대 갈색(휘도≈87)은 여전히 차단
- **EXP 캔버스 ensemble 재구성** (T값 + mode 조합):
  - canvasWhite (T=140, R/G/B mode) — 흰글자 정밀 보호
  - canvasWhiteSoft (T=120, **휘도 mode**) — 베이지 글자 + 막대 채워진 부분 위
  - canvasWhiteDeep (T=70, **휘도 mode**) — 막대 진한 영역 위 매우 어두워진 글자
  - 캔버스 6종(pp + soft + raw + white140 + lum120 + lum70) × PSM 3 = 최대 18 results

### v1.3.18 (2026-05-05) — MP에 white-extraction 보강 (paddle misread 안정화)
- **MP에도 white-extraction 캔버스 추가** (T=140): EXP에서 효과 본 패턴 도입
  - 사용자 진단 (2026-05-04T15-26-05): MP "120/235"를 paddle이 "12072"로 misread → sanity 차단으로 voting 일관성 떨어짐
  - 원인: 영역 좌측 4~5 raw px artifact가 매 사이클 소프트/오츠 캔버스에서 AutoTrim 거부 (54~55% > 50% 임계값)
  - 해결: white-extraction은 AutoTrim 거치지 않고 raw 픽셀에서 흰 글자만 추출 → 좌측 회색 artifact 자동 검정 처리
  - MP 캔버스 4종(pp + soft + otsu + white) × PSM 2(7/13) = 최대 8 results

### v1.3.17 (2026-05-04) — White-extraction 듀얼 임계값 (어두운 글자 보호)
- **white-extraction 임계값 T=170 → T=140 + T=110 듀얼 캔버스**
  - 사용자 진단 (2026-05-04T15-18-24): T=170으로 우측 "1399"만 살고 좌측 "16."/"13."이 손실됨
  - 원인: 게임 글자가 진행 막대 위에서 빛 반사로 R/G/B≈130~150 회색조 → T=170에서 차단됨
  - 해결: T=140(기본) + T=110(관대 보조) 듀얼 → ensemble로 막대 위 어두운 글자도 살림
  - 캔버스 5종(pp + soft + raw + white140 + white110) × PSM 3 = 최대 15 results

### v1.3.16 (2026-05-04) — EXP white-extraction + 큰 점프 자동 흡수
- **EXP white-extraction 캔버스 추가** (4번째 캔버스): `applyWhiteExtraction(T=170)` + 수동 invert
  - 진행 막대가 채도 낮은 회색일 때 chromaMask가 작동 안 하는 케이스 대응
  - 사용자 진단 (2026-05-04T15-08-36): "72.5989" 좌측 막대 페이드 회색 → "72" 글자 OCR 누락
  - 채도 무관 R/G/B≥170만 흰 글자 → 수동 invert → 검은 글자 + 흰 배경 (가장 robust)
  - PSM 7/8/13 × 4 캔버스 = 최대 12 results
- **큰 점프(±5%p+) 영원 reject → 15회 일관 검증으로 완화**
  - v1.3.14 영원 reject 정책이 레벨업 후 트래커 미갱신 케이스(anchor=10% → 실제 72%)도 차단
  - 1초당 ~1회 OCR × 15회 = 15초 안정 일치 → 자동 anchor 갱신 (misread는 15초 일관 불가능)

### v1.3.15 (2026-05-04) — EXP OCR 강화 + ADENA template 로그 정리
- **EXP 다중 캔버스 도입** (ADENA 수준): pp + soft + raw(16x, pad 3) → PSM 7/8/13 × 3 = 최대 9 results
  - 7↔1 misread (70.9060→10.9060) 사용자 진단 리포트 대응 (`diagnostic/2026-05-04T14-41-58`)
  - 캔버스 다양성으로 agreement-misread 깨기 — 한 캔버스에서만 misread해도 다수결로 정정
- **EXP chroma mask 강화**: threshold 130→100 (ADENA 수준), maskColor=255 강제 → 진행 막대 색상 더 적극 제거, 검은 글자 보존
- **EXP paddle pad 2→3**: vertical 보강 ("7" 상단 가로획 손실 방지)
- **ADENA template 로그 throttle**: 동일 (template, OCR) 쌍은 30s 윈도우당 1회만 UI 로그 (매 사이클 도배 차단)
- **confusion pair 추가**: 3↔4, 5↔8 (ADENA template), 7→1 (EXP) — 학습 데이터 보강 우선순위

### v1.2.0-paddle (2026-05-03) — 게임 폰트 traineddata 통합
- **컴팩트 모드** (F3): 두 줄 트래커 (시작·EXP/H·ADENA/H + 레벨·EXP·아데나 NOW + 증가량)
- **ADENA OCR 강화**: per-digit voting (이중 캔버스 12x+16x), leading-digit-drop suffix-match, pad 4→10
- **자동 캡처 + 사후 라벨링 도구** (3단계 워크플로우): 게임 중엔 PNG만 자동 저장 → 종료 후 라벨링 패널에서 OCR 추천값 미리 채워진 상태로 Enter 연타로 정리
- **N-history dedup** (최근 10개 OCR 비교): 무의미 중복 80% 절약
- **게임 폰트 traineddata 학습**: 463개 라벨 → BCER 4.02% → 1.96% (52% 개선)
  - Worker init: `lang='eng'` → `'eng+lineage'`
  - `build/tessdata/lineage.traineddata` (11.7MB) 빌드 extraResources 자동 포함

### v1.1.0 (2026-04-25)
- 경험치 % 자동 포맷 디바운스 **사용자 설정화** (기본 700ms → 3000ms)
- 타이틀바 **버전 배지** 추가

### v1.0.0 (초기)
- MP 계산 엔진 + UI + 트래커 + 핫키 + 테마 + 프리셋

## 🎯 OCR 정확도 개선 합의 방향 (2026-05-02)

> 사용자 지시: "추후에는 개선이 안된다면 학습 시켜서 하는 방향으로 할게 기록 남겨줘"

- **휴리스틱 기반 1차 개선** → 안 되면 → **게임 폰트 전용 traineddata 학습**
- 동일 confusion pair가 휴리스틱 3회 패치 후에도 재발하면 학습 단계로 escalate
- 상세: `docs/OCR-FUTURE-PLAN.md`

### 알려진 confusion pair (학습 우선순위)
0↔8, 0↔5, 3↔9, **4↔9** (2026-05-02), 6↔8, 5↔7, 1·7 누락, **3↔4** (2026-05-04, ADENA template), **5↔8** (2026-05-04, ADENA template gap=0%), **7→1** (2026-05-04, EXP "70.9060"→"10.9060"), **4→5** (2026-05-05, EXP last digit "93.9614"→"93.9615" — anti-alias가 4 위쪽 닫힌 것처럼 만듦)

## 🛠️ 향후 개선 후보 (TODO)

- [ ] `build/icon.ico` 생성 (SVG → ICO 변환) → 앱 아이콘 커스텀화
- [ ] 완료 알림 반복 횟수 옵션 (자리 비웠을 때)
- [ ] 사운드 볼륨 슬라이더
- [ ] 버프 지속시간 카운트다운 표시 (파란물약 600s, 메디 640s)
- [ ] 위치별 버프 효과 재검증 (아가타/싱잉/히든밸리는 현재 제거됨, 사용자가 직접 입력으로 추가 가능)
- [ ] 자동 업데이트 (electron-updater)
- [ ] GitHub Release 업로드 / 배포 자동화
- [ ] 다국어 지원 (현재 한국어 고정)

## 🧪 테스트

- `npm test` → `test/engine.test.js` 실행 (assert 기반, 36 케이스)
- 주요 케이스: WIS별 회복량, 파란물약 보너스, 위치 보너스, 틱 주기, 복합 버프, 블록 상태, 커스텀 위치 보너스, 포맷팅, breakdown 일치성

## 🤖 WSL 학습 환경 (게임 폰트 traineddata)

### 환경 위치
| 항목 | 경로 |
|------|------|
| WSL 배포판 | Ubuntu (`wsl.exe -d Ubuntu -u root` 으로 root 접근) |
| 학습 데이터 (Windows) | `C:\Users\<user>\AppData\Roaming\LineageMPTimer\training-data\` |
| 학습 데이터 (WSL 복사본) | `/root/lineage-train/{mp,exp,level,adena}/` |
| tesstrain 워크스페이스 | `/root/tesstrain/` |
| Ground truth (학습용) | `/root/tesstrain/data/lineage-ground-truth/` |
| 학습 체크포인트 | `/root/tesstrain/data/lineage/checkpoints/` |
| 베이스 모델 (best) | `/root/tesstrain/tessdata_best/eng.traineddata` |
| 최종 결과물 | `/root/tesstrain/data/lineage.traineddata` (→ Windows `build/tessdata/`) |

### 설치된 패키지 (apt)
- `tesseract-ocr` (5.3.4) + `tesseract-ocr-eng` + `libtesseract-dev`
- `python3-pil`, `python3-pip`, `make`
- 학습 도구: `lstmtraining`, `combine_tessdata` (`/usr/bin/`에 설치됨)

### 재학습 방법 (정확도 향상 필요시)
```bash
# 1. 추가 데이터 라벨링 (앱에서 수집 → %APPDATA%/.../training-data/ 에 누적)
# 2. WSL에서 데이터 동기화
wsl.exe -d Ubuntu -u root -- bash //root/setup_data.sh   # ground-truth 폴더 갱신
# 3. 추가 학습 (체크포인트에서 이어 학습)
wsl.exe -d Ubuntu -u root -- bash -c "cd /root/tesstrain && make training MODEL_NAME=lineage START_MODEL=eng TESSDATA=/root/tesstrain/tessdata_best MAX_ITERATIONS=15000 PSM=7"
# 4. 결과 복사
wsl.exe -d Ubuntu -u root -- cp /root/tesstrain/data/lineage.traineddata /mnt/c/dev/lineage-mp-timer/build/tessdata/
# 5. 앱 재빌드
cd /c/dev/lineage-mp-timer && npm run build
```

### 학습 메트릭 추적
- BCER (Best Character Error Rate): 낮을수록 정확. 0.01 이하 권장.
- 첫 학습 (2026-05-03, 463 sample, 5000 iter): **BCER 1.96%**

상세: `docs/TRAINING-PIPELINE.md`

## 🔁 세션 재개 가이드

새 세션에서 추가 작업 요청 시:
1. `cd C:\dev\lineage-mp-timer`
2. `git log --oneline -10` 으로 최근 변경 확인 + `git status` 로 미커밋 변경 점검
3. **이 문서(`CLAUDE.md`)로 전체 구조 파악** + `docs/SESSION-HANDOFF-LATEST.md` (최근 세션 인수인계 ★)
4. **`.omc/plans/v1.4.0-auto-detection.md` SPEC 검토** (큰 영역 → 자동 ROI 탐지, planner 작성, 5 tasks ~600-800 LOC)
5. **`.omc/plans/open-questions.md`** 5개 결정 사항 — v1.4.0 구현 시작 전 답변 필수
6. **`docs/OCR-FUTURE-PLAN.md` 진행 history**로 OCR 작업 흐름 파악
7. 변경 후 **반드시**:
   - `npm test` (엔진 회귀, 현재 36/36 통과)
   - `node -c src/js/app.js` (문법 체크)
   - `npm run build` (사용자가 portable 실행 중이면 먼저 종료 요청)
8. 커밋 + (필요 시) 사용자 안내

### 🚨 다음 세션 우선 액션
- **사용자 보고 받기** — Phase 1 ADENA 자동 레이아웃 감지 결과:
  - 사용자가 `🔓 ADENA 수동 고정 해제` → `🔄 재탐지` → ADENA 자동 인식 성공 여부
  - 성공 → manual override 불필요, 모든 사용자에 적용 가능
  - 실패 → Phase 2 (다중 yellow blob best-fit) 검토
- **EXP 4→5 confusion 추적** — 같은 misread 3회 패치 후에도 재발하면 학습 단계 escalate
- **빌드 절차 명심**: `npm run build && npm run dist` (dist만 단독으로는 빌드 안 함!)
- **상세 인수인계**: `docs/SESSION-HANDOFF-LATEST.md` v9 참조

---

_Last updated: 2026-05-05 v9 · 작성: Claude (Anthropic) · v1.4.0 post-release root cause 5종 수정 + ADENA 자동 레이아웃 + 수동 override_
