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
