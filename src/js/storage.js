/**
 * 프리셋 + 설정 + 트래커 저장 (localStorage)
 */
(function (global) {
  'use strict';

  const PRESET_KEY = 'lmp.presets.v1';
  const SETTINGS_KEY = 'lmp.settings.v1';
  const LAST_KEY = 'lmp.last.v1';
  const TRACKER_KEY = 'lmp.tracker.v1';

  function safeParse(raw, fallback) {
    try {
      const v = JSON.parse(raw);
      return v ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  // ===== Presets =====
  function loadPresets() {
    return safeParse(localStorage.getItem(PRESET_KEY), []);
  }

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
      sound: true,
      toast: true,
      minimizeOnClose: false,
      alwaysOnTop: false,
      volume: 0.5
    });
  }

  function saveSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
  }

  // ===== Last input =====
  function loadLast() {
    return safeParse(localStorage.getItem(LAST_KEY), null);
  }

  function saveLast(state) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(state)); } catch (_) {}
  }

  // ===== Session Tracker =====
  function loadTracker() {
    return safeParse(localStorage.getItem(TRACKER_KEY), {
      active: false,
      startedAt: null,
      start: { level: 1, exp: 0, adena: 0 },
      current: { level: 1, exp: 0, adena: 0 }
    });
  }

  function saveTracker(state) {
    try { localStorage.setItem(TRACKER_KEY, JSON.stringify(state)); } catch (_) {}
  }

  global.MpStorage = {
    loadPresets,
    savePresets,
    addPreset,
    removePreset,
    loadSettings,
    saveSettings,
    loadLast,
    saveLast,
    loadTracker,
    saveTracker
  };
})(window);
