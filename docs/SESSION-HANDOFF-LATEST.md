# 세션 인수인계 — 2026-05-05 v7 (v1.3.15 → v1.3.21 + v1.4.0 SPEC)

> **다음 세션에서 가장 먼저 읽어야 할 문서**
> 이번 세션에서 v1.3.15 → v1.3.21 (7개 빌드) + v1.4.0 자동 탐지 SPEC 완료.
> 사용자 진단 리포트 5회 분석으로 OCR/anchor 메커니즘 깊이 진화.

---

## ⚡ TL;DR — 30초 요약

**최신 빌드**: `dist/LineageMPTimer-1.3.21-portable.exe` (134 MB)

**핵심 진화** (v1.3.15 → v1.3.21):
1. EXP/MP/ADENA에 **다중 캔버스 ensemble** 도입 (최대 18 results 다수결)
2. **휘도 기반 white-extraction** 도입 — 게임 글자가 베이지(R≈250,G≈230,B≈180)인 점 발견 후 R/G/B mode → 휘도 mode로 진화
3. **큰 점프 자동 흡수** (15회 일관 검증) — 영원 reject(v1.3.14) 정책 완화
4. **displayId 일치 검증** — 멀티 모니터 anchor 오염 차단

**v1.4.0 SPEC 완료**: `.omc/plans/v1.4.0-auto-detection.md`
- 큰 영역 1개 → ROI 자동 탐지 (HSV color blob)
- 5 tasks, ~600-800 LOC, 점진적 마이그레이션 v1.4.0~v1.5.0

**🚨 사용자 즉시 액션 필요**:
- 진단 `2026-05-04T16-41-16`에서 **EXP anchor `expNow=17.9950`로 오염됨** (실제 화면 78.16%)
- 트래커 UI에서 `inExpNow`에 **"78.16" 직접 입력** 또는 **트래커 RESET**
- **EXP 영역 다시 지정** (MP/Level/ADENA와 같은 모니터 displayId로 통일)

---

## 📊 이번 세션 빌드 사이클 (7개)

| 버전 | 핵심 변경 | 진단 케이스 |
|------|----------|-----------|
| **v1.3.15** | EXP 다중 캔버스(pp+soft+raw) + ADENA template 로그 throttle | 14:41:58 — EXP "70" → "10" 7↔1 misread |
| **v1.3.16** | EXP white-extraction(T=170) + 큰 점프 15회 자동 흡수 | 15:08:36 — EXP "72.5989" 좌측 막대 회색 손실 |
| **v1.3.17** | EXP white 듀얼 임계값(T=140+T=110) | 15:18:24 — EXP "1399"만 살고 "16." 손실 |
| **v1.3.18** | MP에 white-extraction(T=140) 추가 | 15:26:05 — MP paddle "12072" misread 빈발 |
| **v1.3.19** | **휘도 mode 도입** (게임 글자 베이지 발견) — applyWhiteExtraction에 `luminance` 옵션 | 15:34:02 — "74.1354%" 좌측 누락 |
| **v1.3.20** | ADENA에 휘도 white-extraction(T=120) | 16:09:12 — paddle "1317" leading-digit drop |
| **v1.3.21** | displayId 일치 검증 (영역 지정 + 진단 리포트) | 16:41:16 — EXP만 displayId 다른 모니터로 anchor 17.99 오염 |

---

## 🧬 진화 추이 — 캔버스 ensemble

| 버전 | EXP 캔버스 | MP 캔버스 | ADENA 캔버스 |
|------|-----------|----------|-------------|
| v1.3.14 (이전) | pp 단일 (3 results) | pp+soft+otsu (6 results) | pp+soft+otsu+raw (12 results) |
| v1.3.15 | + raw → 9 results | (그대로) | (그대로) |
| v1.3.17 | + white140 + white110 → 15 results | (그대로) | (그대로) |
| v1.3.18 | (그대로) | + white140 → 8 results | (그대로) |
| **v1.3.19** | + white80 → 18 results, **휘도 mode 적용** | (R/G/B mode 유지) | (그대로) |
| **v1.3.20** | (그대로) | (그대로) | + 휘도 white120 → 15 results |
| v1.3.21 | (그대로) | (그대로) | (그대로) |

**현재 v1.3.21 캔버스 구성**:
- EXP: pp + soft + raw + **white140**(R/G/B) + **lum120**(휘도) + **lum70**(휘도) — 6종
- MP: pp + soft + otsu + **white140**(R/G/B) — 4종
- ADENA: pp + soft + otsu + raw + **lum120**(휘도) — 5종

