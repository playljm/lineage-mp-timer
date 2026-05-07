# 세션 인수인계 — 2026-05-08 v12 (v1.5.0 traineddata 재학습 — BCER 1.96% → 1.560%)

> **다음 세션에서 가장 먼저 읽어야 할 문서**
> P2 학습 데이터 재수집 + 자동 라벨링 + 재학습 + v1.5.0 release

---

## ⚡ TL;DR — 30초 요약

**현재 상태**: v1.5.0 빌드. baseline 463 → 신규 884 라벨로 재학습. **BCER 1.96% → 1.560% (0.4%p 개선)**.

**최신 빌드**: `dist/LineageMPTimer-1.5.0-portable.exe` + ZIP

**가장 결정적 진전**:
- 자동 캡처 1,368개 누적 (사용자 평소 사냥 + 라벨링 패널 미사용)
- 사용자가 라벨링을 위임 → AI가 ensemble OCR + voting 자동 처리
- WSL tesseract `lineage` 단독 모델 + 다중 PSM ensemble (3-PSM) + ocrSuggestion 4-way voting
- 합의율 31.7% → 421 신규 라벨 채택, 909 폐기

---

## 🔥 이번 세션 진행 (2026-05-07 22:00 ~ 2026-05-08 00:10)

### 1. Phase 0: 능력 검증 (15 sample)
- vision OCR vs ocrSuggestion 합의율: **47%** (catastrophic misread 다수 발견)
- 핵심 발견: ocrSuggestion 자체가 paddle/tess의 misread 포함 — 학습 라벨로 직접 사용 불가
- MP 80%, EXP 40%, ADENA 20% 합의율

### 2. Sanity reject (84개 → `_rejected/`)
- MP cur > max 또는 max ∉ {235, 242}: 35개
- EXP 정수부 ≥ 100 (자릿수 깨짐): 29개
- ADENA 1~2자리 (catastrophic): 20개

### 3. WSL tesseract ensemble OCR (1,308개 PNG)
- `lineage` 단독 모델 + PSM 7/8/13 = 3-PSM ensemble
- 핵심 발견: **eng 섞으면 결과 오염** → lineage 단독 + 다중 PSM이 가장 정확
- 처리 시간 약 7분 (3,924 OCR call)

### 4. 4-way voting + 자동 라벨링
- 4 source: ocrSuggestion + lineage psm7/8/13
- voting 규칙:
  - **unanimous_4** (4 일치) ✅
  - **consensus_3** (3 일치) ✅
  - **two_only_2** (2 valid 모두 일치) ✅
  - **majority_2_rejected** (4 valid 중 2 vs 2 split) ❌ — 학습 노이즈 위험
  - **split** (모두 다름) ❌
- 정규화 규칙:
  - MP: trim + `_` 제거 + sanity (X/Y, max ∈ {235, 242}, cur ≤ max)
  - EXP: `,` → `.`, trailing `.` 제거, sanity (정수부 0~99, X.YYYY)
  - ADENA: `|`/공백 split → 가장 긴 3~7자리 token
- 결과: **421 채택 / 909 폐기 (31.7% acceptance)**

### 5. WSL 학습 (846 라벨 활용, 30→830 corrupted .lstmf 제거)
- baseline 463 → **신규 884 라벨** (91% 증가)
- corrupted .lstmf 8개 (149 + 4 cycle 추가) 식별 → 본 폴더 + Windows에서 제거
- iterative training cycle 적용 (max 5 retries) — fail 자동 식별 + sed로 list.train/eval 정리
- 학습 시간: **90초** (체크포인트 이어 학습)
- 결과: **best BCER 1.560% (lineage_1.560_346_8600.checkpoint)**, 이전 baseline 1.96% 대비 0.4%p 개선

### 6. 빌드 + ZIP 배포
- version 1.4.1 → 1.5.0 bump
- build/tessdata/lineage.traineddata 갱신 (00:04 timestamp)
- npm run build (NSIS + portable)
- npm run dist (ZIP 패키징)

---

## 📊 학습 데이터 분포 (v1.5.0)

| Region | baseline | 신규 (v2 suffix) | 합계 | _rejected |
|---|---:|---:|---:|---:|
| MP | 111 | 183 | 294 (293 후 cleanup) | 35 sanity + ~120 voting |
| EXP | 203 | 114 | 317 | 29 sanity + 443 voting |
| ADENA | 107 | 124 | 231 (230 후 cleanup) | 20 sanity + 245 voting |
| LEVEL | 42 | 0 (제외) | 42 | (학습 미사용) |
| **합계** | **463** | **421** | **884** (mp+exp+adena = 842) | |

> ⚠ **LEVEL은 v1.5.0에서 제외**. 다양성 부족 (12개 unique 값) — v1.5.1에서 부캐 사냥으로 보강 후 재학습.

---

## 🛠 새 진단/처리 도구

