# Lineage MP Timer — Project Context (v3.0)

> Electron 기반 리니지 클래식 **MP 자연회복 완충 타이머 + EXP/레벨/아데나 세션 트래커**.
> 게임 화면을 인식해 MP/EXP/레벨/아데나를 읽고, MP 완충 예상 시각·EXP/h·아데나/h·레벨업 ETA를 계산. MP가 차면 토스트+사운드 알림.
>
> 새 세션은 이 문서 → `README.md`(사용자용 v3.0 개요) → `CHANGELOG.md` 순으로 읽으면 됨.
> v1.x~v2.x 상세 변경 이력은 `HISTORY.md` 참고 (이 문서에서 분리됨).

---

## 📍 위치 / 스택
- 루트: `C:\dev\lineage-mp-timer` (cloudflare 형제 레포의 서브모듈)
- Git: 로컬 + remote(playljm). 최신: `3a087dc feat(v3.0): TypeScript + electron-vite 전면 리뉴얼`
- 스택: **TypeScript + electron-vite** (Electron ^33, vite ^6, vitest ^3, tesseract.js ^7)
- 빌드 산출물: `out/`(번들) → `dist/`(exe, electron-builder)

## 🚀 명령어
```bash
npm install
npm run dev          # electron-vite 개발 실행 (HMR)
npm run typecheck    # tsc --noEmit (node + web 구성)
npm test             # vitest run (도메인 엔진/트래커 + OCR 정확도 벤치마크)
npm run test:ocr     # OCR 정확도 벤치마크만
npm run build        # out/ 로 번들 (exe 아님)
npm run dist         # build + electron-builder (NSIS + portable exe)
```
> `npm run build`는 번들만, exe는 `npm run dist`. 빌드 전 사용자가 portable exe 실행 중이면 종료 필요(덮어쓰기 락).

## 📁 파일 구조 (v3.0)
```
src/
  core/                 순수 로직 (DOM/Node/캔버스 무관, node+web 양쪽 컴파일)
    domain/             mp-engine · session-tracker · storage-schema
    ocr/                types · imaging · segmentation · template-matcher ·
                        bar-fill · parser · text-recognizer · recognizer ·
                        tracker · roi-detector · learn · (base-templates.json)
  main/                 Electron 메인 모듈: index · windows · capture · ipc ·
                        hotkeys · paths · training-store · cloud-write/login (async fs)
  preload/              타입 안전 contextBridge: index.ts (window.api), overlay.ts
  renderer/             브라우저 UI (vanilla TS + Vite): index.html, overlay.html
    src/state/          reactive store (단일 진실 소스, DOM-as-anchor 폐기)
    src/capture/        화면 캡처 → RgbaImage 브리지
    src/ocr/            검출 루프 (캡처 → 인식 → 추적기 거부권 → 스토어)
    src/timer/          mp-timer (완충 카운트다운, 세그먼트 재계산)
    src/ui/             theme.ts + 뷰(monitor/setup/settings/compact)
    src/styles/         design-system.css · app-shell.css (디자인 토큰)
  shared/ipc-contract.ts  IPC 채널 단일 소스
test/                   vitest (domain + ocr 정확도 벤치마크), fixtures/ocr/ 캡처 PNG
```
> v2.x 모놀리식(`electron/main.js`, `src/js/{engine,app,storage}.js`, 8268줄 `app.js`)은 **전부 제거됨**. 위 경로가 현재 진실.

## 📐 MP 회복 공식 (src/core/domain/mp-engine.ts — 게임 상수 v2.x와 동일)
| 요소 | 값 |
|---|---|
| 기본 틱 주기 | 정지 16s · 이동 32s · 전투 64s (`TICK_BASE 16` × 배수 1/2/4) |
| 블록 상태 | 배고픔/과중 → 회복 0 (`blocked`) |
| WIS 기본 회복량 | ≤14 → 1, 이후 `1 + floor((WIS-13)/2)` (15-16=2, 17-18=3, …) |
| 파란물약 | `+max(1, WIS-10)` MP/틱, 지속 600s |
| 메디테이션 | +5 MP/틱, 지속 640s, **정지 상태만** |
| 위치 보너스 | 여관 +2 · 던전(법사 30Q) -3 · 필드 0 · 직접입력(-20~+50) |
| 수정 지팡이 | +10 MP/틱 |
> 공식 출처 주석에는 아가타+2 / 싱잉·히든밸리 +3도 있으나, 현재 UI 위치 선택은 필드/여관/던전/직접입력만 노출(나머지는 직접입력으로 대체).
> `calculateFullMpTime`은 `blocked`/회복≤0 시 Infinity, 완충 시각은 자정 넘으면 `+1d` 표기.

