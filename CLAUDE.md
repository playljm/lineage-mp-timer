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
| 프리셋 / 설정 / 마지막 입력값 / 트래커 / 핫키 | `localStorage` (key prefix `lmp.*`) |
| 창 위치·크기 | `%APPDATA%\Roaming\LineageMPTimer\window-bounds.json` |

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

## 🔁 세션 재개 가이드

새 세션에서 추가 작업 요청 시:
1. `cd C:\dev\lineage-mp-timer`
2. `git log --oneline -10` 으로 최근 변경 확인
3. 이 문서(`CLAUDE.md`)로 전체 구조 파악
4. 변경 후 **반드시**:
   - `npm test` (엔진 회귀)
   - `node -c src/js/app.js` (문법 체크)
   - `npm run build` (사용자가 앱 실행 중이면 먼저 종료 요청)
5. 커밋 + (필요 시) 사용자 안내

---

_Last updated: 2026-04-16 · 작성: Claude (Anthropic)_
