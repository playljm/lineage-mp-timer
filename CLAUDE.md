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
0↔8, 0↔5, 3↔9, **4↔9** (2026-05-02), 6↔8, 5↔7, 1·7 누락, **3↔4** (2026-05-04, ADENA template), **5↔8** (2026-05-04, ADENA template gap=0%), **7→1** (2026-05-04, EXP "70.9060"→"10.9060")

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

### 🚨 미해결 이슈 (다음 세션 우선 처리)
- 사용자 anchor `expNow=17.99` 오염 — 직접 입력 또는 RESET 필요
- EXP 영역 displayId cached 불일치 — 같은 모니터로 재지정 권장
- v1.3.21 검증 진단 리포트 받기 (`displayCheck.status: "ok"` 확인)

---

_Last updated: 2026-05-05 v7 · 작성: Claude (Anthropic) · v1.3.15→v1.3.21 + v1.4.0 SPEC_