## 🔍 OCR 인식 우선순위 체인 (v3.0 — 근본 재설계)
v2.x 간헐 오인식(0↔8, 4↔9, 6↔8)의 두 근본 원인(등폭 분할 / 16×24 다운스케일)을 제거.
1. **MP 바 픽셀 측정** (`bar-fill.ts`) — 게이지 채움 컬럼 직접 셈. OCR 불필요, ~100% 정확(100% 1회 보정 필요). MP 1순위.
2. **유저 디지트 템플릿** (`template-matcher.ts`) — 본인 게임 폰트 학습. 학습된 글자는 **절대 기본 템플릿으로 폴백 안 함**(v2.x "폴백 홀" 차단).
3. **기본 템플릿** (`base-templates.json`) — 번들 픽셀 폰트 부트스트랩.
4. **연결성분(CCL) 분할** (`segmentation.ts`) — 잉크 연결 구조로 글자 경계 검출(등폭 분할 폐기).
5. **베이지안 시간 추적기 거부권** (`tracker.ts`) — v2.x DRY-RUN → 실제 거부권 보유 권위자로 승격.
- 인식 코어는 캔버스/DOM/Node 무관 `RgbaImage` 파이프라인 → **게임 없이** 캡처 픽스처로 정확도 단위 테스트(`test/ocr/accuracy.test.ts`).
- EXP 소수 정규화: 끝의 `%`가 가짜 5번째 소수로 잡히던 문제 자동 보정.
- **Paddle/Tesseract 4-way voting은 은퇴**. tesseract.js는 보조 텍스트 인식(`text-recognizer.ts`)에만 잔존, 커스텀 `lineage.traineddata`는 **더 이상 번들하지 않음**(package.json은 `eng.traineddata*`만 포함).

## ⚙️ 런타임 아키텍처
- **단일 reactive store** (`renderer/src/state/store.ts`) — DOM-as-anchor 안티패턴 제거, 모든 상태의 단일 진실 소스.
- **타입 안전 IPC** (`shared/ipc-contract.ts`) — 채널 rename = 컴파일 에러. `window.api` 주요 메서드: `listDisplays`, `startRegionSelect`, `listWindows`, `resolveWindowSource`, `getResourcePaths`, `setAlwaysOnTop`, `minimizeWindow`/`hideWindow`/`closeWindow`, `toggleDevtools`, `setCompact`, `notifyComplete`, `setGlobalHotkeys`, `saveTrainingSample`/`savePendingSample`/`listPendingSamples`, `cloudLoginPopup`/`cloudWriteTraineddata`/`cloudRollbackTraineddata`, `saveDiagnosticReport`. 이벤트: `always-on-top-changed`, `hotkey`. 영역 선택 오버레이는 `window.overlayApi`.
- **세그먼트 재계산** (`timer/mp-timer.ts`) — 실행 중 버프/위치/상태 변경 시 누적 MP + 현재 구간 진행분으로 정확한 완충 시각 재산출. Pause/Resume/Reset 지원.
- **캡처 방식 2종** (`autoDetect.captureMode`): `screen`(모니터+수동 영역, 좌표는 디스플레이-로컬 물리px — 오버레이 `toDisplayRect`가 논리→물리 변환, `captureRegion`은 *재곱셈 없이* 1:1 크롭) / `window`(게임 창을 제목으로 캡처, 모니터 무관). 창 모드는 `detection.ts`가 매 시작 시 `resolveWindowSource(title)`로 휘발성 `window:HWND`를 재해결하고, `detectGameUiScaled`로 창 전체에서 ROI를 자동 도출해 **메모리 보관**(스토어 미오염). 검은 프레임/창 소실 시 self-heal 재탐색.
- **영역 직접 지정(ROI) 편집기** (창 모드, `views/setup.ts`): 창 스냅샷(`detection.captureWindowFrame` → `screen-capture.captureFullDataUrl`)을 네이티브 1:1로 띄워 마우스 드래그로 항목별 ROI를 지정. `autoDetect.windowRoi`(창-프레임 물리px) 오버라이드로 저장 → `ensureWindowRois`가 자동 검출보다 우선 적용(`forceRoiRefresh`로 즉시 반영). 자동 ROI가 빗나가는 클라이언트 대응.
- **수동 입력 잠금** (`tracker.ts` `manualLockMs`): `force`(수동 입력) 후 EXP/레벨/아데나는 10분간 OCR 무시(`user_locked`)로 입력값 고정. MP는 제외(bar-pixel 정확 + 계속 변함). 보정·학습 「인식:」 힌트는 **실제 사용값** 표시(거부/잠금 시 무시되는 OCR을 `(무시)`로 부가 노출).
- **전역 단축키 동기화**: main이 시작 시 `DEFAULT_HOTKEYS` 등록하므로, 렌더러가 부팅 시 저장된 enable/disable을 `setGlobalHotkeys`로 동기화(안 그러면 끈 단축키가 재시작 때 부활). 재등록은 main-side `dispatchHotkey`로 일원화(`windows.ts`).
- **폰트**: `Pretendard`(variable woff2) 번들(빌드 전용 devDependency — Vite가 `out/`에 인라인, exe 영향 +2MB). 폼 컨트롤 전역 테마(`.field` 밖 입력칸도 다크 테마, WCAG AAA).
- Electron main: `getResourcePaths`(`paths.ts`)가 packaged(`resourcesPath/tesseract`) vs dev(`node_modules` + `build/tessdata`) 레이아웃을 구분, 누락 시 null → 렌더러 CDN 폴백.

