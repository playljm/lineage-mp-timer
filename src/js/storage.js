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
      expAutoFormatDelayMs: 3000
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

  // ===== Auto-detect (MP 자동 감지) =====
  function loadAutoDetect() {
    return safeParse(localStorage.getItem(AUTO_DETECT_KEY), {
      enabled: false,
      sourceId: null,
      displayId: null,
      displayLabel: null,
      region: null,           // { x, y, width, height } — 디스플레이 좌표
      confidenceThreshold: 50,
      intervalMs: 1000,
      preprocess: true        // 그레이스케일+threshold 전처리
    });
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
