# 세션 인수인계 — 2026-05-05 v8 (v1.4.0 자동 모드 통합 완료)

> **다음 세션에서 가장 먼저 읽어야 할 문서**
> 이번 세션에서 v1.4.0 자동 ROI 탐지 + Phase A 안전망 + UX 개선 + 친구 배포 ZIP 자동화 완료.
> 사용자 자리 비움 + 자율 진행 모드 — 빌드만 사용자 액션 필요.

---

## ⚡ TL;DR — 30초 요약

**현재 상태**: v1.4.0 코드 작업 100% 완료, **빌드 대기 중** (사용자가 portable 실행 중이면 종료 후 빌드)

**다음 액션** (사용자 깨어났을 때):
```bash
cd C:\dev\lineage-mp-timer
npm test               # 36/36 통과 확인
npm run build          # NSIS + portable.exe 생성 (사용자 portable 종료 필수)
npm run dist           # 친구 배포 ZIP 생성 (LineageMPTimer-v1.4.0.zip)
```

**산출물**:
- `dist/LineageMPTimer-1.4.0-portable.exe` — 본인용 + 친구용
- `dist/LineageMPTimer-v1.4.0.zip` — 친구 배포 패키지 (포터블 + 사용설명서 + 처음시작 + 변경내역)

---

## 📦 v1.4.0 완료된 작업

### Phase A — 안전망 (수동 모드 사용자 보호)
- **EXP 자릿수 mismatch 영원 폐기 → 20회 일관 검증 흡수** (`app.js:4276~`)
  - 사용자 진단 (2026-05-05T10-03-19): "88.3623"를 paddle "8.3628"/tess "3.2523" 1자리 misread → 영원 차단됐던 anchor 자동 회복 가능
- **영역 height < 18px 경고** (onPickRegion) — EXP=17px misread 직접 원인이었음

### Phase B — 자동 ROI 탐지
- **B1**: `src/js/roi-detector.js` (499 LOC) — HSV CCL + 4 anchor 탐지 + Negative space validation
- **B1.5**: `src/debug/roi-debug.html` (422 LOC) — 스탠드얼론 디버그 페이지 (HSV 슬라이더 라이브 튜닝)
- **B2+B3**: `storage.js` mode/gameRegion/cachedROIs 필드 + `app.js` ensureAutoModeROIs() — 기존 OCR 함수 무수정 원칙
- **B4**: UI 모드 토글 + 자동 모드 섹션 + 온보딩 모달 + ROI 상태 패널 + 오버레이 프리뷰

### Phase E — 친구 배포 자동화
- `scripts/build-distribute.ps1` + `npm run dist`
- ZIP 내용: portable.exe + 사용설명서.md + 처음시작.txt + 변경내역.txt

### 문서
- `사용설명서.md` v1.4.0 갱신 (자동 모드 메인, 수동 모드 fallback)
- `CLAUDE.md` v1.4.0 entry + 다음 세션 가이드 갱신
- `.omc/plans/v1.4.0-auto-detection.md` rev1 보정 노트 (실제 스크린샷 분석 반영, OQ 5/5 답변)

---

## 🧬 SPEC 보정 핵심 (실제 게임 스크린샷 분석으로 정정한 5가지)

| # | 어제 SPEC 잘못 | 실제 화면 | 코드 반영 |
|---|---|---|---|
| 1 | HP 바 "중앙 상단" `y < 0.4` | **중앙 하단** y_rel > 0.65 | roi-detector.js findHpBar |
| 2 | EXP 바 hue 25-45 (갈색) | **오렌지** hue 15-25 | findExpBar |
| 3 | "MP = HP 바 옆" 단순 인접 | HP/MP 사이 황금 해골 프레임 | validateNegativeSpace 추가 |
| 4 | "MP 텍스트 = MP 바 위/옆" | 텍스트가 **MP 바 내부** 흰글자 | mpTextROI = mpBar 자체 |
| 5 | ADENA "우하단" 모호 | 인벤토리 슬롯 그리드 우측 끝 | x_rel > 0.85, y_rel > 0.92 |

---

## 📜 git 커밋 히스토리 (이번 세션, 5개)

```
d6aee49 feat(v1.4.0): Phase B4 UI 모드 토글 + UX 개선 + 사용설명서 갱신
d231c98 feat(v1.4.0): Phase B2+B3 자동 모드 통합 (storage + app.js mode 분기 + ROI 캐시)
685a23e feat(v1.4.0): Phase B1+B1.5 ROI 탐지 모듈 + 디버그 툴 + Phase E 인프라
f9358ba feat(v1.4.0): Phase A 안전망 + SPEC rev1 보정
219b8bd fix: v1.3.15~v1.3.21 OCR 다중 캔버스 + 휘도 mode + displayId 검증
```

브랜치: `paddle-ocr` (master 아님)

---

## 🔧 핵심 원칙 (다음 세션도 지킬 것)

