/**
 * 프리셋 + 설정 + 트래커 + 핫키 + 아이템(사냥 획득) 저장 (localStorage)
 */
(function (global) {
  'use strict';

  const PRESET_KEY = 'lmp.presets.v1';
  const SETTINGS_KEY = 'lmp.settings.v1';
  const LAST_KEY = 'lmp.last.v1';
  const TRACKER_KEY = 'lmp.tracker.v1';
  const HOTKEY_KEY = 'lmp.hotkeys.v1';
  const ITEMS_KEY = 'lmp.items.v1';
  const AUTO_DETECT_KEY = 'lmp.autoDetect.v1';

  const DEFAULT_HOTKEYS = {
    alwaysOnTop: { accel: 'F1', enabled: true, scope: 'global', label: '항상 위' },
    toggleHide:  { accel: 'F2', enabled: true, scope: 'global', label: '창 숨기기' },
    startPause:  { accel: 'Space', enabled: true, scope: 'window', label: '타이머 시작/정지' },
    reset:       { accel: 'R', enabled: true, scope: 'window', label: '타이머 리셋' }
  };

  const DEFAULT_ITEMS = [
    { id: 'it-minil',    name: '미늘갑옷',       price: 10000, qty: 0 },
    { id: 'it-magic',    name: '마력의 지팡이',   price: 4500,  qty: 0 },
    { id: 'it-greataxe', name: '대형 도끼',       price: 6500,  qty: 0 },
    { id: 'it-bronze',   name: '청동판금갑옷',    price: 8000,  qty: 0 }
  ];

  function safeParse(raw, fallback) {
    try {
      const v = JSON.parse(raw);
      return v ?? fallback;
    } catch (_) { return fallback; }
  }

  // ===== Presets =====
  function loadPresets() { return safeParse(localStorage.getItem(PRESET_KEY), []); }
  function savePresets(list) {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); } catch (_) {}
  }
  function addPreset(preset) {
    const list = loadPresets();
    const idx = list.findIndex((p) => p.name === preset.name);
    if (idx >= 0) list[idx] = preset;
    else list.push(preset);
    savePresets(list);
    return list;
  }
  function removePreset(name) {
    const list = loadPresets().filter((p) => p.name !== name);
    savePresets(list);
    return list;
  }

  // ===== Settings =====
  function loadSettings() {
    return safeParse(localStorage.getItem(SETTINGS_KEY), {
      sound: true, toast: true, minimizeOnClose: false,
      alwaysOnTop: false, volume: 0.5, theme: 'green',
      expAutoFormatDelayMs: 3000,
      compactMode: false
    });
  }
  function saveSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
  }

  // ===== Last input =====
  function loadLast() { return safeParse(localStorage.getItem(LAST_KEY), null); }
  function saveLast(state) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(state)); } catch (_) {}
  }

  // ===== Session Tracker =====
  function loadTracker() {
    return safeParse(localStorage.getItem(TRACKER_KEY), {
      active: false, startedAt: null,
      start: { level: 1, exp: 0, adena: 0 },
      current: { level: 1, exp: 0, adena: 0 }
    });
  }
  function saveTracker(state) {
    try { localStorage.setItem(TRACKER_KEY, JSON.stringify(state)); } catch (_) {}
  }

  // ===== Hotkeys =====
  function loadHotkeys() {
    const stored = safeParse(localStorage.getItem(HOTKEY_KEY), null);
    const defaults = JSON.parse(JSON.stringify(DEFAULT_HOTKEYS));
    if (!stored) return defaults;
    for (const k of Object.keys(defaults)) {
      if (stored[k]) defaults[k] = { ...defaults[k], ...stored[k] };
    }
    return defaults;
  }
  function saveHotkeys(hotkeys) {
    try { localStorage.setItem(HOTKEY_KEY, JSON.stringify(hotkeys)); } catch (_) {}
  }
  function defaultHotkeys() { return JSON.parse(JSON.stringify(DEFAULT_HOTKEYS)); }

  // ===== Auto-detect (MP/EXP OCR 자동 감지) =====
  function loadAutoDetect() {
    const stored = safeParse(localStorage.getItem(AUTO_DETECT_KEY), null);
    const defaults = {
      enabled: false,
      sourceId: null,
      displayId: null,
      displayLabel: null,
      scaleFactor: 1,
      confidenceThreshold: 0,  // Tesseract.js v5는 confidence가 0으로 떨어지는 케이스 많음 → 결과 sanity check로 대체
      intervalMs: 1000,
      preprocess: true,        // 그레이스케일+threshold 전처리
      autoStart: false,        // 인식 후 타이머 자동 시작
      autoStartTracker: false, // 첫 경험치 인식 시 트래커 자동 시작 (시작값을 첫 인식값으로)
      stabilityRequired: 3,    // [v1.4.3] OCR 결과 안정성 — 디폴트 3 (5↔8/0↔8 단발 misread 흡수)
      ocrEngine: 'hybrid',     // 'tesseract' | 'paddle' | 'hybrid' — paddle MP 검출 실패(빈 결과) 보완 위해 hybrid 기본
      mpSingleNumber: true,    // MP 영역을 단일 숫자(cur)로만 OCR + max는 INPUTS의 사용자 입력값 사용
                               // — 슬래시/콜론/배너 텍스처 우회. 사용자가 MP 영역을 cur 숫자만 좁게 잡으면 LEVEL/ADENA처럼 안정.
      showPreview: true,       // 캡처된 이미지 미리보기
      mpRegion: null,          // { x, y, width, height, sourceId, displayId, displayLabel, scaleFactor }
      mpBarRegion: null,       // 블루 MP 바 영역 — 색칠 비율 × userMax = cur
      useMpBar: false,         // 기본 OFF — OCR이 더 안정적. 바 모드 사용하려면 사용자가 명시적으로 ON
      mpBarMaxX: 0,            // 100% 보정값 (cols, 0이면 미보정 — 영역 전체 width 사용)
      mpBarRefColor: null,     // 보정 시 fill 영역의 평균 RGB { r, g, b } — 색 매칭 기준
      expRegion: null,
      levelRegion: null,
      adenaRegion: null,
      levelOffset: 0,          // OCR 결과 보정값 (사용자 수정 시 자동 학습)
      // ===== v1.4.0 자동 ROI 탐지 =====
      mode: 'manual',          // 'manual' | 'auto' — 'auto' 시 gameRegion으로부터 ROI 자동 도출
      gameRegion: null,        // 게임 화면 전체 영역 { x, y, width, height, sourceId, displayId, displayLabel, scaleFactor }
      cachedROIs: null,        // Phase 1 결과 캐시 { anchors, textROIs, detectedAt, frameSize }
      roiCacheMaxAge: 300,     // 초 단위 — 캐시 강제 갱신 주기 (300s = 5분)
      roiFailThreshold: 5,     // OCR N회 연속 실패 시 캐시 무효화 → Phase 1 재실행
      roiOffsets: null         // 사용자 미세 조정용 오프셋 (advanced, v1.4.1+)
    };
    if (!stored) return defaults;
    // 마이그레이션: 이전 'region' → 'mpRegion'
    if (stored.region && !stored.mpRegion) {
      stored.mpRegion = stored.region;
      delete stored.region;
    }
    // 마이그레이션: 영역에 sourceId/displayId/scaleFactor 흡수
    const enrich = (r) => {
      if (!r) return r;
      if (!r.sourceId && stored.sourceId) {
        return {
          x: r.x, y: r.y, width: r.width, height: r.height,
          sourceId: stored.sourceId,
          displayId: stored.displayId,
          displayLabel: stored.displayLabel,
          scaleFactor: stored.scaleFactor || 1
        };
      }
      return r;
    };
    if (stored.mpRegion) stored.mpRegion = enrich(stored.mpRegion);
    if (stored.mpBarRegion) stored.mpBarRegion = enrich(stored.mpBarRegion);
    if (stored.expRegion) stored.expRegion = enrich(stored.expRegion);
    if (stored.levelRegion) stored.levelRegion = enrich(stored.levelRegion);
    if (stored.adenaRegion) stored.adenaRegion = enrich(stored.adenaRegion);
    // 마이그레이션: paddle 단독은 MP 영역(슬래시 + 컬러바 배경)에서 빈 결과 다발 → hybrid로 일괄 승격
    // 사용자가 의도적으로 tesseract 선택한 케이스는 보존
    if (stored.ocrEngine === 'paddle' && !stored._engineMigratedToHybrid) {
      stored.ocrEngine = 'hybrid';
      stored._engineMigratedToHybrid = true;
      console.log('[storage] ocrEngine paddle → hybrid 자동 마이그레이션 (MP 검출 실패 보완)');
    }
    // [v1.6.0] ADENA belowCand 알고리즘 변경 (좌측 -5→-15px, width 80→100px)
    //   사용자 진단 (2026-05-09T10-57-47): "78835" → ROI 캡처 "8835" 첫 자리 7 손실
    //   기존 캐시는 좌측 5px 시프트라 새 알고리즘 효과 못 봄 → 1회 자동 무효화 → 다음 사이클 재탐지
    if (stored.cachedROIs && !stored._roiInvalidatedFor160) {
      stored.cachedROIs = null;
      stored._roiInvalidatedFor160 = true;
      console.log('[storage] v1.6.0: cachedROIs 1회 자동 무효화 (ADENA ROI 알고리즘 개선) — 다음 사이클 재탐지');
    }
    // [v1.6.2] ADENA belowCand x -15→-20, y/height 미세 조정 (사용자 진단 2026-05-09T11-42-02)
    if (stored.cachedROIs && !stored._roiInvalidatedFor162) {
      stored.cachedROIs = null;
      stored._roiInvalidatedFor162 = true;
      console.log('[storage] v1.6.2: cachedROIs 1회 자동 무효화 (ADENA 좌측 -20 시프트 + height 축소) — 다음 사이클 재탐지');
    }
    // [v1.6.3] ADENA belowCand y/height 재조정 (윗쪽 잘림 fix, 사용자 진단 2026-05-09T11-53-46)
    if (stored.cachedROIs && !stored._roiInvalidatedFor163) {
      stored.cachedROIs = null;
      stored._roiInvalidatedFor163 = true;
      console.log('[storage] v1.6.3: cachedROIs 1회 자동 무효화 (ADENA y *0.88 + height *0.75) — 다음 사이클 재탐지');
    }
    // [v1.6.4] ADENA belowCand height 축소 (다음 UI 라인 제외, 사용자 스크린샷 2026-05-09 20:59)
    if (stored.cachedROIs && !stored._roiInvalidatedFor164) {
      stored.cachedROIs = null;
      stored._roiInvalidatedFor164 = true;
      console.log('[storage] v1.6.4: cachedROIs 1회 자동 무효화 (ADENA y *0.83 + height *0.55, 글자 한 줄만) — 다음 사이클 재탐지');
    }
    // mpBarMaxX 의미 변경 (col index → filledCount). refColor 없으면 reset해서 재보정 유도.
    if (stored.mpBarMaxX > 0 && !stored.mpBarRefColor) {
      console.log('[storage] mpBarMaxX 의미 변경됨 — refColor 없어서 재보정 필요. 기존 보정값 reset.');
      stored.mpBarMaxX = 0;
    }
    // MP 바 픽셀 모드는 안정성 부족 → OCR 모드로 일괄 전환 (1회만, 사용자가 다시 켤 수 있음)
    if (stored.useMpBar === true && !stored._barModeMigratedToOcr) {
      console.log('[storage] useMpBar true → false 자동 전환 (OCR이 더 안정적). 사용자가 다시 켜려면 체크박스 클릭.');
      stored.useMpBar = false;
      stored._barModeMigratedToOcr = true;
    }
    return { ...defaults, ...stored };
  }
  function saveAutoDetect(s) {
    try { localStorage.setItem(AUTO_DETECT_KEY, JSON.stringify(s)); } catch (_) {}
  }

  // ===== Items (사냥 획득 아이템) =====
  function loadItems() {
    const stored = safeParse(localStorage.getItem(ITEMS_KEY), null);
    if (stored && Array.isArray(stored) && stored.length > 0) return stored;
    return defaultItems();
  }
  function saveItems(items) {
    try { localStorage.setItem(ITEMS_KEY, JSON.stringify(items)); } catch (_) {}
  }
  function defaultItems() { return JSON.parse(JSON.stringify(DEFAULT_ITEMS)); }

  global.MpStorage = {
    loadPresets, savePresets, addPreset, removePreset,
    loadSettings, saveSettings,
    loadLast, saveLast,
    loadTracker, saveTracker,
    loadHotkeys, saveHotkeys, defaultHotkeys,
    loadItems, saveItems, defaultItems,
    loadAutoDetect, saveAutoDetect
  };
})(window);
