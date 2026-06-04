# Lineage MP Timer v3.0

리니지 클래식용 **MP 자연회복 완충 타이머 + EXP/아데나 세션 트래커** Electron 앱.

게임 화면을 인식해 MP/EXP/레벨/아데나를 자동으로 읽고, MP 완충 예상 시각·EXP/h·아데나/h·레벨업 ETA를 계산합니다. MP가 차면 토스트 + 사운드로 알려줍니다.

> **v3.0 리뉴얼**: TypeScript + electron-vite로 전면 재작성. 문자 인식(OCR)을 근본부터 재설계하고, UI/UX를 3탭 구조로 정리했습니다.

---

## 무엇이 달라졌나 (v2 → v3)

### OCR(문자 인식) 근본 재설계
v2.x의 간헐적 오인식(`0↔8`, `4↔9`, `6↔8` …)은 두 가지 근본 원인이 있었습니다:
1. **등폭 글자 분할** — `글자폭 = 영역폭 / 글자수` 균등 분할. 픽셀 폰트는 monospace가 아니라 한 컬럼만 어긋나도 옆 글자 잉크가 섞여 들어감 (학습 시점에도 영구 오염).
2. **16×24 다운스케일** — 6/8, 4/9를 가르는 1px 획이 뭉개져 매칭 점수가 near-tie가 됨.

v3.0의 인식 우선순위 체인:
1. **MP 바 픽셀 측정** — 게이지의 채워진 컬럼 수를 직접 셈. OCR 불필요, ~100% 정확.
2. **유저 디지트 템플릿** — 본인 게임 폰트를 학습. 학습된 글자는 절대 기본 템플릿으로 폴백하지 않음(v2.x "폴백 홀" 차단).
3. **기본 템플릿(부트스트랩)** — 번들된 픽셀 폰트 템플릿.
4. **연결성분(CCL) 글자 분할** — 잉크의 실제 연결 구조로 글자 경계를 찾음(등폭 분할 폐기).
5. **베이지안 시간 추적기(거부권)** — v2.x에서 DRY-RUN(관찰만)이던 것을 실제 거부권을 가진 권위자로 승격.

### 검증 가능한 코어
인식 코어는 캔버스/DOM/Node에 의존하지 않는 순수 `RgbaImage` 파이프라인입니다. 덕분에 **게임 없이** 1,300여 장의 캡처 샘플에 대해 인식 정확도를 단위 테스트로 측정합니다(`test/ocr/accuracy.test.ts`).

### UI/UX
4탭(개발자 콘솔 노출) → **3탭**(모니터 / 설정·OCR / 환경설정). 디자인 토큰 시스템, 카운트다운 히어로 중심의 시각 계층, 진단 패널은 숨김 드로어로, 접근성(ARIA, `prefers-reduced-motion`) 보강.

---

## 아키텍처

```
src/
  core/            순수 로직 (DOM/Node/캔버스 무관, 양쪽 lib 설정에서 컴파일)
    domain/        mp-engine, session-tracker, storage-schema
    ocr/           types, imaging, segmentation, template-matcher, bar-fill,
                   parser, text-recognizer, recognizer, tracker, roi-detector
  main/            Electron 메인 (windows, capture, ipc, hotkeys, paths,
                   training-store, cloud-write/login) — async fs
  preload/         타입 안전 contextBridge (window.api / window.overlayApi)
  renderer/        브라우저 UI (vanilla TS + Vite)
    src/
      state/       reactive store (단일 진실 소스, DOM-as-anchor 폐기)
      capture/     화면 캡처 → RgbaImage 브리지
      ocr/         검출 루프 (캡처 → 인식 → 추적기 거부권 → 스토어)
      timer/       MP 완충 카운트다운
      ui/          디자인 토큰 + 뷰 (monitor / setup / settings / compact)
  shared/          IPC 계약
test/              vitest (엔진/트래커/저장/OCR 정확도 벤치마크)
```

## MP 회복 공식

- 기본 틱: 정지 16s / 이동 32s / 전투 64s
- WIS 기본 회복: ≤14 → 1, 이후 `1 + floor((WIS-13)/2)` (15–16=2, 17–18=3, …)
- 파란물약: `+max(1, WIS-10)`/틱 · 메디테이션: +5/틱(정지) · 여관 +2 / 던전 −3 · 수정 지팡이 +10/틱
- 배고픔/과중: 회복 불가

## 실행 / 빌드

```bash
npm install
npm run dev          # electron-vite 개발 실행 (HMR)
npm run typecheck    # tsc --noEmit (node + web 구성)
npm test             # vitest (엔진/트래커/OCR 정확도)
npm run build        # out/ 로 번들
npm run dist         # Windows NSIS + portable 빌드
```

## 단축키

| 키 | 동작 |
|---|---|
| `Space` | 타이머 시작/정지 |
| `R` | 리셋 |
| `F1` | 항상 위 (전역) |
| `F2` | 창 숨기기 (전역) |
| `F3` | 컴팩트 모드 |

## 라이선스

MIT
