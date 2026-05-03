# 세션 인수인계 — 2026-05-03

> 이 문서는 **다음 세션에서 작업을 이어받을 때 가장 먼저 읽어야 할** 인수인계 문서입니다.
> 이전 세션에서 진행된 모든 작업의 컨텍스트와 다음 단계가 정리되어 있습니다.

---

## 📋 이번 세션 요약

### 시작 상황
- v1.2.0-paddle 빌드 직전 상태
- 컴팩트 모드 일부 구현됨, ADENA OCR misread 다발
- 사용자 요청 흐름:
  1. 컴팩트 모드 + 트래커 행 통합 요청
  2. ADENA 4↔9, leading-digit-drop misread 보고 (수회)
  3. 사용자 지시: "개선이 안된다면 학습 시켜서 하는 방향으로 할게 기록 남겨줘"
  4. 휴리스틱 한계 도달 → "B로 가야해. A는 의미없어" (학습 기반 전환)
  5. "라벨링 작업 니가 작업해줘 claude code가 작업 가능한거 아니야?" → Claude가 직접 라벨링 수행
  6. "wsl 설치되어있어 진행해줘" → WSL Tesseract 학습 실행

### 종료 상황
- BCER 1.96% 달성한 `lineage.traineddata` 통합 완료
- 빌드 (127MB portable exe) 사용자 테스트 대기 중
- 모든 변경 단일 커밋 (`ec51acb`) — remote 미설정으로 push 보류

---

## ✅ 완료된 작업

### 1. 컴팩트 모드 (UI)
- F3 단축키 + 📦 버튼
- 두 줄 레이아웃:
  - Row 1: 🕐 시작 / 📈 EXP/H / 💰 ADENA/H
  - Row 2: ⚔️ Lv NOW + 증가량 / 📊 EXP NOW + 증가량 / 🪙 아데나 NOW + 증가량
- 창 크기 자동 조정: 560×190 (min 360×130)
- 파일: `src/index.html` (compact-view 섹션), `src/js/app.js` (`syncCompactView`), `electron/main.js` (`app:set-compact-mode` IPC), `src/styles/neon.css`

### 2. ADENA OCR 휴리스틱 강화 (ocrAdenaRegionTesseract)
- **이중 캔버스**: preprocessed 12x + raw 16x
- **PSM × 캔버스 = 6개 결과**
- **per-digit majority voting**: 자릿수 일치 결과끼리 위치별 majority
- **leading-digit-drop suffix-match**: 짧은 결과가 긴 결과의 suffix면 긴 쪽 채택
- **pad 4 → 10**: 영역 사방 확장 (글자 잘림 방지)
- 파일: `src/js/app.js` 라인 ~2144 부근

### 3. 자동 캡처 + 사후 라벨링 도구
- **단계 1 (사냥 중)**: "🎬 자동 캡처 시작" → 매 N초 PNG 저장 (라벨 없이)
- **단계 2 (사냥 후)**: "🏷️ 라벨링 시작" → OCR 추천값 미리 채워진 input으로 Enter 연타
- **단축키**: Enter (확정) / Tab (스킵) / Del (삭제) / Esc (종료)
- **일괄 처리**: 💨 같은 OCR 모두 확정 / 💢 모두 삭제
- **N-history dedup**: 최근 10개 OCR 추적, 중복 80% 절약
- IPC: `save-pending-sample`, `list-pending-samples`, `confirm-pending-sample`, `delete-pending-sample`, `clear-all-pending`
- 파일: `src/index.html` (training-section), `src/js/app.js` (training functions), `electron/main.js` (IPC handlers)

### 4. 게임 폰트 traineddata 학습
- 463개 라벨된 샘플 (사용자 일부 + Claude가 본 세션에서 라벨링)
- WSL Ubuntu + tesstrain Makefile + Tesseract LSTM fine-tuning
- 5000 iterations → **BCER 1.96%** (베이스 4.02% 대비 52% 개선)
- 결과: `build/tessdata/lineage.traineddata` (11.7MB)
- 통합: worker init `lang='eng+lineage'`

---

## 🚧 미완료 / 사용자 검증 필요

### 🧪 테스트 검증 (가장 중요)
새 portable exe로 다음 케이스 검증 필요:

1. **`LineageMPTimer-paddle-portable-1.2.0-paddle.exe` 실행** (127MB · 03:10 빌드)
2. **자동 감지 ON** 후 OCR 정확도 확인:
   - ADENA: 이전 misread 케이스 (49224, 49411, 42402 등) 정확히 인식?
   - EXP: 5↔8 confusion 해결?
   - MP: leading-digit-drop ("171/235", "187/235") 정확히 인식?
3. **F12 콘솔 확인**: `[Tesseract] loading language traineddata` 메시지에 `eng+lineage` 표시되는지

