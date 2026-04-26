/**
 * Lineage MP Timer — 렌더러 컨트롤러
 * - 세그먼트 기반 실시간 MP 재계산 (실행 중 버프/위치/상태 변경 즉시 반영)
 * - pause / resume 지원 (일시정지 후 START 다시 누르면 이어서)
 * - Session Tracker, Hotkeys, Theme, Custom Location
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
    appVersion: $('app-version'),
    presetName: $('preset-name'), btnPresetSave: $('btn-preset-save'),
    presetList: $('preset-list'),
    chkSound: $('chk-sound'), chkToast: $('chk-toast'), chkMinimize: $('chk-minimize'),
    inExpDelay: $('in-exp-delay'), expDelayValue: $('exp-delay-value'),
    btnResetWindow: $('btn-reset-window'),
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
    btnHotkeyReset: $('btn-hotkey-reset'),
    // items
    itemsList: $('items-list'),
    itemsTotal: $('items-total-value'),
    btnItemsApply: $('btn-items-apply'),
    btnItemAdd: $('btn-item-add'),
    btnItemsReset: $('btn-items-reset'),
    // auto-detect (MP + EXP)
    btnAdMpRegion: $('btn-ad-mp-region'),
    btnAdExpRegion: $('btn-ad-exp-region'),
    btnAdToggle: $('btn-ad-toggle'),
    adStatus: $('ad-status'),
    adDisplay: $('ad-display'),
    adMpRegionInfo: $('ad-mp-region-info'),
    adExpRegionInfo: $('ad-exp-region-info'),
    adMpLast: $('ad-mp-last'),
    adExpLast: $('ad-exp-last'),
    adInitStatus: $('ad-init-status'),
    adMpPreview: $('ad-mp-preview'),
    adExpPreview: $('ad-exp-preview'),
    chkAdAutoStart: $('chk-ad-auto-start'),
    chkAdPreview: $('chk-ad-preview')
  };

  const THEMES = ['green', 'cyan', 'pink', 'yellow', 'purple', 'red'];

  const mpState = {
    running: false,
    paused: false,
    startedAt: null,
    startMp: 0,
    accumulatedMp: 0,
    segmentStartAt: null,
    prevConfigSnapshot: null,
    completedFired: false,
    tickTimerId: null
  };
  let tracker = S.loadTracker();
  let hotkeys = S.loadHotkeys();
  let items = S.loadItems();
  let autoDetect = S.loadAutoDetect();
  let captureTarget = null;
  const expDebounce = { trkExpStart: null, trkExpNow: null };

  // OCR / Capture state
  let ocrWorker = null;
  let ocrInitPromise = null;
  // sourceId별 stream/video 관리 — 듀얼 모니터에 영역이 분산된 경우 지원
  const captureStreams = new Map(); // sourceId → { stream, video }
  let detectInterval = null;
  let detectionRunning = false;
  const EXP_DELAY_MIN = 500;
  const EXP_DELAY_MAX = 10000;
  const EXP_DELAY_DEFAULT = 3000;
  let expAutoFormatDelayMs = EXP_DELAY_DEFAULT;
  function clampExpDelay(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return EXP_DELAY_DEFAULT;
    return Math.max(EXP_DELAY_MIN, Math.min(EXP_DELAY_MAX, Math.round(n)));
  }

  // ========== Undo / Redo ==========
  const UNDO_LIMIT = 50;
  const undoStack = [];
  const redoStack = [];
  let undoDebounceTimer = null;
  let lastSnapshotSerialized = null;
  let applyingSnapshot = false;

  function captureSnapshot() {
    return {
      curMp: dom.inCurMp.value,
      maxMp: dom.inMaxMp.value,
      wis: dom.inWis.value,
      useBluePotion: dom.chkPotion.checked,
      useMeditation: dom.chkMeditation.checked,
      hasCrystalStaff: dom.chkStaff.checked,
      location: dom.inLocation.value,
      customLocation: dom.inLocationCustom.value,
      state: dom.inState.value,
      targetPct: dom.inTargetPct.value,
      trkLevelStart: dom.trkLevelStart.value,
      trkLevelNow: dom.trkLevelNow.value,
      trkExpStart: dom.trkExpStart.value,
      trkExpNow: dom.trkExpNow.value,
      trkAdenaStart: dom.trkAdenaStart.value,
      trkAdenaNow: dom.trkAdenaNow.value,
      items: JSON.parse(JSON.stringify(items))
    };
  }

  function applySnapshot(snap) {
    if (!snap) return;
    applyingSnapshot = true;
    try {
      dom.inCurMp.value = snap.curMp ?? dom.inCurMp.value;
      dom.inMaxMp.value = snap.maxMp ?? dom.inMaxMp.value;
      dom.inWis.value = snap.wis ?? dom.inWis.value;
      dom.chkPotion.checked = !!snap.useBluePotion;
      dom.chkMeditation.checked = !!snap.useMeditation;
      dom.chkStaff.checked = !!snap.hasCrystalStaff;
      if (snap.location) dom.inLocation.value = snap.location;
      dom.inLocationCustom.value = snap.customLocation ?? dom.inLocationCustom.value;
      if (snap.state) dom.inState.value = snap.state;
      dom.inTargetPct.value = snap.targetPct ?? dom.inTargetPct.value;
      dom.trkLevelStart.value = snap.trkLevelStart ?? dom.trkLevelStart.value;
      dom.trkLevelNow.value = snap.trkLevelNow ?? dom.trkLevelNow.value;
      dom.trkExpStart.value = snap.trkExpStart ?? dom.trkExpStart.value;
      dom.trkExpNow.value = snap.trkExpNow ?? dom.trkExpNow.value;
      dom.trkAdenaStart.value = snap.trkAdenaStart ?? dom.trkAdenaStart.value;
      dom.trkAdenaNow.value = snap.trkAdenaNow ?? dom.trkAdenaNow.value;
      if (snap.items) items = JSON.parse(JSON.stringify(snap.items));

      updateCustomLocationVisibility();
      updateQuickPctActive();
      renderItems();
      if (mpState.running) onConfigChangedWhileRunning();
      else renderAll();
      renderTracker();
      saveLast();
      saveTrackerCurrent();
      S.saveItems(items);
    } finally {
      applyingSnapshot = false;
    }
  }

  function pushUndoImmediate() {
    if (applyingSnapshot) return;
    const snap = captureSnapshot();
    const ser = JSON.stringify(snap);
    if (ser === lastSnapshotSerialized) return;
    lastSnapshotSerialized = ser;
    undoStack.push(snap);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  function pushUndo() {
    if (applyingSnapshot) return;
    clearTimeout(undoDebounceTimer);
    undoDebounceTimer = setTimeout(pushUndoImmediate, 500);
  }

  function undo() {
    clearTimeout(undoDebounceTimer);
    // 디바운스 대기 중인 최신 변경이 있으면 먼저 커밋
    const pending = captureSnapshot();
    const pendingSer = JSON.stringify(pending);
    if (pendingSer !== lastSnapshotSerialized) {
      lastSnapshotSerialized = pendingSer;
      undoStack.push(pending);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    if (undoStack.length < 2) {
      flashHint('↶ 되돌릴 내용이 없습니다.');
      return;
    }
    const current = undoStack.pop();
    redoStack.push(current);
    const prev = undoStack[undoStack.length - 1];
    lastSnapshotSerialized = JSON.stringify(prev);
    applySnapshot(prev);
    flashHint('↶ 되돌리기');
  }

  function redo() {
    if (redoStack.length === 0) {
      flashHint('↷ 다시 실행할 내용이 없습니다.');
      return;
    }
    const snap = redoStack.pop();
    lastSnapshotSerialized = JSON.stringify(snap);
    undoStack.push(snap);
    applySnapshot(snap);
    flashHint('↷ 다시 실행');
  }

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

  /**
   * 경험치 % 입력 파싱: 소수점 없이 정수만 입력하면 마지막 4자리를 소수부로 자동 변환.
   *   "874564" → 87.4564
   *   "54321"  → 5.4321
   *   "4321"   → 0.4321
   *   "21"     → 0.0021
   *   "25.4321" (소수점 직접 입력) → 25.4321 그대로
   *   "" or invalid → 0
   * 반환은 0~100 범위로 클램프된 숫자.
   */
  function parseExpPct(raw) {
    if (raw == null) return 0;
    const s = String(raw).trim();
    if (!s) return 0;
    // 사용자가 직접 소수점을 찍은 경우: 그대로 파싱
    if (s.includes('.')) {
      const n = parseFloat(s);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(100, n));
    }
    // 정수만 입력: 숫자 외 제거 후 마지막 4자리를 소수부로
    const digits = s.replace(/[^0-9]/g, '');
    if (!digits) return 0;
    const padded = digits.padStart(5, '0'); // 최소 5자리 확보 (앞=정수부, 뒤4=소수부)
    const intPart = padded.slice(0, -4);
    const decPart = padded.slice(-4);
    const n = parseFloat(`${parseInt(intPart, 10)}.${decPart}`);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function formatExpPct(n) {
    const v = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    return v.toFixed(4);
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

  function updateQuickPctActive() {
    const pct = parseInt(dom.inTargetPct.value, 10);
    document.querySelectorAll('.quick-pct button').forEach((b) => {
      b.classList.toggle('active', parseInt(b.getAttribute('data-pct'), 10) === pct);
    });
  }

  // ========== Segment-based Simulation ==========
  function cloneCfg(cfg) { return JSON.parse(JSON.stringify(cfg)); }

  function cfgAffectsRecovery(a, b) {
    if (!a || !b) return true;
    // 회복 속도에 실제 영향을 주는 속성만 — targetPct/maxMp는 목표만 바꾸므로 누적에 영향 없음
    const keys = ['wis','useBluePotion','useMeditation','hasCrystalStaff',
                  'location','customLocationBonus','state'];
    return keys.some((k) => a[k] !== b[k]);
  }

  /** 이전 config 기준으로 현재까지의 MP를 누적에 반영 + 세그먼트 재시작
   *  segmentStartAt을 "이전 config의 마지막 틱 경계"로 snap해서
   *  게임 내 실제 틱 주기와 어긋나지 않게 유지한다. */
  function commitSegment() {
    if (!mpState.segmentStartAt || !mpState.prevConfigSnapshot) return;
    const prev = mpState.prevConfigSnapshot;
    if (prev.state !== 'blocked') {
      const recovery = E.calculateTickRecovery(prev);
      const interval = E.calculateTickInterval(prev.state);
      if (interval > 0 && recovery > 0) {
        const elapsedSec = Math.max(0, (Date.now() - mpState.segmentStartAt) / 1000);
        const ticks = Math.floor(elapsedSec / interval);
        mpState.accumulatedMp += ticks * recovery;
        // 마지막 틱 경계로 snap → 다음 틱 타이밍이 게임과 동기화 유지
        mpState.segmentStartAt += ticks * interval * 1000;
        return;
      }
    }
    mpState.segmentStartAt = Date.now();
  }

  /** 실행 중 config 변경 시 즉시 호출 */
  function onConfigChangedWhileRunning() {
    if (!mpState.running) return;
    const newCfg = readMpConfig();
    if (cfgAffectsRecovery(mpState.prevConfigSnapshot, newCfg)) {
      commitSegment();
    }
    // 회복량 영향 없는 변경(목표%/maxMp)은 commit 없이 snapshot만 갱신 + 재계산
    mpState.prevConfigSnapshot = cloneCfg(newCfg);
    tickMp();
  }

  function getSimulatedMp(cfg) {
    // 시작되지 않았으면 입력값 그대로
    if (!mpState.startedAt) return cfg.curMp;
    let segMp = 0;
    if (mpState.running && mpState.segmentStartAt && mpState.prevConfigSnapshot) {
      const prev = mpState.prevConfigSnapshot;
      if (prev.state !== 'blocked') {
        const segElapsed = Math.max(0, (Date.now() - mpState.segmentStartAt) / 1000);
        const recovery = E.calculateTickRecovery(prev);
        const interval = E.calculateTickInterval(prev.state);
        if (interval > 0 && recovery > 0) {
          const segTicks = Math.floor(segElapsed / interval);
          segMp = segTicks * recovery;
        }
      }
    }
    return Math.min(cfg.maxMp, mpState.startMp + mpState.accumulatedMp + segMp);
  }

  // ========== Render ==========
  function renderAll() {
    const cfg = readMpConfig();
    const target = effectiveTargetMp(cfg);
    // running/paused 상태에서는 status 건드리지 않음 (각 함수가 관리)
    renderBreakdown(cfg);
    renderTickInfo(cfg);
    if (mpState.running) {
      tickMp();
      return;
    }
    if (mpState.paused) {
      // paused 시 현재 누적만 반영, 시간 표시는 그대로
      const simCur = Math.min(cfg.maxMp, mpState.startMp + mpState.accumulatedMp);
      renderGauge(simCur, cfg.maxMp, target);
      updatePausedRemaining(cfg, simCur, target);
      return;
    }
    // idle 경로
    const total = E.calculateFullMpTime(cfg.curMp, target, cfg);
    renderGauge(cfg.curMp, cfg.maxMp, target);
    renderIdleTimes(total, cfg);
    if (cfg.curMp >= target) {
      const label = cfg.targetPct >= 100 ? 'FULL' : `${cfg.targetPct}%`;
      setStatus('done', label);
      document.body.classList.add('state-done');
    } else if (cfg.state === 'blocked') {
      setStatus('blocked', 'BLOCKED');
      document.body.classList.remove('state-done');
    } else {
      setStatus('idle', 'IDLE');
      document.body.classList.remove('state-done');
    }
  }

  function updatePausedRemaining(cfg, simCur, target) {
    // paused 상태에서는 마지막 틱 경계부터 멈춰있으므로 "다음 틱 = interval" 로 고정 표시
    const recovery = E.calculateTickRecovery(cfg);
    const interval = E.calculateTickInterval(cfg.state);
    const needed = Math.max(0, target - simCur);
    let remaining = 0;
    if (needed > 0) {
      if (cfg.state === 'blocked' || recovery <= 0 || interval <= 0) remaining = Infinity;
      else remaining = Math.ceil(needed / recovery) * interval;
    }
    if (Number.isFinite(remaining)) {
      dom.timeRemaining.textContent = E.formatDuration(remaining);
      dom.timeComplete.textContent = E.formatCompletionTime(remaining);
    } else {
      dom.timeRemaining.textContent = '∞';
      dom.timeComplete.textContent = '--:--:--';
    }
  }

  function renderIdleTimes(total, cfg) {
    if (!Number.isFinite(total)) {
      dom.timeRemaining.textContent = '∞';
      dom.timeComplete.textContent = '--:--:--';
      return;
    }
    dom.timeRemaining.textContent = E.formatDuration(total);
    dom.timeComplete.textContent = E.formatCompletionTime(total);
  }

  function renderGauge(cur, max, target) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
    const rounded = Math.round(cur);
    dom.mpCurrent.textContent = rounded;
    dom.mpMax.textContent = max;
    dom.mpPercent.textContent = `${pct.toFixed(1)}%`;
    dom.barFill.style.width = `${pct}%`;
    const goalReached = target ? cur >= target : cur >= max;
    dom.barFill.classList.toggle('full', goalReached && max > 0);

    // 실행/일시정지 중엔 curMp 입력 필드를 시뮬 값으로 동기화 + readonly
    const isActive = mpState.running || mpState.paused;
    if (isActive) {
      if (document.activeElement !== dom.inCurMp) dom.inCurMp.value = rounded;
      dom.inCurMp.readOnly = true;
      dom.inCurMp.classList.add('synced');
    } else {
      dom.inCurMp.readOnly = false;
      dom.inCurMp.classList.remove('synced');
    }
  }
  function renderTickInfo(cfg) {
    const recovery = E.calculateTickRecovery(cfg);
    const interval = E.calculateTickInterval(cfg.state);
    dom.tickRecovery.textContent = cfg.state === 'blocked' ? '회복 불가' : `+${recovery} MP / ${interval}s`;
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

  function updateStartButton() {
    if (mpState.running) dom.btnStart.textContent = '⏸ PAUSE';
    else if (mpState.paused) dom.btnStart.textContent = '▶ RESUME';
    else dom.btnStart.textContent = '▶ START';
  }

  function updateDocumentTitle(remainingSec) {
    if (!mpState.running && !mpState.paused) {
      document.title = 'Lineage MP Timer';
      return;
    }
    if (!Number.isFinite(remainingSec)) {
      document.title = '∞ · Lineage MP Timer';
      return;
    }
    const prefix = mpState.paused ? '⏸' : '⏱';
    document.title = `${prefix} ${E.formatDuration(remainingSec)} · Lineage MP Timer`;
  }

  // ========== Timer ==========
  function startTimer() {
    const cfg = readMpConfig();
    const target = effectiveTargetMp(cfg);
    if (cfg.state === 'blocked') { flashHint('회복 불가 상태입니다.'); return; }

    const isResume = mpState.paused && !mpState.completedFired;

    if (!isResume) {
      // 이미 목표 도달 상태면 시작 안 함
      if (cfg.curMp >= target) {
        flashHint(cfg.targetPct >= 100 ? '이미 MP가 가득 찼습니다.' : `이미 목표 ${cfg.targetPct}% 도달.`);
        return;
      }
      mpState.startMp = cfg.curMp;
      mpState.accumulatedMp = 0;
      mpState.startedAt = Date.now();
      mpState.completedFired = false;
    } else {
      // Resume: 현재 누적 기준 이미 목표 초과인지 체크
      const simCur = Math.min(cfg.maxMp, mpState.startMp + mpState.accumulatedMp);
      if (simCur >= target) {
        flashHint('이미 목표 도달. 리셋 후 새로 시작하세요.');
        return;
      }
    }
    mpState.segmentStartAt = Date.now();
    mpState.prevConfigSnapshot = cloneCfg(cfg);
    mpState.running = true;
    mpState.paused = false;
    document.body.classList.remove('state-done');
    setStatus('running', 'RUNNING');

    if (mpState.tickTimerId) clearInterval(mpState.tickTimerId);
    mpState.tickTimerId = setInterval(tickMp, 1000);
    updateStartButton();
    tickMp();
  }

  function pauseTimer() {
    if (!mpState.running) return;
    commitSegment();
    if (mpState.tickTimerId) { clearInterval(mpState.tickTimerId); mpState.tickTimerId = null; }
    mpState.running = false;
    mpState.paused = true;
    setStatus('paused', 'PAUSED');
    const cfg = readMpConfig();
    const target = effectiveTargetMp(cfg);
    const simCur = Math.min(cfg.maxMp, mpState.startMp + mpState.accumulatedMp);
    renderGauge(simCur, cfg.maxMp, target);
    updatePausedRemaining(cfg, simCur, target);
    updateStartButton();
  }

  function resetTimer() {
    if (mpState.tickTimerId) { clearInterval(mpState.tickTimerId); mpState.tickTimerId = null; }
    mpState.running = false;
    mpState.paused = false;
    mpState.startedAt = null;
    mpState.startMp = 0;
    mpState.accumulatedMp = 0;
    mpState.segmentStartAt = null;
    mpState.prevConfigSnapshot = null;
    mpState.completedFired = false;
    document.body.classList.remove('state-done');
    document.title = 'Lineage MP Timer';
    renderAll();
    updateStartButton();
  }

  /** 게임 틱 단위 simCur와 별개로, remaining은 매초 부드럽게 감소해야 함
   *  공식: remaining = (다음 틱까지 시간) + max(0, 필요 틱 수 - 1) * interval */
  function computeSmoothRemaining(cfg, simCur, target) {
    if (simCur >= target) return 0;
    const recovery = E.calculateTickRecovery(cfg);
    const interval = E.calculateTickInterval(cfg.state);
    if (cfg.state === 'blocked' || recovery <= 0 || interval <= 0) return Infinity;

    const needed = target - simCur;
    const ticksNeeded = Math.ceil(needed / recovery);
    // 현재 세그먼트 내에서 다음 틱까지 남은 시간 (0..interval)
    const segElapsed = mpState.segmentStartAt
      ? Math.max(0, (Date.now() - mpState.segmentStartAt) / 1000)
      : 0;
    const sinceLast = segElapsed % interval;
    const toNextTick = sinceLast === 0 ? interval : (interval - sinceLast);
    return toNextTick + Math.max(0, ticksNeeded - 1) * interval;
  }

  function tickMp() {
    const cfg = readMpConfig();
    const target = effectiveTargetMp(cfg);
    const simCur = getSimulatedMp(cfg);
    const remaining = computeSmoothRemaining(cfg, simCur, target);

    renderGauge(simCur, cfg.maxMp, target);
    if (Number.isFinite(remaining)) {
      dom.timeRemaining.textContent = E.formatDuration(remaining);
      dom.timeComplete.textContent = E.formatCompletionTime(remaining);
    } else {
      dom.timeRemaining.textContent = '∞';
      dom.timeComplete.textContent = '--:--:--';
    }
    renderTickInfo(cfg);
    renderBreakdown(cfg);
    updateDocumentTitle(remaining);

    if (simCur >= target) onComplete(cfg);
  }

  function onComplete(cfg) {
    if (mpState.completedFired) return;
    mpState.completedFired = true;
    if (mpState.tickTimerId) { clearInterval(mpState.tickTimerId); mpState.tickTimerId = null; }
    mpState.running = false;
    mpState.paused = false;
    document.body.classList.add('state-done');
    const target = effectiveTargetMp(cfg);
    const isFull = cfg.targetPct >= 100;
    setStatus('done', isFull ? 'FULL!' : `${cfg.targetPct}%!`);
    renderGauge(target, cfg.maxMp, target);
    dom.timeRemaining.textContent = '00:00:00';
    document.title = '🎉 MP 완료 · Lineage MP Timer';
    updateStartButton();
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

  // ========== Custom Location ==========
  function updateCustomLocationVisibility() {
    dom.customLocationWrap.style.display = (dom.inLocation.value === 'custom') ? '' : 'none';
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
    updateQuickPctActive();
    if (mpState.running) onConfigChangedWhileRunning();
    else renderAll();
    pushUndoImmediate();
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
        exp: parseExpPct(dom.trkExpStart.value),
        adena: $clampInt(dom.trkAdenaStart.value, 0, 9999999999, 0)
      },
      current: {
        level: $clampInt(dom.trkLevelNow.value, 1, 99, 1),
        exp: parseExpPct(dom.trkExpNow.value),
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
    dom.trkExpDiff.textContent = `${dExp >= 0 ? '+' : ''}${dExp.toFixed(4)}%`;
    dom.trkExpDiff.classList.toggle('negative', dExp < 0);
    dom.trkAdenaDiff.textContent = `${dAdena >= 0 ? '+' : ''}${formatNumber(dAdena)}`;
    dom.trkAdenaDiff.classList.toggle('negative', dAdena < 0);
    let elapsedSec = 0;
    if (tracker.active && tracker.startedAt) {
      elapsedSec = Math.max(0, Math.floor((Date.now() - tracker.startedAt) / 1000));
    }
    dom.trkTime.textContent = E.formatDuration(elapsedSec);
    // 너무 짧은 경과 시 분모가 작아 rate가 비현실적으로 크게 나와 혼란 → 30초 이후부터 표시
    if (elapsedSec >= 30) {
      const hours = elapsedSec / 3600;
      dom.trkExpRate.textContent = `${dExp >= 0 ? '+' : ''}${(dExp / hours).toFixed(4)}%/h`;
      dom.trkAdenaRate.textContent = `${dAdena >= 0 ? '+' : ''}${formatNumber(dAdena / hours)}/h`;
    } else if (tracker.active && elapsedSec > 0) {
      dom.trkExpRate.textContent = '측정 중...';
      dom.trkAdenaRate.textContent = '측정 중...';
    } else {
      dom.trkExpRate.textContent = '+0.0000%/h';
      dom.trkAdenaRate.textContent = '+0/h';
    }
  }
  function restoreTrackerInputs() {
    if (tracker.start) {
      dom.trkLevelStart.value = tracker.start.level ?? 1;
      dom.trkExpStart.value = formatExpPct(tracker.start.exp ?? 0);
      dom.trkAdenaStart.value = tracker.start.adena ?? 0;
    }
    if (tracker.current) {
      dom.trkLevelNow.value = tracker.current.level ?? 1;
      dom.trkExpNow.value = formatExpPct(tracker.current.exp ?? 0);
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

  // ========== MP Auto-detect (OCR) ==========
  function setAdStatus(label, kind) {
    if (!dom.adStatus) return;
    dom.adStatus.textContent = label;
    dom.adStatus.className = 'ad-status-badge' + (kind ? ' ' + kind : '');
  }

  function formatRegion(r) {
    if (!r) return '미지정';
    const mon = r.displayLabel ? `[${r.displayLabel}] ` : '';
    return `${mon}${r.x}, ${r.y} · ${r.width}×${r.height}`;
  }
  function renderAutoDetectInfo() {
    if (!dom.adDisplay) return;
    // 모니터 표시: 두 영역 monitor 다른지 표시
    const mpMon = autoDetect.mpRegion && autoDetect.mpRegion.displayLabel;
    const expMon = autoDetect.expRegion && autoDetect.expRegion.displayLabel;
    let monText = '미지정';
    if (mpMon && expMon) {
      monText = (mpMon === expMon) ? mpMon : `MP=${mpMon} / EXP=${expMon}`;
    } else if (mpMon) monText = mpMon;
    else if (expMon) monText = expMon;
    dom.adDisplay.textContent = monText;
    if (dom.adMpRegionInfo) dom.adMpRegionInfo.textContent = formatRegion(autoDetect.mpRegion);
    if (dom.adExpRegionInfo) dom.adExpRegionInfo.textContent = formatRegion(autoDetect.expRegion);
    if (dom.btnAdToggle) {
      dom.btnAdToggle.textContent = autoDetect.enabled
        ? '⏹ 자동 감지 중지'
        : '▶ 자동 감지 시작';
    }
    setAdStatus(autoDetect.enabled ? 'ON' : 'OFF', autoDetect.enabled ? 'on' : '');
  }

  async function initOcrWorker() {
    if (ocrWorker) return ocrWorker;
    if (ocrInitPromise) return ocrInitPromise;
    if (typeof Tesseract === 'undefined') {
      throw new Error('Tesseract.js 라이브러리가 로드되지 않았습니다. (CDN/CSP 확인)');
    }
    console.log('[OCR] Tesseract worker 초기화 시작...');
    if (dom.adInitStatus) dom.adInitStatus.textContent = '⏳ 시작...';

    const TIMEOUT_MS = 60000;
    const start = Date.now();
    let lastStatus = 'starting';

    ocrInitPromise = (async () => {
      try {
        // 패키징된 앱은 로컬 파일 (인터넷 차단 환경 대응), dev는 CDN
        let resourcePaths = null;
        if (api && api.getResourcePaths) {
          try { resourcePaths = await api.getResourcePaths(); } catch (e) { console.warn('[OCR] resource paths fetch failed:', e); }
        }
        const useLocal = !!resourcePaths;
        console.log('[OCR] resource source:', useLocal ? 'LOCAL (packaged)' : 'CDN (dev)');
        if (dom.adInitStatus) dom.adInitStatus.textContent = useLocal ? '⏳ 로컬 OCR 파일 로드...' : '⏳ CDN OCR 파일 로드...';

        const opts = useLocal ? {
          workerPath: resourcePaths.workerPath,
          corePath: resourcePaths.corePath,
          langPath: resourcePaths.langPath,
          // file:// 환경에서 blob URL 워커가 file:// 리소스를 cross-origin으로 막는 문제 방지
          workerBlobURL: false,
          cacheMethod: 'none',
          gzip: true
        } : {
          workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
          corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5',
          langPath: 'https://tessdata.projectnaptha.com/4.0.0',
          cacheMethod: 'write'
        };
        opts.logger = (m) => {
          if (m && m.status) {
            const pct = m.progress != null ? Math.round(m.progress * 100) + '%' : '';
            lastStatus = m.status + (pct ? ' ' + pct : '');
            const elapsed = Math.round((Date.now() - start) / 1000);
            console.log('[Tesseract]', lastStatus, '+' + elapsed + 's');
            if (dom.adInitStatus) dom.adInitStatus.textContent = '⏳ ' + lastStatus + ' (+' + elapsed + 's)';
          }
        };
        opts.errorHandler = (e) => console.error('[Tesseract worker error]', e);
        const createPromise = Tesseract.createWorker('eng', 1, opts);

        const timeoutPromise = new Promise((_, rej) => {
          setTimeout(() => rej(new Error(
            'OCR 워커 초기화 타임아웃 (' + (TIMEOUT_MS / 1000) + 's). 마지막 상태: ' + lastStatus +
            '. CDN 접속이 차단됐거나 매우 느릴 수 있음. F12 콘솔 [Tesseract] 로그 확인.'
          )), TIMEOUT_MS);
        });

        const w = await Promise.race([createPromise, timeoutPromise]);
        try {
          await w.setParameters({
            // MP(50/327)와 경험치(87.4321) 모두 인식하도록 통합 화이트리스트
            tessedit_char_whitelist: '0123456789/. ',
            tessedit_pageseg_mode: '7'
          });
        } catch (e) { console.warn('[OCR] setParameters skipped:', e && e.message); }
        const total = Math.round((Date.now() - start) / 1000);
        console.log('[OCR] Tesseract worker 초기화 완료 (총 ' + total + 's)');
        if (dom.adInitStatus) dom.adInitStatus.textContent = '✅ 준비 완료 (' + total + 's)';
        ocrWorker = w;
        return w;
      } catch (err) {
        console.error('[OCR] Tesseract worker init 실패:', err);
        ocrInitPromise = null;
        if (dom.adInitStatus) dom.adInitStatus.textContent = '❌ ' + (err.message || err);
        throw err;
      }
    })();
    return ocrInitPromise;
  }

  async function getCaptureStreamFor(sourceId) {
    if (!sourceId) throw new Error('소스 ID 없음');
    const cached = captureStreams.get(sourceId);
    if (cached) return cached;
    console.log('[Capture] 새 스트림 시작:', sourceId);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: 1, maxWidth: 4096,
          minHeight: 1, maxHeight: 2160
        }
      }
    });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('video timeout (' + sourceId + ')')), 5000);
      video.onloadedmetadata = () => { clearTimeout(t); res(); };
      video.onerror = (e) => { clearTimeout(t); rej(e); };
    });
    try { await video.play(); } catch (_) {}
    const entry = { stream, video };
    captureStreams.set(sourceId, entry);
    return entry;
  }

  function stopAllCaptureStreams() {
    captureStreams.forEach(({ stream }) => {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    });
    captureStreams.clear();
  }

  async function setupCaptureStreams() {
    // 사용 중인 모든 sourceId의 스트림 준비
    const sourceIds = new Set();
    if (autoDetect.mpRegion && autoDetect.mpRegion.sourceId) sourceIds.add(autoDetect.mpRegion.sourceId);
    if (autoDetect.expRegion && autoDetect.expRegion.sourceId) sourceIds.add(autoDetect.expRegion.sourceId);
    if (sourceIds.size === 0) throw new Error('지정된 영역의 sourceId가 없습니다');
    // 사용 안 하는 stream 정리
    Array.from(captureStreams.keys()).forEach((sid) => {
      if (!sourceIds.has(sid)) {
        const cap = captureStreams.get(sid);
        try { cap.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        captureStreams.delete(sid);
      }
    });
    for (const sid of sourceIds) {
      await getCaptureStreamFor(sid);
    }
  }

  function preprocessCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    // 그레이스케일 + threshold (반전 자동 결정)
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    }
    const avg = sum / (d.length / 4);
    // 평균 휘도가 어두우면 글자가 밝은 것 → 흰 배경 검은 글자로 반전
    const invert = avg < 128;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      let bw = v > 128 ? 255 : 0;
      if (invert) bw = 255 - bw;
      d[i] = bw; d[i + 1] = bw; d[i + 2] = bw;
    }
    ctx.putImageData(img, 0, 0);
  }

  function captureRegionToCanvas(region) {
    if (!region) return null;
    const cap = captureStreams.get(region.sourceId);
    if (!cap || !cap.video) {
      throw new Error('해당 영역의 캡처 스트림이 없습니다. (sourceId: ' + region.sourceId + ')');
    }
    const scale = region.scaleFactor || 1;
    const sx = Math.max(0, Math.round(region.x * scale));
    const sy = Math.max(0, Math.round(region.y * scale));
    const sw = Math.max(1, Math.round(region.width * scale));
    const sh = Math.max(1, Math.round(region.height * scale));
    const upscale = 3;
    const canvas = document.createElement('canvas');
    canvas.width = sw * upscale;
    canvas.height = sh * upscale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    try {
      ctx.drawImage(cap.video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      throw new Error('캡처 실패: ' + e.message);
    }
    if (autoDetect.preprocess !== false) preprocessCanvas(canvas);
    return canvas;
  }

  function updatePreview(targetEl, canvas) {
    if (!targetEl) return;
    if (!autoDetect.showPreview) {
      targetEl.removeAttribute('src');
      return;
    }
    try {
      targetEl.src = canvas.toDataURL('image/png');
    } catch (_) { /* ignore */ }
  }

  async function ocrMpRegion() {
    if (!autoDetect.mpRegion) return null;
    const canvas = captureRegionToCanvas(autoDetect.mpRegion);
    if (!canvas) return null;
    updatePreview(dom.adMpPreview, canvas);
    const w = await initOcrWorker();
    const res = await w.recognize(canvas);
    const text = ((res && res.data && res.data.text) || '').trim();
    const confidence = (res && res.data && res.data.confidence) || 0;

    // 1순위: 슬래시/파이프/콜론 구분자
    let m = text.match(/(\d{1,5})\s*[\/\\|:]\s*(\d{1,5})/);
    // 2순위: 슬래시 인식 못한 경우 — 두 숫자가 비숫자로 구분된 패턴
    if (!m) m = text.match(/(\d{1,5})[^\d]+(\d{1,5})/);
    // 3순위: 텍스트 안의 첫 두 숫자
    if (!m) {
      const nums = text.match(/\d{1,5}/g);
      if (nums && nums.length >= 2) m = [null, nums[0], nums[1]];
    }
    if (!m) return { text, confidence, parsed: null };
    const cur = parseInt(m[1], 10);
    const max = parseInt(m[2], 10);
    if (!Number.isFinite(cur) || !Number.isFinite(max)) {
      return { text, confidence, parsed: null };
    }
    return { text, confidence, parsed: { cur, max } };
  }

  async function ocrExpRegion() {
    if (!autoDetect.expRegion) return null;
    const canvas = captureRegionToCanvas(autoDetect.expRegion);
    if (!canvas) return null;
    updatePreview(dom.adExpPreview, canvas);
    const w = await initOcrWorker();
    const res = await w.recognize(canvas);
    const text = ((res && res.data && res.data.text) || '').trim();
    const confidence = (res && res.data && res.data.confidence) || 0;
    // "87.4321" 또는 "87.4321%" — 첫 소수 패턴 또는 정수 (5자리 이상이면 87.4321 형태로 변환)
    let parsed = null;
    const decMatch = text.match(/(\d{1,3})\s*\.\s*(\d{1,4})/);
    if (decMatch) {
      const intPart = parseInt(decMatch[1], 10);
      const decPart = decMatch[2].padEnd(4, '0').slice(0, 4);
      const n = parseFloat(intPart + '.' + decPart);
      if (Number.isFinite(n) && n >= 0 && n <= 100) parsed = { exp: n };
    } else {
      // 점이 인식 안 됐을 가능성 → 5자리 이상 정수면 마지막 4자리를 소수부로 (parseExpPct 로직)
      const intOnly = text.replace(/[^0-9]/g, '');
      if (intOnly && intOnly.length >= 4) {
        const n = parseExpPct(intOnly);
        if (n >= 0 && n <= 100) parsed = { exp: n };
      }
    }
    return { text, confidence, parsed };
  }

  // Sanity check: confidence가 신뢰성 낮을 때 결과 자체로 검증
  function isValidMpParsed(p) {
    return p && Number.isFinite(p.cur) && Number.isFinite(p.max)
      && p.cur >= 0 && p.max > 0 && p.max <= 99999 && p.cur <= p.max;
  }
  function isValidExpParsed(p) {
    return p && Number.isFinite(p.exp) && p.exp >= 0 && p.exp <= 100;
  }

  async function runDetectionTick() {
    if (detectionRunning) return; // 이전 틱 진행 중이면 스킵
    detectionRunning = true;
    const threshold = (typeof autoDetect.confidenceThreshold === 'number') ? autoDetect.confidenceThreshold : 0;
    try {
      // MP 영역
      if (autoDetect.mpRegion) {
        try {
          const r = await ocrMpRegion();
          if (r) {
            const validParsed = isValidMpParsed(r.parsed);
            const passConfidence = r.confidence >= threshold;
            if (validParsed && passConfidence) {
              const { cur, max } = r.parsed;
              const prevCur = parseInt(dom.inCurMp.value, 10) || 0;
              const prevMax = parseInt(dom.inMaxMp.value, 10) || 0;
              let changed = false;
              if (cur !== prevCur) { dom.inCurMp.value = cur; changed = true; }
              if (max !== prevMax) { dom.inMaxMp.value = max; changed = true; }
              if (changed) {
                if (mpState.running) onConfigChangedWhileRunning();
                else renderAll();
                saveLast();
                // 자동 START — idle 상태이고 cur < target이면 타이머 시작
                if (autoDetect.autoStart && !mpState.running && !mpState.paused) {
                  const cfg = readMpConfig();
                  const tgt = effectiveTargetMp(cfg);
                  if (cfg.curMp < tgt && cfg.state !== 'blocked') {
                    try { startTimer(); } catch (_) {}
                  }
                }
              }
              const confLabel = r.confidence > 0 ? ` · ${Math.round(r.confidence)}%` : '';
              dom.adMpLast.textContent = `✅ ${cur}/${max}${confLabel}`;
            } else if (r.parsed && !validParsed) {
              dom.adMpLast.textContent = `🟡 ${r.parsed.cur}/${r.parsed.max} (범위 벗어남)`;
            } else if (r.parsed) {
              dom.adMpLast.textContent = `🟡 ${r.parsed.cur}/${r.parsed.max} · ${Math.round(r.confidence)}% (낮음)`;
            } else {
              dom.adMpLast.textContent = `❌ "${(r.text || '???').slice(0, 20)}"`;
            }
          }
        } catch (e) {
          dom.adMpLast.textContent = '⚠️ ' + (e.message || e);
        }
      }
      // 경험치 영역
      if (autoDetect.expRegion) {
        try {
          const r = await ocrExpRegion();
          if (r) {
            const validParsed = isValidExpParsed(r.parsed);
            const passConfidence = r.confidence >= threshold;
            if (validParsed && passConfidence) {
              const exp = r.parsed.exp;
              const prev = parseExpPct(dom.trkExpNow.value);
              if (Math.abs(exp - prev) > 0.0001) {
                dom.trkExpNow.value = formatExpPct(exp);
                renderTracker();
                saveTrackerCurrent();
              }
              const confLabel = r.confidence > 0 ? ` · ${Math.round(r.confidence)}%` : '';
              dom.adExpLast.textContent = `✅ ${formatExpPct(exp)}%${confLabel}`;
            } else if (r.parsed && !validParsed) {
              dom.adExpLast.textContent = `🟡 ${formatExpPct(r.parsed.exp)}% (범위 벗어남)`;
            } else if (r.parsed) {
              dom.adExpLast.textContent = `🟡 ${formatExpPct(r.parsed.exp)}% · ${Math.round(r.confidence)}% (낮음)`;
            } else {
              dom.adExpLast.textContent = `❌ "${(r.text || '???').slice(0, 20)}"`;
            }
          }
        } catch (e) {
          dom.adExpLast.textContent = '⚠️ ' + (e.message || e);
        }
      }
    } catch (e) {
      console.error('[AutoDetect] tick error:', e);
    } finally {
      detectionRunning = false;
    }
  }

  async function startAutoDetect() {
    const hasMp = !!(autoDetect.mpRegion && autoDetect.mpRegion.sourceId);
    const hasExp = !!(autoDetect.expRegion && autoDetect.expRegion.sourceId);
    if (!hasMp && !hasExp) {
      flashHint('먼저 [📷 MP 영역] 또는 [📷 경험치 영역]을 지정하세요.');
      return;
    }
    setAdStatus('초기화...', 'on');
    if (dom.adInitStatus) dom.adInitStatus.textContent = '⏳ 캡처 스트림 준비 중...';
    try {
      console.log('[AutoDetect] 시작 시도', {
        mpRegion: autoDetect.mpRegion, expRegion: autoDetect.expRegion
      });
      await setupCaptureStreams();
      console.log('[AutoDetect] capture streams OK, count=', captureStreams.size);
      if (dom.adInitStatus) dom.adInitStatus.textContent = '⏳ OCR 워커 초기화...';
      await initOcrWorker();
      console.log('[AutoDetect] OCR worker OK');
      autoDetect.enabled = true;
      S.saveAutoDetect(autoDetect);
      renderAutoDetectInfo();
      if (detectInterval) clearInterval(detectInterval);
      detectInterval = setInterval(runDetectionTick, autoDetect.intervalMs || 1000);
      runDetectionTick();
    } catch (e) {
      const msg = (e && (e.stack || e.message)) || String(e);
      console.error('[AutoDetect] startAutoDetect FAILED:', e);
      setAdStatus('ERROR', 'error');
      const short = (e && e.message) ? e.message : '시작 실패';
      if (dom.adInitStatus) {
        dom.adInitStatus.textContent = '❌ ' + short;
        dom.adInitStatus.title = msg;
      }
      flashHint('⚠️ ' + short + ' (DevTools 자동 열림)');
      autoDetect.enabled = false;
      S.saveAutoDetect(autoDetect);
      if (api && api.openDevTools) {
        try { await api.openDevTools(); } catch (_) {}
      }
    }
  }

  function stopAutoDetect() {
    if (detectInterval) clearInterval(detectInterval);
    detectInterval = null;
    stopAllCaptureStreams();
    autoDetect.enabled = false;
    S.saveAutoDetect(autoDetect);
    renderAutoDetectInfo();
  }

  function showDisplayPicker(displays, kind) {
    const labelByKind = kind === 'exp' ? '경험치' : (kind === 'mp' ? 'MP' : '');
    const title = labelByKind ? `${labelByKind} 영역 — 모니터 선택` : '모니터 선택';
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="dialog">
          <h3>${escapeHtml(title)}</h3>
          <p>${labelByKind ? labelByKind + ' 영역이' : '영역이'} 위치한 모니터를 선택하세요. 듀얼 모니터에서 영역마다 다른 모니터를 지정할 수 있습니다.</p>
          <div class="display-grid">
            ${displays.map((d) => `
              <button class="display-card" data-id="${d.id}" type="button">
                ${d.thumbnail ? `<img src="${d.thumbnail}" alt="" />` : ''}
                <div class="display-label">${escapeHtml(d.label)}${d.primary ? ' <small>(주)</small>' : ''}</div>
                <div class="display-bounds">${d.bounds.width}×${d.bounds.height} @ ${d.scaleFactor}x</div>
              </button>
            `).join('')}
          </div>
          <button class="ghost-btn" data-cancel type="button">취소</button>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = (val) => { try { document.body.removeChild(overlay); } catch (_) {} resolve(val); };
      overlay.addEventListener('click', (e) => {
        const card = e.target.closest('.display-card');
        if (card) { close(parseInt(card.getAttribute('data-id'), 10)); return; }
        if (e.target === overlay || e.target.hasAttribute('data-cancel')) close(null);
      });
      const onKey = (e) => { if (e.key === 'Escape') { close(null); document.removeEventListener('keydown', onKey); } };
      document.addEventListener('keydown', onKey);
    });
  }

  async function onPickRegion(kind) {
    if (!api || !api.listDisplays) {
      flashHint('이 환경에서는 화면 캡처를 지원하지 않습니다.');
      return;
    }
    const wasOn = autoDetect.enabled;
    if (wasOn) stopAutoDetect();
    try {
      const displays = await api.listDisplays();
      if (!displays || !displays.length) {
        flashHint('⚠️ 디스플레이를 찾을 수 없습니다.');
        return;
      }
      // 영역 지정 시 매번 모니터 picker 표시 (1개면 자동) — 듀얼 모니터 분산 영역 지원
      let displayId;
      if (displays.length === 1) {
        displayId = displays[0].id;
      } else {
        displayId = await showDisplayPicker(displays, kind);
      }
      if (displayId == null) return;
      const selected = displays.find((d) => d.id === displayId);
      if (!selected || !selected.sourceId) {
        flashHint('⚠️ 모니터 캡처 소스를 가져올 수 없습니다.');
        return;
      }
      const result = await api.startRegionSelect(displayId);
      if (!result || !result.region) return;
      // 영역 데이터에 sourceId/displayId/scaleFactor 포함 → 영역마다 다른 모니터 가능
      const regionData = {
        x: result.region.x,
        y: result.region.y,
        width: result.region.width,
        height: result.region.height,
        sourceId: selected.sourceId,
        displayId: displayId,
        displayLabel: selected.label,
        scaleFactor: result.scaleFactor || selected.scaleFactor || 1
      };
      // 마지막 사용 모니터(legacy 호환용)도 함께 저장
      autoDetect.sourceId = selected.sourceId;
      autoDetect.displayId = displayId;
      autoDetect.displayLabel = selected.label;
      autoDetect.scaleFactor = regionData.scaleFactor;
      if (kind === 'exp') autoDetect.expRegion = regionData;
      else autoDetect.mpRegion = regionData;
      S.saveAutoDetect(autoDetect);
      renderAutoDetectInfo();
      flashHint(`✅ ${kind === 'exp' ? '경험치' : 'MP'} 영역 지정 완료 (${selected.label})`);
      if (wasOn) startAutoDetect();
    } catch (e) {
      console.error('onPickRegion failed', e);
      flashHint('⚠️ 영역 지정 실패: ' + (e.message || e));
    }
  }

  async function toggleAutoDetect() {
    if (autoDetect.enabled) stopAutoDetect();
    else await startAutoDetect();
  }

  // ========== Items (사냥 획득 아이템 판매 계산) ==========
  function itemSubtotal(it) {
    const qty = Math.max(0, Math.floor(Number(it.qty) || 0));
    const price = Math.max(0, Math.floor(Number(it.price) || 0));
    return qty * price;
  }

  function itemsGrandTotal() {
    return items.reduce((sum, it) => sum + itemSubtotal(it), 0);
  }

  function renderItems() {
    if (!dom.itemsList) return;
    const html = items.map((it, idx) => `
      <div class="item-row" data-idx="${idx}">
        <input type="text" class="item-name" data-field="name" value="${escapeHtml(it.name || '')}" placeholder="아이템 이름" title="아이템 이름" />
        <input type="number" class="item-qty" data-field="qty" min="0" step="1" value="${it.qty || 0}" title="드랍 수량" />
        <input type="number" class="item-price" data-field="price" min="0" step="100" value="${it.price || 0}" title="판매 단가 (원)" />
        <span class="item-subtotal" data-subtotal>${formatNumber(itemSubtotal(it))}</span>
        <button class="item-del" title="아이템 제거">×</button>
      </div>
    `).join('');
    dom.itemsList.innerHTML = html;
    updateItemsTotal();
  }

  function updateItemsTotal() {
    if (!dom.itemsTotal) return;
    dom.itemsTotal.textContent = formatNumber(itemsGrandTotal());
    // 각 행의 소계도 갱신
    document.querySelectorAll('#items-list .item-row').forEach((row) => {
      const idx = parseInt(row.getAttribute('data-idx'), 10);
      const it = items[idx];
      if (!it) return;
      const subtotalEl = row.querySelector('[data-subtotal]');
      if (subtotalEl) subtotalEl.textContent = formatNumber(itemSubtotal(it));
    });
  }

  function onItemFieldChange(idx, field, value) {
    const it = items[idx];
    if (!it) return;
    if (field === 'name') {
      it.name = value;
    } else if (field === 'qty') {
      it.qty = Math.max(0, Math.floor(Number(value) || 0));
    } else if (field === 'price') {
      it.price = Math.max(0, Math.floor(Number(value) || 0));
    }
    S.saveItems(items);
    updateItemsTotal();
    pushUndo();
  }

  function onItemDelete(idx) {
    items.splice(idx, 1);
    S.saveItems(items);
    renderItems();
    pushUndoImmediate();
  }

  function onItemAdd() {
    items.push({
      id: 'it-custom-' + Date.now(),
      name: '새 아이템',
      price: 0,
      qty: 0
    });
    S.saveItems(items);
    renderItems();
    pushUndoImmediate();
    // 새로 추가된 행의 이름 필드에 포커스
    const rows = document.querySelectorAll('#items-list .item-row');
    const last = rows[rows.length - 1];
    if (last) {
      const nameInput = last.querySelector('.item-name');
      if (nameInput) { nameInput.focus(); nameInput.select(); }
    }
  }

  function onItemsReset() {
    items.forEach((it) => { it.qty = 0; });
    S.saveItems(items);
    renderItems();
    pushUndoImmediate();
  }

  function onItemsApplyToAdena() {
    const total = itemsGrandTotal();
    if (total <= 0) {
      flashHint('합계가 0원입니다. 수량을 먼저 입력하세요.');
      return;
    }
    const curAdena = $clampInt(dom.trkAdenaNow.value, 0, 9999999999, 0);
    dom.trkAdenaNow.value = curAdena + total;
    // 수량 리셋 (단가는 유지)
    items.forEach((it) => { it.qty = 0; });
    S.saveItems(items);
    renderItems();
    renderTracker();
    saveTrackerCurrent();
    pushUndoImmediate();
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
            btn.title = `등록 실패 (${f.reason}).`;
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
    button.title = 'Esc=취소, Backspace=비우기';
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
  function onInputChanged(k) {
    if (mpState.running) onConfigChangedWhileRunning();
    else renderAll();
    saveLast();
    if (k === 'inTargetPct') updateQuickPctActive();
    pushUndo();
  }

  function bindEvents() {
    ['inCurMp','inMaxMp','inWis','inLocationCustom','inState','inTargetPct'].forEach((k) => {
      dom[k].addEventListener('input', () => onInputChanged(k));
      dom[k].addEventListener('change', () => onInputChanged(k));
    });

    dom.inLocation.addEventListener('change', () => {
      updateCustomLocationVisibility();
      onInputChanged('inLocation');
    });

    ['chkPotion','chkMeditation','chkStaff'].forEach((k) => {
      dom[k].addEventListener('change', () => onInputChanged(k));
    });

    // 숫자 입력 편의성
    const numericInputs = ['inCurMp','inMaxMp','inWis','inLocationCustom','inTargetPct',
      'trkLevelStart','trkLevelNow','trkExpStart','trkExpNow','trkAdenaStart','trkAdenaNow'];
    numericInputs.forEach((k) => {
      const el = dom[k];
      if (!el) return;
      el.addEventListener('focus', () => { setTimeout(() => el.select(), 0); });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          el.blur();
          if (['inCurMp','inMaxMp','inWis','inLocationCustom','inTargetPct'].includes(k)) {
            dom.btnStart.click();
          }
        }
      });
    });

    // 목표 % 빠른 선택
    document.querySelectorAll('.quick-pct button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pct = parseInt(btn.getAttribute('data-pct'), 10);
        if (!Number.isFinite(pct)) return;
        dom.inTargetPct.value = pct;
        onInputChanged('inTargetPct');
      });
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
    if (dom.inExpDelay) {
      const updateExpDelay = (persist) => {
        expAutoFormatDelayMs = clampExpDelay(dom.inExpDelay.value);
        if (dom.expDelayValue) {
          dom.expDelayValue.textContent = (expAutoFormatDelayMs / 1000).toFixed(1) + 's';
        }
        if (persist) saveSettingsFromUi();
      };
      dom.inExpDelay.addEventListener('input', () => updateExpDelay(false));
      dom.inExpDelay.addEventListener('change', () => updateExpDelay(true));
    }
    if (dom.btnResetWindow) {
      dom.btnResetWindow.addEventListener('click', () => {
        if (api && api.resetWindowSize) api.resetWindowSize();
      });
    }

    // Tracker
    [
      'trkLevelStart','trkLevelNow','trkExpStart','trkExpNow','trkAdenaStart','trkAdenaNow'
    ].forEach((k) => {
      dom[k].addEventListener('input', () => { renderTracker(); saveTrackerCurrent(); pushUndo(); });
      dom[k].addEventListener('change', () => { renderTracker(); saveTrackerCurrent(); pushUndo(); });
    });

    // 경험치 % 자동 소수점 포맷 ("874564" → "87.4564")
    //   · input 이벤트: 700ms 디바운스 후 자동 변환 (타이핑 멈추면 자동 포맷)
    //   · blur / Enter / Tab: 즉시 변환
    ['trkExpStart','trkExpNow'].forEach((k) => {
      const applyFormat = () => {
        const parsed = parseExpPct(dom[k].value);
        const formatted = formatExpPct(parsed);
        if (dom[k].value !== formatted) {
          dom[k].value = formatted;
        }
        renderTracker();
        saveTrackerCurrent();
      };
      dom[k].addEventListener('input', () => {
        clearTimeout(expDebounce[k]);
        expDebounce[k] = setTimeout(applyFormat, expAutoFormatDelayMs);
      });
      dom[k].addEventListener('blur', () => {
        clearTimeout(expDebounce[k]);
        applyFormat();
      });
      dom[k].addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Tab') {
          clearTimeout(expDebounce[k]);
          if (e.key === 'Enter') e.preventDefault();
          applyFormat();
          if (e.key === 'Enter') dom[k].blur();
        }
      });
    });
    dom.btnTrackerStart.addEventListener('click', startTracker);
    dom.btnTrackerStop.addEventListener('click', stopTracker);
    dom.btnTrackerReset.addEventListener('click', resetTracker);
    dom.btnTrackerSnap.addEventListener('click', snapshotTracker);

    // Items
    if (dom.itemsList) {
      dom.itemsList.addEventListener('input', (e) => {
        const row = e.target.closest('.item-row');
        if (!row) return;
        const idx = parseInt(row.getAttribute('data-idx'), 10);
        const field = e.target.getAttribute('data-field');
        if (field) onItemFieldChange(idx, field, e.target.value);
      });
      dom.itemsList.addEventListener('click', (e) => {
        if (e.target.classList.contains('item-del')) {
          const row = e.target.closest('.item-row');
          if (!row) return;
          const idx = parseInt(row.getAttribute('data-idx'), 10);
          onItemDelete(idx);
        }
      });
    }
    if (dom.btnItemAdd) dom.btnItemAdd.addEventListener('click', onItemAdd);
    if (dom.btnItemsReset) dom.btnItemsReset.addEventListener('click', onItemsReset);
    if (dom.btnItemsApply) dom.btnItemsApply.addEventListener('click', onItemsApplyToAdena);

    // Auto-detect
    if (dom.btnAdMpRegion) dom.btnAdMpRegion.addEventListener('click', () => onPickRegion('mp'));
    if (dom.btnAdExpRegion) dom.btnAdExpRegion.addEventListener('click', () => onPickRegion('exp'));
    if (dom.btnAdToggle) dom.btnAdToggle.addEventListener('click', toggleAutoDetect);
    if (dom.chkAdAutoStart) {
      dom.chkAdAutoStart.checked = !!autoDetect.autoStart;
      dom.chkAdAutoStart.addEventListener('change', () => {
        autoDetect.autoStart = dom.chkAdAutoStart.checked;
        S.saveAutoDetect(autoDetect);
      });
    }
    if (dom.chkAdPreview) {
      dom.chkAdPreview.checked = autoDetect.showPreview !== false;
      dom.chkAdPreview.addEventListener('change', () => {
        autoDetect.showPreview = dom.chkAdPreview.checked;
        S.saveAutoDetect(autoDetect);
        if (!dom.chkAdPreview.checked) {
          if (dom.adMpPreview) dom.adMpPreview.removeAttribute('src');
          if (dom.adExpPreview) dom.adExpPreview.removeAttribute('src');
        }
      });
    }

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

    document.addEventListener('keydown', (e) => {
      if (captureTarget) return;
      const tag = (e.target.tagName || '').toLowerCase();
      const isInput = (tag === 'input' || tag === 'select' || tag === 'textarea');

      // Undo / Redo — Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
      if (e.ctrlKey || e.metaKey) {
        const k = (e.key || '').toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          if (isInput) return; // input 내에선 브라우저 기본 텍스트 undo
          e.preventDefault();
          undo();
          return;
        }
        if ((k === 'z' && e.shiftKey) || k === 'y') {
          if (isInput) return;
          e.preventDefault();
          redo();
          return;
        }
      }

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
    s.expAutoFormatDelayMs = expAutoFormatDelayMs;
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
    expAutoFormatDelayMs = clampExpDelay(s.expAutoFormatDelayMs != null ? s.expAutoFormatDelayMs : EXP_DELAY_DEFAULT);
    if (dom.inExpDelay) dom.inExpDelay.value = String(expAutoFormatDelayMs);
    if (dom.expDelayValue) dom.expDelayValue.textContent = (expAutoFormatDelayMs / 1000).toFixed(1) + 's';
    if (api && api.setMinimizeOnClose) api.setMinimizeOnClose(!!s.minimizeOnClose);
    if (api && api.setAlwaysOnTop && s.alwaysOnTop) {
      api.setAlwaysOnTop(true);
      dom.btnPin.classList.add('active');
    }
    applyTheme(s.theme || 'green', false);
  }

  async function applyAppVersion() {
    if (!dom.appVersion) return;
    try {
      if (api && api.getVersion) {
        const v = await api.getVersion();
        if (v) dom.appVersion.textContent = 'v' + v;
      }
    } catch (_) { /* ignore */ }
  }

  // ========== Init ==========
  function init() {
    restoreSettings();
    applyAppVersion();
    restoreLast();
    restoreTrackerInputs();
    renderAllHotkeys();
    updateCustomLocationVisibility();
    bindEvents();
    renderPresets();
    renderItems();
    updateQuickPctActive();
    renderAll();
    renderTracker();
    renderAutoDetectInfo();
    applyGlobalHotkeys();
    // 초기 스냅샷 (undo 기준점)
    setTimeout(() => pushUndoImmediate(), 100);
    // 자동 감지 자동 재개 (이전 세션에서 ON 상태였으면)
    const hasAnyRegion = (autoDetect.mpRegion && autoDetect.mpRegion.sourceId) ||
                         (autoDetect.expRegion && autoDetect.expRegion.sourceId);
    if (autoDetect.enabled && hasAnyRegion) {
      setTimeout(() => startAutoDetect().catch(() => {}), 500);
    }

    // 전역 드래그&드롭 차단 — 숫자 입력 값이 드래그로 이동되는 것 방지
    window.addEventListener('dragstart', (e) => {
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        e.preventDefault();
      }
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
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
