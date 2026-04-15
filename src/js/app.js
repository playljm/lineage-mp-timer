/**
 * Lineage MP Timer — 렌더러 컨트롤러
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
    chkMinimize: $('chk-minimize')
  };

  // ========== State ==========
  const state = {
    running: false,
    startedAt: null,        // ms
    simulatedMp: 0,         // 실시간 증가되는 시뮬레이션 MP
    totalSeconds: 0,        // 계산된 완충 시간
    completedFired: false,
    tickTimerId: null
  };

  // ========== Config ==========
  function readConfig() {
    return {
      curMp: clampInt(dom.inCurMp.value, 0, 99999, 0),
      maxMp: clampInt(dom.inMaxMp.value, 1, 99999, 1),
      wis: clampInt(dom.inWis.value, 1, 50, 15),
      useBluePotion: dom.chkPotion.checked,
      useMeditation: dom.chkMeditation.checked,
      hasCrystalStaff: dom.chkStaff.checked,
      location: dom.inLocation.value,
      state: dom.inState.value
    };
  }

  function clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  }

  // ========== 렌더 ==========
  function renderAll() {
    const cfg = readConfig();
    const total = E.calculateFullMpTime(cfg.curMp, cfg.maxMp, cfg);
    state.totalSeconds = total;

    renderGauge(cfg.curMp, cfg.maxMp);
    renderBreakdown(cfg);
    renderTickInfo(cfg, total);
    renderTimes(total);

    if (!state.running) {
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

  function renderTickInfo(cfg, total) {
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
    const remaining = state.running
      ? Math.max(0, state.totalSeconds - Math.floor((Date.now() - state.startedAt) / 1000))
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ========== 타이머 ==========
  function startTimer() {
    const cfg = readConfig();
    const total = E.calculateFullMpTime(cfg.curMp, cfg.maxMp, cfg);
    if (!Number.isFinite(total)) {
      flashHint('회복 불가 상태입니다.');
      return;
    }
    if (total <= 0) {
      flashHint('이미 MP가 가득 찼습니다.');
      return;
    }

    state.running = true;
    state.startedAt = Date.now();
    state.simulatedMp = cfg.curMp;
    state.totalSeconds = total;
    state.completedFired = false;
    document.body.classList.remove('state-done');
    setStatus('running', 'RUNNING');

    if (state.tickTimerId) clearInterval(state.tickTimerId);
    state.tickTimerId = setInterval(tick, 1000);
    tick();
  }

  function pauseTimer() {
    if (!state.running) return;
    if (state.tickTimerId) {
      clearInterval(state.tickTimerId);
      state.tickTimerId = null;
    }
    state.running = false;
    setStatus('paused', 'PAUSED');
  }

  function resetTimer() {
    if (state.tickTimerId) {
      clearInterval(state.tickTimerId);
      state.tickTimerId = null;
    }
    state.running = false;
    state.startedAt = null;
    state.simulatedMp = 0;
    state.totalSeconds = 0;
    state.completedFired = false;
    document.body.classList.remove('state-done');
    renderAll();
  }

  function tick() {
    const cfg = readConfig();
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    const remaining = Math.max(0, state.totalSeconds - elapsed);

    // 시뮬레이션 MP 계산
    const recovery = E.calculateTickRecovery(cfg);
    const interval = E.calculateTickInterval(cfg.state);
    const ticksElapsed = Math.floor(elapsed / interval);
    const simulatedCur = Math.min(cfg.maxMp, cfg.curMp + ticksElapsed * recovery);

    renderGauge(simulatedCur, cfg.maxMp);
    dom.timeRemaining.textContent = E.formatDuration(remaining);
    dom.timeComplete.textContent = E.formatCompletionTime(remaining);

    if (remaining <= 0 || simulatedCur >= cfg.maxMp) {
      onComplete(cfg);
    }
  }

  function onComplete(cfg) {
    if (state.completedFired) return;
    state.completedFired = true;
    if (state.tickTimerId) {
      clearInterval(state.tickTimerId);
      state.tickTimerId = null;
    }
    state.running = false;
    document.body.classList.add('state-done');
    setStatus('done', 'FULL!');
    renderGauge(cfg.maxMp, cfg.maxMp);
    dom.timeRemaining.textContent = '00:00:00';

    const settings = S.loadSettings();
    if (settings.toast && api && api.notifyComplete) {
      api.notifyComplete({
        title: '🎉 MP 충전 완료!',
        body: `${cfg.maxMp} MP 가득 찼습니다. 귀환하세요.`
      }).catch(() => {});
    }
    if (settings.sound) {
      playCompleteSound(settings.volume ?? 0.5);
    }
  }

  // ========== Web Audio 합성 사운드 ==========
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
    // 3-tone arpeggio (pleasant ding)
    beep(880, 0.15, volume, 0.0, 'triangle');
    beep(1175, 0.15, volume, 0.15, 'triangle');
    beep(1568, 0.35, volume, 0.3, 'triangle');
  }

  function flashHint(msg) {
    dom.runStatus.textContent = msg;
    dom.runStatus.className = 'paused';
    setTimeout(() => renderAll(), 1500);
  }

  // ========== 프리셋 ==========
  function renderPresets() {
    const list = S.loadPresets();
    if (!list.length) {
      dom.presetList.innerHTML = '<span class="muted">저장된 프리셋이 없습니다.</span>';
      return;
    }
    dom.presetList.innerHTML = list
      .map(
        (p) => `<span class="preset-item" data-name="${escapeHtml(p.name)}">
          <span class="preset-load">${escapeHtml(p.name)}</span>
          <button class="del" title="삭제">×</button>
        </span>`
      )
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
    const cfg = readConfig();
    return {
      name,
      maxMp: cfg.maxMp,
      wis: cfg.wis,
      useBluePotion: cfg.useBluePotion,
      useMeditation: cfg.useMeditation,
      hasCrystalStaff: cfg.hasCrystalStaff,
      location: cfg.location,
      state: cfg.state
    };
  }

  // ========== 이벤트 ==========
  function bindEvents() {
    ['inCurMp','inMaxMp','inWis','inLocation','inState'].forEach((k) => {
      dom[k].addEventListener('input', () => { if (!state.running) renderAll(); saveLast(); });
      dom[k].addEventListener('change', () => { if (!state.running) renderAll(); saveLast(); });
    });
    ['chkPotion','chkMeditation','chkStaff'].forEach((k) => {
      dom[k].addEventListener('change', () => { if (!state.running) renderAll(); saveLast(); });
    });

    dom.btnStart.addEventListener('click', () => {
      if (state.running) pauseTimer();
      else startTimer();
    });
    dom.btnPause.addEventListener('click', pauseTimer);
    dom.btnReset.addEventListener('click', resetTimer);

    // 제목 바 버튼
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

    // 프리셋
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

    // 설정
    dom.chkSound.addEventListener('change', saveSettingsFromUi);
    dom.chkToast.addEventListener('change', saveSettingsFromUi);
    dom.chkMinimize.addEventListener('change', async () => {
      saveSettingsFromUi();
      if (api && api.setMinimizeOnClose) {
        await api.setMinimizeOnClose(dom.chkMinimize.checked);
      }
    });

    // 키보드 단축키
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.code === 'Space') { e.preventDefault(); dom.btnStart.click(); }
      else if (e.key.toLowerCase() === 'r') { resetTimer(); }
    });

    // Always-on-top 변경 수신
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
    const cfg = readConfig();
    S.saveLast({
      curMp: cfg.curMp,
      maxMp: cfg.maxMp,
      wis: cfg.wis,
      useBluePotion: cfg.useBluePotion,
      useMeditation: cfg.useMeditation,
      hasCrystalStaff: cfg.hasCrystalStaff,
      location: cfg.location,
      state: cfg.state
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
    if (api && api.setMinimizeOnClose) {
      api.setMinimizeOnClose(!!s.minimizeOnClose);
    }
    if (api && api.setAlwaysOnTop && s.alwaysOnTop) {
      api.setAlwaysOnTop(true);
      dom.btnPin.classList.add('active');
    }
  }

  // ========== Init ==========
  function init() {
    restoreSettings();
    restoreLast();
    bindEvents();
    renderPresets();
    renderAll();

    // 매 초 업데이트 (카운트다운 동기화)
    setInterval(() => {
      if (!state.running) renderAll();
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