---

## 🔬 핵심 알고리즘 — `applyWhiteExtraction(canvas, T, opts)`

`src/js/app.js:1958` 근처. v1.3.19에서 `opts.luminance` 옵션 추가.

```js
const useLuminance = !!(opts && opts.luminance);
for (let i = 0; i < d.length; i += 4) {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  const pass = useLuminance
    ? ((r + g + b) / 3 >= T)        // 휘도 mode (베이지 글자 대응)
    : (r >= T && g >= T && b >= T); // R/G/B mode (흰글자 정밀)
  // ...
}
```

**중요한 발견**: 게임 EXP/ADENA 글자가 흰색이 아니라 **베이지 (R≈250, G≈230, B≈180)**. 진행 막대 위에서 합성되어 (R≈180, G≈160, B≈100)으로 어두워지면 R/G/B mode T=110도 B 채널 fail. 휘도 평균 147 → T=140 통과 가능.

---

## 🚨 사용자 진단 리포트 분석 (5회)

| 시각 | 버전 | EXP 결과 | 핵심 발견 |
|------|------|---------|----------|
| 14:41:58 | v1.3.14 | "70" → "10" misread | 7↔1 confusion + 진행 막대 색상 |
| 15:08:36 | v1.3.15 | "72.5989" 좌측 누락 | 막대 회색 그라데이션 chromaMask 무시 |
| 15:18:24 | v1.3.16 | "1399"만 살아남음 | T=170 너무 엄격 (어두운 글자 손실) |
| 15:26:05 | v1.3.17 | "73.6618" 정상 ✅ | 듀얼 임계값 효과 |
| 15:34:02 | v1.3.18 | "1354"만 살아남음 | 막대 진한 영역 위 글자 (lum mode 필요) |
| 16:09:12 | v1.3.19 | "75.7665" 정상 ✅ | 휘도 mode 효과 명백 |
| 16:41:16 | v1.3.20 | OCR 정상, **anchor 17.99 오염** | EXP만 displayId 다른 모니터 |

---

## 🛠 v1.3.21 displayId 검증 메커니즘

`src/js/app.js`:
- **영역 지정 직후** (`onPickRegion`, line ~4988): flashHint + hybridLog 경고
- **진단 리포트 생성** (line ~5362): `report.displayCheck` 필드 자동 포함

**3가지 status**:
| status | 의미 | 권장 |
|--------|------|------|
| `ok` | 모든 영역 같은 모니터 | (정상) |
| `monitor_mismatch` | 다른 displayLabel | 강한 경고 — 영역 재지정 |
| `displayid_cached_mismatch` | 같은 라벨, 다른 ID | 정보 경고 — 같은 모니터 영역 재지정 권장 |

---

## 📋 v1.4.0 자동 탐지 SPEC

**파일**: `.omc/plans/v1.4.0-auto-detection.md` (planner 에이전트 작성)

**핵심 설계**:
1. **`roi-detector.js` 신규 모듈** — HSV color blob detection
   - HP 바 (빨강), MP 바 (파랑), EXP 바 (갈색), ADENA (노랑)
2. **2단계 파이프라인**: ROI 자동 탐지 → 기존 OCR 그대로 재사용
3. **기존 OCR 함수 무수정** — `autoDetect.mpRegion` 동적 갱신만
4. **자동/수동 모드 토글** (`autoDetect.mode = 'manual' | 'auto'`)
5. **점진적 마이그레이션** v1.4.0 → v1.4.2 → v1.4.3 → v1.5.0

**규모**: 5 tasks, 5 files (1 신규 + 4 수정), ~600-800 LOC

**Open Questions**: `.omc/plans/open-questions.md` (5개)

---

## 📦 git 상태 (미커밋)

```
M CLAUDE.md            ← v1.3.15 ~ v1.3.21 버전 히스토리 + confusion pair 추가
M package.json         ← 1.3.14 → 1.3.21
M src/js/app.js        ← 누적 코드 변경 (다중 캔버스, 휘도 mode, displayId 검증)
?? .omc/plans/         ← v1.4.0 SPEC + open-questions
```

**커밋 권장 시점**:
1. 사용자 v1.3.21 검증 완료 (진단 리포트로 displayCheck.status: "ok" 확인)
2. v1.4.0 Open Questions 답변 후 구현 시작 직전 (안전 커밋)

