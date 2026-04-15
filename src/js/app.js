/**
 * Lineage MP Timer — 렌더러 컨트롤러
 * - MP 타이머, 트래커, 핫키, 테마, 직접 입력 위치
 */
(function () {
  'use strict';

  const E = window.MpEngine;
  const S = window.MpStorage;
  const api = window.api || null;

  const $ = (id) => document.getElementById(id);
  const dom = {
    mpCurrent: $('mp-current'), mpMax: $('mp-max'), mpPercent: $('mp-percent'),
    barFill: $('bar-fill'),
    timeRemaining: $('time-remaining'), timeComplete: $('time-complete'),
    tickRecovery: $('tick-recovery'), runStatus: $('run-status'),
    breakdown: $('breakdown'),
    inCurMp: $('in-cur-mp'), inMaxMp: $('in-max-mp'), inWis: $('in-wis'),
    chkPotion: $('chk-potion'), chkMeditation: $('chk-meditation'), chkStaff: $('chk-staff'),
    inLocation: $('in-location'),
    inLocationCustom: $('in-location-custom'),
    customLocationWrap: $('custom-location-wrap'),
    inState: $('in-state'),
    inTargetPct: $('in-target-pct'),
    btnStart: $('btn-start'), btnPause: $('btn-pause'), btnReset: $('btn-reset'),
    btnPin: $('btn-pin'), btnTray: $('btn-tray'), btnQuit: $('btn-quit'),
    presetName: $('preset-name'), btnPresetSave: $('btn-preset-save'),
    presetList: $('preset-list'),
    chkSound: $('chk-sound'), chkToast: $('chk-toast'), chkMinimize: $('chk-minimize'),
    btnResetWindow: $('btn-reset-window'),
    // tracker
    trkLevelStart: $('track-level-start'), trkLevelNow: $('track-level-now'),
    trkLevelDiff: $('track-level-diff'),
    trkExpStart: $('track-exp-start'), trkExpNow: $('track-exp-now'),
    trkExpDiff: $('track-exp-diff'),
    trkAdenaStart: $('track-adena-start'), trkAdenaNow: $('track-adena-now'),
    trkAdenaDiff: $('track-adena-diff'),
    trkTime: $('tracker-time'), trkExpRate: $('tracker-exp-rate'),
    trkAdenaRate: $('tracker-adena-rate'), trkStatus: $('tracker-status'),
    btnTrackerStart: $('btn-tracker-start'), btnTrackerStop: $('btn-tracker-stop'),
    btnTrackerReset: $('btn-tracker-reset'), btnTrackerSnap: $('btn-tracker-snapshot'),
    // hotkeys
    btnHotkeyReset: $('btn-hotkey-reset')
  };

  const THEMES = ['green', 'cyan', 'pink', 'yellow', 'purple', 'red'];

  const mpState = {
    running: false, startedAt: null, simulatedMp: 0,
    totalSeconds: 0, completedFired: false, tickTimerId: null
  };
  let tracker = S.loadTracker();
  let hotkeys = S.loadHotkeys();
  let captureTarget = null;

  function $clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  }
  function $clampFloat(v, min, max, dflt) {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }
  function formatNumber(n) {
    if (!Number.isFinite(n)) return '0';
    return Math.round(n).toLocaleString('en-US');
  }

  function readMpConfig() {
    return {
      curMp: $clampInt(dom.inCurMp.value, 0, 99999, 0),
      maxMp: $clampInt(dom.inMaxMp.value, 1, 99999, 1),
      wis: $clampInt(dom.inWis.value, 1, 50, 15),
      useBluePotion: dom.chkPotion.checked,
      useMeditation: dom.chkMeditation.checked,
      hasCrystalStaff: dom.chkStaff.checked,
      location: dom.inLocation.value,
      customLocationBonus: $clampInt(dom.inLocationCustom.value, -20, 50, 0),
      state: dom.inState.value,
      targetPct: $clampInt(dom.inTargetPct.value, 1, 100, 100)
    };
  }

  function effectiveTargetMp(cfg) {
    const max = cfg.maxMp || 1;
    const t = Math.floor(max * (cfg.targetPct || 100) / 100);
    return Math.max(1, Math.min(max, t));
  }

  // ========== MP Timer ==========
  function renderAll() {
    const cfg = readMpConfig();
    const target = effectiveTargetMp(cfg);
    const total = E.calculateFullMpTime(cfg.curMp, target, cfg);
    mpState.totalSeconds = total;
    renderGauge(cfg.curMp, cfg.maxMp, target);
    renderBreakdown(cfg);
    renderTickInfo(cfg);
    renderTimes(total);
    if (!mpState.running) {
      if (cfg.curMp >= target) {
        const label = cfg.targetPct >= 100 ? 'FULL' : `${cfg.targetPct}%`;
        setStatus('done', label);
        document.body.classList.add('state-done');
      }
      else if (cfg.state === 'blocked') { setStatus('blocked', 'BLOCKED'); document.body.classList.remove('state-done'); }
      else { setStatus('idle', 'IDLE'); document.body.classList.remove('state-done'); }
    }
  }
  function renderGauge(cur, max, target) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
    dom.mpCurrent.textContent = cur;
    dom.mpMax.textContent = max;
    dom.mpPercent.textContent = `${pct.toFixed(1)}%`;
    dom.barFill.style.width = `${pct}%`;
    const goalReached = target ? cur >= target : cur >= max;
    dom.barFill.classList.toggle('full', goalReached && max > 0);
  }
  function renderTickInfo(cfg) {
    const recovery = E.calculateTickRecovery(cfg);
    const interval = E.calculateTickInterval(cfg.state);
    dom.tickRecovery.textContent = cfg.state === 'blocked' ? '회복 불가' : `+${recovery} MP / ${interval}s`;
  }
  function renderTimes(total) {
    if (!Number.isFinite(total)) {
      dom.timeRemaining.textContent = '∞';
      dom.timeComplete.textContent = '--:--:--';
      return;
    }
    const remaining = mpState.running
      ? Math.max(0, mpState.totalSeconds - Math.floor((Date.now() - mpState.startedAt) / 1000))
      : total;
    dom.timeRemaining.textContent = E.formatDuration(remaining);
    dom.timeComplete.textContent = E.formatCompletionTime(remaining);
  }
  function renderBreakdown(cfg) {
    if (cfg.state === 'blocked') {
      dom.breakdown.innerHTML = '<span class="chip negative"><b>회복 불가</b> 배고픔/과중 해제 필요</span>';
      return;
    }
    const bd = E.breakdown(cfg);
    const chips = bd.items.map((it) => {
      const neg = it.value < 0;
      const sign = it.value >= 0 ? '+' : '';
      return `<span class="chip${neg ? ' negative' : ''}">${escapeHtml(it.label)}: <b>${sign}${it.value}</b></span>`;
    });
    chips.push(`<span class="chip">TOTAL: <b>+${bd.total}</b> / ${bd.interval}s</span>`);
    dom.breakdown.innerHTML = chips.join('');
  }
  function setStatus(kind, label) { dom.runStatus.className = kind; dom.runStatus.textContent = label; }

  function startTimer() {
    const cfg = readMpConfig();
    const target = effectiveTargetMp(cfg);
    const total = E.calculateFullMpTime(cfg.curMp, target, cfg);
    if (!Number.isFinite(total)) { flashHint('회복 불가 상태입니다.'); return; }
    if (total <= 0) { flashHint(cfg.targetPct >= 100 ? '이미 MP가 가득 찼습니다.' : `이미 목표 ${cfg.targetPct}% 도달.`); return; }
    mpState.running = true;
    mpState.startedAt = Date.now();
    mpState.simulatedMp = cfg.curMp;
    mpState.totalSeconds = total;
    mpState.completedFired = false;
    document.body.classList.remove('state-done');
    setStatus('running', 'RUNNING');
    if (mpState.tickTimerId) clearInterval(mpState.tickTimerId);
    mpState.tickTimerId = setInterval(tickMp, 1000);
    tickMp();
  }
  function pauseTimer() {
    if (!mpState.running) return;
    if (mpState.tickTimerId) { clearInterval(mpState.tickTimerId); mpState.tickTimerId = null; }
    mpState.running = false;
    setStatus('paused', 'PAUSED');
  }
  function resetTimer() {
    if (mpState.tickTimerId) { clearInterval(mpState.tickTimerId); mpState.tickTimerId = null; }
    mpState.running = false;
    mpState.startedAt = null;
    mpState.simulatedMp = 0;
    mpState.totalSeconds = 0;
    mpState.completedFired = false;
    document.body.classList.remove('state-done');
    renderAll();
  }
  function tickMp() {
    const cfg = readMpConfig();
    const target = effectiveTargetMp(cfg);
    const elapsed = Math.floor((Date.now() - mpState.startedAt) / 1000);
    const remaining = Math.max(0, mpState.totalSeconds - elapsed);
    const recovery = E.calculateTickRecovery(cfg);
    const interval = E.calculateTickInterval(cfg.state);
    const ticksElapsed = Math.floor(elapsed / interval);
    const simulatedCur = Math.min(cfg.maxMp, cfg.curMp + ticksElapsed * recovery);
    renderGauge(simulatedCur, cfg.maxMp, target);
    dom.timeRemaining.textContent = E.formatDuration(remaining);
    dom.timeComplete.textContent = E.formatCompletionTime(remaining);
    if (remaining <= 0 || simulatedCur >= target) onComplete(cfg);
  }
  function onComplete(cfg) {
    if (mpState.completedFired) return;
    mpState.completedFired = true;
    if (mpState.tickTimerId) { clearInterval(mpState.tickTimerId); mpState.tickTimerId = null; }
    mpState.running = false;
    document.body.classList.add('state-done');
    const target = effectiveTargetMp(cfg);
    const isFull = cfg.targetPct >= 100;
    setStatus('done', isFull ? 'FULL!' : `${cfg.targetPct}%!`);
    renderGauge(target, cfg.maxMp, target);
    dom.timeRemaining.textContent = '00:00:00';
    const settings = S.loadSettings();
    if (settings.toast && api && api.notifyComplete) {
      const title = isFull ? '🎉 MP 충전 완료!' : `🎯 목표 MP ${cfg.targetPct}% 도달!`;
      const body = isFull
        ? `${cfg.maxMp} MP 가득 찼습니다.`
        : `${target} / ${cfg.maxMp} MP (${cfg.targetPct}%) 도달.`;
      api.notifyComplete({ title, body }).catch(() => {});
    }
    if (settings.sound) playCompleteSound(settings.volume ?? 0.5);
  }

  // ========== Audio ==========
  let audioCtx = null;
  function getAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    }
    return audioCtx;
  }
  function beep(freq, duration, volume, delay, type = 'sine') {
    const ctx = getAudio(); if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type; osc.frequency.value = freq;
    const start = ctx.currentTime + (delay || 0);
    const stop = start + duration;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, stop);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start); osc.stop(stop + 0.05);
  }
  function playCompleteSound(volume) {
    beep(880, 0.15, volume, 0.0, 'triangle');
    beep(1175, 0.15, volume, 0.15, 'triangle');
    beep(1568, 0.35, volume, 0.3, 'triangle');
  }
  function flashHint(msg) {
    dom.runStatus.textContent = msg;
    dom.runStatus.className = 'paused';
    setTimeout(() => renderAll(), 1500);
  }

  // ========== Custom Location Visibility ==========
  function updateCustomLocationVisibility() {
    if (dom.inLocation.value === 'custom') {
      dom.customLocationWrap.style.display = '';
    } else {
      dom.customLocationWrap.style.display = 'none';
    }
  }

  // ========== Theme ==========
  function applyTheme(theme, persist = true) {
    if (!THEMES.includes(theme)) theme = 'green';
    THEMES.forEach((t) => document.body.classList.remove(`theme-${t}`));
    document.body.classList.add(`theme-${theme}`);
    document.querySelectorAll('.theme-chip').forEach((c) => {
      c.classList.toggle('active', c.getAttribute('data-theme') === theme);
    });
    if (persist) {
      const s = S.loadSettings();
      s.theme = theme;
      S.saveSettings(s);
    }
  }

  // ========== Presets ==========
  function renderPresets() {
    const list = S.loadPresets();
    if (!list.length) { dom.presetList.innerHTML = '<span class="muted">저장된 프리셋이 없습니다.</span>'; return; }
    dom.presetList.innerHTML = list.map((p) =>
      `<span class="preset-item" data-name="${escapeHtml(p.name)}">
        <span class="preset-load">${escapeHtml(p.name)}</span>
        <button class="del" title="삭제">×</button>
      </span>`).join('');
  }
  function applyPreset(preset) {
    if (!preset) return;
    dom.inMaxMp.value = preset.maxMp ?? dom.inMaxMp.value;
    dom.inWis.value = preset.wis ?? dom.inWis.value;
    dom.chkPotion.checked = !!preset.useBluePotion;
    dom.chkMeditation.checked = !!preset.useMeditation;
    dom.chkStaff.checked = !!preset.hasCrystalStaff;
    if (preset.location) dom.inLocation.value = preset.location;
    if (preset.customLocationBonus != null) dom.inLocationCustom.value = preset.customLocationBonus;
    if (preset.state) dom.inState.value = preset.state;
    if (preset.targetPct != null) dom.inTargetPct.value = preset.targetPct;
    updateCustomLocationVisibility();
    renderAll();
  }
  function currentPreset(name) {
    const cfg = readMpConfig();
    return {
      name, maxMp: cfg.maxMp, wis: cfg.wis,
      useBluePotion: cfg.useBluePotion, useMeditation: cfg.useMeditation,
      hasCrystalStaff: cfg.hasCrystalStaff,
      location: cfg.location, customLocationBonus: cfg.customLocationBonus,
      state: cfg.state, targetPct: cfg.targetPct
    };
  }

  // ========== Tracker ==========
  function readTrackerInputs() {
    return {
      start: {
        level: $clampInt(dom.trkLevelStart.value, 1, 99, 1),
        exp: $clampFloat(dom.trkExpStart.value, 0, 100, 0),
        adena: $clampInt(dom.trkAdenaStart.value, 0, 9999999999, 0)
      },
      current: {
        level: $clampInt(dom.trkLevelNow.value, 1, 99, 1),
        exp: $clampFloat(dom.trkExpNow.value, 0, 100, 0),
        adena: $clampInt(dom.trkAdenaNow.value, 0, 9999999999, 0)
      }
    };
  }
  function totalExpProgress(start, current) {
    return (current.level - start.level) * 100 + (current.exp - start.exp);
  }
  function setTrackerStatus(text, kind) {
    dom.trkStatus.textContent = text;
    dom.trkStatus.className = (kind || '') + ' small';
  }
  function startTracker() {
    const t = readTrackerInputs();
    tracker.active = true;
    tracker.startedAt = Date.now();
    tracker.start = t.start;
    tracker.current = t.current;
    S.saveTracker(tracker);
    setTrackerStatus('RUNNING', 'running');
    renderTracker();
  }
  function stopTracker() {
    tracker.active = false;
    S.saveTracker(tracker);
    setTrackerStatus('STOPPED', '');
    renderTracker();
  }
  function resetTracker() {
    tracker = {
      active: false, startedAt: null,
      start: { level: 1, exp: 0, adena: 0 },
      current: { level: 1, exp: 0, adena: 0 }
    };
    S.saveTracker(tracker);
    dom.trkLevelStart.value = 1; dom.trkLevelNow.value = 1;
    dom.trkExpStart.value = 0; dom.trkExpNow.value = 0;
    dom.trkAdenaStart.value = 0; dom.trkAdenaNow.value = 0;
    setTrackerStatus('IDLE', '');
    renderTracker();
  }
  function snapshotTracker() {
    const cur = readTrackerInputs().current;
    dom.trkLevelStart.value = cur.level;
    dom.trkExpStart.value = cur.exp;
    dom.trkAdenaStart.value = cur.adena;
    if (tracker.active) {
      tracker.start = cur;
      tracker.startedAt = Date.now();
      S.saveTracker(tracker);
    }
    renderTracker();
  }
  function renderTracker() {
    const t = readTrackerInputs();
    const dLevel = t.current.level - t.start.level;
    const dExp = totalExpProgress(t.start, t.current);
    const dAdena = t.current.adena - t.start.adena;
    dom.trkLevelDiff.textContent = `${dLevel >= 0 ? '+' : ''}${dLevel}`;
    dom.trkLevelDiff.classList.toggle('negative', dLevel < 0);
    dom.trkExpDiff.textContent = `${dExp >= 0 ? '+' : ''}${dExp.toFixed(1)}%`;
    dom.trkExpDiff.classList.toggle('negative', dExp < 0);
    dom.trkAdenaDiff.textContent = `${dAdena >= 0 ? '+' : ''}${formatNumber(dAdena)}`;
    dom.trkAdenaDiff.classList.toggle('negative', dAdena < 0);
    let elapsedSec = 0;
    if (tracker.active && tracker.startedAt) {
      elapsedSec = Math.max(0, Math.floor((Date.now() - tracker.startedAt) / 1000));
    }
    dom.trkTime.textContent = E.formatDuration(elapsedSec);
    if (elapsedSec > 0) {
      const hours = elapsedSec / 3600;
      dom.trkExpRate.textContent = `${dExp >= 0 ? '+' : ''}${(dExp / hours).toFixed(1)}%/h`;
      dom.trkAdenaRate.textContent = `${dAdena >= 0 ? '+' : ''}${formatNumber(dAdena / hours)}/h`;
    } else {
      dom.trkExpRate.textContent = '+0%/h';
      dom.trkAdenaRate.textContent = '+0/h';
    }
  }
  function restoreTrackerInputs() {
    if (tracker.start) {
      dom.trkLevelStart.value = tracker.start.level ?? 1;
      dom.trkExpStart.value = tracker.start.exp ?? 0;
      dom.trkAdenaStart.value = tracker.start.adena ?? 0;
    }
    if (tracker.current) {
      dom.trkLevelNow.value = tracker.current.level ?? 1;
      dom.trkExpNow.value = tracker.current.exp ?? 0;
      dom.trkAdenaNow.value = tracker.current.adena ?? 0;
    }
    setTrackerStatus(tracker.active ? 'RUNNING' : 'IDLE', tracker.active ? 'running' : '');
  }
  function saveTrackerCurrent() {
    const t = readTrackerInputs();
    tracker.start = t.start;
    tracker.current = t.current;
    S.saveTracker(tracker);
  }

  // ========== Hotkeys ==========
  function eventToAccelerator(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Control');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    let key = e.key;
    if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return null;
    if (key === ' ') key = 'Space';
    else if (key === 'Escape') return null;
    else if (key === 'Backspace') return null;
    else if (key === 'Enter') key = 'Return';
    else if (/^F\d{1,2}$/.test(key)) key = key.toUpperCase();
    else if (key.length === 1) key = key.toUpperCase();
    else key = key.charAt(0).toUpperCase() + key.slice(1);
    parts.push(key);
    return parts.join('+');
  }
  function prettyAccelerator(accel) {
    if (!accel) return 'NONE';
    return accel.replace(/Control/g, 'Ctrl').replace(/CommandOrControl/g, 'Ctrl').replace(/Meta/g, 'Win');
  }
  function renderHotkeyRow(name) {
    const row = document.querySelector(`.hotkey-row[data-hk="${name}"]`);
    if (!row) return;
    const cfg = hotkeys[name];
    const enabledChk = row.querySelector('[data-hk-enabled]');
    const bindBtn = row.querySelector('[data-hk-bind]');
    enabledChk.checked = !!cfg.enabled;
    bindBtn.textContent = cfg.accel ? prettyAccelerator(cfg.accel) : 'NONE';
    bindBtn.classList.toggle('disabled', !cfg.enabled);
    bindBtn.classList.toggle('empty', !cfg.accel);
    bindBtn.classList.remove('conflict');
  }
  function renderAllHotkeys() { Object.keys(hotkeys).forEach(renderHotkeyRow); }
  async function applyGlobalHotkeys() {
    if (!api || !api.setGlobalHotkeys) return;
    const map = {};
    for (const [name, cfg] of Object.entries(hotkeys)) {
      if (cfg.scope === 'global' && cfg.enabled && cfg.accel) map[name] = cfg.accel;
    }
    try {
      const res = await api.setGlobalHotkeys(map);
      if (res && Array.isArray(res.failures) && res.failures.length) {
        for (const f of res.failures) {
          const row = document.querySelector(`.hotkey-row[data-hk="${f.name}"]`);
          if (row) {
            const btn = row.querySelector('[data-hk-bind]');
            btn.classList.add('conflict');
            btn.title = `등록 실패 (${f.reason}). 다른 앱과 충돌하거나 사용 불가한 키.`;
          }
        }
      }
    } catch (e) { console.error('applyGlobalHotkeys', e); }
  }
  function startHotkeyCapture(name, button) {
    if (captureTarget) endHotkeyCapture(false);
    captureTarget = { name, button };
    button.classList.add('capturing');
    button.classList.remove('conflict');
    button.textContent = '키 입력...';
    button.title = '새 키를 누르세요. Esc=취소, Backspace=비우기';
    document.addEventListener('keydown', captureHandler, true);
  }
  function endHotkeyCapture(save = true) {
    if (!captureTarget) return;
    const { button } = captureTarget;
    button.classList.remove('capturing');
    document.removeEventListener('keydown', captureHandler, true);
    captureTarget = null;
    if (save) { S.saveHotkeys(hotkeys); applyGlobalHotkeys(); }
    renderAllHotkeys();
  }
  function captureHandler(e) {
    e.preventDefault(); e.stopPropagation();
    if (!captureTarget) return;
    if (e.key === 'Escape') { endHotkeyCapture(false); return; }
    if (e.key === 'Backspace') {
      hotkeys[captureTarget.name].accel = '';
      endHotkeyCapture(true);
      return;
    }
    const accel = eventToAccelerator(e);
    if (!accel) return;
    for (const [n, c] of Object.entries(hotkeys)) {
      if (n !== captureTarget.name && c.accel === accel) {
        captureTarget.button.classList.add('conflict');
        captureTarget.button.textContent = `${prettyAccelerator(accel)} (중복)`;
        return;
      }
    }
    hotkeys[captureTarget.name].accel = accel;
    endHotkeyCapture(true);
  }
  function clearHotkey(name) {
    hotkeys[name] = JSON.parse(JSON.stringify(S.defaultHotkeys()[name]));
    S.saveHotkeys(hotkeys);
    renderHotkeyRow(name);
    applyGlobalHotkeys();
  }
  function resetAllHotkeys() {
    hotkeys = S.defaultHotkeys();
    S.saveHotkeys(hotkeys);
    renderAllHotkeys();
    applyGlobalHotkeys();
  }
  function toggleHotkeyEnabled(name, enabled) {
    hotkeys[name].enabled = !!enabled;
    S.saveHotkeys(hotkeys);
    renderHotkeyRow(name);
    applyGlobalHotkeys();
  }
  function matchWindowHotkey(e) {
    const accel = eventToAccelerator(e);
    if (!accel) return null;
    for (const [name, cfg] of Object.entries(hotkeys)) {
      if (cfg.scope === 'window' && cfg.enabled && cfg.accel === accel) return name;
    }
    return null;
  }

  // ========== Events ==========
  function bindEvents() {
    ['inCurMp','inMaxMp','inWis','inLocationCustom','inState','inTargetPct'].forEach((k) => {
      dom[k].addEventListener('input', () => { if (!mpState.running) renderAll(); saveLast(); });
      dom[k].addEventListener('change', () => { if (!mpState.running) renderAll(); saveLast(); });
    });
    dom.inLocation.addEventListener('change', () => {
      updateCustomLocationVisibility();
      if (!mpState.running) renderAll();
      saveLast();
    });
    ['chkPotion','chkMeditation','chkStaff'].forEach((k) => {
      dom[k].addEventListener('change', () => { if (!mpState.running) renderAll(); saveLast(); });
    });

    dom.btnStart.addEventListener('click', () => {
      if (mpState.running) pauseTimer(); else startTimer();
    });
    dom.btnPause.addEventListener('click', pauseTimer);
    dom.btnReset.addEventListener('click', resetTimer);

    dom.btnPin.addEventListener('click', async () => {
      if (!api) return;
      const current = await api.getAlwaysOnTop();
      const next = !current;
      await api.setAlwaysOnTop(next);
      dom.btnPin.classList.toggle('active', next);
      const settings = S.loadSettings();
      settings.alwaysOnTop = next;
      S.saveSettings(settings);
    });
    dom.btnTray.addEventListener('click', () => {
      if (api && api.minimizeToTray) api.minimizeToTray();
    });
    dom.btnQuit.addEventListener('click', () => {
      if (api && api.quit) api.quit(); else window.close();
    });

    dom.btnPresetSave.addEventListener('click', () => {
      const name = (dom.presetName.value || '').trim();
      if (!name) { flashHint('프리셋 이름을 입력하세요.'); return; }
      S.addPreset(currentPreset(name));
      dom.presetName.value = '';
      renderPresets();
    });
    dom.presetList.addEventListener('click', (e) => {
      const item = e.target.closest('.preset-item');
      if (!item) return;
      const name = item.getAttribute('data-name');
      if (e.target.classList.contains('del')) { S.removePreset(name); renderPresets(); return; }
      const preset = S.loadPresets().find((p) => p.name === name);
      applyPreset(preset);
    });

    dom.chkSound.addEventListener('change', saveSettingsFromUi);
    dom.chkToast.addEventListener('change', saveSettingsFromUi);
    dom.chkMinimize.addEventListener('change', async () => {
      saveSettingsFromUi();
      if (api && api.setMinimizeOnClose) await api.setMinimizeOnClose(dom.chkMinimize.checked);
    });
    if (dom.btnResetWindow) {
      dom.btnResetWindow.addEventListener('click', () => {
        if (api && api.resetWindowSize) api.resetWindowSize();
      });
    }

    // Tracker
    [
      'trkLevelStart','trkLevelNow','trkExpStart','trkExpNow','trkAdenaStart','trkAdenaNow'
    ].forEach((k) => {
      dom[k].addEventListener('input', () => { renderTracker(); saveTrackerCurrent(); });
      dom[k].addEventListener('change', () => { renderTracker(); saveTrackerCurrent(); });
    });
    dom.btnTrackerStart.addEventListener('click', startTracker);
    dom.btnTrackerStop.addEventListener('click', stopTracker);
    dom.btnTrackerReset.addEventListener('click', resetTracker);
    dom.btnTrackerSnap.addEventListener('click', snapshotTracker);

    // Hotkeys
    document.querySelectorAll('.hotkey-row').forEach((row) => {
      const name = row.getAttribute('data-hk');
      const enabledChk = row.querySelector('[data-hk-enabled]');
      const bindBtn = row.querySelector('[data-hk-bind]');
      const clearBtn = row.querySelector('[data-hk-clear]');
      enabledChk.addEventListener('change', () => toggleHotkeyEnabled(name, enabledChk.checked));
      bindBtn.addEventListener('click', () => startHotkeyCapture(name, bindBtn));
      clearBtn.addEventListener('click', () => clearHotkey(name));
    });
    if (dom.btnHotkeyReset) dom.btnHotkeyReset.addEventListener('click', resetAllHotkeys);

    // Theme picker
    document.querySelectorAll('.theme-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        applyTheme(chip.getAttribute('data-theme'));
      });
    });

    // 윈도우 단축키
    document.addEventListener('keydown', (e) => {
      if (captureTarget) return;
      const tag = (e.target.tagName || '').toLowerCase();
      const isInput = (tag === 'input' || tag === 'select' || tag === 'textarea');
      const matched = matchWindowHotkey(e);
      if (!matched) return;
      if (isInput) return;
      e.preventDefault();
      if (matched === 'startPause') dom.btnStart.click();
      else if (matched === 'reset') resetTimer();
    });

    if (api && api.onAlwaysOnTopChanged) {
      api.onAlwaysOnTopChanged((value) => {
        dom.btnPin.classList.toggle('active', !!value);
      });
    }
  }

  function saveSettingsFromUi() {
    const s = S.loadSettings();
    s.sound = dom.chkSound.checked;
    s.toast = dom.chkToast.checked;
    s.minimizeOnClose = dom.chkMinimize.checked;
    S.saveSettings(s);
  }

  function saveLast() {
    const cfg = readMpConfig();
    S.saveLast({
      curMp: cfg.curMp, maxMp: cfg.maxMp, wis: cfg.wis,
      useBluePotion: cfg.useBluePotion, useMeditation: cfg.useMeditation,
      hasCrystalStaff: cfg.hasCrystalStaff,
      location: cfg.location, customLocationBonus: cfg.customLocationBonus,
      state: cfg.state, targetPct: cfg.targetPct
    });
  }
  function restoreLast() {
    const last = S.loadLast(); if (!last) return;
    if (last.curMp != null) dom.inCurMp.value = last.curMp;
    if (last.maxMp != null) dom.inMaxMp.value = last.maxMp;
    if (last.wis != null) dom.inWis.value = last.wis;
    if (typeof last.useBluePotion === 'boolean') dom.chkPotion.checked = last.useBluePotion;
    if (typeof last.useMeditation === 'boolean') dom.chkMeditation.checked = last.useMeditation;
    if (typeof last.hasCrystalStaff === 'boolean') dom.chkStaff.checked = last.hasCrystalStaff;
    if (last.location) dom.inLocation.value = last.location;
    if (last.customLocationBonus != null) dom.inLocationCustom.value = last.customLocationBonus;
    if (last.state) dom.inState.value = last.state;
    if (last.targetPct != null) dom.inTargetPct.value = last.targetPct;
  }
  function restoreSettings() {
    const s = S.loadSettings();
    dom.chkSound.checked = !!s.sound;
    dom.chkToast.checked = !!s.toast;
    dom.chkMinimize.checked = !!s.minimizeOnClose;
    if (api && api.setMinimizeOnClose) api.setMinimizeOnClose(!!s.minimizeOnClose);
    if (api && api.setAlwaysOnTop && s.alwaysOnTop) {
      api.setAlwaysOnTop(true);
      dom.btnPin.classList.add('active');
    }
    applyTheme(s.theme || 'green', false);
  }

  // ========== Init ==========
  function init() {
    restoreSettings();
    restoreLast();
    restoreTrackerInputs();
    renderAllHotkeys();
    updateCustomLocationVisibility();
    bindEvents();
    renderPresets();
    renderAll();
    renderTracker();
    applyGlobalHotkeys();
    setInterval(() => {
      if (!mpState.running) renderAll();
      renderTracker();
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