`scripts/`:
- `wsl-tesseract-batch.sh` — WSL tesseract ensemble OCR batch (3 PSM × 1308 PNG)
- `wsl-tesseract-vote.js` — 4-way voting + 자동 라벨링 + fs 이동 (Node.js)
- `wsl-sync-groundtruth.sh` — Windows training-data → WSL ground-truth sync
- `wsl-train.sh` — 단순 학습 wrapper (10000 iter)
- `wsl-robust-train.sh` — sync + make lists + corrupted 자동 cleanup + iterative training
- `wsl-cleanup-and-resume.sh` — list.train/eval sed 정리 + 학습 재개

---

## 🚨 다음 세션 우선 액션

### Priority 1: 사용자 평가 (신규 빌드 검증)
- 사용자가 v1.5.0 portable 사용 후 진단 캡처 제출
- 이전 confusion pair (0↔8, 5↔8, 6↔8, 4↔9, 7↔1, 9↔7) 재발 빈도 측정
- 던전 알림 등 일시 텍스트 misread 차단 효과 확인
- 판정 기준: misread 빈도 baseline 대비 30%+ 감소

### Priority 2: LEVEL 다양성 보강 + v1.5.1
- 부캐 사냥으로 Lv.1, 5, 10, 15, 20, 30, 50, 70, 99 등 캡처
- 1주~1개월 후 LEVEL 100+ 라벨 확보
- v1.5.1 학습에 LEVEL 포함

### Priority 3: 자동 캡처 토글 진단 출력
- 사용자가 자동 캡처 ON/OFF 상태 인지 못함
- 진단 리포트에 자동 캡처 토글 + 누적 inventory 카운트 출력

### Priority 4: voting 휴리스틱 개선
- `majority_2_rejected` 케이스 — 50% disagreement 일부는 진실. vision verification queue으로 회수 가능
- `split` 케이스에서 시간순 단조성 (EXP) 적용 가능

---

## 📝 빌드/배포 절차 (변동 없음)

```bash
cd C:\dev\lineage-mp-timer
# 1. 사용자 portable 종료
# 2. 빌드
npm run build      # NSIS + portable
# 3. dist
npm run dist       # ZIP 패키징
# 4. 산출물:
#    dist/LineageMPTimer-1.5.0-portable.exe
#    dist/LineageMPTimer-v1.5.0.zip
```

⚠️ `npm run dist` 단독으로는 코드 변경 안 반영 (ZIP만 재패키징). 반드시 `npm run build` 먼저.

---

## 🎓 이번 세션 메타 교훈

1. **사용자 위임 시 끝까지 처리**: 사용자가 "끝까지 처리해줘" 하면 나에게 떠넘기지 말고 자동화 구현해야. 첫 시도에서 사용자에게 라벨링 패널 사용 권유 → 사용자 짜증. 두 번째 시도에서 WSL tesseract ensemble + voting으로 자동화 성공.

2. **`make lists` cache 함정**: Makefile target이 cache로 skip되면 list.train/eval 갱신 안 됨. 학습 fail 후 같은 fail file 그대로. 직접 sed로 list.train/eval 정리하고 file 제거해야.

3. **bash -c '...' single quote 안에서 변수 expansion**: 특정 환경에서 안 됨. script file로 작성해서 wsl bash로 실행이 가장 robust.

4. **MSYS path 변환 함정**: Git Bash가 `/root/...` 같은 unix path를 자동으로 `C:/Program Files/Git/root/...`로 변환. WSL 호출 시 `MSYS_NO_PATHCONV=1` 또는 `//root/...` 더블 슬래시 필수.

5. **ensemble OCR 효과**: 같은 모델 (paddle/tess) 다중 결과는 ensemble 효과 약함. **다른 모델 (tesseract lineage)** 추가가 결정적. eng는 픽셀 폰트에 약하므로 lineage 단독 + 다중 PSM이 베스트.

6. **체크포인트 이어 학습 vs 처음부터**: v1.4.x baseline 체크포인트 (BCER 1.96%) 이어 학습 → 90초만에 BCER 1.560% 도달. 처음부터는 1시간+ 걸림. 신규 데이터 추가 시 이어 학습이 압도적 효율.

7. **corrupted .lstmf 사전 검증 한계**: size threshold로는 못 잡힘 (header만 invalid한 경우). 학습 시도 → fail file 식별 → 제거 → 재시도 cycle이 가장 robust.

---

## 📂 생성된 plan/script 문서

```
.omc/plans/v1.4.2-auto-stabilization.md       — Phase 3 (3a/3b/3c)
.omc/plans/v1.4.3-confusion-defense.md        — P0 + P1 (이전 세션)
.omc/plans/v1.5.0-training-data-recollection.md — P2 학습 재수집 (이번 세션 실행)
scripts/wsl-tesseract-batch.sh                — ensemble OCR batch
scripts/wsl-tesseract-vote.js                 — 4-way voting + auto-labeling
scripts/wsl-sync-groundtruth.sh               — Windows → WSL sync
scripts/wsl-train.sh                          — 단순 학습 wrapper
scripts/wsl-robust-train.sh                   — robust train (make lists + corrupted cleanup)
scripts/wsl-cleanup-and-resume.sh             — list.train/eval sed + iterative training
```

---

_Last updated: 2026-05-08 v12 · Claude (Anthropic) · v1.5.0 traineddata 재학습 (BCER 1.96 → 1.560)_
