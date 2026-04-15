/**
 * Lineage MP Timer — 렌더러 컨트롤러
 * - MP 타이머 (계산 + 카운트다운 + 알림)
 * - Session Tracker (경험치/아데나 시간당 효율)
 */
(function () {
  'use strict';

  const E = window.MpEngine;
  const S = window.MpStorage;
  const api = window.api || null;

  // ========== DOM ==========
  const $ = (id) => document.getElementById(id);
  const dom = {
    mpCurrent: $('mp-current'),
    mpMax: $('mp-max'),
    mpPercent: $('mp-percent'),
    barFill: $('bar-fill'),

    timeRemaining: $('time-remaining'),
    timeComplete: $('time-complete'),
    tickRecovery: $('tick-recovery'),
    runStatus: $('run-status'),
    breakdown: $('breakdown'),

    inCurMp: $('in-cur-mp'),
    inMaxMp: $('in-max-mp'),
    inWis: $('in-wis'),
    chkPotion: $('chk-potion'),
    chkMeditation: $('chk-meditation'),
    chkStaff: $('chk-staff'),
    inLocation: $('in-location'),
    inState: $('in-state'),

    btnStart: $('btn-start'),
    btnPause: $('btn-pause'),
    btnReset: $('btn-reset'),
    btnPin: $('btn-pin'),
    btnTray: $('btn-tray'),
    btnQuit: $('btn-quit'),

    presetName: $('preset-name'),
    btnPresetSave: $('btn-preset-save'),
    presetList: $('preset-list'),

    chkSound: $('chk-sound'),
    chkToast: $('chk-toast'),
    chkMinimize: $('chk-minimize'),

    // Tracker
    trkLevelStart: $('track-level-start'),
    trkLevelNow: $('track-level-now'),
    trkLevelDiff: $('track-level-diff'),
    trkExpStart: $('track-exp-start'),
    trkExpNow: $('track-exp-now'),
    trkExpDiff: $('track-exp-diff'),
    trkAdenaStart: $('track-adena-start'),
    trkAdenaNow: $('track-adena-now'),
    trkAdenaDiff: $('track-adena-diff'),
    trkTime: $('tracker-time'),
    trkExpRate: $('tracker-exp-rate'),
    trkAdenaRate: $('tracker-adena-rate'),
    trkStatus: $('tracker-status'),
    btnTrackerStart: $('btn-tracker-start'),
    btnTrackerStop: $('btn-tracker-stop'),
    btnTrackerReset: $('btn-tracker-reset'),
    btnTrackerSnap: $('btn-tracker-snapshot')
  };

  // ========== State ==========
  const mpState = {
    running: false,
    startedAt: null,
    simulatedMp: 0,
    totalSeconds: 0,
    completedFired: false,
    tickTimerId: null
  };

  let tracker = S.loadTracker();

  // ========== Helpers ==========
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
      state: dom.inState.value
    };
  }

  // ========== MP Timer Render ==========
  function renderAll() {
    const cfg = readMpConfig();
    const total = E.calculateFullMpTime(cfg.curMp, cfg.maxMp, cfg);
    mpState.totalSeconds = total;

    renderGauge(cfg.curMp, cfg.maxMp);
    renderBreakdown(cfg);
    renderTickInfo(cfg);
    renderTimes(total);

    if (!mpState.running) {
      if (cfg.curMp >= cfg.maxMp) {
        setStatus('done', 'FULL');
        document.body.classList.add('state-done');
      } else if (cfg.state === 'blocked') {
        setStatus('blocked', 'BLOCKED');
        document.body.classList.remove('state-done');
      } else {
        setStatus('idle', 'IDLE');
        document.body.classList.remove('state-done');
      }
    }
  }

  function renderGauge(cur, max) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
    dom.mpCurrent.textContent = cur;
    dom.mpMax.textContent = max;
    dom.mpPercent.textContent = `${pct.toFixed(1)}%`;
    dom.barFill.style.width = `${pct}%`;
    dom.barFill.classList.toggle('full', cur >= max && max > 0);
  }

  function renderTickInfo(cfg) {
    const recovery = E.calculateTickRecovery(cfg);
    const interval = E.calculateTickInterval(cfg.state);
    dom.tickRecovery.textContent = cfg.state === 'blocked'
      ? '회복 불가'
      : `+${recovery} MP / ${interval}s`;
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

  function setStatus(kind, label) {
    dom.runStatus.className = kind;
    dom.runStatus.textContent = label;
  }

  // ========== MP Timer Logic ==========
  function startTimer() {
    const cfg = readMpConfig();
    const total = E.calculateFullMpTime(cfg.curMp, cfg.maxMp, cfg);
    if (!Number.isFinite(total)) { flashHint('회복 불가 상태입니다.'); return; }
    if (total <= 0) { flashHint('이미 MP가 가득 찼습니다.'); return; }

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
    if (mpState.tickTimerId) {
      clearInterval(mpState.tickTimerId);
      mpState.tickTimerId = null;
    }
    mpState.running = false;
    setStatus('paused', 'PAUSED');
  }

  function resetTimer() {
    if (mpState.tickTimerId) {
      clearInterval(mpState.tickTimerId);
      mpState.tickTimerId = null;
    }
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
    const elapsed = Math.floor((Date.now() - mpState.startedAt) / 1000);
    const remaining = Math.max(0, mpState.totalSeconds - elapsed);

    const recovery = E.calculateTickRecovery(cfg);
    const interval = E.calculateTickInterval(cfg.state);
    const ticksElapsed = Math.floor(elapsed / interval);
    const simulatedCur = Math.min(cfg.maxMp, cfg.curMp + ticksElapsed * recovery);

    renderGauge(simulatedCur, cfg.maxMp);
    dom.timeRemaining.textContent = E.formatDuration(remaining);
    dom.timeComplete.textContent = E.formatCompletionTime(remaining);

    if (remaining <= 0 || simulatedCur >= cfg.maxMp) onComplete(cfg);
  }

  function onComplete(cfg) {
    if (mpState.completedFired) return;
    mpState.completedFired = true;
    if (mpState.tickTimerId) { clearInterval(mpState.tickTimerId); mpState.tickTimerId = null; }
    mpState.running = false;
    document.body.classList.add('state-done');
    setStatus('done', 'FULL!');
    renderGauge(cfg.maxMp, cfg.maxMp);
    dom.timeRemaining.textContent = '00:00:00';

    const settings = S.loadSettings();
    if (settings.toast && api && api.notifyComplete) {
      api.notifyComplete({
        title: '🎉 MP 충전 완료!',
        body: `${cfg.maxMp} MP 가득 찼습니다.`
      }).catch(() => {});
    }
    if (settings.sound) playCompleteSound(settings.volume ?? 0.5);
  }

  // ========== Web Audio ==========
  let audioCtx = null;
  function getAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (_) { audioCtx = null; }
    }
    return audioCtx;
  }

  function beep(freq, duration, volume, delay, type = 'sine') {
    const ctx = getAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const start = ctx.currentTime + (delay || 0);
    const stop = start + duration;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, stop);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(stop + 0.05);
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

  // ========== Presets ==========
  function renderPresets() {
    const list = S.loadPresets();
    if (!list.length) {
      dom.presetList.innerHTML = '<span class="muted">저장된 프리셋이 없습니다.</span>';
      return;
    }
    dom.presetList.innerHTML = list
      .map((p) => `<span class="preset-item" data-name="${escapeHtml(p.name)}">
        <span class="preset-load">${escapeHtml(p.name)}</span>
        <button class="del" title="삭제">×</button>
      </span>`)
      .join('');
  }

  function applyPreset(preset) {
    if (!preset) return;
    dom.inMaxMp.value = preset.maxMp ?? dom.inMaxMp.value;
    dom.inWis.value = preset.wis ?? dom.inWis.value;
    dom.chkPotion.checked = !!preset.useBluePotion;
    dom.chkMeditation.checked = !!preset.useMeditation;
    dom.chkStaff.checked = !!preset.hasCrystalStaff;
    if (preset.location) dom.inLocation.value = preset.location;
    if (preset.state) dom.inState.value = preset.state;
    renderAll();
  }

  function currentPreset(name) {
    const cfg = readMpConfig();
    return {
      name,
      maxMp: cfg.maxMp, wis: cfg.wis,
      useBluePotion: cfg.useBluePotion,
      useMeditation: cfg.useMeditation,
      hasCrystalStaff: cfg.hasCrystalStaff,
      location: cfg.location, state: cfg.state
    };
  }

  // ========== Session Tracker ==========
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

  /**
   * 누적 % 진행도 계산
   * "1레벨 30%" → "2레벨 10%" 면 +80% 진행
   */
  function totalExpProgress(start, current) {
    const dLevel = current.level - start.level;
    const dExp = current.exp - start.exp;
    return dLevel * 100 + dExp;
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
      active: false,
      startedAt: null,
      start: { level: 1, exp: 0, adena: 0 },
      current: { level: 1, exp: 0, adena: 0 }
    };
    S.saveTracker(tracker);
    dom.trkLevelStart.value = 1;
    dom.trkLevelNow.value = 1;
    dom.trkExpStart.value = 0;
    dom.trkExpNow.value = 0;
    dom.trkAdenaStart.value = 0;
    dom.trkAdenaNow.value = 0;
    setTrackerStatus('IDLE', '');
    renderTracker();
  }

  /** 현재값 → 시작값 복사 (스냅샷) */
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

    // 차이
    const dLevel = t.current.level - t.start.level;
    const dExp = totalExpProgress(t.start, t.current);
    const dAdena = t.current.adena - t.start.adena;

    dom.trkLevelDiff.textContent = `${dLevel >= 0 ? '+' : ''}${dLevel}`;
    dom.trkLevelDiff.classList.toggle('negative', dLevel < 0);

    dom.trkExpDiff.textContent = `${dExp >= 0 ? '+' : ''}${dExp.toFixed(1)}%`;
    dom.trkExpDiff.classList.toggle('negative', dExp < 0);

    dom.trkAdenaDiff.textContent = `${dAdena >= 0 ? '+' : ''}${formatNumber(dAdena)}`;
    dom.trkAdenaDiff.classList.toggle('negative', dAdena < 0);

    // 세션 시간 + 시간당 효율
    let elapsedSec = 0;
    if (tracker.active && tracker.startedAt) {
      elapsedSec = Math.max(0, Math.floor((Date.now() - tracker.startedAt) / 1000));
    } else if (tracker.startedAt) {
      // 정지 후 마지막 시간 유지 (선택)
      elapsedSec = 0;
    }
    dom.trkTime.textContent = E.formatDuration(elapsedSec);

    if (elapsedSec > 0) {
      const hours = elapsedSec / 3600;
      const expPerH = dExp / hours;
      const adenaPerH = dAdena / hours;
      dom.trkExpRate.textContent = `${expPerH >= 0 ? '+' : ''}${expPerH.toFixed(1)}%/h`;
      dom.trkAdenaRate.textContent = `${adenaPerH >= 0 ? '+' : ''}${formatNumber(adenaPerH)}/h`;
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
    if (tracker.active) {
      setTrackerStatus('RUNNING', 'running');
    } else {
      setTrackerStatus('IDLE', '');
    }
  }

  function saveTrackerCurrent() {
    const t = readTrackerInputs();
    tracker.start = t.start;
    tracker.current = t.current;
    S.saveTracker(tracker);
  }

  // ========== Events ==========
  function bindEvents() {
    ['inCurMp','inMaxMp','inWis','inLocation','inState'].forEach((k) => {
      dom[k].addEventListener('input', () => { if (!mpState.running) renderAll(); saveLast(); });
      dom[k].addEventListener('change', () => { if (!mpState.running) renderAll(); saveLast(); });
    });
    ['chkPotion','chkMeditation','chkStaff'].forEach((k) => {
      dom[k].addEventListener('change', () => { if (!mpState.running) renderAll(); saveLast(); });
    });

    dom.btnStart.addEventListener('click', () => {
      if (mpState.running) pauseTimer();
      else startTimer();
    });
    dom.btnPause.addEventListener('click', pauseTimer);
    dom.btnReset.addEventListener('click', resetTimer);

    // Titlebar
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
      if (api && api.quit) api.quit();
      else window.close();
    });

    // Presets
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
      if (e.target.classList.contains('del')) {
        S.removePreset(name);
        renderPresets();
        return;
      }
      const preset = S.loadPresets().find((p) => p.name === name);
      applyPreset(preset);
    });

    // Settings
    dom.chkSound.addEventListener('change', saveSettingsFromUi);
    dom.chkToast.addEventListener('change', saveSettingsFromUi);
    dom.chkMinimize.addEventListener('change', async () => {
      saveSettingsFromUi();
      if (api && api.setMinimizeOnClose) await api.setMinimizeOnClose(dom.chkMinimize.checked);
    });

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
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.code === 'Space') { e.preventDefault(); dom.btnStart.click(); }
      else if (e.key.toLowerCase() === 'r') { resetTimer(); }
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
      useBluePotion: cfg.useBluePotion,
      useMeditation: cfg.useMeditation,
      hasCrystalStaff: cfg.hasCrystalStaff,
      location: cfg.location, state: cfg.state
    });
  }

  function restoreLast() {
    const last = S.loadLast();
    if (!last) return;
    if (last.curMp != null) dom.inCurMp.value = last.curMp;
    if (last.maxMp != null) dom.inMaxMp.value = last.maxMp;
    if (last.wis != null) dom.inWis.value = last.wis;
    if (typeof last.useBluePotion === 'boolean') dom.chkPotion.checked = last.useBluePotion;
    if (typeof last.useMeditation === 'boolean') dom.chkMeditation.checked = last.useMeditation;
    if (typeof last.hasCrystalStaff === 'boolean') dom.chkStaff.checked = last.hasCrystalStaff;
    if (last.location) dom.inLocation.value = last.location;
    if (last.state) dom.inState.value = last.state;
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
  }

  // ========== Init ==========
  function init() {
    restoreSettings();
    restoreLast();
    restoreTrackerInputs();
    bindEvents();
    renderPresets();
    renderAll();
    renderTracker();

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