**커밋 메시지 안 (사용자 결정 후 진행)**:
```
fix: v1.3.15~v1.3.21 OCR 다중 캔버스 + 휘도 mode + displayId 검증

- v1.3.15~v1.3.18: 다중 캔버스 ensemble (EXP 18, MP 8, ADENA 12 results)
- v1.3.19: 휘도 mode (applyWhiteExtraction luminance opt) — 베이지 글자 대응
- v1.3.20: ADENA에 휘도 white-extraction
- v1.3.21: displayId 일치 검증 (영역 지정 + 진단 리포트)
- v1.4.0 자동 탐지 SPEC 작성 (.omc/plans/)
```

---

## 🚦 다음 세션 시작 가이드

### 1. 사용자 앱 상태 확인
- `dist/LineageMPTimer-1.3.21-portable.exe` 실행 상태?
- EXP anchor 회복 완료? (직접 입력 또는 RESET)
- EXP 영역 재지정 완료? (같은 모니터)

### 2. v1.3.21 검증 진단 리포트 받기
새 진단에서 확인:
- `report.displayCheck.status === "ok"` → displayId 일치 ✓
- `anchors.expNow` 정상 (10~99% 범위, 사냥 진행 시 점진 증가)
- hybridLog에 `⚠ 영역 모니터 불일치` 또는 `ℹ displayId cached 불일치` 메시지 없어야

### 3. v1.4.0 SPEC 검토 + 구현 의사 결정
- `.omc/plans/v1.4.0-auto-detection.md` 정독
- `.omc/plans/open-questions.md` 5개 질문 답변
- 구현 진행 시 task 1부터 순차 (또는 architect 에이전트 추가 검증)

### 4. 명령어 (예전과 동일)
```bash
cd C:\dev\lineage-mp-timer
git status                  # 미커밋 변경 확인
git log --oneline -10       # 최근 커밋
node -c src/js/app.js       # 문법 체크
npm test                    # 36 케이스 (현재 36/36 통과)
npm run build               # NSIS+portable (사용자 portable 종료 후)
```

### 5. 진단 데이터 위치
- `%APPDATA%/Roaming/LineageMPTimer/diagnostic/` (작은 폴더 다수, 정리 가능)
- `%APPDATA%/Roaming/LineageMPTimer/training-data/` (학습 자료 — **절대 삭제 금지**, 48 MB)

---

## 🧹 dist/ 정리 메모

현재 dist/ ~784 MB. 정리 가능:
- v1.3.18~v1.3.20 빌드 산출물 → 이미 삭제 완료
- v1.3.21 + win-unpacked 빌드 캐시
- 더 정리하려면: `dist/win-unpacked/` 삭제 (~127 MB 절약, 다음 빌드 시 재생성)

---

## 📚 참고 문서

- **이 문서 (SESSION-HANDOFF-LATEST.md)** — 세션 간 컨텍스트
- `CLAUDE.md` — 프로젝트 전체 구조 + 버전 히스토리 (v1.3.21까지 갱신됨)
- `docs/OCR-FUTURE-PLAN.md` — OCR 정확도 개선 history (학습 escalate 정책)
- `docs/TRAINING-PIPELINE.md` — WSL traineddata 학습 절차 (BCER 1.96%)
- `.omc/plans/v1.4.0-auto-detection.md` — 자동 탐지 SPEC ⭐
- `.omc/plans/open-questions.md` — v1.4.0 구현 시작 전 결정 사항 5개

---

## 🎯 핵심 통찰 (다음 세션이 알아야 할 것)

1. **게임 글자는 흰색이 아니라 베이지** — 휘도 mode가 R/G/B mode보다 robust
2. **다중 캔버스 ensemble이 진리** — 단일 캔버스는 항상 어떤 케이스에서 실패
3. **anchor 갱신 메커니즘은 양날의 검** — 큰 점프 자동 흡수가 misread도 흡수 가능 (v1.3.16 도입 시 trade-off)
4. **displayId가 silent failure의 주요 원인** — 멀티 모니터 환경에서 사용자가 인지 못 하는 사이 영역이 다른 모니터에 잡힘
5. **v1.4.0 자동 탐지가 모든 문제를 동시에 해결** — 사용성 + displayId + 영역 어긋남 + AutoTrim 거부 모두

---

_Last updated: 2026-05-05 02:10 · 작성: Claude (Anthropic) · 세션 11+ 시간 (v1.3.15 → v1.3.21 + v1.4.0 SPEC)_