### 다음 작업 후보 (우선순위 순)
1. **사용자 테스트 결과 반영**:
   - 정확도 충분 → 휴리스틱 단순화 (per-digit voting, suffix-match 등 정리)
   - 정확도 부족 → 추가 데이터 수집 + 재학습
2. **Remote 설정 + push**: 현재 로컬 커밋만 (`ec51acb`). GitHub repo 만들면 `git remote add origin ... && git push -u origin paddle-ocr`
3. **버전 bump**: `package.json` 1.2.0-paddle → 1.3.0 또는 v2.0.0 (메이저 변경 폭 큼)
4. **CHANGELOG.md 작성** (현재 없음, 신규 파일 생성)

---

## 🗂️ 핵심 자산 위치

### Windows 측
| 자산 | 경로 |
|------|------|
| 프로젝트 루트 | `C:\dev\lineage-mp-timer\` |
| 빌드 산출물 | `dist/LineageMPTimer-paddle-portable-1.2.0-paddle.exe` |
| 학습 데이터 (영구) | `%APPDATA%\Roaming\LineageMPTimer\training-data\{mp,exp,level,adena}\` (463개) |
| 학습 데이터 (대기) | `%APPDATA%\Roaming\LineageMPTimer\training-data\_pending\` (현재 비어있음) |
| traineddata | `build\tessdata\lineage.traineddata` (11.7MB) |
| 베이스 traineddata | `build\tessdata\eng.traineddata.gz` (10.9MB) |

### WSL Ubuntu 측 (root)
| 자산 | 경로 | 크기 |
|------|------|------|
| 데이터 작업 폴더 | `/root/lineage-train/` | ~10MB |
| tesstrain 워크스페이스 | `/root/tesstrain/` | ~50MB |
| Ground truth (학습 입력) | `/root/tesstrain/data/lineage-ground-truth/` (463 PNG+gt.txt) | ~10MB |
| 베이스 모델 (best) | `/root/tesstrain/tessdata_best/eng.traineddata` | 16MB |
| **학습 체크포인트** | `/root/tesstrain/data/lineage/checkpoints/` (BCER별 보존) | ~30MB |
| 최종 결과물 | `/root/tesstrain/data/lineage.traineddata` | 11.7MB |
| 헬퍼 스크립트 | `/root/setup_data.sh`, `/root/gen_lstmf.sh`, `/root/run_train.sh` | - |

체크포인트 보존되어 있어 **이어 학습 가능** (`--continue_from data/lineage/checkpoints/lineage_checkpoint`).

---

## 📚 관련 문서

| 문서 | 내용 |
|------|------|
| `CLAUDE.md` | 프로젝트 전체 컨텍스트 (이번 세션 변경 반영됨) |
| `docs/OCR-FUTURE-PLAN.md` | OCR 정확도 개선 계획 + 진행 history (사용자 지시 기록) |
| `docs/TRAINING-PIPELINE.md` | WSL 학습 파이프라인 6단계 가이드 (이번 세션 신규) |
| `docs/SESSION-HANDOFF-LATEST.md` | 이 문서 — 최신 세션 인수인계 |

---

## ⚠️ 알려진 제약

### Git
- **Remote 미설정**: `git remote -v` 비어있음. push 하려면 GitHub repo 생성 후 추가 필요.
- **브랜치**: `paddle-ocr` (master 아님)

### WSL
- `wsl.exe -- bash` 실행 시 **shell 변수 escape 이슈** — `bash -c "..."` 형태로 변수 인용 시 wsl.exe가 변수를 빈 값으로 expand. 해결책: 스크립트 파일로 작성 후 `wsl.exe -d Ubuntu -u root -- bash //path/to/script.sh` 형태로 실행 (앞에 `//` 두 개 필요, Git Bash 경로 변환 회피).

### Tesseract.js v5
- `eng+lineage` lang 사용 시 두 traineddata 모두 로드 (CDN 또는 로컬 tessdata에서). 패키징 시 `build/tessdata/`에 둘 다 있어야 함.
- 첫 실행 시 traineddata 로드에 시간 소요 (~10초). `[Tesseract] loading language traineddata` 메시지 확인.

---

## 💬 사용자 컨텍스트 / 선호도

- 한국어 응답 선호
- 빠른 피드백 사이클 선호 (빌드 → 테스트 → 즉시 피드백)
- "개선이 안되면 학습으로" 지시 (휴리스틱 패치 3회 후 학습 단계 escalate trigger)
- ITEM DROPS 수동 입력보다 OCR 자동화 선호 ("A는 의미없어")
- 작업 진행 시 명확한 진행률 보고 선호 (예: "172/255 (67%)")

---

_생성일: 2026-05-03 · 작성: Claude (Anthropic) · 다음 세션이 이 문서를 가장 먼저 읽어야 함_
