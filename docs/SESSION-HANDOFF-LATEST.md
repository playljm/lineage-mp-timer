# 세션 인수인계 — 2026-05-05 v9 (v1.4.0 자동 탐지 root cause 5종 + ADENA 레이아웃 자동화)

> **다음 세션에서 가장 먼저 읽어야 할 문서**
> 이번 세션에서 v1.4.0 자동 탐지의 모든 root cause를 발견·수정. 사용자 게임에서 자동 모드 정상 동작 확인.

---

## ⚡ TL;DR — 30초 요약

**현재 상태**: v1.4.0 자동 모드가 사용자 게임에서 **정상 동작**. ADENA만 일시적으로 manual override 사용 중 (Phase 1 자동 레이아웃 감지가 적용된 새 빌드에서는 자동 동작 가능).

**최신 빌드**: `dist/LineageMPTimer-1.4.0-portable.exe` + `dist/LineageMPTimer-v1.4.0.zip` (a638042 시점)

**남은 사소 이슈**:
- EXP "93.9614" → "93.9615" 1자릿수 misread (`4→5` confusion). 사용자 평가 "이정도는 괜찮다" — escalation tracking에 등록.

---

## 🔥 이번 세션 발견·수정한 root cause 5종

진단 시간 순으로:

### 1. SPEC rev1 임계값과 실제 게임 화면 불일치 (`2dc5422`)
- HP hue 355→350-20, MP hue 200-270 sat>10%, EXP hue 12-38, ADENA yRel>0.80
- 검증: Node + pngjs 객관 검증 (scripts/test-roi-detection.js)

### 2. **`preprocessCanvas` 그레이스케일 변환 (가장 치명적)** (`f79f8e5`)
- `captureRegionToCanvas('soft', ...)` mode 무관하게 항상 그레이스케일로 변환
- RoiDetector가 HSV 분석 시 saturation=0 → 모든 blob 미탐지
- 수정: `captureRegionToRawCanvas(upscale=1)` 사용으로 RAW RGB 보존

### 3. `list-displays` sourceId 매핑 버그 (`f79f8e5`)
- `screen.getAllDisplays()` vs `desktopCapturer.getSources()` 순서 다를 수 있음
- 인덱스 fallback만 사용 → 듀얼 모니터에서 잘못된 monitor 캡처
- 수정: `start-region-select`와 동일한 3-tier 매칭 (display_id → 해상도 → 인덱스)

### 4. `captureRegionToRawCanvas`도 마지막에 `autoTrimEdgeArtifacts` 호출 (`203ff3a`)
- gameRegion 우측 12~18px를 "artifact"로 오인 잘라냄 → ADENA 아이콘 누락
- 수정: `opts.noTrim` 추가, ensureAutoModeROIs에서 noTrim:true 전달

### 5. ADENA 텍스트 ROI 우측 클램프 (`b20407a`)
- `frameW * 0.06` 너비를 우측 경계 클램프해서 16px만 남음
- 수정: width = max(90, iconWidth*2.5), ADENA만 우측 overflow 허용

---

## 🆕 이번 세션 추가 기능

### A. ADENA 수동 override (`588adb2`)
- 자동 모드 UI에 `📌 ADENA 직접 지정` 버튼 추가
- `autoDetect._adenaManualOverride` 플래그로 자동 탐지 무시
- 토글: 다시 누르면 `🔓 ADENA 수동 고정 해제` → 자동 복귀

### B. ADENA 가로/세로 레이아웃 자동 감지 (`a638042`, Phase 1)
- `inkScore` 헬퍼 — 픽셀 단위 휘도 gradient 비율 측정
- icon 우측 / 하단 두 후보 영역의 텍스트 밀도 비교
- below > right × 1.3 → 세로 레이아웃 채택
- **발견**: Lineage Classic 표준 UI는 [icon] / [digits] 세로 레이아웃 (기존 가로 default가 잘못된 가정이었음)

### C. 진단 스냅샷 자동 저장 (`b6977e2`)
- 자동 탐지 첫 성공 시 `game-region-raw.png` + `game-region-overlay.png` (4 anchor + 4 text ROI 시각화) 저장
- 첫 실패 시 `game-region-capture.png` 저장 (디버깅 용)
- 사용자가 anchor 위치를 직접 확인 가능