## ⌨️ 단축키
| 키 | 동작 | 범위 |
|---|---|---|
| Space | 타이머 시작/정지 | 창 내부 |
| R | 리셋 | 창 내부 |
| F1 | 항상 위 | 전역 |
| F2 | 창 숨기기 | 전역 |
| F3 | 컴팩트 모드 | 창 내부 |
> 전역 키는 `setGlobalHotkeys`로 재바인딩(`HotkeyMap`), `hotkey` 이벤트로 렌더러 전달.

## 🎨 UI/UX (v3.0)
- 4탭(개발자 콘솔 노출) → **3탭**: 모니터 / 설정·OCR / 환경설정.
- 디자인 토큰 시스템(`renderer/src/styles/design-system.css`, `app-shell.css`) — v2.x 미정의 변수 해결, 6색 테마(`ui/theme.ts`), 접근성(ARIA, `prefers-reduced-motion`), 테마 스크롤바.
- 카운트다운 히어로 중심 시각 계층, 진단은 숨김 드로어(`고급·진단` / DevTools `lmpLog`)로.

## 💾 데이터 저장 (userData = `%APPDATA%\LineageMPTimer\`)
| 데이터 | 위치 |
|---|---|
| 프리셋/설정/마지막 입력/트래커/핫키/ROI | `localStorage` (`lmp.*`), 스키마 버전 관리(`storage-schema.ts`) |
| 창 위치·크기 | `userData/window-bounds.json` (가장 가까운 모니터 workArea로 클램프) |
| 학습 데이터 | `userData/training-data/{mp,exp,level,adena}/<label>_<stamp>.{png,gt.txt}` |
| 자동 캡처 큐 | `userData/training-data/_pending/{region}/` |
| 클라우드 수신 traineddata | `userData/tessdata/` (write/rollback, atomic rename) |
| 진단 리포트 | `userData/diagnostic/<stamp>/` |

## ✅ 핵심 기능
WIS/버프/위치/상태 MP 회복 엔진 · 실시간 카운트다운+게이지 · 완료 토스트+사운드 · 세션 트래커(레벨/경험치/아데나 + 시간당 효율) · OCR 자동 인식(바 픽셀+유저 템플릿+CCL+베이지안) · 글로벌/창 단축키 · 6색 테마 · 프리셋 · 창 복원 · 항상 위/트레이 · Pause/Resume · 목표 MP% 알림 · 컴팩트 HUD · 선택적 클라우드 sync.

## 🧪 테스트 / 타입체크
- `npm test` → vitest (`test/` 8개 파일). 핵심: `test/domain/{mp-engine,session-tracker}.test.ts`(엔진 회귀, v2.x 케이스 그대로 이식), `test/ocr/{accuracy,bar-fill,parser,tracker}.test.ts`(정확도 벤치마크는 `test/fixtures/ocr/` 캡처 PNG).
- `npm run typecheck` → `tsconfig.node.json` + `tsconfig.web.json` (코어는 양쪽에서 컴파일).
- 변경 후 권장: `npm test` + `npm run typecheck` + (배포 시) `npm run dist`.

## 🤖 게임 폰트 재학습 (보조)
WSL tesstrain 파이프라인 잔존(`scripts/wsl-*.sh`, 상세 `docs/TRAINING-PIPELINE.md`). 단 v3.0은 바 픽셀+유저 템플릿이 1순위라 커스텀 traineddata 의존도가 낮아졌고, 현재 빌드는 커스텀 traineddata를 번들하지 않음. 정확도 escalation 정책·confusion pair 이력은 `docs/OCR-FUTURE-PLAN.md` 참고.

## 🔁 세션 재개 체크리스트
1. `cd C:\dev\lineage-mp-timer` → `git log --oneline -10` + `git status`
2. 이 문서 + `README.md`(v3.0) + `CHANGELOG.md`로 현재 구조 파악
3. 코어 로직은 `src/core/`, UI는 `src/renderer/src/`, IPC는 `src/shared/ipc-contract.ts`부터
4. 변경 후 `npm test` + `npm run typecheck`, 배포면 `npm run dist`(사용자 portable 종료 먼저)
5. v1.x~v2.x 상세 이력이 필요하면 `HISTORY.md` (이 문서에서 분리)

## 🛠️ 향후 후보 (TODO)
`build/icon.ico` 커스텀 · 완료 알림 반복 옵션 · 사운드 볼륨 슬라이더 · 버프 지속시간 카운트다운 · 자동 업데이트(electron-updater) · GitHub Release 배포 자동화 · 다국어.

---
_v3.0 (2026-06-05) 기준. 상세 변경 이력: `HISTORY.md` / `CHANGELOG.md`._