1. **기존 OCR 함수(ocrMpRegion, ocrExpRegionHybrid, captureRegionToCanvas 등) 무수정** — 자동 모드는 autoDetect.{mp,exp,level,adena}Region 동적 갱신만으로 통합
2. **Manual 모드 v1.3.x와 100% 동일** — `mode==='auto'` 게이트로만 새 로직 진입
3. **자동 모드는 opt-in** — 기본 'manual', 사용자 명시적 토글 시에만 활성화
4. **각 phase 후 즉시 커밋** — 회귀 차단 + rollback 용이
5. **검증: node -c + npm test (36/36)**

---

## 🚦 빌드 단계 (사용자 액션 필요)

### 1. portable 종료 확인
- 실행 중인 `LineageMPTimer-*.exe` 종료 (덮어쓰기 락 방지)

### 2. 빌드
```bash
cd C:\dev\lineage-mp-timer
npm run build          # ~3-5분, NSIS Setup + portable.exe 생성
```

### 3. ZIP 패키지 (친구 배포용)
```bash
npm run dist           # ~30초, dist/LineageMPTimer-v1.4.0.zip 생성
```

### 4. 검증
- `dist/LineageMPTimer-1.4.0-portable.exe` 실행 → 자동 모드 토글 확인
- 게임 영역 1개 드래그 → ROI 상태 패널 4개 모두 ✅(초록) 확인
- 진단 리포트 생성 → `report.autoDetect.cachedROIs` 필드 존재 확인

---

## 🐛 사용자 케이스 회복 시나리오

### EXP anchor 88.36 자동 회복 (v1.4.0 Phase A 효과)
v1.3.21에서는 영원 폐기됐지만 v1.4.0부터:
- 사용자가 사냥 시작 → tess "8.3628"/paddle 같은 misread 20회 일관 시 → ⚠️ 자동 흡수 → anchor 갱신
- 또는 사용자가 직접 "88.36" 입력 → 즉시 anchor 회복

### EXP displayId mismatch (v1.4.0 자동 모드 사용 시 우회)
- 자동 모드는 게임 영역 1개만 → displayId 단일 → cached mismatch 자체 발생 X

---

## 🛠️ 향후 개선 후보 (v1.4.x)

- [ ] **v1.4.1**: ROI 미세 조정 UI (offset slider) — 탐지 약간 어긋날 때
- [ ] **v1.4.2**: Drift tracking — 게임 창 이동 자동 추적 (HP 바 주변 작은 영역 재탐지)
- [ ] **v1.4.3**: 게임 창 리사이즈 대응 (비율 기반 ROI 재계산)
- [ ] **v1.5.0**: Template matching 보강, 다른 클라이언트 버전 프로파일

---

## 📚 참고 문서

- **이 문서 (SESSION-HANDOFF-LATEST.md)** — 세션 간 컨텍스트
- `CLAUDE.md` — 프로젝트 전체 구조 + v1.4.0까지 버전 히스토리
- `사용설명서.md` — 사용자/친구용 (v1.4.0 자동 모드 메인)
- `docs/OCR-FUTURE-PLAN.md` — OCR 정확도 개선 history
- `docs/TRAINING-PIPELINE.md` — WSL traineddata 학습 절차 (BCER 1.96%)
- `.omc/plans/v1.4.0-auto-detection.md` — SPEC + rev1 보정 노트 ⭐
- `.omc/plans/open-questions.md` — v1.4.0 시작 전 결정 5개 (5/5 답변 완료)

---

## 🎯 핵심 통찰 (다음 세션이 알아야 할 것)

1. **SPEC을 그대로 믿지 말 것** — 어제 SPEC v1.4.0의 HP 위치 필터(`y<0.4`)는 잘못됐고, 실제 스크린샷 분석으로 5개 정정함. 새 기능 작업 시 실제 게임 화면 1장이 SPEC보다 가치 큼.
2. **기존 OCR 무수정 원칙이 통합 성공의 핵심** — autoDetect.mpRegion 등 동적 갱신만으로 hybrid voting/stability/template matching 그대로 재사용. 200~300줄 코드로 자동 모드 통합 가능했음.
3. **자릿수 영원 폐기는 항상 위험** — v1.3.x에서 잘 동작하던 정책이 사용자 케이스에서 anchor 영원 차단으로 작용. 큰 점프와 동일하게 N회 일관 검증으로 흡수가 정답.
4. **친구 배포 = UX 디자인** — 신규 사용자(친구)가 5분 안에 셋업 못 하면 안 씀. 자동 모드 + 1분 온보딩 + ZIP 패키지(처음시작.txt 포함)로 "압축 해제 → 실행 → 드래그 1번 → 끝".

---

_Last updated: 2026-05-05 v8 · 작성: Claude (Anthropic) · 자율 진행 모드 — v1.4.0 자동 모드 통합 + Phase A 안전망 + 친구 배포 ZIP 자동화 완료_