---

## 📊 사용자 환경 (참고용)

- 모니터: LG ULTRAGEAR (2560×1440 추정)
- gameRegion: (1275, 428, 1284, 964)
- displayId: 68531662 (gameRegion) vs 3029396359 (legacy manual ROIs) — Windows monitor handle 변경 cached
- ADENA UI 레이아웃: **세로** (icon 아래 digits, 인벤토리 스타일)
- ADENA 위치: gameRegion (1216, 882, 51, 14) — auto-detected adenaIcon (1221, 853, 41, 33) 바로 아래

---

## 🎯 다음 세션 우선 액션

### 사용자가 새 빌드 테스트 결과 보고 시:
1. **ADENA 수동 override 해제**: 사용자가 `🔓 ADENA 수동 고정 해제` 클릭
2. **재탐지**: `🔄 재탐지` 버튼 → Phase 1 알고리즘이 세로 레이아웃 자동 감지하는지 확인
3. **성공 케이스**: ADENA OCR 정상 인식. 이후 manual override 불필요.
4. **실패 케이스**: Phase 2 (다중 yellow blob best-fit) 진행 검토

### 알려진 이슈 / TODO
- **EXP 4→5 confusion**: 사용자 진단 (2026-05-05T13-39-30) "93.9614"→"93.9615". 같은 패턴 3회 패치 후에도 재발하면 `4→5` 학습 데이터 추가 후 traineddata 재학습.
- **Phase 2 ADENA**: 다중 yellow blob 후보 + nearby digit cluster 점수화 (다른 사용자 케이스 발견 시 진행)
- **Phase 3 ADENA**: 사용자 manual override 위치를 hint로 영구 저장 → 자동 재탐지 시 hint 근처 blob에 가산점

---

## ⚙️ 빌드 / 배포 절차 (다음 세션 주의사항)

**필수 순서** (꼭 두 단계 모두 실행):
```bash
npm run build    # electron-builder로 portable.exe 생성 (사용자 portable 종료 필수)
npm run dist     # ZIP 패키징 (build 결과물 기반, 자체로는 빌드 안 함)
```

**낚시 함정** (이번 세션에서 30분 낭비):
- `npm run dist`는 **빌드를 하지 않음** — 기존 portable.exe를 ZIP으로 묶기만 함
- 코드 변경 후 dist만 실행 → OLD 코드의 portable이 그대로 ZIP에 들어감
- 반드시 `npm run build && npm run dist` 순서

**인수인계 메모리**: `~/.claude/projects/C--dev/memory/lineage-mp-timer-build.md`에 기록됨

---

## 🧪 검증 인프라

### `scripts/test-roi-detection.js`
- PNG 파일 → RoiDetector.detectGameUI 호출 → 결과 출력
- 임계값 완화 진단 모드 — HP/MP/EXP/ADENA 각 색상별 blob 후보 확인
- 사용법: `node scripts/test-roi-detection.js [path-to-screenshot.png]`
- pngjs devDependency 사용

### `scripts/test-mp-area.js`
- MP 영역 hue 히스토그램 분석 (dual-monitor에서 MP bar 위치 추정 등)

---

## 🔁 재개 가이드

새 세션에서:
1. `cd C:\dev\lineage-mp-timer`
2. `git log --oneline -15` — 최신 커밋 확인 (a638042가 최신이어야)
3. **이 문서 + `CLAUDE.md`** 읽기 (CLAUDE.md v1.4.0 entry + 빌드 가이드)
4. 사용자 보고 받으면 위 "다음 세션 우선 액션" 진행
5. 코드 변경 시:
   - `npm test` (36/36 통과)
   - `node -c src/js/app.js` (문법 체크)
   - `npm run build && npm run dist` (반드시 둘 다)
   - 사용자에게 portable 종료 안내

---

_Last updated: 2026-05-05 v9 · 작성: Claude (Anthropic) · ADENA 자동화 5단계 root cause 정리 + Phase 1 레이아웃 감지_
