/**
 * Lineage MP Timer — 렌더러 컨트롤러
 * - 세그먼트 기반 실시간 MP 재계산 (실행 중 버프/위치/상태 변경 즉시 반영)
 * - pause / resume 지원 (일시정지 후 START 다시 누르면 이어서)
 * - Session Tracker, Hotkeys, Theme, Custom Location
 */
(function () {
  'use strict';

  // ==========================================================================
  // Tesseract WASM stderr 노이즈 필터링
  //   tesseract-core가 인식 통계(Bottom/top/Median/quartile/Mean/SD 등)를
  //   stderr로 console.log에 마구 출력 — diagnose 어렵게 함. 패턴 매칭으로 차단.
  // ==========================================================================
  const _origConsoleLog = console.log.bind(console);
  const NOISE_PATTERNS = [
    // Tesseract WASM stderr 통계
    /^Bottom=/, /^Total count=/, /^Min=/, /^Max=/, /^Mean=/, /^SD=/, /^Range=/,
    /^Lower quartile=/, /^Upper quartile=/, /^Median=/,
    // 매 틱 반복되는 OCR 다수결 로그 (디버그 시 거슬림 — 필요 시 주석 처리)
    /^\[OCR LEVEL\] 다수결:/,
    /^\[OCR EXP/,
    /^\[OCR ADENA/,
    /^\[Tesseract\] recognizing text/
  ];
  console.log = function () {
    const first = arguments[0];
    if (typeof first === 'string') {
      for (const p of NOISE_PATTERNS) {
        if (p.test(first)) return;
      }
    }
    _origConsoleLog.apply(console, arguments);
  };

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
    btnCompact: $('btn-compact'),
    compactView: $('compact-view'),
    compactStartTime: $('compact-start-time'),
    compactElapsed: $('compact-elapsed'),
    compactExpRate: $('compact-exp-rate'),
    compactAdenaRate: $('compact-adena-rate'),
    compactLevel: $('compact-level'),
    compactLevelDiff: $('compact-level-diff'),
    compactExp: $('compact-exp'),
    compactExpDiff: $('compact-exp-diff'),
    compactAdena: $('compact-adena'),
    compactAdenaDiff: $('compact-adena-diff'),
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
    // auto-detect (MP + EXP + LEVEL + ADENA)
    btnAdMpRegion: $('btn-ad-mp-region'),
    btnAdMpBarRegion: $('btn-ad-mp-bar-region'),
    btnAdMpBarCalibrate: $('btn-ad-mp-bar-calibrate'),
    adCalibrateStatus: $('ad-calibrate-status'),
    btnAdExpRegion: $('btn-ad-exp-region'),
    btnAdLevelRegion: $('btn-ad-level-region'),
    btnAdAdenaRegion: $('btn-ad-adena-region'),
    chkAdUseMpBar: $('chk-ad-use-mp-bar'),
    adMpBarRegionInfo: $('ad-mp-bar-region-info'),
    btnAdToggle: $('btn-ad-toggle'),
    adStatus: $('ad-status'),
    adDisplay: $('ad-display'),
    adMpRegionInfo: $('ad-mp-region-info'),
    adExpRegionInfo: $('ad-exp-region-info'),
    adLevelRegionInfo: $('ad-level-region-info'),
    adAdenaRegionInfo: $('ad-adena-region-info'),
    adMpLast: $('ad-mp-last'),
    adExpLast: $('ad-exp-last'),
    adLevelLast: $('ad-level-last'),
    adAdenaLast: $('ad-adena-last'),
    adInitStatus: $('ad-init-status'),
    adMpPreview: $('ad-mp-preview'),
    adExpPreview: $('ad-exp-preview'),
    adLevelPreview: $('ad-level-preview'),
    adAdenaPreview: $('ad-adena-preview'),
    // 학습 데이터 수집 UI
    trainLabelMp: $('train-label-mp'),
    trainLabelExp: $('train-label-exp'),
    trainLabelLevel: $('train-label-level'),
    trainLabelAdena: $('train-label-adena'),
    btnTrainCaptureToggle: $('btn-train-capture-toggle'),
    selTrainCaptureInterval: $('sel-train-capture-interval'),
    trainCaptureStatus: $('train-capture-status'),
    btnTrainLabelStart: $('btn-train-label-start'),
    btnTrainPendingRefresh: $('btn-train-pending-refresh'),
    btnTrainPendingClear: $('btn-train-pending-clear'),
    trainPendingCount: $('train-pending-count'),
    trainLabelingPanel: $('train-labeling-panel'),
    trainLabelingCurrent: $('train-labeling-current'),
    trainLabelingTotal: $('train-labeling-total'),
    trainLabelingThumb: $('train-labeling-thumb'),
    trainLabelingRegion: $('train-labeling-region'),
    trainLabelingMeta: $('train-labeling-meta'),
    trainLabelingInput: $('train-labeling-input'),
    btnTrainLabelingConfirm: $('btn-train-labeling-confirm'),
    btnTrainLabelingSkip: $('btn-train-labeling-skip'),
    btnTrainLabelingDelete: $('btn-train-labeling-delete'),
    btnTrainLabelingStop: $('btn-train-labeling-stop'),
    btnTrainLabelingBulkConfirm: $('btn-train-labeling-bulk-confirm'),
    btnTrainLabelingBulkDelete: $('btn-train-labeling-bulk-delete'),
    btnTrainSaveAll: $('btn-train-save-all'),
    btnTrainSaveAdena: $('btn-train-save-adena'),
    btnTrainSaveMp: $('btn-train-save-mp'),
    btnTrainOpenFolder: $('btn-train-open-folder'),
    btnTrainStatsRefresh: $('btn-train-stats-refresh'),
    trainStatTotal: $('train-stat-total'),
    trainStatMp: $('train-stat-mp'),
    trainStatExp: $('train-stat-exp'),
    trainStatLevel: $('train-stat-level'),
    trainStatAdena: $('train-stat-adena'),
    trainStatPendingTotal: $('train-stat-pending-total'),
    trainStatPendingMp: $('train-stat-pending-mp'),
    trainStatPendingExp: $('train-stat-pending-exp'),
    trainStatPendingLevel: $('train-stat-pending-level'),
    trainStatPendingAdena: $('train-stat-pending-adena'),
    trainStatus: $('train-status'),
    chkAdAutoStart: $('chk-ad-auto-start'),
    chkAdAutoStartTracker: $('chk-ad-auto-start-tracker'),
    chkAdPreview: $('chk-ad-preview'),
    selAdStability: $('sel-ad-stability'),
    selAdEngine: $('sel-ad-engine'),
    inAdLevelOffset: $('in-ad-level-offset'),
    // Paddle 비교 테스트 버튼
    btnPaddleSelftest: $('btn-paddle-selftest'),
    btnPaddleTestExp: $('btn-paddle-test-exp'),
    btnPaddleTestMp: $('btn-paddle-test-mp'),
    btnPaddleTestLevel: $('btn-paddle-test-level'),
    btnPaddleTestAdena: $('btn-paddle-test-adena'),
    paddleTestResult: $('paddle-test-result'),
    paddleDebugInfo: $('paddle-debug-info'),
    btnPaddleDebugCopy: $('btn-paddle-debug-copy'),
    paddleDebugCopied: $('paddle-debug-copied'),
    btnOpenDevtools: $('btn-open-devtools'),
    hybridDecisionLog: $('hybrid-decision-log'),
    // 탭 + 요약 바
    tabBar: $('tab-bar'),
    summaryBar: $('summary-bar'),
    summaryMp: $('summary-mp'),
    summaryMpPct: $('summary-mp-pct'),
    summaryRemaining: $('summary-remaining'),
    summaryExpRate: $('summary-exp-rate'),
    summaryAdenaRate: $('summary-adena-rate')
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
  // 🔧 앱 재시작 시 트래커 자동 일시정지 — startedAt이 과거 timestamp라
  //   `Date.now() - startedAt` 으로 계산되는 elapsed 시간이 무한히 증가하는 버그 방지.
  //   사용자가 명시적으로 [Start] 버튼을 눌러야 새로운 세션이 시작됨.
  //   start/current 값은 유지 (마지막 사냥 종료 시점 상태를 표시).
  if (tracker && (tracker.active || tracker.startedAt)) {
    tracker.active = false;
    tracker.startedAt = null;
    S.saveTracker(tracker);
    console.log('[Tracker] 앱 재시작 감지 — 세션 타이머 자동 일시정지. Start 버튼으로 새 세션 시작 가능.');
  }
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
  let detectionRunningSince = 0;
  // 사용자가 트래커 NOW 칸 직접 편집할 때 그 영역 OCR 일시 정지 (덮어쓰기 방지)
  // blur 후 5초 grace period — 그 사이 같은 칸 다시 클릭하면 grace 갱신
  const userEditUntil = { exp: 0, level: 0, adena: 0, mp: 0 };
  function markUserEdit(key) { userEditUntil[key] = Date.now() + 5000; }
  function isUserEditing(key) { return Date.now() < (userEditUntil[key] || 0); }
  // 트래커 자동 시작이 in-flight 일 때 중복 트리거 방지 (RESET 후 재시작 포함)
  let autoStartInProgress = false;

  // 마지막 OCR raw 값 (사용자 수정 시 offset 자동 학습용)
  let lastRawOcrLevel = null;
  // 안정된 raw OCR 레벨 (최근 N번 같은 값일 때만 갱신) — 자동 학습은 안정 상태에서만
  let lastStableRawOcrLevel = null;
  let recentRawOcrLevels = [];
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
    // 자동 감지가 켜져있으면 "현재 시점부터 다시 카운트" 의미로 동작:
    //   - 시작값 ← 현재 화면에 보이던 OCR 값
    //   - 세션 시간 = 00:00:00 부터 다시
    //   - tracker.active 유지 (재자동시작 경로를 안 거치므로 OCR 노이즈가 시작값으로 박히는 문제 원천 차단)
    const autoDetectActive = !!(autoDetect && autoDetect.enabled &&
      (autoDetect.expRegion || autoDetect.levelRegion || autoDetect.adenaRegion));

    if (autoDetectActive) {
      const cur = readTrackerInputs().current;
      tracker = {
        active: true,
        startedAt: Date.now(),
        start: { level: cur.level, exp: cur.exp, adena: cur.adena },
        current: { level: cur.level, exp: cur.exp, adena: cur.adena }
      };
      S.saveTracker(tracker);
      // 시작 칸 = 현재값으로 동기화 (현재 칸은 OCR이 다음 틱에 갱신)
      dom.trkLevelStart.value = cur.level;
      dom.trkExpStart.value = formatExpPct(cur.exp);
      dom.trkAdenaStart.value = cur.adena;
      setTrackerStatus('RUNNING', 'running');
      renderTracker();
      return;
    }

    // 자동 감지 OFF: 기존처럼 입력값을 모두 1/0 으로 초기화
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
    // 컴팩트 뷰 동기화 — 시작/현재/증가량 포함
    syncCompactView(elapsedSec, dExp, dAdena, t.current, dLevel);
  }

  // 컴팩트 뷰: 시작 시간 (HH:MM) + 경과 + EXP/H + ADENA/H + 트래커 (현재값 + 증가량)
  function syncCompactView(elapsedSec, dExp, dAdena, current, dLevel) {
    if (!dom.compactView) return;
    if (tracker.active && tracker.startedAt) {
      const d = new Date(tracker.startedAt);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      if (dom.compactStartTime) dom.compactStartTime.textContent = hh + ':' + mm;
      if (dom.compactElapsed) dom.compactElapsed.textContent = '(' + E.formatDuration(elapsedSec) + ')';
    } else {
      if (dom.compactStartTime) dom.compactStartTime.textContent = '--:--';
      if (dom.compactElapsed) dom.compactElapsed.textContent = '(00:00)';
    }
    if (elapsedSec >= 30) {
      const hours = elapsedSec / 3600;
      if (dom.compactExpRate) dom.compactExpRate.textContent = `${dExp >= 0 ? '+' : ''}${(dExp / hours).toFixed(4)}%/h`;
      if (dom.compactAdenaRate) dom.compactAdenaRate.textContent = `${dAdena >= 0 ? '+' : ''}${formatNumber(dAdena / hours)}/h`;
    } else if (tracker.active && elapsedSec > 0) {
      if (dom.compactExpRate) dom.compactExpRate.textContent = '측정 중';
      if (dom.compactAdenaRate) dom.compactAdenaRate.textContent = '측정 중';
    } else {
      if (dom.compactExpRate) dom.compactExpRate.textContent = '+0.0000%/h';
      if (dom.compactAdenaRate) dom.compactAdenaRate.textContent = '+0/h';
    }

    // 트래커 행 (현재값 + 증가량)
    const setDiff = (el, value, suffix = '') => {
      if (!el) return;
      const sign = value >= 0 ? '+' : '';
      const txt = (typeof value === 'number')
        ? sign + (suffix === '%' ? value.toFixed(4) + '%' : (Number.isInteger(value) ? value : formatNumber(value)) + suffix)
        : '+0' + suffix;
      el.textContent = txt;
      el.classList.toggle('negative', value < 0);
      el.classList.toggle('positive', value > 0);
    };
    if (current && Number.isFinite(current.level)) {
      if (dom.compactLevel) dom.compactLevel.textContent = String(current.level);
    } else if (dom.compactLevel) dom.compactLevel.textContent = '--';
    setDiff(dom.compactLevelDiff, dLevel || 0);

    if (current && Number.isFinite(current.exp)) {
      if (dom.compactExp) dom.compactExp.textContent = current.exp.toFixed(4) + '%';
    } else if (dom.compactExp) dom.compactExp.textContent = '--%';
    setDiff(dom.compactExpDiff, dExp || 0, '%');

    if (current && Number.isFinite(current.adena)) {
      if (dom.compactAdena) dom.compactAdena.textContent = formatNumber(current.adena);
    } else if (dom.compactAdena) dom.compactAdena.textContent = '--';
    setDiff(dom.compactAdenaDiff, dAdena || 0);
  }

  // 컴팩트 모드 토글 — body.compact-mode + 컴팩트 뷰 표시 + 창 크기 조정
  function setCompactMode(enabled) {
    document.body.classList.toggle('compact-mode', enabled);
    if (dom.compactView) {
      if (enabled) dom.compactView.removeAttribute('hidden');
      else dom.compactView.setAttribute('hidden', '');
    }
    if (api && api.setCompactMode) api.setCompactMode(enabled);
    if (dom.btnCompact) {
      dom.btnCompact.title = enabled ? '컴팩트 모드 해제 (F3)' : '컴팩트 모드 (F3)';
      dom.btnCompact.classList.toggle('active', enabled);
    }
    try {
      const s = S.loadSettings();
      s.compactMode = enabled;
      S.saveSettings(s);
    } catch (_) { /* ignore */ }
  }
  function toggleCompactMode() {
    setCompactMode(!document.body.classList.contains('compact-mode'));
  }

  // ==========================================================================
  // 학습 데이터 수집 (Tesseract LSTM fine-tuning용)
  //   각 영역의 최근 캡처 캔버스(latestCaptureCanvas)를 사용자 정답 라벨과 함께
  //   %APPDATA%/LineageMPTimer/training-data/{region}/ 에 저장.
  //   파일: <safe-label>_<timestamp>.png + <safe-label>_<timestamp>.gt.txt
  // ==========================================================================
  function _trainSetStatus(msg, kind) {
    if (!dom.trainStatus) return;
    dom.trainStatus.textContent = msg;
    dom.trainStatus.classList.toggle('success', kind === 'success');
    dom.trainStatus.classList.toggle('error', kind === 'error');
  }
  async function _trainRefreshStats() {
    if (!api) return;
    try {
      if (api.getTrainingStats) {
        const stats = await api.getTrainingStats();
        if (stats) {
          if (dom.trainStatTotal) dom.trainStatTotal.textContent = String(stats.total || 0);
          if (dom.trainStatMp) dom.trainStatMp.textContent = String(stats.byRegion?.mp || 0);
          if (dom.trainStatExp) dom.trainStatExp.textContent = String(stats.byRegion?.exp || 0);
          if (dom.trainStatLevel) dom.trainStatLevel.textContent = String(stats.byRegion?.level || 0);
          if (dom.trainStatAdena) dom.trainStatAdena.textContent = String(stats.byRegion?.adena || 0);
        }
      }
      if (api.listPendingSamples) {
        const p = await api.listPendingSamples({ includeImage: false });
        if (p) {
          if (dom.trainStatPendingTotal) dom.trainStatPendingTotal.textContent = String(p.total || 0);
          if (dom.trainStatPendingMp) dom.trainStatPendingMp.textContent = String(p.byRegion?.mp || 0);
          if (dom.trainStatPendingExp) dom.trainStatPendingExp.textContent = String(p.byRegion?.exp || 0);
          if (dom.trainStatPendingLevel) dom.trainStatPendingLevel.textContent = String(p.byRegion?.level || 0);
          if (dom.trainStatPendingAdena) dom.trainStatPendingAdena.textContent = String(p.byRegion?.adena || 0);
          if (dom.trainPendingCount) dom.trainPendingCount.textContent = String(p.total || 0);
        }
      }
    } catch (_) { /* ignore */ }
  }

  // ===== 자동 캡처 (라벨 없이 _pending에 PNG만 저장) =====
  let trainCaptureTimer = null;
  let trainCaptureCount = 0;
  let trainCaptureSkipped = 0;
  // dedup: 최근 N(=10)개의 OCR 결과 추적. 새 값이 히스토리에 있으면 스킵
  //   - 단순 직전값만 비교하면 220↔221 진동 시 모두 저장됨 → 히스토리 방식이 강력
  //   - OCR 결과가 빈/null인 경우는 dedup 안 함 (인식 실패 케이스는 저장하면 학습 가치 큼)
  const DEDUP_HISTORY_SIZE = 10;
  const recentCapturedOcrHistory = { mp: [], exp: [], level: [], adena: [] };
  function _trainIsCapturing() { return !!trainCaptureTimer; }
  async function _trainCaptureOnce() {
    if (!api || !api.savePendingSample) return;
    let savedThisTick = 0;
    let skippedThisTick = 0;
    for (const region of ['mp', 'exp', 'level', 'adena']) {
      const canvas = latestCaptureCanvas[region];
      if (!canvas) continue;
      const ocr = recentOcrResults[region] || '';
      // dedup: OCR 값이 최근 10개 히스토리에 있으면 스킵
      if (ocr && recentCapturedOcrHistory[region].includes(ocr)) {
        skippedThisTick++;
        continue;
      }
      let dataUrl;
      try { dataUrl = canvas.toDataURL('image/png'); } catch (_) { continue; }
      try {
        const r = await api.savePendingSample({ region, dataUrl, ocrSuggestion: ocr });
        if (r && r.ok) {
          savedThisTick++;
          if (ocr) {
            recentCapturedOcrHistory[region].push(ocr);
            if (recentCapturedOcrHistory[region].length > DEDUP_HISTORY_SIZE) {
              recentCapturedOcrHistory[region].shift();
            }
          }
        }
      } catch (_) { /* ignore */ }
    }
    trainCaptureCount += savedThisTick;
    trainCaptureSkipped += skippedThisTick;
    if (savedThisTick > 0 || skippedThisTick > 0) {
      _trainSetStatus(`🎬 캡처 누적: ${trainCaptureCount}개 (중복 스킵 ${trainCaptureSkipped}개)`, 'success');
      if (savedThisTick > 0) _trainRefreshStats();
    }
  }
  function startTrainCapture() {
    if (trainCaptureTimer) return;
    const interval = parseInt((dom.selTrainCaptureInterval && dom.selTrainCaptureInterval.value) || '10', 10);
    const ms = Math.max(2, interval) * 1000;
    trainCaptureCount = 0;
    trainCaptureSkipped = 0;
    // 새 세션 시작 시 dedup 히스토리 리셋
    recentCapturedOcrHistory.mp.length = 0;
    recentCapturedOcrHistory.exp.length = 0;
    recentCapturedOcrHistory.level.length = 0;
    recentCapturedOcrHistory.adena.length = 0;
    _trainCaptureOnce();
    trainCaptureTimer = setInterval(() => _trainCaptureOnce(), ms);
    if (dom.btnTrainCaptureToggle) {
      dom.btnTrainCaptureToggle.textContent = '⏸️ 자동 캡처 정지';
      dom.btnTrainCaptureToggle.classList.add('active');
    }
    if (dom.trainCaptureStatus) {
      dom.trainCaptureStatus.textContent = `🔴 REC (${interval}초 간격)`;
      dom.trainCaptureStatus.classList.add('active');
    }
    _trainSetStatus(`🎬 자동 캡처 시작 (${interval}초 간격)`, 'success');
  }
  function stopTrainCapture() {
    if (!trainCaptureTimer) return;
    clearInterval(trainCaptureTimer);
    trainCaptureTimer = null;
    if (dom.btnTrainCaptureToggle) {
      dom.btnTrainCaptureToggle.textContent = '🎬 자동 캡처 시작';
      dom.btnTrainCaptureToggle.classList.remove('active');
    }
    if (dom.trainCaptureStatus) {
      dom.trainCaptureStatus.textContent = '⏸️ 정지';
      dom.trainCaptureStatus.classList.remove('active');
    }
    _trainSetStatus('자동 캡처 종료. [라벨링 시작]에서 정리하세요.', 'success');
    _trainRefreshStats();
  }
  function toggleTrainCapture() {
    if (_trainIsCapturing()) stopTrainCapture(); else startTrainCapture();
  }

  // ===== 라벨링 (대기 샘플 한 줄씩 표시) =====
  const trainLabeling = { samples: [], idx: 0, active: false };
  async function startLabeling() {
    if (!api || !api.listPendingSamples) return;
    const p = await api.listPendingSamples({ includeImage: true });
    if (!p || !p.samples || p.samples.length === 0) {
      _trainSetStatus('대기 중인 샘플 없음 — 먼저 자동 캡처', 'error');
      return;
    }
    trainLabeling.samples = p.samples;
    trainLabeling.idx = 0;
    trainLabeling.active = true;
    if (dom.trainLabelingPanel) dom.trainLabelingPanel.removeAttribute('hidden');
    _renderLabelingItem();
  }
  function _renderLabelingItem() {
    const total = trainLabeling.samples.length;
    if (dom.trainLabelingTotal) dom.trainLabelingTotal.textContent = String(total);
    if (trainLabeling.idx >= total) {
      stopLabeling(true);
      return;
    }
    if (dom.trainLabelingCurrent) dom.trainLabelingCurrent.textContent = String(trainLabeling.idx + 1);
    const s = trainLabeling.samples[trainLabeling.idx];
    if (dom.trainLabelingThumb) dom.trainLabelingThumb.src = s.dataUrl || '';
    if (dom.trainLabelingRegion) dom.trainLabelingRegion.textContent = s.region.toUpperCase();
    if (dom.trainLabelingMeta) dom.trainLabelingMeta.textContent = `📅 ${s.capturedAt || ''} · OCR 추천: ${s.ocrSuggestion || '(없음)'}`;
    if (dom.trainLabelingInput) {
      dom.trainLabelingInput.value = s.ocrSuggestion || '';
      dom.trainLabelingInput.focus();
      dom.trainLabelingInput.select();
    }
  }
  async function confirmLabeling() {
    if (!trainLabeling.active) return;
    const s = trainLabeling.samples[trainLabeling.idx];
    if (!s) return;
    const label = (dom.trainLabelingInput && dom.trainLabelingInput.value || '').trim();
    if (!label) {
      _trainSetStatus('라벨 비어있음 (스킵하려면 Tab, 삭제는 Del)', 'error');
      return;
    }
    try {
      const res = await api.confirmPendingSample({ region: s.region, baseName: s.baseName, label });
      if (res && res.ok) {
        _trainSetStatus(`✅ ${s.region.toUpperCase()} ${label} 확정 (${trainLabeling.idx + 1}/${trainLabeling.samples.length})`, 'success');
        trainLabeling.idx++;
        _renderLabelingItem();
        _trainRefreshStats();
      } else {
        _trainSetStatus(`확정 실패: ${res && res.error || '?'}`, 'error');
      }
    } catch (e) {
      _trainSetStatus('확정 예외: ' + e.message, 'error');
    }
  }
  function skipLabeling() {
    if (!trainLabeling.active) return;
    trainLabeling.idx++;
    _renderLabelingItem();
  }
  async function deleteLabeling() {
    if (!trainLabeling.active) return;
    const s = trainLabeling.samples[trainLabeling.idx];
    if (!s) return;
    try {
      await api.deletePendingSample({ region: s.region, baseName: s.baseName });
      _trainSetStatus(`🗑️ ${s.region.toUpperCase()} 삭제`, 'success');
      // 현재 idx 위치에 다음 샘플이 들어옴 (배열에서 제거)
      trainLabeling.samples.splice(trainLabeling.idx, 1);
      _renderLabelingItem();
      _trainRefreshStats();
    } catch (e) {
      _trainSetStatus('삭제 예외: ' + e.message, 'error');
    }
  }
  function stopLabeling(finished) {
    trainLabeling.active = false;
    trainLabeling.samples = [];
    trainLabeling.idx = 0;
    if (dom.trainLabelingPanel) dom.trainLabelingPanel.setAttribute('hidden', '');
    if (finished) _trainSetStatus('🎉 라벨링 완료', 'success');
    else _trainSetStatus('라벨링 종료', '');
  }
  // 같은 OCR 추천값을 가진 대기 샘플을 입력 라벨로 일괄 확정
  async function bulkConfirmSameOcr() {
    if (!trainLabeling.active) return;
    const cur = trainLabeling.samples[trainLabeling.idx];
    if (!cur) return;
    const label = (dom.trainLabelingInput && dom.trainLabelingInput.value || '').trim();
    if (!label) {
      _trainSetStatus('라벨 비어있음', 'error');
      return;
    }
    const targetOcr = cur.ocrSuggestion || '';
    const targetRegion = cur.region;
    // 현재 idx 이후 (현재 포함) 같은 region + 같은 ocrSuggestion 모두 대상
    const matches = trainLabeling.samples.slice(trainLabeling.idx).filter(
      (s) => s.region === targetRegion && (s.ocrSuggestion || '') === targetOcr
    );
    if (matches.length === 0) {
      _trainSetStatus('일치하는 샘플 없음', 'error');
      return;
    }
    if (!confirm(`${targetRegion.toUpperCase()} OCR 추천값 "${targetOcr || '(없음)'}"을 가진 대기 샘플 ${matches.length}개를 모두 "${label}"로 확정하시겠습니까?`)) return;
    let ok = 0, fail = 0;
    for (const s of matches) {
      try {
        const res = await api.confirmPendingSample({ region: s.region, baseName: s.baseName, label });
        if (res && res.ok) ok++; else fail++;
      } catch (_) { fail++; }
    }
    // 처리한 샘플들을 배열에서 제거 (현재 idx 위치 유지)
    trainLabeling.samples = trainLabeling.samples.filter(
      (s) => !(s.region === targetRegion && (s.ocrSuggestion || '') === targetOcr)
    );
    // idx가 배열 길이보다 크면 끝
    if (trainLabeling.idx >= trainLabeling.samples.length) {
      _trainSetStatus(`💨 일괄 확정 ${ok}개 (실패 ${fail}) — 대기 모두 처리됨`, 'success');
      stopLabeling(true);
    } else {
      _trainSetStatus(`💨 일괄 확정 ${ok}개 (실패 ${fail})`, 'success');
      _renderLabelingItem();
    }
    _trainRefreshStats();
  }
  // 같은 OCR 추천값을 가진 대기 샘플 일괄 삭제
  async function bulkDeleteSameOcr() {
    if (!trainLabeling.active) return;
    const cur = trainLabeling.samples[trainLabeling.idx];
    if (!cur) return;
    const targetOcr = cur.ocrSuggestion || '';
    const targetRegion = cur.region;
    const matches = trainLabeling.samples.slice(trainLabeling.idx).filter(
      (s) => s.region === targetRegion && (s.ocrSuggestion || '') === targetOcr
    );
    if (matches.length === 0) {
      _trainSetStatus('일치하는 샘플 없음', 'error');
      return;
    }
    if (!confirm(`${targetRegion.toUpperCase()} OCR 추천값 "${targetOcr || '(없음)'}"을 가진 대기 샘플 ${matches.length}개를 모두 삭제하시겠습니까?`)) return;
    let ok = 0;
    for (const s of matches) {
      try {
        await api.deletePendingSample({ region: s.region, baseName: s.baseName });
        ok++;
      } catch (_) { /* ignore */ }
    }
    trainLabeling.samples = trainLabeling.samples.filter(
      (s) => !(s.region === targetRegion && (s.ocrSuggestion || '') === targetOcr)
    );
    if (trainLabeling.idx >= trainLabeling.samples.length) {
      _trainSetStatus(`💢 일괄 삭제 ${ok}개 — 대기 모두 처리됨`, 'success');
      stopLabeling(true);
    } else {
      _trainSetStatus(`💢 일괄 삭제 ${ok}개`, 'success');
      _renderLabelingItem();
    }
    _trainRefreshStats();
  }
  async function clearAllPending() {
    if (!api || !api.clearAllPending) return;
    if (!confirm('대기 중인 모든 샘플을 삭제하시겠습니까?')) return;
    try {
      const r = await api.clearAllPending();
      _trainSetStatus(`🗑️ ${r.removed || 0}개 파일 삭제`, 'success');
      _trainRefreshStats();
    } catch (e) {
      _trainSetStatus('삭제 예외: ' + e.message, 'error');
    }
  }
  async function _saveTrainingRegion(region, labelInputEl) {
    if (!api || !api.saveTrainingSample) {
      _trainSetStatus('IPC 미사용 가능 (api 없음)', 'error');
      return false;
    }
    const canvas = latestCaptureCanvas[region];
    if (!canvas) {
      _trainSetStatus(`${region.toUpperCase()}: 최근 캡처 없음 — 자동 감지 ON 후 다시 시도`, 'error');
      return false;
    }
    const label = (labelInputEl && labelInputEl.value || '').trim();
    if (!label) {
      _trainSetStatus(`${region.toUpperCase()}: 정답값 입력 필요`, 'error');
      if (labelInputEl) labelInputEl.focus();
      return false;
    }
    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (e) {
      _trainSetStatus(`${region.toUpperCase()}: 캔버스 변환 실패 - ${e.message}`, 'error');
      return false;
    }
    try {
      const res = await api.saveTrainingSample({ region, dataUrl, label, gtText: label });
      if (res && res.ok) {
        return true;
      }
      _trainSetStatus(`${region.toUpperCase()}: 저장 실패 - ${res && res.error || 'unknown'}`, 'error');
      return false;
    } catch (e) {
      _trainSetStatus(`${region.toUpperCase()}: 저장 예외 - ${e.message}`, 'error');
      return false;
    }
  }
  async function saveTrainingAll() {
    const targets = [
      { region: 'mp', el: dom.trainLabelMp },
      { region: 'exp', el: dom.trainLabelExp },
      { region: 'level', el: dom.trainLabelLevel },
      { region: 'adena', el: dom.trainLabelAdena }
    ];
    const filled = targets.filter((t) => t.el && (t.el.value || '').trim());
    if (filled.length === 0) {
      _trainSetStatus('정답값이 하나도 입력 안됨', 'error');
      return;
    }
    let ok = 0, fail = 0;
    for (const t of filled) {
      const success = await _saveTrainingRegion(t.region, t.el);
      if (success) ok++; else fail++;
    }
    if (fail === 0) {
      _trainSetStatus(`✅ ${ok}개 저장 완료`, 'success');
    } else {
      _trainSetStatus(`⚠️ ${ok}개 성공, ${fail}개 실패`, 'error');
    }
    _trainRefreshStats();
  }
  function setupTrainingControls() {
    // 자동 캡처 토글
    if (dom.btnTrainCaptureToggle) {
      dom.btnTrainCaptureToggle.addEventListener('click', () => toggleTrainCapture());
    }
    // 라벨링 시작/종료/확정/스킵/삭제
    if (dom.btnTrainLabelStart) {
      dom.btnTrainLabelStart.addEventListener('click', () => startLabeling());
    }
    if (dom.btnTrainLabelingConfirm) {
      dom.btnTrainLabelingConfirm.addEventListener('click', () => confirmLabeling());
    }
    if (dom.btnTrainLabelingSkip) {
      dom.btnTrainLabelingSkip.addEventListener('click', () => skipLabeling());
    }
    if (dom.btnTrainLabelingDelete) {
      dom.btnTrainLabelingDelete.addEventListener('click', () => deleteLabeling());
    }
    if (dom.btnTrainLabelingStop) {
      dom.btnTrainLabelingStop.addEventListener('click', () => stopLabeling(false));
    }
    if (dom.btnTrainLabelingBulkConfirm) {
      dom.btnTrainLabelingBulkConfirm.addEventListener('click', () => bulkConfirmSameOcr());
    }
    if (dom.btnTrainLabelingBulkDelete) {
      dom.btnTrainLabelingBulkDelete.addEventListener('click', () => bulkDeleteSameOcr());
    }
    if (dom.trainLabelingInput) {
      dom.trainLabelingInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirmLabeling(); }
        else if (e.key === 'Tab') { e.preventDefault(); skipLabeling(); }
        else if (e.key === 'Delete') { e.preventDefault(); deleteLabeling(); }
        else if (e.key === 'Escape') { e.preventDefault(); stopLabeling(false); }
      });
    }
    if (dom.btnTrainPendingRefresh) {
      dom.btnTrainPendingRefresh.addEventListener('click', () => _trainRefreshStats());
    }
    if (dom.btnTrainPendingClear) {
      dom.btnTrainPendingClear.addEventListener('click', () => clearAllPending());
    }
    // 보조: 수동 1개씩 저장
    if (dom.btnTrainSaveAll) {
      dom.btnTrainSaveAll.addEventListener('click', () => saveTrainingAll());
    }
    if (dom.btnTrainSaveAdena) {
      dom.btnTrainSaveAdena.addEventListener('click', async () => {
        const ok = await _saveTrainingRegion('adena', dom.trainLabelAdena);
        if (ok) _trainSetStatus('✅ ADENA 1개 저장', 'success');
        _trainRefreshStats();
      });
    }
    if (dom.btnTrainSaveMp) {
      dom.btnTrainSaveMp.addEventListener('click', async () => {
        const ok = await _saveTrainingRegion('mp', dom.trainLabelMp);
        if (ok) _trainSetStatus('✅ MP 1개 저장', 'success');
        _trainRefreshStats();
      });
    }
    if (dom.btnTrainOpenFolder && api && api.openTrainingFolder) {
      dom.btnTrainOpenFolder.addEventListener('click', async () => {
        try {
          const r = await api.openTrainingFolder();
          if (r && r.ok) _trainSetStatus(`📁 ${r.dir}`, 'success');
          else _trainSetStatus(`폴더 열기 실패 - ${r && r.error || ''}`, 'error');
        } catch (e) {
          _trainSetStatus(`폴더 열기 예외 - ${e.message}`, 'error');
        }
      });
    }
    if (dom.btnTrainStatsRefresh) {
      dom.btnTrainStatsRefresh.addEventListener('click', () => _trainRefreshStats());
    }
    // 수동 라벨 입력 Enter → saveTrainingAll
    [dom.trainLabelMp, dom.trainLabelExp, dom.trainLabelLevel, dom.trainLabelAdena].forEach((el) => {
      if (!el) return;
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveTrainingAll(); }
      });
    });
    // 초기 통계
    _trainRefreshStats();
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
    // 모니터 표시: 모든 영역의 displayLabel 수집해서 unique 만들기
    const labels = [];
    [autoDetect.mpRegion, autoDetect.mpBarRegion, autoDetect.expRegion, autoDetect.levelRegion, autoDetect.adenaRegion]
      .forEach((r) => { if (r && r.displayLabel && !labels.includes(r.displayLabel)) labels.push(r.displayLabel); });
    dom.adDisplay.textContent = labels.length === 0 ? '미지정' : labels.join(' / ');
    if (dom.adMpRegionInfo) dom.adMpRegionInfo.textContent = formatRegion(autoDetect.mpRegion);
    if (dom.adMpBarRegionInfo) {
      const r = autoDetect.mpBarRegion;
      const enabled = autoDetect.useMpBar && r;
      const calib = autoDetect.mpBarMaxX > 0 ? ' · 🎯 보정 ' + autoDetect.mpBarMaxX + 'col' : '';
      dom.adMpBarRegionInfo.textContent = (enabled ? '🟢 ' : (r ? '⚪ ' : '')) + formatRegion(r) + calib;
    }
    if (dom.adExpRegionInfo) dom.adExpRegionInfo.textContent = formatRegion(autoDetect.expRegion);
    if (dom.adLevelRegionInfo) dom.adLevelRegionInfo.textContent = formatRegion(autoDetect.levelRegion);
    if (dom.adAdenaRegionInfo) dom.adAdenaRegionInfo.textContent = formatRegion(autoDetect.adenaRegion);
    if (dom.chkAdUseMpBar) dom.chkAdUseMpBar.checked = !!autoDetect.useMpBar;
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
        // ⚠️ lineage.traineddata 사용 보류 — 학습 데이터 편향(MP /235 90%, LEVEL "28" 95%)으로
        //    오버피팅 발생, 일반 숫자 인식 능력 소실 확인됨 (2026-05-04).
        //    재학습 필요: 더 다양한 값 + 균형 잡힌 분포 + 1000~2000 iter (현재 5000은 과도).
        //    상세: docs/SESSION-HANDOFF-LATEST.md 참조.
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
    [autoDetect.mpRegion, autoDetect.mpBarRegion, autoDetect.expRegion, autoDetect.levelRegion, autoDetect.adenaRegion]
      .forEach((r) => { if (r && r.sourceId) sourceIds.add(r.sourceId); });
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

  /**
   * 캔버스 전처리 — 그레이스케일 + 자동 반전 + 콘트라스트 스트레치 + (옵션) 샤프닝/이진화
   *
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   *   sharpen   (default true)  — Laplacian 샤프닝 적용 (글자 가장자리 강조)
   *   binarize  (default false) — 콘트라스트 후 Otsu 이진화 (clean binary 이미지)
   *   contrastLo (default 80)   — 콘트라스트 스트레치 하한
   *   contrastHi (default 180)  — 콘트라스트 스트레치 상한
   *
   * 다양성을 위해 다른 옵션 조합으로 여러 변형 캔버스를 만들면 OCR voting 정확도 ↑
   */
  function preprocessCanvas(canvas, opts) {
    const sharpen   = !opts || opts.sharpen !== false;
    const binarize  = !!(opts && opts.binarize);
    const lo        = (opts && Number.isFinite(opts.contrastLo)) ? opts.contrastLo : 80;
    const hi        = (opts && Number.isFinite(opts.contrastHi)) ? opts.contrastHi : 180;
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    // 1) 그레이스케일 + 평균 휘도 계산
    let sum = 0;
    const N = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    }
    const avg = sum / N;
    const invert = avg < 128; // 어두운 배경이면 반전
    // 2) 콘트라스트 스트레치 (lo~hi → 0~255)
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      let v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (invert) v = 255 - v;
      v = Math.max(0, Math.min(255, ((v - lo) * 255) / range));
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    // 3) Sharpening — 3x3 Laplacian unsharp mask로 글자 가장자리 강조
    //    4↔9, 7↔1 같은 글리프 헷갈림에 효과적 (열린 위 vs 닫힌 위 차이가 더 명확)
    if (sharpen) applySharpenKernel(canvas);
    // 4) Otsu 이진화 — 깔끔한 binary 이미지 (anti-aliasing 제거)
    //    8↔5↔6 confusion 깰 가능성: anti-alias edge 제거되면 글리프 모양이 변함
    if (binarize) applyOtsuBinarization(canvas);
  }

  /**
   * Otsu 자동 threshold 이진화 — 픽셀 분포 분석 후 최적 임계값 산출
   * 결과: 모든 픽셀이 0 또는 255 (anti-alias 그라데이션 완전 제거)
   */
  function applyOtsuBinarization(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    // Otsu 알고리즘 — between-class variance 최대화 threshold
    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) hist[Math.round((d[i] + d[i+1] + d[i+2]) / 3)]++;
    const total = d.length / 4;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let sumB = 0, wB = 0, varMax = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sumAll - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > varMax) { varMax = v; threshold = t; }
    }
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i+1] + d[i+2]) / 3 > threshold ? 255 : 0;
      d[i] = v; d[i+1] = v; d[i+2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }

  /**
   * 캔버스 양 끝의 "의심스러운 좁은 글자" 자동 trim.
   *
   * 문제: ADENA 영역을 1~2px 너무 넓게 그렸을 때 끝의 코인 아이콘이나 외곽 안티앨리어스가
   *       phantom "1" 디짓으로 OCR됨 (예: 57887 → 578871).
   * 해결: 컬럼 ink density 분석 → 양 끝의 isolated narrow 그룹 감지 → 가장자리 trim.
   *
   * 보존 조건 (false positive 최소화):
   *   - 양 끝 그룹이 다른 글자 그룹들 median width의 25% 이상이면 보존 (real digit일 수 있음)
   *   - gap이 충분히 작거나 (= 정상 spacing) 보존
   *   - vertical extent가 60% 이상이면 보존 (full-height 문자는 진짜 digit 가능성 ↑)
   *
   * 매개변수: side — 'right' | 'both' (기본 'both'로 양쪽 검사)
   */
  /**
   * 채도(saturation) 픽셀을 배경색으로 강제 마스킹.
   *   ADENA 영역에 들어오는 노란/주황 금화 더미, 빨간 별, 아이템 아이콘 등 컬러
   *   그래픽이 OCR에서 추가 글자(예: 금화 → "8")로 오인되는 케이스 차단.
   *   - 채도(max-min RGB) ≥ 30인 픽셀을 영역 명암 기반 배경색으로 변환
   *   - light-on-dark (avgLum<128) → 검정, dark-on-light → 흰색
   *   - 게임 글자는 거의 무채색 (R≈G≈B)이라 영향 없음
   *   - autoTrim의 column-level chroma trim보다 더 강력 (영역 전체 컬러 픽셀 제거)
   */
  function maskChromaPixels(canvas) {
    if (!canvas) return canvas;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    // 임계값 60 — 게임 글자 안티앨리어싱(채도 ≤30~40)은 보호, 노란 금화(190)/빨간 별(100~150)만 잡음
    const SAT_THRESHOLD = 60;
    // 평균 휘도 → 배경 명암 결정
    let sumLum = 0;
    for (let i = 0; i < d.length; i += 4) sumLum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    const avgLum = sumLum / (d.length / 4);
    const maskColor = avgLum < 128 ? 0 : 255;
    let maskedCount = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) >= SAT_THRESHOLD) {
        d[i] = maskColor; d[i + 1] = maskColor; d[i + 2] = maskColor;
        maskedCount++;
      }
    }
    if (maskedCount > 0) {
      ctx.putImageData(img, 0, 0);
      console.log('[ChromaMask] ' + maskedCount + ' colored px masked → ' + maskColor + ' (avgLum=' + avgLum.toFixed(0) + ')');
    }
    return canvas;
  }

  function autoTrimEdgeArtifacts(canvas, side) {
    if (!canvas || canvas.width < 30) return canvas;
    const checkRight = side !== 'left';
    const checkLeft = side !== 'right';
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    // 명/암 자동 감지 — 평균 휘도로 dark-on-light vs light-on-dark 판단
    let sumLum = 0;
    for (let i = 0; i < d.length; i += 4) sumLum += (d[i] + d[i+1] + d[i+2]) / 3;
    const avgLum = sumLum / (d.length / 4);
    const inkIsDark = avgLum >= 128;  // 배경이 밝으면 ink는 어두움 (gray < 128)
    const isInk = inkIsDark
      ? (g) => g < 128
      : (g) => g > 128;
    // 컬럼 ink density + color density (한 패스로 둘 다 계산)
    //   density       — ink 픽셀 개수 (글자 위치 검출용)
    //   colorDensity  — ink 중 채도 높은(>=30) 픽셀 비율 (별/아이콘 검출용)
    const density = new Array(w).fill(0);
    const colorDensity = new Array(w).fill(0);
    const COLOR_PIXEL_SAT = 30;
    for (let x = 0; x < w; x++) {
      let inkCount = 0;
      let colorInkCount = 0;
      for (let y = 0; y < h; y++) {
        const idx = (y * w + x) * 4;
        const r = d[idx], gPx = d[idx + 1], bPx = d[idx + 2];
        const gray = (r + gPx + bPx) / 3;
        if (!isInk(gray)) continue;
        inkCount++;
        if (Math.max(r, gPx, bPx) - Math.min(r, gPx, bPx) >= COLOR_PIXEL_SAT) colorInkCount++;
      }
      density[x] = inkCount;
      colorDensity[x] = inkCount > 0 ? colorInkCount / inkCount : 0;
    }
    const inkThreshold = Math.max(1, h * 0.10);
    // ink groups
    const groups = [];
    let inGroup = false;
    let gs = 0;
    for (let x = 0; x < w; x++) {
      if (density[x] >= inkThreshold) {
        if (!inGroup) { inGroup = true; gs = x; }
      } else {
        if (inGroup) { groups.push({ start: gs, end: x - 1, width: x - gs }); inGroup = false; }
      }
    }
    if (inGroup) groups.push({ start: gs, end: w - 1, width: w - gs });
    if (groups.length < 2) return canvas;

    // Median width 계산
    const widths = groups.map(g => g.width).slice().sort((a, b) => a - b);
    const median = widths[Math.floor(widths.length / 2)];

    // Vertical extent helper (isInk로 명/암 자동 매칭)
    const verticalRatio = (start, end) => {
      let top = h, bot = -1;
      for (let y = 0; y < h; y++) {
        for (let x = start; x <= end; x++) {
          const idx = (y * w + x) * 4;
          if (isInk((d[idx] + d[idx+1] + d[idx+2]) / 3)) {
            if (y < top) top = y;
            if (y > bot) bot = y;
            break;
          }
        }
      }
      return bot < 0 ? 0 : (bot - top + 1) / h;
    };

    // Chroma score — 그룹 평균 채도 (max-min RGB). 게임 숫자는 거의 무채색(<10),
    // 빨간 별/아이템 아이콘 등 컬러 artifact는 채도 ≥ 30. ink 픽셀만 카운트.
    const chromaScore = (start, end) => {
      let sumSat = 0;
      let count = 0;
      for (let y = 0; y < h; y++) {
        for (let x = start; x <= end; x++) {
          const idx = (y * w + x) * 4;
          const r = d[idx], gPx = d[idx + 1], bPx = d[idx + 2];
          const gray = (r + gPx + bPx) / 3;
          if (!isInk(gray)) continue;  // 배경 제외, ink 픽셀만
          const mx = Math.max(r, gPx, bPx);
          const mn = Math.min(r, gPx, bPx);
          sumSat += (mx - mn);
          count++;
        }
      }
      return count > 5 ? sumSat / count : 0;
    };

    let trimLeft = 0;
    let trimRight = w;

    // 오른쪽 끝 검사
    if (checkRight && groups.length >= 2) {
      const last = groups[groups.length - 1];
      const prev = groups[groups.length - 2];
      const gap = last.start - prev.end - 1;
      const widthRatio = last.width / Math.max(1, median);
      const vRatio = verticalRatio(last.start, last.end);
      const chroma = chromaScore(last.start, last.end);
      // 트리거 조건 (둘 중 하나):
      //   (A) 기존 small-geometric: 좁고 + 떨어져 + 짧음
      //   (B) chroma-based: 채도 평균 ≥ 30 + gap ≥ 2 (컬러 별/아이콘)
      const isGeometric = (widthRatio < 0.25 && gap >= 3 && vRatio < 0.6);
      const isChromatic = (chroma >= 30 && gap >= 2);
      if (isGeometric || isChromatic) {
        trimRight = prev.end + Math.floor(gap / 2) + 1;
        const reason = isChromatic ? 'chroma=' + chroma.toFixed(0) : 'geometric';
        console.log('[AutoTrim] right artifact (' + reason + '): width=' + last.width + ' median=' + median + ' gap=' + gap + ' vRatio=' + vRatio.toFixed(2) + ' chroma=' + chroma.toFixed(0) + ' trim@' + trimRight);
      }
    }
    // 왼쪽 끝 검사
    if (checkLeft && groups.length >= 2) {
      const first = groups[0];
      const next = groups[1];
      const gap = next.start - first.end - 1;
      const widthRatio = first.width / Math.max(1, median);
      const vRatio = verticalRatio(first.start, first.end);
      const chroma = chromaScore(first.start, first.end);
      const isGeometric = (widthRatio < 0.25 && gap >= 3 && vRatio < 0.6);
      const isChromatic = (chroma >= 30 && gap >= 2);
      if (isGeometric || isChromatic) {
        trimLeft = first.end + Math.floor(gap / 2);
        const reason = isChromatic ? 'chroma=' + chroma.toFixed(0) : 'geometric';
        console.log('[AutoTrim] left artifact (' + reason + '): width=' + first.width + ' median=' + median + ' gap=' + gap + ' vRatio=' + vRatio.toFixed(2) + ' chroma=' + chroma.toFixed(0) + ' trim@' + trimLeft);
      }
    }

    // === 2차: Column-level chroma trim (별이 글자에 붙어있어 group으로 합쳐진 케이스) ===
    // group-based 검사는 별이 글자에 0~2px로 붙으면 같은 group으로 합쳐져 평균 채도가
    // 글자에 의해 희석되어 detect 못함. 컬럼 단위로 colored ink 비율 50%↑인 columns가
    // 좌/우 끝에서 연속 run으로 발견되면 그 만큼 추가 trim.
    {
      const COLOR_DENSITY_THRESHOLD = 0.5;  // 컬럼이 "colored"로 분류되려면 ink 픽셀 절반 이상이 채도 ≥30
      const SEARCH_LIMIT = Math.floor(w * 0.35);  // 좌/우 35% 영역만 검사 (중앙 본 글자 보호)
      // 좌측 끝에서 colored column run 찾기
      if (checkLeft) {
        let lastColorX = -1;
        for (let x = 0; x < SEARCH_LIMIT; x++) {
          if (colorDensity[x] >= COLOR_DENSITY_THRESHOLD) {
            lastColorX = x;
          } else if (lastColorX >= 0 && x - lastColorX >= 2) {
            break;  // 비컬러 픽셀 2개 연속 → run 종료
          }
        }
        if (lastColorX >= 0) {
          const newLeft = lastColorX + 1;
          if (newLeft > trimLeft) {
            trimLeft = newLeft;
            console.log('[AutoTrim] left chroma column run: trimLeft=' + trimLeft + ' (colorDensity[0..' + lastColorX + '])');
          }
        }
      }
      // 우측 끝에서 colored column run 찾기
      if (checkRight) {
        let firstColorX = -1;
        for (let x = w - 1; x >= w - SEARCH_LIMIT; x--) {
          if (colorDensity[x] >= COLOR_DENSITY_THRESHOLD) {
            firstColorX = x;
          } else if (firstColorX >= 0 && firstColorX - x >= 2) {
            break;
          }
        }
        if (firstColorX >= 0) {
          const newRight = firstColorX;
          if (newRight < trimRight) {
            trimRight = newRight;
            console.log('[AutoTrim] right chroma column run: trimRight=' + trimRight + ' (colorDensity[' + firstColorX + '..])');
          }
        }
      }
    }

    // 변경 없으면 그대로 return
    if (trimLeft === 0 && trimRight === w) return canvas;
    const newW = Math.max(1, trimRight - trimLeft);
    const tmp = document.createElement('canvas');
    tmp.width = newW;
    tmp.height = h;
    tmp.getContext('2d').drawImage(canvas, trimLeft, 0, newW, h, 0, 0, newW, h);
    canvas.width = newW;
    canvas.height = h;
    canvas.getContext('2d').drawImage(tmp, 0, 0);
    // UI 로그 (사용자가 자동 trim 동작 확인 가능, throttle 없음 — 실제로 자주 fire하지 않음)
    if (typeof pushHybridLog === 'function') {
      const dirInfo = [];
      if (trimLeft > 0) dirInfo.push('L:' + trimLeft + 'px');
      if (trimRight < w) dirInfo.push('R:' + (w - trimRight) + 'px');
      pushHybridLog('✂️ AutoTrim ' + dirInfo.join('+') + ' (artifact 제거: ' + w + '→' + newW + 'px)');
    }
    return canvas;
  }

  function applySharpenKernel(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const src = ctx.getImageData(0, 0, w, h);
    const dst = ctx.createImageData(w, h);
    const sd = src.data, dd = dst.data;
    // 3x3 Laplacian sharpen kernel: center=5, neighbors=-1 (sum=1 → 평균 휘도 보존)
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        const top = ((y - 1) * w + x) * 4;
        const bot = ((y + 1) * w + x) * 4;
        const lft = (y * w + (x - 1)) * 4;
        const rgt = (y * w + (x + 1)) * 4;
        const v = sd[i] * 5 - sd[top] - sd[bot] - sd[lft] - sd[rgt];
        const c = Math.max(0, Math.min(255, v));
        dd[i] = c; dd[i + 1] = c; dd[i + 2] = c; dd[i + 3] = 255;
      }
    }
    // 가장자리 픽셀은 원본 복사 (kernel 미적용)
    for (let i = 0; i < dd.length; i += 4) {
      if (dd[i + 3] !== 255) {
        dd[i] = sd[i]; dd[i + 1] = sd[i + 1]; dd[i + 2] = sd[i + 2]; dd[i + 3] = 255;
      }
    }
    ctx.putImageData(dst, 0, 0);
  }

  /**
   * 영역을 12x 업스케일 캔버스로 캡처 + 전처리
   * @param {object} region
   * @param {string} [mode] 전처리 변형 모드:
   *   undefined / 'default' — 콘트라스트 + 샤프닝 (기본)
   *   'soft'                — 콘트라스트만 (샤프닝 OFF) — 부드러운 글리프
   *   'otsu'                — 콘트라스트 + 샤프닝 + Otsu 이진화 — clean binary
   *   'tight'               — 좁은 콘트라스트 (90~170) + 샤프닝 — strict edge
   * 다양한 모드로 변형 캔버스를 만들면 voting 다양성 ↑ (agreement-misread 저항)
   */
  function captureRegionToCanvas(region, mode, opts) {
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
    // 업스케일 12x — 글리프 헷갈림(4↔9 등) 구분을 위해 더 크게
    const upscale = 12;
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
    if (autoDetect.preprocess !== false) {
      // 컬러 픽셀 마스킹 (preprocessCanvas 전에) — ADENA 영역 노란 금화/빨간 별 등
      // 채도 그래픽을 배경에 흡수시켜 OCR 글자만 보이게 함
      // 기본 OFF (MP/EXP/LEVEL 글자 안티앨리어싱이 영향 받지 않도록), ADENA 호출에서만 명시적 ON
      if (opts && opts.chromaMask) {
        maskChromaPixels(canvas);
      }

      if (mode === 'soft') {
        preprocessCanvas(canvas, { sharpen: false });
      } else if (mode === 'otsu') {
        preprocessCanvas(canvas, { sharpen: true, binarize: true });
      } else if (mode === 'tight') {
        preprocessCanvas(canvas, { sharpen: true, contrastLo: 90, contrastHi: 170 });
      } else {
        preprocessCanvas(canvas);
      }
      // 자동 가장자리 artifact trim — 사용자가 영역을 1~2px 너무 넓게 그려도 자동 보정
      autoTrimEdgeArtifacts(canvas, 'both');
    }
    return canvas;
  }

  /**
   * paddle 같은 자연 이미지 OCR용 — sharpening/contrast 등 가공 없이 raw 업스케일.
   * @param {object} region
   * @param {number} [upscale=6] 업스케일 배수
   * @param {object} [opts] {
   *   smooth?: boolean (default false: nearest-neighbor)
   *   invertForPaddle?, binarize?, morphOpen?, removeIslands? — paddle/tesseract 추가 전처리
   *   pad?: number (default 0: 캡처 주변 padding 추가 — leading 글자 누락 방지)
   * }
   */
  function captureRegionToRawCanvas(region, upscale, opts) {
    if (!region) return null;
    const cap = captureStreams.get(region.sourceId);
    if (!cap || !cap.video) {
      throw new Error('해당 영역의 캡처 스트림이 없습니다. (sourceId: ' + region.sourceId + ')');
    }
    const scale = region.scaleFactor || 1;
    const ups = upscale && upscale > 0 ? upscale : 6;
    const smooth = !!(opts && opts.smooth);
    const invertForPaddle = !!(opts && opts.invertForPaddle);
    const binarize = !!(opts && opts.binarize);
    const morphOpenIters = (opts && Number.isFinite(opts.morphOpen)) ? Math.max(0, opts.morphOpen) : 0;
    const pad = (opts && Number.isFinite(opts.pad)) ? Math.max(0, Math.round(opts.pad)) : 0;
    // pad는 source(게임 화면) 픽셀 자체를 사방 확장 — 사용자가 leading 글자를 살짝 잘랐어도 자동 보충
    const vw = cap.video.videoWidth || 0;
    const vh = cap.video.videoHeight || 0;
    const baseSx = Math.round(region.x * scale);
    const baseSy = Math.round(region.y * scale);
    const baseSw = Math.max(1, Math.round(region.width * scale));
    const baseSh = Math.max(1, Math.round(region.height * scale));
    const sx = Math.max(0, baseSx - pad);
    const sy = Math.max(0, baseSy - pad);
    // pad만큼 확장하되 video 경계로 클램프
    const swMax = vw > 0 ? (vw - sx) : (baseSw + pad * 2);
    const shMax = vh > 0 ? (vh - sy) : (baseSh + pad * 2);
    const sw = Math.min(swMax, baseSw + pad * 2 - (baseSx - pad < 0 ? Math.abs(baseSx - pad) : 0));
    const sh = Math.min(shMax, baseSh + pad * 2 - (baseSy - pad < 0 ? Math.abs(baseSy - pad) : 0));
    const canvas = document.createElement('canvas');
    canvas.width = sw * ups;
    canvas.height = sh * ups;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = smooth;
    if (smooth) ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(cap.video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      throw new Error('캡처 실패: ' + e.message);
    }
    // 후처리: paddle은 자연 이미지(어두운글자/밝은배경)에 훈련됨
    // 게임 UI는 흰글자/어두운배경 — 반전하면 paddle 학습 분포에 맞춰짐
    if (invertForPaddle || binarize) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      // 1) 평균 휘도 → 자동 반전 판정
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i+1] + d[i+2]) / 3;
      const avg = sum / (d.length / 4);
      const needInvert = invertForPaddle && avg < 128;
      // 2) Otsu threshold (이진화 옵션 ON 시)
      let threshold = 128;
      if (binarize) {
        const hist = new Array(256).fill(0);
        for (let i = 0; i < d.length; i += 4) hist[Math.round((d[i] + d[i+1] + d[i+2]) / 3)]++;
        const total = d.length / 4;
        let sumAll = 0;
        for (let t = 0; t < 256; t++) sumAll += t * hist[t];
        let sumB = 0, wB = 0, varMax = 0;
        for (let t = 0; t < 256; t++) {
          wB += hist[t];
          if (wB === 0) continue;
          const wF = total - wB;
          if (wF === 0) break;
          sumB += t * hist[t];
          const mB = sumB / wB;
          const mF = (sumAll - sumB) / wF;
          const v = wB * wF * (mB - mF) * (mB - mF);
          if (v > varMax) { varMax = v; threshold = t; }
        }
      }
      // 3) 픽셀 변환
      for (let i = 0; i < d.length; i += 4) {
        let v = (d[i] + d[i+1] + d[i+2]) / 3;
        if (binarize) v = v > threshold ? 255 : 0;
        if (needInvert) v = 255 - v;
        d[i] = v; d[i+1] = v; d[i+2] = v;
      }
      ctx.putImageData(img, 0, 0);
    }
    // 4) 모폴로지 opening — 슬래시드 제로의 가운데 슬래시 제거
    //    erode (검은 영역 축소) → dilate (검은 영역 복원) 순서
    //    슬래시는 작아서 erode 시 사라지고, 0의 외곽 링은 두꺼워서 살아남음
    //    이후 dilate로 링 두께 복원, 슬래시는 이미 사라져 복원 안 됨
    if (morphOpenIters > 0) {
      for (let it = 0; it < morphOpenIters; it++) {
        morphErode(canvas);
      }
      for (let it = 0; it < morphOpenIters; it++) {
        morphDilate(canvas);
      }
    }
    // 5) 연결 요소 제거 — 큰 컴포넌트의 bbox에 완전히 둘러싸인 작은 섬 제거
    //    슬래시드 제로의 슬래시: 0의 링 안에 위치한 작은 검은 섬 → 제거 대상
    //    소수점/외곽 디지트: 어디에도 둘러싸이지 않음 → 보존
    if (opts && opts.removeIslands) {
      removeIslandComponents(canvas);
    }
    // 6) 자동 가장자리 artifact trim — pad 확장으로 들어온 옆 아이콘/노이즈 제거
    //    autoTrimEdgeArtifacts 함수는 명/암 자동 감지 → raw canvas (light-on-dark)에서도 동작
    autoTrimEdgeArtifacts(canvas, 'both');
    return canvas;
  }

  // 검은 픽셀(글자) 침식 — 8-neighbor 중 하나라도 흰색이면 자기도 흰색
  function morphErode(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const src = ctx.getImageData(0, 0, w, h).data;
    const dst = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        let allBlack = src[idx] < 128;
        if (allBlack) {
          outer: for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const nidx = (ny * w + nx) * 4;
              if (src[nidx] >= 128) { allBlack = false; break outer; }
            }
          }
        }
        const v = allBlack ? 0 : 255;
        dst[idx] = v; dst[idx + 1] = v; dst[idx + 2] = v; dst[idx + 3] = 255;
      }
    }
    ctx.putImageData(new ImageData(dst, w, h), 0, 0);
  }

  /**
   * 연결 컴포넌트 분석 — 큰 컴포넌트의 bbox 안에 완전히 들어간 작은 섬 제거
   * 슬래시드 제로(0 안의 슬래시) 같은 패턴 제거용
   */
  function removeIslandComponents(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const labels = new Int32Array(w * h);
    const components = [];
    let nextLabel = 0;
    // BFS flood fill — 8-connectivity로 검은 영역 그룹화
    const queue = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (labels[idx] !== 0 || d[idx * 4] >= 128) continue;
        nextLabel++;
        let qHead = 0, qTail = 0;
        queue[qTail++] = idx;
        labels[idx] = nextLabel;
        let pixels = [idx];
        let minX = x, maxX = x, minY = y, maxY = y;
        while (qHead < qTail) {
          const i = queue[qHead++];
          const cy = (i / w) | 0;
          const cx = i - cy * w;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const nidx = ny * w + nx;
              if (labels[nidx] !== 0 || d[nidx * 4] >= 128) continue;
              labels[nidx] = nextLabel;
              pixels.push(nidx);
              if (nx < minX) minX = nx;
              if (nx > maxX) maxX = nx;
              if (ny < minY) minY = ny;
              if (ny > maxY) maxY = ny;
              queue[qTail++] = nidx;
            }
          }
        }
        components.push({ label: nextLabel, area: pixels.length, pixels, minX, maxX, minY, maxY });
      }
    }
    if (components.length < 2) return;
    // 각 컴포넌트가 다른 더 큰 컴포넌트의 bbox에 완전히 둘러싸여 있으면 제거 대상
    const toRemove = new Set();
    for (const c of components) {
      for (const o of components) {
        if (c === o || toRemove.has(c.label)) continue;
        // o가 c보다 충분히 커야 (2배 이상) — 비슷한 크기면 슬래시가 아님
        if (o.area < c.area * 2) continue;
        // c의 bbox가 o의 bbox 안에 strict하게 포함되어야 (가장자리 닿으면 제외)
        if (c.minX > o.minX && c.maxX < o.maxX &&
            c.minY > o.minY && c.maxY < o.maxY) {
          toRemove.add(c.label);
          break;
        }
      }
    }
    if (toRemove.size === 0) return;
    // 제거 대상 섬을 흰색으로
    for (const c of components) {
      if (!toRemove.has(c.label)) continue;
      for (const i of c.pixels) {
        const pi = i * 4;
        d[pi] = 255; d[pi + 1] = 255; d[pi + 2] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // 검은 픽셀(글자) 팽창 — 8-neighbor 중 하나라도 검정이면 자기도 검정
  function morphDilate(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const src = ctx.getImageData(0, 0, w, h).data;
    const dst = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        let anyBlack = src[idx] < 128;
        if (!anyBlack) {
          outer: for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const nidx = (ny * w + nx) * 4;
              if (src[nidx] < 128) { anyBlack = true; break outer; }
            }
          }
        }
        const v = anyBlack ? 0 : 255;
        dst[idx] = v; dst[idx + 1] = v; dst[idx + 2] = v; dst[idx + 3] = 255;
      }
    }
    ctx.putImageData(new ImageData(dst, w, h), 0, 0);
  }

  // 최근 캡처된 캔버스 (학습 데이터 저장용) — region key('mp'/'exp'/'level'/'adena')
  const latestCaptureCanvas = { mp: null, exp: null, level: null, adena: null };
  // 최근 OCR raw 결과 (학습 자동 수집의 'OCR과 트래커 일치' 체크용)
  //   safe-string 형태로 저장 → 트래커 NOW와 직접 비교 (자릿수/포맷 일치)
  const recentOcrResults = { mp: null, exp: null, level: null, adena: null };
  function _regionKeyForElId(el) {
    if (!el || !el.id) return null;
    if (el.id === 'ad-mp-preview') return 'mp';
    if (el.id === 'ad-exp-preview') return 'exp';
    if (el.id === 'ad-level-preview') return 'level';
    if (el.id === 'ad-adena-preview') return 'adena';
    return null;
  }
  function updatePreview(targetEl, canvas) {
    if (!targetEl) return;
    // 학습 데이터 저장 위해 캔버스는 항상 보존 (preview 표시 여부와 무관)
    const key = _regionKeyForElId(targetEl);
    if (key && canvas) latestCaptureCanvas[key] = canvas;
    if (!autoDetect.showPreview) {
      targetEl.removeAttribute('src');
      return;
    }
    try {
      targetEl.src = canvas.toDataURL('image/png');
    } catch (_) { /* ignore */ }
  }

  // ==========================================================================
  // MP 바 픽셀 분석 — OCR 완전 우회. 게임의 컬러 MP 바(파란색)에서
  //   채워진 비율을 측정해서 (사용자 입력 max) × ratio = cur 계산.
  //
  // 채움 판정: HSV 색공간의 saturation(채도) 사용 — 컬러풀(채도 ↑) = 바 채움,
  //   회색/검정/흰색(채도 ↓) = 바 비어있음 또는 텍스트/배경.
  //   이렇게 하면 어떤 컬러 바든(블루/레드/그린) reference color 없이 자동 처리.
  //
  // 텍스트 오버레이 처리: column 단위로 "한 픽셀이라도 채도 높으면 채워짐" 판정 →
  //   텍스트가 일부 픽셀만 가려도 column 전체는 살아있음.
  // ==========================================================================
  // RGB → Hue (0~360°). 회색(saturation=0)일 때 -1 반환.
  function rgbToHue(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta === 0) return -1;
    let h;
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = h * 60;
    if (h < 0) h += 360;
    return h;
  }
  // Hue 거리 — 원형(0=360 동치)
  function hueDistance(h1, h2) {
    const d = Math.abs(h1 - h2);
    return Math.min(d, 360 - d);
  }

  // RGB Euclidean distance
  function rgbDist(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }
  // 영역에서 fill의 대표 RGB 추출 — 평균이 아니라 가장 채도 높고 밝은 픽셀들의 평균
  //   텍스트(흰색/회색)나 배경(어두움)에 흐려지지 않은 진짜 fill 색
  function computeAvgRgb(data, w, h, xStart, xEnd) {
    // 1단계: sample 영역의 모든 픽셀 후보 수집 (채도 + 밝기 충분한 것만)
    const candidates = [];
    for (let x = xStart; x < xEnd; x++) {
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const val = max / 255;
        if (sat < 0.30 || val < 0.30) continue;  // dim/회색 픽셀 제외
        if (max > 240 && sat < 0.2) continue;     // 흰색 텍스트
        candidates.push({ r, g, b, score: sat * val });
      }
    }
    if (candidates.length === 0) return null;
    // 2단계: score(채도×밝기) 상위 30% 픽셀만 선택 → 진짜 fill 픽셀들
    candidates.sort((a, b) => b.score - a.score);
    const topCount = Math.max(5, Math.floor(candidates.length * 0.30));
    const top = candidates.slice(0, topCount);
    let sumR = 0, sumG = 0, sumB = 0;
    for (const p of top) { sumR += p.r; sumG += p.g; sumB += p.b; }
    return { r: sumR / top.length, g: sumG / top.length, b: sumB / top.length, count: top.length };
  }

  function computeBarFillRatio(canvas, refColor) {
    if (!canvas || !canvas.width || !canvas.height) return null;
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const w = canvas.width, h = canvas.height;
      const data = ctx.getImageData(0, 0, w, h).data;
      const hasRef = refColor && Number.isFinite(refColor.r);
      const refBrightness = hasRef ? Math.max(refColor.r, refColor.g, refColor.b) / 255 : 0;
      // === Column 평균 brightness ===
      //   text 픽셀 제외, 채도 있는 픽셀만 (배경 흰점/검은점 제외)
      const colAvgBright = new Array(w).fill(0);
      for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          if (max > 240 && sat < 0.2) continue;  // 흰 텍스트
          if (max < 30) continue;                 // 거의 검은 배경
          sum += max;
          cnt++;
        }
        colAvgBright[x] = cnt > 0 ? sum / cnt / 255 : 0;
      }
      // === Boundary 검출: 절대 임계 (refBrightness × 0.90) ===
      //   refBrightness = 보정 시 학습한 fill 평균 밝기
      //   강한 임계 90% — 진짜 fill 픽셀만 통과, 빈 영역(어두운 데코) 차단
      //   refColor 없으면 max/min 자연 분리 (보정 안 된 상태)
      let absThreshold;
      if (hasRef) {
        absThreshold = refBrightness * 0.85;
      } else {
        let maxColB = 0, minColB = 1;
        for (let x = 0; x < w; x++) {
          if (colAvgBright[x] > maxColB) maxColB = colAvgBright[x];
          if (colAvgBright[x] < minColB) minColB = colAvgBright[x];
        }
        absThreshold = (maxColB + minColB) / 2;
      }
      console.log('[MP bar] absThreshold=' + absThreshold.toFixed(3) + ' (refBright=' + refBrightness.toFixed(3) + ')');
      const RGB_TOL = 60;
      const SAT_MIN = 0.30;
      const VAL_MIN = 0.30;
      const HUE_TOL = 30;
      // Step 1: 5~25% 구간에서 dominant hue 자동 검출
      //   - 0~5% leftmost는 바 시작 데코(테두리/괄호)로 다른 색 가능 → skip
      //   - 5~25%는 MP가 100%일 때 fill 영역 안에 확실히 들어감
      //   - hue 히스토그램으로 dominant 찾기
      const refSampleStart = Math.max(0, Math.floor(w * 0.05));
      const refSampleEnd = Math.max(refSampleStart + 5, Math.floor(w * 0.25));
      const hueHist = new Array(36).fill(0);   // 10° 버킷 36개
      for (let x = refSampleStart; x < refSampleEnd; x++) {
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          const val = max / 255;
          if (sat > SAT_MIN && val > VAL_MIN) {
            const hue = rgbToHue(r, g, b);
            if (hue >= 0) hueHist[Math.floor(hue / 10) % 36]++;
          }
        }
      }
      let refBucket = -1, refCount = 0;
      for (let i = 0; i < 36; i++) {
        if (hueHist[i] > refCount) { refCount = hueHist[i]; refBucket = i; }
      }
      if (refBucket < 0) {
        // 왼쪽에 컬러 픽셀 0 — 진단 정보 수집해서 반환
        //   가장 채도 높은 픽셀 통계 출력 (사용자가 thresholds 어떤지 판단 가능)
        let maxSat = 0, maxVal = 0;
        for (let x = refSampleStart; x < refSampleEnd; x++) {
          for (let y = 0; y < h; y++) {
            const i = (y * w + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const sat = max === 0 ? 0 : (max - min) / max;
            const val = max / 255;
            if (sat > maxSat) maxSat = sat;
            if (val > maxVal) maxVal = val;
          }
        }
        console.warn('[MP bar] refHue 추출 실패 — 왼쪽 10%에 SAT>' + SAT_MIN + ' AND VAL>' + VAL_MIN + ' 픽셀 0개. ' +
                     '실측 max sat=' + maxSat.toFixed(2) + ' max val=' + maxVal.toFixed(2));
        return {
          ratio: 0, ratioSmoothed: 0, ratioCluster: 0, ratioRightmost: 0,
          filledCols: 0, totalCols: w, refHue: -1,
          colFilled: new Array(w).fill(false),
          density: new Array(w).fill(0),
          smoothedBoundary: -1,
          clusterBoundary: -1,
          diagnosticMaxSat: maxSat,
          diagnosticMaxVal: maxVal
        };
      }
      const refHue = refBucket * 10 + 5;
      // Step 1.5: ADAPTIVE 임계값 학습 — 샘플 영역에서 refHue 매치 픽셀들의
      //   최대 intensity (sat × val) 측정. 이의 50%를 fill 임계로 사용.
      //   → 빈 영역의 어두운 같은-hue 데코는 intensity 낮아 자동 배제.
      let maxRefIntensity = 0;
      for (let x = refSampleStart; x < refSampleEnd; x++) {
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          const val = max / 255;
          if (sat > SAT_MIN && val > VAL_MIN) {
            const hue = rgbToHue(r, g, b);
            if (hue >= 0 && hueDistance(hue, refHue) < HUE_TOL) {
              const intensity = sat * val;
              if (intensity > maxRefIntensity) maxRefIntensity = intensity;
            }
          }
        }
      }
      const ADAPTIVE_INTENSITY = maxRefIntensity * 0.65;
      console.log('[MP bar] mode=' + (hasRef ? 'RGB-distance' : 'HSV-adaptive') + (hasRef ? ' refRGB=(' + Math.round(refColor.r) + ',' + Math.round(refColor.g) + ',' + Math.round(refColor.b) + ')' : ' refHue=' + refHue + '°'));
      // Step 2: column별 채움 검사 — column 평균 brightness가 절대 임계 이상이면 fill
      const colFilled = new Array(w).fill(false);
      for (let x = 0; x < w; x++) {
        if (colAvgBright[x] < absThreshold) continue;
        // refColor 있으면 색 일치도 추가 검사
        if (hasRef) {
          let hasRefMatch = false;
          for (let y = 0; y < h; y++) {
            const i = (y * w + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (rgbDist(r, g, b, refColor.r, refColor.g, refColor.b) < RGB_TOL) {
              hasRefMatch = true; break;
            }
          }
          if (!hasRefMatch) continue;
        }
        colFilled[x] = true;
      }
      const filledCount = colFilled.filter(Boolean).length;
      // 가장 오른쪽 filled column 위치 — 단순 boundary
      let rightmostFilled = -1;
      for (let x = w - 1; x >= 0; x--) {
        if (colFilled[x]) { rightmostFilled = x; break; }
      }
      // === Sliding window 밀도 기반 boundary (텍스트 gap 통과) ===
      //   각 column에서 ±WINDOW 범위의 채움 밀도 측정.
      //   텍스트가 가린 column도 주변이 채워졌으면 "fill 영역"으로 본다.
      //   가장 오른쪽 density >= 30% column = boundary.
      const WINDOW = Math.max(8, Math.floor(w * 0.05));
      const density = new Array(w).fill(0);
      for (let x = 0; x < w; x++) {
        let f = 0, t = 0;
        for (let dx = -WINDOW; dx <= WINDOW; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < w) {
            t++;
            if (colFilled[nx]) f++;
          }
        }
        density[x] = f / t;
      }
      let smoothedBoundary = -1;
      for (let x = w - 1; x >= 0; x--) {
        if (density[x] >= 0.30) { smoothedBoundary = x; break; }
      }
      const ratioSmoothed = smoothedBoundary < 0 ? 0 : (smoothedBoundary + 1) / w;
      // === Rightmost-cluster boundary ===
      //   가장 오른쪽 column부터 walk back. column이 filled이고 ±15 범위에 ≥2 이웃 filled이면
      //   "노이즈 아닌 실제 fill 영역"으로 인정. 임계 완화로 낮은 MP(작은 fill 영역)에서도 검출.
      let clusterBoundary = -1;
      for (let x = w - 1; x >= 0; x--) {
        if (!colFilled[x]) continue;
        let neighbors = 0;
        for (let dx = -15; dx <= 15; dx++) {
          if (dx === 0) continue;
          const nx = x + dx;
          if (nx >= 0 && nx < w && colFilled[nx]) neighbors++;
        }
        if (neighbors >= 2) { clusterBoundary = x; break; }
      }
      const ratioCluster = clusterBoundary < 0 ? 0 : (clusterBoundary + 1) / w;
      return {
        ratio: filledCount / w,
        ratioSmoothed,
        ratioCluster,
        ratioRightmost: (rightmostFilled + 1) / w,
        filledCols: filledCount,
        totalCols: w,
        refHue,
        colFilled,
        density,
        smoothedBoundary,
        clusterBoundary
      };
    } catch (e) {
      console.warn('[MP bar] fill ratio compute failed:', e);
      return null;
    }
  }

  // 검출 결과를 캔버스 위에 시각화 — 녹색 띠(채움) + 빨강 띠(빈) + 흰 boundary 선
  function drawBarDetectionOverlay(canvas, result) {
    if (!canvas || !result || !result.colFilled) return;
    try {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      const stripeY = h - 4;
      // column별로 정확히 색칠 (정밀)
      for (let x = 0; x < w; x++) {
        ctx.fillStyle = result.colFilled[x] ? 'rgba(0, 255, 0, 0.85)' : 'rgba(255, 0, 0, 0.65)';
        ctx.fillRect(x, stripeY, 1, 3);
      }
      // boundary 표시:
      //   노란선 = cluster (채택값)
      //   청색선 = smoothed (참조)
      //   흰선   = rightmost (참조)
      const xC = Math.round(result.ratioCluster * w);
      const xS = Math.round(result.ratioSmoothed * w);
      const xR = Math.round(result.ratioRightmost * w);
      ctx.fillStyle = 'rgba(255, 255, 0, 0.95)';
      ctx.fillRect(xC - 1, 0, 2, h);
      if (xS !== xC) {
        ctx.fillStyle = 'rgba(0, 200, 255, 0.6)';
        ctx.fillRect(xS - 1, 0, 1, h);
      }
      if (xR !== xC && xR !== xS) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.fillRect(xR - 1, 0, 1, h);
      }
    } catch (_) { /* ignore */ }
  }

  async function ocrMpRegionFromBar() {
    if (!autoDetect.mpBarRegion) return null;
    const userMax = parseInt(dom.inMaxMp.value, 10) || 0;
    if (userMax <= 0) {
      // userMax 미입력 시 바 모드 의미 없음 → null 반환 (UI에서 안내)
      return { text: 'INPUTS의 최대 MP 입력 필요', confidence: 0, parsed: null };
    }
    const canvas = captureRegionToRawCanvas(autoDetect.mpBarRegion, 1, {});
    if (!canvas) return null;
    const result = computeBarFillRatio(canvas, autoDetect.mpBarRefColor);
    if (!result) {
      updatePreview(dom.adMpPreview, canvas);
      return { text: '바 분석 실패', confidence: 0, parsed: null };
    }
    // 시각화 (보드 오버레이) — 사용자가 검출 결과를 한눈에 진단 가능
    drawBarDetectionOverlay(canvas, result);
    updatePreview(dom.adMpPreview, canvas);
    const { ratio, ratioSmoothed, ratioCluster, ratioRightmost, filledCols, totalCols, refHue, clusterBoundary } = result;
    // === filledCount 기반 cur 계산 ===
    //   보정값(mpBarMaxX) = 100% MP 시점 filled column 수
    //   현재 filled column / 보정값 = 비율
    //   RGB 매칭이라 빈 영역이 정확히 배제됨 → filled 픽셀 수가 직접 비례
    const maxFilled = parseInt(autoDetect.mpBarMaxX, 10) || 0;
    let calibratedRatio;
    let chosen;
    if (maxFilled > 0) {
      calibratedRatio = Math.max(0, Math.min(1, filledCols / maxFilled));
      chosen = 'filled/calib';
    } else {
      // 미보정 — fallback chain (이전 boundary 방식)
      let chosenRatio = ratioCluster;
      chosen = 'cluster';
      if (chosenRatio < 0.005 && ratioSmoothed > 0.005) { chosen = 'smoothed'; chosenRatio = ratioSmoothed; }
      if (chosenRatio < 0.005 && ratioRightmost > 0.005) { chosen = 'rightmost'; chosenRatio = ratioRightmost; }
      if (chosenRatio < 0.005 && ratio > 0.005) { chosen = 'ratio'; chosenRatio = ratio; }
      calibratedRatio = chosenRatio;
    }
    const cur = Math.round(userMax * calibratedRatio);
    const hueLabel = refHue < 0 ? 'RGB' : Math.round(refHue) + '°';
    console.log('[MP bar] filled=' + filledCols + '/' + (maxFilled || totalCols) + ' (' + (calibratedRatio * 100).toFixed(1) + '%) cluster=' + (ratioCluster * 100).toFixed(1) + '% [' + chosen + '] → cur=' + cur + '/' + userMax);
    return {
      text: 'bar:' + (calibratedRatio * 100).toFixed(1) + '% [' + chosen + ']',
      confidence: 95,
      parsed: { cur, max: userMax, agreementCount: 1, totalAttempts: 1 },
      barMode: true,
      ratio: calibratedRatio,
      refHue,
      chosen,
      calibratedMaxFilled: maxFilled
    };
  }

  // 100% MP 보정 — 현재 mp 바 captured에서 cluster boundary를 mpBarMaxX로 저장.
  //   사용자가 MP 가득 찼을 때 호출. 이후 모든 측정은 이 width 대비 비율.
  async function calibrateMpBarMax() {
    const writeStatus = (s) => { if (dom.adCalibrateStatus) dom.adCalibrateStatus.textContent = s; };
    console.warn('[calibrate v18] STEP 1: 함수 진입');
    writeStatus('🎯 [v18] STEP 1 함수 진입');
    try {
      if (!autoDetect.mpBarRegion) {
        console.warn('[calibrate] STEP 2 FAIL: mpBarRegion 없음');
        writeStatus('🎯 [v18] ❌ MP 바 영역 미지정');
        flashHint('⚠️ 먼저 [📊 MP 바] 영역을 지정하세요.');
        return;
      }
      writeStatus('🎯 STEP 2 OK: 영역 ' + autoDetect.mpBarRegion.width + '×' + autoDetect.mpBarRegion.height);
      const cap = captureStreams.get(autoDetect.mpBarRegion.sourceId);
      if (!cap || !cap.video) {
        writeStatus('🎯 STEP 3 캡처 스트림 시작 중...');
        try {
          await setupCaptureStreams();
          writeStatus('🎯 STEP 3 캡처 스트림 준비 완료');
        } catch (e) {
          writeStatus('🎯 ❌ STEP 3 FAIL: ' + (e.message || e));
          return;
        }
      } else {
        writeStatus('🎯 STEP 3 OK: 기존 스트림 사용');
      }
      let canvas;
      try {
        canvas = captureRegionToRawCanvas(autoDetect.mpBarRegion, 1, {});
        writeStatus('🎯 STEP 4 OK: canvas ' + (canvas ? canvas.width + 'x' + canvas.height : 'null'));
      } catch (e) {
        writeStatus('🎯 ❌ STEP 4 FAIL: ' + (e.message || e));
        return;
      }
      if (!canvas) {
        writeStatus('🎯 ❌ STEP 4b FAIL: canvas null');
        return;
      }
      writeStatus('🎯 STEP 5 보정 분석 중...');
      // 보정 시점: 캔버스 데이터 직접 가져와서 fill 영역(5~25%)의 평균 RGB 계산 → refColor
      const ctxC = canvas.getContext('2d', { willReadFrequently: true });
      const wC = canvas.width, hC = canvas.height;
      const dataC = ctxC.getImageData(0, 0, wC, hC).data;
      const refStart = Math.max(0, Math.floor(wC * 0.05));
      const refEnd = Math.max(refStart + 5, Math.floor(wC * 0.25));
      const refColor = computeAvgRgb(dataC, wC, hC, refStart, refEnd);
      if (!refColor) {
        writeStatus('🎯 ❌ STEP 5 FAIL: refColor 계산 불가');
        return;
      }
      autoDetect.mpBarRefColor = { r: refColor.r, g: refColor.g, b: refColor.b };
      // refColor 저장 후 분석 — RGB 매칭 적용
      const result = computeBarFillRatio(canvas, autoDetect.mpBarRefColor);
      if (!result) {
        writeStatus('🎯 ❌ STEP 5 FAIL: 분석 결과 없음');
        return;
      }
      // 보정값: filledCount 직접 사용 (총 fill column 수, ratio가 아닌 raw count)
      const filledAtFull = result.filledCols;
      if (!Number.isFinite(filledAtFull) || filledAtFull < 5) {
        writeStatus('🎯 ❌ STEP 6 FAIL: 채움 cols 부족 filled=' + filledAtFull);
        return;
      }
      autoDetect.mpBarMaxX = filledAtFull;  // 100% MP일 때 fill columns 수
      S.saveAutoDetect(autoDetect);
      renderAutoDetectInfo();
      const pct = Math.round(filledAtFull / result.totalCols * 100);
      const msg = '✅ 보정 완료 — 100% = ' + filledAtFull + ' filled cols / ' + result.totalCols + ' (' + pct + '%) RGB=(' + Math.round(refColor.r) + ',' + Math.round(refColor.g) + ',' + Math.round(refColor.b) + ')';
      flashHint('✅ 보정 완료');
      console.warn('[calibrate v22] SUCCESS:', msg);
      writeStatus('🎯 ' + msg);
    } catch (e) {
      console.error('[calibrate] 예외:', e);
      writeStatus('🎯 ❌ 예외: ' + (e.message || e));
      flashHint('⚠️ 보정 실패: ' + (e.message || e));
    }
  }

  async function ocrMpRegionTesseract() {
    if (!autoDetect.mpRegion) return null;
    const canvas = captureRegionToCanvas(autoDetect.mpRegion);
    if (!canvas) return null;
    updatePreview(dom.adMpPreview, canvas);
    const w = await initOcrWorker();
    // 다양한 캔버스 변형 — 6/8 confusion 같은 단일 자리 misread 깨기
    let canvasSoft = null;
    let canvasOtsu = null;
    try { canvasSoft = captureRegionToCanvas(autoDetect.mpRegion, 'soft'); } catch (_) {}
    try { canvasOtsu = captureRegionToCanvas(autoDetect.mpRegion, 'otsu'); } catch (_) {}

    // INPUTS에 입력된 max MP — 슬래시 인식 실패 시 폴백으로 활용
    const userMax = parseInt(dom.inMaxMp.value, 10) || 0;

    // 단일 텍스트 결과를 (cur, max, fallback) 튜플로 파싱
    const parseMpText = (text) => {
      let m = text.match(/(\d{1,5})\s*[\/\\|:]\s*(\d{1,5})/);
      if (!m) m = text.match(/(\d{1,5})[^\d]+(\d{1,5})/);
      if (!m) {
        const nums = text.match(/\d{1,5}/g);
        if (nums && nums.length >= 2) m = [null, nums[0], nums[1]];
      }
      let cur = NaN, max = NaN, fb = false;
      if (m) { cur = parseInt(m[1], 10); max = parseInt(m[2], 10); }
      const initialValid = m && Number.isFinite(cur) && Number.isFinite(max)
        && cur <= max && max > 0 && max <= 99999;
      if (!initialValid && userMax > 0) {
        const digits = text.replace(/[^0-9]/g, '');
        if (digits) {
          const maxLen = String(userMax).length;
          let tryCur = NaN;
          if (digits.length === maxLen) {
            tryCur = parseInt(digits, 10);
          } else if (digits.length > maxLen && digits.length <= maxLen * 2 + 1) {
            tryCur = parseInt(digits.slice(0, digits.length - maxLen), 10);
            if (Number.isFinite(tryCur) && tryCur > userMax && digits.length > maxLen + 1) {
              const retry = parseInt(digits.slice(0, digits.length - maxLen - 1), 10);
              if (Number.isFinite(retry) && retry <= userMax) tryCur = retry;
            }
          } else if (digits.length > 0 && digits.length < maxLen) {
            tryCur = parseInt(digits, 10);
          }
          if (Number.isFinite(tryCur) && tryCur >= 0 && tryCur <= userMax) {
            cur = tryCur; max = userMax; fb = true;
          } else { return { cur: NaN, max: NaN, fb: false }; }
        }
      }
      if (!Number.isFinite(cur) || !Number.isFinite(max)) return { cur: NaN, max: NaN, fb: false };
      return { cur, max, fb };
    };

    // PSM 7 (single line) + 13 (raw line) — slash 패턴이라 PSM 8(single word)은 제외
    // 캔버스 다양성(default, soft, otsu) × PSM 2개 = 최대 6개 결과 → 6/8 confusion 같은 단일 자리 misread 깨기
    const psmModes = ['7', '13'];
    const results = [];
    const recognizeMpOn = async (label, c) => {
      for (const psm of psmModes) {
        try {
          await w.setParameters({
            tessedit_char_whitelist: '0123456789/',
            tessedit_pageseg_mode: psm,
            load_system_dawg: '0', load_freq_dawg: '0',
            load_unambig_dawg: '0', load_punc_dawg: '0',
            load_number_dawg: '0', load_bigram_dawg: '0'
          });
          const res = await w.recognize(c);
          const text = ((res && res.data && res.data.text) || '').trim();
          const rawConf = (res && res.data && res.data.confidence);
          const confidence = Math.max(0, Number.isFinite(rawConf) ? rawConf : 0);
          const p = parseMpText(text);
          results.push({ src: label, psm, text, confidence, ...p });
          console.log('[OCR MP ' + label + ' psm=' + psm + '] text=' + JSON.stringify(text) + ' conf=' + Math.round(confidence) + ' cur=' + p.cur + ' max=' + p.max + (p.fb ? ' (fallback)' : ''));
        } catch (e) {
          console.warn('[OCR MP ' + label + ' psm=' + psm + '] failed:', e);
        }
      }
    };
    await recognizeMpOn('pp', canvas);
    if (canvasSoft) await recognizeMpOn('soft', canvasSoft);
    if (canvasOtsu) await recognizeMpOn('otsu', canvasOtsu);

    if (results.length === 0) return null;
    const valid = results.filter((r) => Number.isFinite(r.cur) && Number.isFinite(r.max));
    if (valid.length === 0) {
      return { text: results[0].text, confidence: results[0].confidence, parsed: null };
    }
    // 다수결: (cur,max) 튜플 매칭 — PSM 두 개 모두 일치(2/2)해야 채택
    const counts = {};
    valid.forEach((r) => {
      const key = r.cur + '/' + r.max;
      counts[key] = (counts[key] || 0) + 1;
    });
    let bestKey = valid[0].cur + '/' + valid[0].max;
    let bestCount = 0;
    for (const [k, cnt] of Object.entries(counts)) {
      if (cnt > bestCount) { bestCount = cnt; bestKey = k; }
    }
    // PSM 단일 결과도 허용 (stability check이 false positive 차단)
    //   2/2 strict 했을 때 정상 결과도 reject되는 문제 → 1/2도 통과시키되
    //   stability 검증 횟수 (기본 1회 → 2회로) + plausibility (max 일치 등) 로 안정성 확보
    if (bestCount < 1) {
      return { text: results[0].text, confidence: results[0].confidence, parsed: null };
    }
    const [bestCur, bestMax] = bestKey.split('/').map((s) => parseInt(s, 10));
    const matched = valid.filter((r) => r.cur === bestCur && r.max === bestMax);
    const avgConf = matched.reduce((s, r) => s + r.confidence, 0) / matched.length;
    const usedFallback = matched.some((r) => r.fb);
    console.log('[OCR MP] 다수결:', counts, '→ ' + bestKey + ' (' + bestCount + '/' + valid.length + ')');
    return {
      text: matched[0].text,
      confidence: avgConf,
      parsed: { cur: bestCur, max: bestMax, agreementCount: bestCount, totalAttempts: valid.length },
      usedFallback
    };
  }

  // 다중 PSM 시도해서 가장 빈도 높은 결과 선택 — 단일 숫자 인식에 효과적
  async function ocrLevelRegionTesseract() {
    if (!autoDetect.levelRegion) return null;
    const canvas = captureRegionToCanvas(autoDetect.levelRegion);
    if (!canvas) return null;
    updatePreview(dom.adLevelPreview, canvas);
    const w = await initOcrWorker();

    // PSM 7 (single line), 8 (single word), 13 (raw line) 세 가지 모드로 시도 후 다수결
    const psmModes = ['7', '8', '13'];
    const results = [];
    for (const psm of psmModes) {
      try {
        await w.setParameters({
          tessedit_char_whitelist: '0123456789',
          tessedit_pageseg_mode: psm,
          load_system_dawg: '0', load_freq_dawg: '0',
          load_unambig_dawg: '0', load_punc_dawg: '0',
          load_number_dawg: '0', load_bigram_dawg: '0'
        });
        const res = await w.recognize(canvas);
        const text = ((res && res.data && res.data.text) || '').trim();
        const rawConf = (res && res.data && res.data.confidence);
        const confidence = Math.max(0, Number.isFinite(rawConf) ? rawConf : 0);
        const digits = text.replace(/[^0-9]/g, '');
        const level = digits ? parseInt(digits, 10) : NaN;
        results.push({ psm, text, confidence, level });
        console.log('[OCR LEVEL psm=' + psm + '] text=' + JSON.stringify(text) + ' conf=' + Math.round(confidence) + ' level=' + level);
      } catch (e) {
        console.warn('[OCR LEVEL psm=' + psm + '] failed:', e);
      }
    }

    if (results.length === 0) return null;

    // 결과들 중 valid한 것만 모음 + 다수결 (같은 값이 더 많이 나온 쪽)
    const valid = results.filter((r) => Number.isFinite(r.level) && r.level >= 1 && r.level <= 99);
    if (valid.length === 0) {
      const t = results[0];
      return { text: t.text, confidence: t.confidence, parsed: null };
    }

    // 다수결: 같은 level 값을 카운트
    const counts = {};
    valid.forEach((r) => { counts[r.level] = (counts[r.level] || 0) + 1; });
    let bestLevel = valid[0].level;
    let bestCount = 0;
    for (const [lv, cnt] of Object.entries(counts)) {
      if (cnt > bestCount) { bestCount = cnt; bestLevel = parseInt(lv, 10); }
    }
    // 가장 많이 나온 결과의 confidence 평균
    const matched = valid.filter((r) => r.level === bestLevel);
    const avgConf = matched.reduce((s, r) => s + r.confidence, 0) / matched.length;
    // 보정 오프셋 적용 — 사용자가 수정 시 자동 학습된 차이값
    const offset = parseInt(autoDetect.levelOffset, 10) || 0;
    const corrected = bestLevel + offset;
    lastRawOcrLevel = bestLevel;  // raw 값 저장 (사용자 수정 시 학습용)

    // 안정성 추적 — 최근 5번 raw OCR 결과 중 모두 같은 값이면 안정 상태로 간주
    recentRawOcrLevels.push(bestLevel);
    if (recentRawOcrLevels.length > 5) recentRawOcrLevels.shift();
    if (recentRawOcrLevels.length >= 3 && recentRawOcrLevels.every((v) => v === bestLevel)) {
      lastStableRawOcrLevel = bestLevel;
    }
    console.log('[OCR LEVEL] 다수결:', counts, '→ raw Lv.' + bestLevel + ' (count=' + bestCount + '/' + valid.length + ') → 보정 +' + offset + ' = Lv.' + corrected + ' (안정=' + lastStableRawOcrLevel + ')');
    return {
      text: matched[0].text,
      confidence: avgConf,
      parsed: { level: corrected, raw: bestLevel, offset, agreementCount: bestCount, totalAttempts: valid.length }
    };
  }

  async function ocrAdenaRegionTesseract() {
    if (!autoDetect.adenaRegion) return null;
    const canvas = captureRegionToCanvas(autoDetect.adenaRegion, undefined, { chromaMask: true });
    if (!canvas) return null;
    updatePreview(dom.adAdenaPreview, canvas);
    const w = await initOcrWorker();

    // 다양한 글리프 표현을 얻기 위해 4가지 캔버스 변형으로 OCR 실행 (agreement-misread 깨기)
    //   - canvas:      12x preprocessed (sharpen + contrast 80~180)   — 기본
    //   - canvasSoft:  12x preprocessed, no sharpen                    — 부드러운 글리프 (anti-alias 보존)
    //   - canvasOtsu:  12x preprocessed + Otsu 이진화                  — clean binary (anti-alias 제거)
    //   - canvasRaw:   16x raw nearest-neighbor, pad 10                — 전처리 없음 + leading-pad
    // 각 캔버스 × PSM 7/8/13 = 최대 12개 결과 → per-digit voting 강력해짐
    let canvasSoft = null;
    let canvasOtsu = null;
    let canvasRaw = null;
    try { canvasSoft = captureRegionToCanvas(autoDetect.adenaRegion, 'soft', { chromaMask: true }); } catch (_) {}
    try { canvasOtsu = captureRegionToCanvas(autoDetect.adenaRegion, 'otsu', { chromaMask: true }); } catch (_) {}
    try {
      canvasRaw = captureRegionToRawCanvas(autoDetect.adenaRegion, 16, { pad: 10 });
      if (canvasRaw) maskChromaPixels(canvasRaw);  // 노란 금화 등 컬러 그래픽 제거
    } catch (_) {}

    const psmModes = ['7', '8', '13'];
    const results = [];
    const recognizeOn = async (label, c) => {
      for (const psm of psmModes) {
        try {
          await w.setParameters({
            tessedit_char_whitelist: '0123456789,',
            tessedit_pageseg_mode: psm,
            load_system_dawg: '0', load_freq_dawg: '0',
            load_unambig_dawg: '0', load_punc_dawg: '0',
            load_number_dawg: '0', load_bigram_dawg: '0'
          });
          const res = await w.recognize(c);
          const text = ((res && res.data && res.data.text) || '').trim();
          const rawConf = (res && res.data && res.data.confidence);
          const confidence = Math.max(0, Number.isFinite(rawConf) ? rawConf : 0);
          const digits = text.replace(/[^0-9]/g, '');
          const adena = digits ? parseInt(digits, 10) : NaN;
          results.push({ src: label, psm, text, confidence, digits, adena });
          console.log('[OCR ADENA ' + label + ' psm=' + psm + '] text=' + JSON.stringify(text) + ' conf=' + Math.round(confidence) + ' adena=' + adena);
        } catch (e) {
          console.warn('[OCR ADENA ' + label + ' psm=' + psm + '] failed:', e);
        }
      }
    };
    await recognizeOn('pp', canvas);
    if (canvasSoft) await recognizeOn('soft', canvasSoft);
    if (canvasOtsu) await recognizeOn('otsu', canvasOtsu);
    if (canvasRaw) await recognizeOn('raw', canvasRaw);

    if (results.length === 0) return null;
    const valid = results.filter((r) => Number.isFinite(r.adena) && r.adena >= 0 && r.adena <= 9999999999);
    if (valid.length === 0) {
      return { text: results[0].text, confidence: results[0].confidence, parsed: null };
    }

    // ===== 1차: 풀-넘버 다수결 =====
    //   동률 시 짧은 자릿수 선호 (digit-add 방지) — 같은 표 수면 "59897" vs "995897"에서 "59897" 선택
    const counts = {};
    valid.forEach((r) => { counts[r.adena] = (counts[r.adena] || 0) + 1; });
    let bestAdena = valid[0].adena;
    let bestCount = 0;
    let bestLen = String(bestAdena).length;
    for (const [v, cnt] of Object.entries(counts)) {
      const vNum = parseInt(v, 10);
      const vLen = String(vNum).length;
      if (cnt > bestCount) {
        bestCount = cnt; bestAdena = vNum; bestLen = vLen;
      } else if (cnt === bestCount && vLen < bestLen) {
        bestAdena = vNum; bestLen = vLen;
      }
    }

    // ===== 1.5차: Leading-digit-drop 검출 =====
    //   - 한 캔버스가 N자리, 다른 캔버스가 N+1자리 읽고 N자리가 N+1자리의 마지막 N자리와 동일하면
    //     앞자리 누락 misread → 긴 쪽 채택 (anchor 없어도 동작)
    //   - 예: 41293 (raw) + 1293 (pp) → "1293"이 "41293"의 suffix → 41293 채택
    //   - 핵심: 적어도 하나의 결과가 더 길어야 — 짧은 다수결로 끌려가는 것 방지
    {
      const lengths = [...new Set(valid.map((r) => r.digits.length))].sort((a, b) => b - a);
      if (lengths.length >= 2 && lengths[0] - lengths[1] === 1) {
        const longLen = lengths[0];
        const shortLen = lengths[1];
        const longResults = valid.filter((r) => r.digits.length === longLen);
        const shortResults = valid.filter((r) => r.digits.length === shortLen);
        // 긴 결과들 중 가장 빈도 높은 값
        const longCounts = {};
        longResults.forEach((r) => { longCounts[r.adena] = (longCounts[r.adena] || 0) + 1; });
        let topLongAdena = NaN, topLongCnt = 0;
        for (const [v, cnt] of Object.entries(longCounts)) {
          if (cnt > topLongCnt) { topLongCnt = cnt; topLongAdena = parseInt(v, 10); }
        }
        // 짧은 결과 중 적어도 하나가 긴 결과의 suffix와 일치 → leading-digit-drop
        const longStr = String(topLongAdena);
        const suffixHit = shortResults.some((r) => r.digits === longStr.slice(-shortLen));
        // 1자리만 누락 + suffix 매치 + leading digit가 1~9 (≠0) 인 경우만 채택
        const leadingDigit = longStr[0];
        if (suffixHit && leadingDigit && leadingDigit !== '0' && Number.isFinite(topLongAdena)) {
          const matched = longResults.filter((r) => r.adena === topLongAdena);
          const avgConf = matched.reduce((s, r) => s + r.confidence, 0) / Math.max(1, matched.length);
          console.log('[OCR ADENA] leading-digit-drop 보정: long=' + topLongAdena + ' (' + longLen + '자리, ' + topLongCnt + '/' + longResults.length + ') vs short=' + shortResults.map((r) => r.digits).join(','));
          return {
            text: String(topLongAdena),
            confidence: avgConf,
            parsed: { adena: topLongAdena, agreementCount: topLongCnt, totalAttempts: valid.length, leadingDigitRescue: true }
          };
        }
      }
    }

    // ===== 2차: 자릿수가 모두 같을 때 자리수별(per-digit) 다수결 =====
    //   - 4↔9, 6↔8 같은 단일 자리 confusion이 모든 PSM에서 동일하게 발생해도
    //     변형 캔버스(soft/otsu/raw)에서 다른 의견이 한 번이라도 나오면 위치별 majority가 정답에 수렴
    //   - 예: pp:39326,39326,39326 + raw:34326,39326,34326 → 자리별 [3,4|9,3,2,6] → 4 win
    //   - tie가 있어도 perPos 자체는 보존 (template per-digit override가 fill-in 가능)
    let perDigitAdena = NaN;
    let perDigitDetail = null;
    let perPos = [];        // 위치별 voting 결과 [{best, count, tie, dist}, ...]
    let sameLenList = [];
    const digitsList = valid.map((r) => r.digits);
    const lenCounts = {};
    digitsList.forEach((s) => { lenCounts[s.length] = (lenCounts[s.length] || 0) + 1; });
    let dominantLen = 0, dominantLenCnt = 0;
    for (const [L, cnt] of Object.entries(lenCounts)) {
      const lenInt = parseInt(L, 10);
      if (cnt > dominantLenCnt) {
        dominantLenCnt = cnt; dominantLen = lenInt;
      } else if (cnt === dominantLenCnt && lenInt < dominantLen) {
        // 동률 tiebreaker: 더 짧은 길이 선호
        //   digit-add (phantom 추가 글자) 방지 — autoTrim 후에도 가끔 발생하는 케이스 대응
        //   "995897" (6자리) vs "59897" (5자리) 동률이면 "59897" 선택
        dominantLen = lenInt;
      }
    }
    if (dominantLen > 0 && dominantLenCnt >= Math.ceil(valid.length / 2)) {
      sameLenList = digitsList.filter((s) => s.length === dominantLen);
      for (let i = 0; i < dominantLen; i++) {
        const c = {};
        sameLenList.forEach((s) => { const ch = s[i]; c[ch] = (c[ch] || 0) + 1; });
        let bestCh = null, bestN = 0;
        for (const [ch, n] of Object.entries(c)) {
          if (n > bestN) { bestN = n; bestCh = ch; }
        }
        const tieAtPos = Object.values(c).filter((n) => n === bestN).length > 1;
        perPos.push({ best: bestCh, count: bestN, tie: tieAtPos, dist: c });
      }
      const tieFound = perPos.some((p) => p.tie);
      if (!tieFound) {
        const reconstructed = perPos.map((p) => p.best).join('');
        const n = parseInt(reconstructed, 10);
        if (Number.isFinite(n) && n >= 0 && n <= 9999999999) {
          perDigitAdena = n;
          perDigitDetail = perPos.map((p, i) => 'pos' + i + ':' + p.best + '(' + p.count + '/' + sameLenList.length + ')').join(' ');
        }
      }
    }

    // ===== 3차: Template Matching — 가변 길이 + 고정 길이 =====
    //   - 가변 길이: OCR이 자릿수를 잘못 셀 때(예: 47090 → 491) 대응
    //   - 고정 길이: 자릿수 동의했을 때 per-position 점수로 voting tie/weak 보정
    let templateAdena = NaN;
    let templateConf = 0;
    let templateLen = 0;
    let templatePerCharFixed = null;   // 고정 dominantLen에서의 per-position [{char, score, secondBest, ...}]
    if (window.TemplateMatcher && window.TemplateMatcher.isLoaded() && canvas) {
      try {
        // 가변 길이 (전체 override 후보)
        const tplResult = window.TemplateMatcher.matchVariableLength(canvas, 1, 7, '0123456789');
        if (tplResult.text && /^\d+$/.test(tplResult.text)) {
          const n = parseInt(tplResult.text, 10);
          if (Number.isFinite(n) && n >= 0 && n <= 9999999999) {
            templateAdena = n;
            templateConf = tplResult.confidence;
            templateLen = tplResult.length;
            const ocrLen = String(bestAdena).length;
            const allLens = (tplResult.allLengths || []).map((a) => `len${a.length}=${a.text}(${(a.confidence*100).toFixed(0)}%)`).join(' ');
            console.log('[OCR ADENA template] var: best len=' + templateLen + ' result=' + n + ' conf=' + (templateConf * 100).toFixed(1) + '% (OCR len=' + ocrLen + ')');
            console.log('[OCR ADENA template] var all lengths:', allLens);
          }
        }
        // 고정 길이 (per-position 정보용)
        if (dominantLen > 0) {
          const fixedRes = window.TemplateMatcher.match(canvas, dominantLen, '0123456789');
          if (fixedRes && fixedRes.perChar && fixedRes.perChar.length === dominantLen) {
            templatePerCharFixed = fixedRes.perChar;
            const detail = fixedRes.perChar.map((p, i) =>
              'p' + i + ':' + (p.char || '?') + '(' + ((p.score || 0)*100).toFixed(0) + '%,gap=' +
              (((p.score || 0) - (p.secondBest && p.secondBest.score || 0))*100).toFixed(0) + '%)').join(' ');
            console.log('[OCR ADENA template] fixed len=' + dominantLen + ' text=' + fixedRes.text + ' detail=' + detail);
            // UI 로그 — 템플릿 결과가 OCR과 다르면 진단 정보로 표시
            if (fixedRes.text !== String(bestAdena)) {
              pushHybridLog('🔍 ADENA template ' + fixedRes.text + ' vs OCR ' + bestAdena + ' | ' + detail);
            }
          }
        }
      } catch (e) {
        console.warn('[OCR ADENA template] match failed:', e);
      }
    } else {
      // 템플릿 미로딩 진단 (한 번만 표시되도록 throttle 가능하지만 일단 매번)
      if (!window.TemplateMatcher) pushHybridLog('⚠ TemplateMatcher 모듈 미로딩');
      else if (!window.TemplateMatcher.isLoaded()) pushHybridLog('⚠ TemplateMatcher 데이터 미로딩');
    }

    // ===== 4차: Hybrid per-digit override — class-aware 3-tier =====
    //
    //  WSL purity 리포트 기준 클래스 신뢰도:
    //    CLEAN (positive avg purity): '1', '2', '3', '5', '/', '.'  → 라벨 노이즈 적음
    //    NOISY (negative avg purity): '0', '4', '6', '7', '8', '9'  → 라벨 노이즈 있음
    //
    //  결정 트리 (각 위치):
    //    [Tier A — DECISIVE]  template best가 CLEAN class + score≥93% + gap≥6%
    //                         → 어떤 voting이든 정정 (5만→9만 같은 unanimous agreement-misread 깨기)
    //                         OR 어느 class든 score≥97% + gap≥13% (extreme confidence)
    //    [Tier B — RECOVERY]  voting weak/tied + (clean class score≥88%/gap≥4% OR noisy class score≥92%/gap≥8%)
    //    [Tier C — SAFE]      voting strong + template 거부 → voting 채택
    //
    //  장점:
    //   - Tier A로 unanimous misread도 정정 (특히 leading "5→9" 사례)
    //   - 클래스별 신뢰도에 따라 차등 임계값 → noisy class false override 차단
    const CLEAN_CLASSES = '1235/.';
    const isClean = (ch) => ch && CLEAN_CLASSES.includes(ch);
    let hybridAdena = NaN;
    let hybridDetail = null;
    let hybridOverrides = 0;
    if (perPos.length > 0 && perPos.length === dominantLen && sameLenList.length > 0) {
      const finalDigits = [];
      const overrideLogs = [];
      const totalSame = sameLenList.length;
      for (let i = 0; i < dominantLen; i++) {
        const v = perPos[i];
        const t = templatePerCharFixed ? templatePerCharFixed[i] : null;
        const votingMargin = v.count / Math.max(1, totalSame);
        const votingStrong = !v.tie && votingMargin >= 0.75;
        let chosen = v.best;
        let tier = null;
        if (t && t.char && t.char !== v.best) {
          const tplScore = t.score || 0;
          const tplGap = tplScore - ((t.secondBest && t.secondBest.score) || 0);
          const cleanBest = isClean(t.char);
          // Tier A — DECISIVE
          //   grayscale Manhattan distance 실측 score 범위: 0.60~0.80
          //   gap은 보통 0.02~0.08 (clean class), 0.01~0.04 (noisy class)
          //   사용자 보고 데이터: p0:6(66%,gap=2%), p4:4(76%,gap=5%) — 정확한 매치도 76% 정도
          if (cleanBest && tplScore >= 0.74 && tplGap >= 0.04) tier = 'A-clean';
          else if (tplScore >= 0.80 && tplGap >= 0.08) tier = 'A-extreme';
          // Tier B — RECOVERY (voting weak only)
          else if (!votingStrong) {
            if (cleanBest && tplScore >= 0.70 && tplGap >= 0.025) tier = 'B-clean';
            else if (!cleanBest && tplScore >= 0.74 && tplGap >= 0.04) tier = 'B-noisy';
          }
          if (tier) {
            chosen = t.char;
            hybridOverrides++;
            overrideLogs.push('[' + tier + '] pos' + i + ':' + (v.best || '?') + '→' + t.char +
              ' (v=' + v.count + '/' + totalSame + (v.tie ? ',tie' : '') +
              ', t=' + (tplScore*100).toFixed(0) + '%/gap=' + (tplGap*100).toFixed(0) + '%' +
              (cleanBest ? ',CLEAN' : ',NOISY') + ')');
          }
        }
        if (!chosen) { finalDigits.length = 0; break; }
        finalDigits.push(chosen);
      }
      if (finalDigits.length === dominantLen) {
        const n = parseInt(finalDigits.join(''), 10);
        if (Number.isFinite(n) && n >= 0 && n <= 9999999999) {
          // 안전 장치: 2개 이상 위치 동시 override는 template hallucination 의심 → reject
          //   (보통 misread는 1자리만 발생, 2개 이상 동시 발생은 template 자체가 잘못된 케이스)
          const maxAllowedOverrides = Math.min(2, Math.floor(dominantLen / 2));
          if (hybridOverrides <= maxAllowedOverrides) {
            hybridAdena = n;
            hybridDetail = overrideLogs.length > 0 ? overrideLogs.join(' | ') : 'no override';
          } else {
            console.log('[OCR ADENA] ⚠ hybrid override 거부: ' + hybridOverrides + '개 위치 동시 변경은 의심스러움 (max=' + maxAllowedOverrides + ')');
            console.log('[OCR ADENA] ⚠ 거부된 overrides:', overrideLogs.join(' | '));
            hybridOverrides = 0;
          }
        }
      }
    }

    // === 우선순위 결정 ===
    // 1) hybrid (voting+template) 결과가 다수결과 다르면 우선
    // 2) per-digit voting 결과가 다수결과 다르면 차선
    // 3) 그 외엔 다수결 그대로
    if (Number.isFinite(hybridAdena) && hybridAdena !== bestAdena && hybridOverrides > 0) {
      console.log('[OCR ADENA] hybrid per-digit override: full-num=' + bestAdena + ' → hybrid=' + hybridAdena + ' (' + hybridDetail + ')');
      pushHybridLog('🔧 ADENA per-digit override: ' + bestAdena + ' → ' + hybridAdena + ' (' + hybridDetail + ')');
      const matched = valid.filter((r) => r.digits.length === dominantLen);
      const avgConf = matched.reduce((s, r) => s + r.confidence, 0) / Math.max(1, matched.length);
      return {
        text: String(hybridAdena),
        confidence: avgConf,
        parsed: { adena: hybridAdena, agreementCount: dominantLenCnt, totalAttempts: valid.length, hybrid: true, overrides: hybridOverrides }
      };
    }
    if (Number.isFinite(perDigitAdena) && perDigitAdena !== bestAdena) {
      console.log('[OCR ADENA] per-digit override: full-num=' + bestAdena + ' → per-digit=' + perDigitAdena + ' (' + perDigitDetail + ')');
      const matched = valid.filter((r) => r.digits.length === dominantLen);
      const avgConf = matched.reduce((s, r) => s + r.confidence, 0) / Math.max(1, matched.length);
      return {
        text: String(perDigitAdena),
        confidence: avgConf,
        parsed: { adena: perDigitAdena, agreementCount: dominantLenCnt, totalAttempts: valid.length, perDigit: true }
      };
    }
    // 가변 길이 template 정보 로그만 (override 안 함 — 라벨노이즈 위험)
    if (Number.isFinite(templateAdena) && templateAdena !== bestAdena) {
      const ocrLen = String(bestAdena).length;
      const lenDiff = templateLen !== ocrLen;
      console.log('[OCR ADENA] ℹ template 차이 (var-length override 비활성): OCR=' + bestAdena + ' template=' + templateAdena + ' conf=' + (templateConf * 100).toFixed(1) + '%' + (lenDiff ? ' [길이 ' + ocrLen + '→' + templateLen + ']' : ''));
    }

    // 1차 다수결: half 미달이면 parsed null로 → 다음 틱 재시도
    const minRequired = Math.max(2, Math.ceil(valid.length / 2));
    if (bestCount < minRequired) {
      console.log('[OCR ADENA] 다수결 약함 (PSM/canvas마다 결과 다름):', counts, '→ skip');
      return { text: results[0].text, confidence: results[0].confidence, parsed: null };
    }
    const matched = valid.filter((r) => r.adena === bestAdena);
    const avgConf = matched.reduce((s, r) => s + r.confidence, 0) / matched.length;
    console.log('[OCR ADENA] 다수결:', counts, '→ adena=' + bestAdena + ' (' + bestCount + '/' + valid.length + ')');
    return {
      text: matched[0].text,
      confidence: avgConf,
      parsed: { adena: bestAdena, agreementCount: bestCount, totalAttempts: valid.length }
    };
  }

  async function ocrExpRegionTesseract() {
    if (!autoDetect.expRegion) return null;
    const canvas = captureRegionToCanvas(autoDetect.expRegion);
    if (!canvas) return null;
    updatePreview(dom.adExpPreview, canvas);
    const w = await initOcrWorker();

    // PSM 7/8/13 다수결 — 글리프 유사 숫자(7↔8 등) 헷갈림 차단
    const psmModes = ['7', '8', '13'];
    const parseExpText = (text) => {
      const decMatch = text.match(/(\d{1,3})\s*\.\s*(\d{1,4})/);
      if (decMatch) {
        const intPart = parseInt(decMatch[1], 10);
        const decPart = decMatch[2].padEnd(4, '0').slice(0, 4);
        const n = parseFloat(intPart + '.' + decPart);
        if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
      } else {
        // 점이 인식 안 됐을 가능성 → 5자리 이상 정수면 마지막 4자리를 소수부로
        const intOnly = text.replace(/[^0-9]/g, '');
        if (intOnly && intOnly.length >= 4) {
          const n = parseExpPct(intOnly);
          if (n >= 0 && n <= 100) return n;
        }
      }
      return NaN;
    };

    const results = [];
    for (const psm of psmModes) {
      try {
        await w.setParameters({
          tessedit_char_whitelist: '0123456789.',
          tessedit_pageseg_mode: psm,
          load_system_dawg: '0', load_freq_dawg: '0',
          load_unambig_dawg: '0', load_punc_dawg: '0',
          load_number_dawg: '0', load_bigram_dawg: '0'
        });
        const res = await w.recognize(canvas);
        const text = ((res && res.data && res.data.text) || '').trim();
        const rawConf = (res && res.data && res.data.confidence);
        const confidence = Math.max(0, Number.isFinite(rawConf) ? rawConf : 0);
        const exp = parseExpText(text);
        results.push({ psm, text, confidence, exp });
        console.log('[OCR EXP psm=' + psm + '] text=' + JSON.stringify(text) + ' conf=' + Math.round(confidence) + ' exp=' + exp);
      } catch (e) {
        console.warn('[OCR EXP psm=' + psm + '] failed:', e);
      }
    }

    if (results.length === 0) return null;
    const valid = results.filter((r) => Number.isFinite(r.exp) && r.exp >= 0 && r.exp <= 100);
    if (valid.length === 0) {
      return { text: results[0].text, confidence: results[0].confidence, parsed: null };
    }

    // 다수결: 정수부 + 소수 1자리(0~999)로 grouping (소수 4자리 정확매칭은 매번 노이즈 1자리 다름)
    // 예: 27.1100과 27.1101은 같은 그룹 27.1, 27.11과 28.9는 다른 그룹
    const keyOf = (e) => Math.round(e * 10) / 10;
    const counts = {};
    valid.forEach((r) => {
      const k = keyOf(r.exp);
      counts[k] = (counts[k] || 0) + 1;
    });
    let bestKey = keyOf(valid[0].exp);
    let bestCount = 0;
    for (const [k, cnt] of Object.entries(counts)) {
      if (cnt > bestCount) { bestCount = cnt; bestKey = parseFloat(k); }
    }
    if (bestCount < 2) {
      console.log('[OCR EXP] 다수결 약함 (PSM마다 결과 다름):', counts, '→ skip');
      return { text: results[0].text, confidence: results[0].confidence, parsed: null };
    }
    // 매칭된 결과 중 confidence 높은 것의 정확한 소수 4자리 값 채택
    const matched = valid.filter((r) => keyOf(r.exp) === bestKey);
    matched.sort((a, b) => b.confidence - a.confidence);
    const finalExp = matched[0].exp;
    const avgConf = matched.reduce((s, r) => s + r.confidence, 0) / matched.length;
    console.log('[OCR EXP] 다수결:', counts, '→ exp=' + finalExp + ' (key=' + bestKey + ' ' + bestCount + '/' + valid.length + ')');
    return {
      text: matched[0].text,
      confidence: avgConf,
      parsed: { exp: finalExp, agreementCount: bestCount, totalAttempts: valid.length }
    };
  }

  // ========================================================================
  // PaddleOCR 버전 — 자동 감지 루프용
  //   · captureRegionToRawCanvas (sharpen·contrast 미적용 raw)
  //   · MpPaddle.recognize 내부에서 canvas → HTMLImageElement 자동 변환
  //   · 반환 shape은 tesseract 버전과 동일 (parsed/text/confidence) — 기존 dispatch 코드 무수정
  // ========================================================================
  async function ocrMpRegionPaddle() {
    if (!autoDetect.mpRegion) return null;
    const canvas = captureRegionToRawCanvas(autoDetect.mpRegion, 1, { pad: 2 });
    if (!canvas) return null;
    updatePreview(dom.adMpPreview, canvas);
    if (!window.MpPaddle) return null;
    try {
      const r = await window.MpPaddle.recognize(canvas);
      const text = r.text || '';
      // tesseract 버전의 parseMpText와 동일한 로직 — 슬래시/구분자 / userMax fallback
      const userMax = parseInt(dom.inMaxMp.value, 10) || 0;
      let m = text.match(/(\d{1,5})\s*[\/\\|:]\s*(\d{1,5})/);
      if (!m) m = text.match(/(\d{1,5})[^\d]+(\d{1,5})/);
      if (!m) {
        const nums = text.match(/\d{1,5}/g);
        if (nums && nums.length >= 2) m = [null, nums[0], nums[1]];
      }
      let cur = NaN, max = NaN, fb = false;
      if (m) { cur = parseInt(m[1], 10); max = parseInt(m[2], 10); }
      const initialValid = m && Number.isFinite(cur) && Number.isFinite(max)
        && cur <= max && max > 0 && max <= 99999;
      if (!initialValid && userMax > 0) {
        const digits = text.replace(/[^0-9]/g, '');
        if (digits) {
          const maxLen = String(userMax).length;
          let tryCur = NaN;
          if (digits.length === maxLen) tryCur = parseInt(digits, 10);
          else if (digits.length > maxLen && digits.length <= maxLen * 2 + 1) {
            tryCur = parseInt(digits.slice(0, digits.length - maxLen), 10);
          } else if (digits.length > 0 && digits.length < maxLen) tryCur = parseInt(digits, 10);
          if (Number.isFinite(tryCur) && tryCur >= 0 && tryCur <= userMax) {
            cur = tryCur; max = userMax; fb = true;
          }
        }
      }
      console.log('[OCR MP paddle] text=' + JSON.stringify(text) + ' cur=' + cur + ' max=' + max + (fb ? ' (fallback)' : ''));
      if (!Number.isFinite(cur) || !Number.isFinite(max)) {
        return { text, confidence: r.confidence, parsed: null };
      }
      return {
        text,
        confidence: r.confidence,
        parsed: { cur, max, agreementCount: 1, totalAttempts: 1 },
        usedFallback: fb
      };
    } catch (e) {
      console.warn('[OCR MP paddle] failed:', e);
      return null;
    }
  }

  async function ocrLevelRegionPaddle() {
    if (!autoDetect.levelRegion) return null;
    const canvas = captureRegionToRawCanvas(autoDetect.levelRegion, 1, { pad: 2 });
    if (!canvas) return null;
    updatePreview(dom.adLevelPreview, canvas);
    if (!window.MpPaddle) return null;
    try {
      const r = await window.MpPaddle.recognize(canvas);
      const text = r.text || '';
      const digits = text.replace(/[^0-9]/g, '');
      const rawLevel = digits ? parseInt(digits, 10) : NaN;
      console.log('[OCR LEVEL paddle] text=' + JSON.stringify(text) + ' raw=' + rawLevel);
      if (!Number.isFinite(rawLevel) || rawLevel < 1 || rawLevel > 99) {
        return { text, confidence: r.confidence, parsed: null };
      }
      const offset = parseInt(autoDetect.levelOffset, 10) || 0;
      const corrected = rawLevel + offset;
      lastRawOcrLevel = rawLevel;
      recentRawOcrLevels.push(rawLevel);
      if (recentRawOcrLevels.length > 5) recentRawOcrLevels.shift();
      if (recentRawOcrLevels.length >= 3 && recentRawOcrLevels.every((v) => v === rawLevel)) {
        lastStableRawOcrLevel = rawLevel;
      }
      return {
        text,
        confidence: r.confidence,
        parsed: { level: corrected, raw: rawLevel, offset, agreementCount: 1, totalAttempts: 1 }
      };
    } catch (e) {
      console.warn('[OCR LEVEL paddle] failed:', e);
      return null;
    }
  }

  async function ocrAdenaRegionPaddle() {
    if (!autoDetect.adenaRegion) return null;
    // ADENA만 padding을 크게 — 코인 아이콘 옆 / 영역 가장자리에 글자 닿아 자리 누락되는 문제 완화
    // pad: 10 — 사용자가 leading 글자(앞자리)를 살짝 잘랐을 때 보충 (digit-drop 방지)
    const canvas = captureRegionToRawCanvas(autoDetect.adenaRegion, 1, { pad: 10 });
    if (!canvas) return null;
    // 노란 금화/빨간 별 등 컬러 그래픽 제거 — paddle도 이 영향을 받음
    maskChromaPixels(canvas);
    updatePreview(dom.adAdenaPreview, canvas);
    if (!window.MpPaddle) return null;
    try {
      const r = await window.MpPaddle.recognize(canvas);
      const text = r.text || '';
      const digits = text.replace(/[^0-9]/g, '');
      const adena = digits ? parseInt(digits, 10) : NaN;
      console.log('[OCR ADENA paddle] text=' + JSON.stringify(text) + ' adena=' + adena);
      if (!Number.isFinite(adena) || adena < 0 || adena > 9999999999) {
        return { text, confidence: r.confidence, parsed: null };
      }
      return {
        text,
        confidence: r.confidence,
        parsed: { adena, agreementCount: 1, totalAttempts: 1 }
      };
    } catch (e) {
      console.warn('[OCR ADENA paddle] failed:', e);
      return null;
    }
  }

  async function ocrExpRegionPaddle() {
    if (!autoDetect.expRegion) return null;
    const canvas = captureRegionToRawCanvas(autoDetect.expRegion, 1, { pad: 2 });
    if (!canvas) return null;
    updatePreview(dom.adExpPreview, canvas);
    if (!window.MpPaddle) return null;
    try {
      const r = await window.MpPaddle.recognize(canvas);
      const text = r.text || '';
      // tesseract parseExpText와 동일 — 소수점 매칭 우선, 없으면 4자리 이상 정수에서 마지막 4자리를 소수부로
      let exp = NaN;
      const decMatch = text.match(/(\d{1,3})\s*\.\s*(\d{1,4})/);
      if (decMatch) {
        const intPart = parseInt(decMatch[1], 10);
        const decPart = decMatch[2].padEnd(4, '0').slice(0, 4);
        exp = parseFloat(intPart + '.' + decPart);
      } else {
        const intOnly = text.replace(/[^0-9]/g, '');
        if (intOnly && intOnly.length >= 4) exp = parseExpPct(intOnly);
      }
      console.log('[OCR EXP paddle] text=' + JSON.stringify(text) + ' exp=' + exp);
      if (!Number.isFinite(exp) || exp < 0 || exp > 100) {
        return { text, confidence: r.confidence, parsed: null };
      }
      return {
        text,
        confidence: r.confidence,
        parsed: { exp, agreementCount: 1, totalAttempts: 1 }
      };
    } catch (e) {
      console.warn('[OCR EXP paddle] failed:', e);
      return null;
    }
  }

  // ========================================================================
  // 엔진 dispatcher — autoDetect.ocrEngine으로 분기 (paddle / tesseract / hybrid)
  // ========================================================================
  async function ocrMpRegion() {
    // 사용자가 INPUTS의 현재 MP 칸 편집 중이면 OCR skip (덮어쓰기 방지)
    if (isUserEditing('mp')) return null;
    let r;
    // 1순위 — 바 픽셀 모드: mpBarRegion 지정 + useMpBar 토글 ON
    //   OCR 완전 우회. 컬러 채움 비율 × userMax = cur (100% 정확)
    if (autoDetect.useMpBar && autoDetect.mpBarRegion) r = await ocrMpRegionFromBar();
    // 2순위 — 기존 OCR 엔진 dispatcher
    else if (autoDetect.ocrEngine === 'paddle') r = await ocrMpRegionPaddle();
    else if (autoDetect.ocrEngine === 'hybrid') r = await ocrMpRegionHybrid();
    else r = await ocrMpRegionTesseract();
    if (r && r.parsed && Number.isFinite(r.parsed.cur) && Number.isFinite(r.parsed.max)) {
      recentOcrResults.mp = r.parsed.cur + '/' + r.parsed.max;
    }
    return r;
  }
  async function ocrLevelRegion() {
    if (isUserEditing('level')) return null;
    let r;
    if (autoDetect.ocrEngine === 'paddle') r = await ocrLevelRegionPaddle();
    else if (autoDetect.ocrEngine === 'hybrid') r = await ocrLevelRegionHybrid();
    else r = await ocrLevelRegionTesseract();
    if (r && r.parsed && Number.isFinite(r.parsed.level)) {
      recentOcrResults.level = String(r.parsed.level);
    }
    return r;
  }
  async function ocrAdenaRegion() {
    if (isUserEditing('adena')) return null;
    let r;
    if (autoDetect.ocrEngine === 'paddle') r = await ocrAdenaRegionPaddle();
    else if (autoDetect.ocrEngine === 'hybrid') r = await ocrAdenaRegionHybrid();
    else r = await ocrAdenaRegionTesseract();
    if (r && r.parsed && Number.isFinite(r.parsed.adena)) {
      recentOcrResults.adena = String(r.parsed.adena);
    }
    return r;
  }
  async function ocrExpRegion() {
    if (isUserEditing('exp')) return null;
    let r;
    if (autoDetect.ocrEngine === 'paddle') r = await ocrExpRegionPaddle();
    else if (autoDetect.ocrEngine === 'hybrid') r = await ocrExpRegionHybrid();
    else r = await ocrExpRegionTesseract();
    if (r && r.parsed && Number.isFinite(r.parsed.exp)) {
      recentOcrResults.exp = r.parsed.exp.toFixed(4);
    }
    return r;
  }

  // ========================================================================
  // 하이브리드 voting — paddle + tesseract 동시 실행 후 일치할 때만 채택
  //   · paddle 약점(6/8) ≠ tesseract 약점(3/9, 0/5, 1) → 동시 오탐 확률 매우 낮음
  //   · 하나만 parsed=null → parsed 있는 쪽 채택 (한쪽 엔진 약한 자리)
  //   · 둘 다 parsed 있고 불일치 → parsed=null (anchor 보존, 다음 틱 재시도)
  // ========================================================================
  // In-UI hybrid 결정 로그 — 최근 20건 큐. DevTools 못 여는 사용자도 진단 가능하게.
  const _hybridLogQueue = [];
  function pushHybridLog(msg) {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    _hybridLogQueue.unshift('[' + ts + '] ' + msg);
    if (_hybridLogQueue.length > 20) _hybridLogQueue.length = 20;
    if (dom.hybridDecisionLog) {
      dom.hybridDecisionLog.textContent = _hybridLogQueue.join('\n');
    }
  }

  function voteHybrid(label, paddleR, tessR, parsedMatches) {
    if (!paddleR && !tessR) return null;
    if (!paddleR) return tessR;
    if (!tessR) return paddleR;
    const pp = paddleR.parsed, tp = tessR.parsed;
    if (!pp && !tp) return paddleR;       // 둘 다 인식 실패
    if (!pp) return tessR;                 // tess만 성공
    if (!tp) return paddleR;               // paddle만 성공
    if (parsedMatches(pp, tp)) {           // 둘 다 성공 + 일치 → 채택
      console.log('[Hybrid ' + label + '] match:', pp);
      pushHybridLog(label + ' ✅ match: ' + JSON.stringify(pp));
      return {
        text: 'paddle:"' + paddleR.text + '" / tess:"' + tessR.text + '"',
        confidence: Math.max(paddleR.confidence || 0, tessR.confidence || 0),
        parsed: pp,
        hybrid: true
      };
    }
    // 둘 다 성공 + 불일치 → 거부 (anchor 보존)
    console.log('[Hybrid ' + label + '] DISAGREE: paddle=', pp, 'tess=', tp);
    pushHybridLog(label + ' ❌ DISAGREE p=' + JSON.stringify(pp) + ' t=' + JSON.stringify(tp));
    return { text: 'mismatch p:' + paddleR.text + ' t:' + tessR.text, confidence: 0, parsed: null };
  }

  async function ocrMpRegionHybrid() {
    const [prRaw, trRaw] = await Promise.all([ocrMpRegionPaddle(), ocrMpRegionTesseract()]);
    let pr = prRaw, tr = trRaw;

    // === Slash-drop sanity check (paddle "37/235" → "377235" 같은 slash 무시 차단) ===
    // userMax(INPUTS) 자릿수보다 max가 +2 이상 길면 slash drop misread → 해당 엔진 결과 폐기.
    // 이렇게 하면 mismatch 표시 안 되고 자연스럽게 single-source로 전환됨.
    const userMaxEarly = parseInt(dom.inMaxMp.value, 10) || 0;
    if (userMaxEarly > 0) {
      const maxLen = String(userMaxEarly).length;
      if (pr && pr.parsed && pr.parsed.max && String(pr.parsed.max).length >= maxLen + 2) {
        pushHybridLog('MP ❌ paddle slash-drop 의심 (max=' + pr.parsed.max + ' >> userMax=' + userMaxEarly + '): paddle 폐기');
        pr = { text: pr.text, confidence: 0, parsed: null };
      }
      if (tr && tr.parsed && tr.parsed.max && String(tr.parsed.max).length >= maxLen + 2) {
        pushHybridLog('MP ❌ tess slash-drop 의심 (max=' + tr.parsed.max + ' >> userMax=' + userMaxEarly + '): tess 폐기');
        tr = { text: tr.text, confidence: 0, parsed: null };
      }
    }

    if (!pr || !tr || !pr.parsed || !tr.parsed) {
      return voteHybrid('MP', pr, tr, (a, b) => a.cur === b.cur && a.max === b.max);
    }
    if (pr.parsed.cur === tr.parsed.cur && pr.parsed.max === tr.parsed.max) {
      return voteHybrid('MP', pr, tr, (a, b) => a.cur === b.cur && a.max === b.max);
    }
    // 불일치 — max 일치 + cur 변화량이 plausible(20 이내)이면 단독 채택
    // 정상 사냥 중 MP는 한 틱(1초)에 ±20 이상 안 변함 (기본 ~+10/16s)
    // anchor=0(첫 인식)일 땐 anchor 체크 스킵 — userMax + cur 범위만 검증
    const userMax = parseInt(dom.inMaxMp.value, 10) || 0;
    const anchorCur = parseInt(dom.inCurMp.value, 10) || 0;
    const hasAnchor = anchorCur > 0;
    const pBaseValid = pr.parsed.max === userMax && pr.parsed.cur >= 0 && pr.parsed.cur <= userMax;
    const tBaseValid = tr.parsed.max === userMax && tr.parsed.cur >= 0 && tr.parsed.cur <= userMax;
    const pPlausible = pBaseValid && (!hasAnchor || Math.abs(pr.parsed.cur - anchorCur) <= 20);
    const tPlausible = tBaseValid && (!hasAnchor || Math.abs(tr.parsed.cur - anchorCur) <= 20);
    if (pPlausible && !tPlausible) {
      console.log('[Hybrid MP] paddle plausible, accept:', pr.parsed);
      pushHybridLog('MP 🟢 paddle 단독 채택: ' + pr.parsed.cur + '/' + pr.parsed.max);
      return pr;
    }
    if (tPlausible && !pPlausible) {
      console.log('[Hybrid MP] tess plausible, accept:', tr.parsed);
      pushHybridLog('MP 🟢 tess 단독 채택: ' + tr.parsed.cur + '/' + tr.parsed.max);
      return tr;
    }
    // 둘 다 plausible — anchor 있으면 delta 작은 쪽, 없으면 agreement 높은 쪽
    if (pPlausible && tPlausible) {
      const pAg = pr.parsed.agreementCount || 1;
      const tAg = tr.parsed.agreementCount || 1;
      if (anchorCur > 0) {
        const pDelta = Math.abs(pr.parsed.cur - anchorCur);
        const tDelta = Math.abs(tr.parsed.cur - anchorCur);
        if (pDelta < tDelta) {
          pushHybridLog('MP 🟡 paddle 채택 (delta ' + pDelta + ' < ' + tDelta + '): ' + pr.parsed.cur);
          return pr;
        }
        if (tDelta < pDelta) {
          pushHybridLog('MP 🟡 tess 채택 (delta ' + tDelta + ' < ' + pDelta + '): ' + tr.parsed.cur);
          return tr;
        }
      }
      if (tAg > pAg) { pushHybridLog('MP 🟡 tess 채택 (agreement ↑): ' + tr.parsed.cur); return tr; }
      if (pAg > tAg) { pushHybridLog('MP 🟡 paddle 채택 (agreement ↑): ' + pr.parsed.cur); return pr; }
      pushHybridLog('MP 🟡 paddle 채택 (default primary): ' + pr.parsed.cur);
      return pr;
    }
    return voteHybrid('MP', pr, tr, (a, b) => a.cur === b.cur && a.max === b.max);
  }
  async function ocrLevelRegionHybrid() {
    const [pr, tr] = await Promise.all([ocrLevelRegionPaddle(), ocrLevelRegionTesseract()]);
    return voteHybrid('LEVEL', pr, tr, (a, b) => a.level === b.level);
  }
  async function ocrAdenaRegionHybrid() {
    const [pr, tr] = await Promise.all([ocrAdenaRegionPaddle(), ocrAdenaRegionTesseract()]);
    // 1) 둘 다 실패 / 한 쪽만 성공은 voteHybrid 기본 로직 통과
    if (!pr || !tr || !pr.parsed || !tr.parsed) {
      return voteHybrid('ADENA', pr, tr, (a, b) => a.adena === b.adena);
    }
    // 2) 일치하면 채택 — 단 anchor 대비 큰 점프(±1,000원 이상) 시 verification queue
    if (pr.parsed.adena === tr.parsed.adena) {
      // 사용자 컨텍스트(2026-05-04): "한 마리 최대 +700원, 거래는 큰 점프 → verify로 처리"
      // 1,000원 threshold = 700 max + 300 안전 마진. 검증 큐는 같은 값 2회 연속 → ACCEPT.
      const anchorAd = parseInt(dom.trkAdenaNow.value, 10) || 0;
      const valBoth = pr.parsed.adena;
      if (anchorAd > 0) {
        const delta = Math.abs(valBoth - anchorAd);
        const ABS_JUMP = 1000;
        if (delta >= ABS_JUMP) {
          if (!ocrAdenaRegionHybrid._verifyQueue) ocrAdenaRegionHybrid._verifyQueue = { val: null, count: 0 };
          const vq = ocrAdenaRegionHybrid._verifyQueue;
          if (vq.val !== null && vq.val === valBoth) {
            vq.count++;
            if (vq.count >= 2) {
              vq.val = null; vq.count = 0;
              pushHybridLog('ADENA 🟢 검증 통과 (큰 점프 ±' + delta.toLocaleString() + '): ' + valBoth.toLocaleString());
              return voteHybrid('ADENA', pr, tr, (a, b) => a.adena === b.adena);
            }
            pushHybridLog('ADENA ⏳ 검증중 (' + (vq.count + 1) + '/3) ±' + delta.toLocaleString() + ': ' + valBoth.toLocaleString());
            return { text: 'verifying ' + valBoth, confidence: 0, parsed: null };
          }
          vq.val = valBoth; vq.count = 1;
          pushHybridLog('ADENA ⏳ 검증 시작 (큰 점프 ±' + delta.toLocaleString() + '): ' + valBoth.toLocaleString());
          return { text: 'verifying ' + valBoth, confidence: 0, parsed: null };
        }
      }
      return voteHybrid('ADENA', pr, tr, (a, b) => a.adena === b.adena);
    }
    // 3) 불일치 — ADENA 특별 처리
    //    anchor (현재 트래커 NOW 값) 자릿수와 일치하는 쪽 우선
    //    digit-drop misread는 자릿수가 짧음, anchor가 5자리면 5자리 결과 우선
    const anchor = parseInt(dom.trkAdenaNow.value, 10) || 0;
    if (anchor > 0) {
      const anchorDigits = String(anchor).length;
      const pDigits = String(pr.parsed.adena).length;
      const tDigits = String(tr.parsed.adena).length;
      if (pDigits === anchorDigits && tDigits !== anchorDigits) {
        // ADENA는 사냥 중 증가만 하는 것이 일반적 — paddle 값이 anchor보다 너무 작으면 implausible
        if (pr.parsed.adena >= anchor * 0.5) {
          console.log('[Hybrid ADENA] paddle digits match anchor (' + anchorDigits + '), accept:', pr.parsed.adena);
          pushHybridLog('ADENA 🟢 paddle 단독 채택 (자릿수 매치): ' + pr.parsed.adena);
          return pr;
        }
      }
      if (tDigits === anchorDigits && pDigits !== anchorDigits) {
        if (tr.parsed.adena >= anchor * 0.5) {
          console.log('[Hybrid ADENA] tess digits match anchor (' + anchorDigits + '), accept:', tr.parsed.adena);
          pushHybridLog('ADENA 🟢 tess 단독 채택 (자릿수 매치): ' + tr.parsed.adena);
          return tr;
        }
      }
      // 한쪽은 anchor 이상 자릿수, 다른쪽은 미달 → 미달인 쪽이 digit-drop misread
      // ADENA는 사냥 중 증가만 → 자릿수 anchor 이상 + value ≥ anchor*0.5 면 신뢰
      if (pDigits >= anchorDigits && tDigits < anchorDigits) {
        if (pr.parsed.adena >= anchor * 0.5) {
          pushHybridLog('ADENA 🟡 paddle 채택 (tess digit-drop): paddle=' + pr.parsed.adena + ' tess=' + tr.parsed.adena);
          return pr;
        }
      }
      if (tDigits >= anchorDigits && pDigits < anchorDigits) {
        if (tr.parsed.adena >= anchor * 0.5) {
          pushHybridLog('ADENA 🟡 tess 채택 (paddle digit-drop): tess=' + tr.parsed.adena + ' paddle=' + pr.parsed.adena);
          return tr;
        }
      }
      // 둘 다 anchor 이상 자릿수 + 불일치
      if (pDigits >= anchorDigits && tDigits >= anchorDigits) {
        const pAg = (pr.parsed.agreementCount || 1);
        const tAg = (tr.parsed.agreementCount || 1);
        const pVal = pr.parsed.adena;
        const tVal = tr.parsed.adena;
        // === Anti-stuck 휴리스틱 ===
        // ADENA는 사냥 중 monotonic 증가만 함. 한 엔진이 anchor와 정확히 같고
        // 다른 엔진은 anchor 너머로 전진했다면 → 일치하는 쪽이 cached misread,
        // 전진한 쪽이 진짜 새 값일 확률 높음.
        // 단 jump가 비정상(>20k/tick)이면 reject.
        if (anchor > 0) {
          const pIsAnchor = pVal === anchor;
          const tIsAnchor = tVal === anchor;
          const MAX_JUMP = 20000;
          if (tIsAnchor && pVal > anchor && (pVal - anchor) <= MAX_JUMP) {
            pushHybridLog('ADENA 🟢 paddle 채택 (전진 vs tess stuck@anchor=' + anchor + '): p=' + pVal + ' t=' + tVal);
            return pr;
          }
          if (pIsAnchor && tVal > anchor && (tVal - anchor) <= MAX_JUMP) {
            pushHybridLog('ADENA 🟢 tess 채택 (전진 vs paddle stuck@anchor=' + anchor + '): t=' + tVal + ' p=' + pVal);
            return tr;
          }
          // Anti-backward: 한쪽이 anchor와 정확 일치 + 다른쪽이 anchor 미만 → anchor 일치 쪽 신뢰
          //   (사용자가 anchor를 수동 보정한 경우, 잘못된 쪽이 backward로 떨어짐)
          if (pIsAnchor && tVal < anchor) {
            pushHybridLog('ADENA 🟢 paddle 채택 (anchor 일치 vs tess backward): p=' + pVal + ' t=' + tVal);
            return pr;
          }
          if (tIsAnchor && pVal < anchor) {
            pushHybridLog('ADENA 🟢 tess 채택 (anchor 일치 vs paddle backward): t=' + tVal + ' p=' + pVal);
            return tr;
          }
          // 둘 다 anchor 미만 (backward) → reject (anchor 보존)
          if (pVal < anchor && tVal < anchor) {
            pushHybridLog('ADENA ❌ 둘 다 backward (p=' + pVal + ' t=' + tVal + ' < anchor=' + anchor + ') — 보존');
            return { text: 'mismatch p:' + pr.text + ' t:' + tr.text, confidence: 0, parsed: null };
          }
          // 둘 다 anchor와 다르고 둘 다 anchor보다 큼 → ADENA monotonic 가정상 큰 쪽
          //   (digit shrink misread (8→5) 가 enlarge misread (5→8) 보다 빈도 높음)
          //   단 비율 차이 3배 이상이면 한쪽이 자릿수-수준 misread일 수 있어 reject
          if (pVal > anchor && tVal > anchor && pVal !== tVal) {
            const pDelta = pVal - anchor;
            const tDelta = tVal - anchor;
            const ratio = Math.max(pDelta, tDelta) / Math.max(1, Math.min(pDelta, tDelta));
            if (ratio < 3 && Math.max(pDelta, tDelta) <= MAX_JUMP) {
              if (pVal > tVal) {
                pushHybridLog('ADENA 🟡 paddle 채택 (larger forward): p=' + pVal + ' t=' + tVal + ' (anchor=' + anchor + ')');
                return pr;
              }
              if (tVal > pVal) {
                pushHybridLog('ADENA 🟡 tess 채택 (larger forward): t=' + tVal + ' p=' + pVal + ' (anchor=' + anchor + ')');
                return tr;
              }
            }
          }
        }
        // 그 외 — agreementCount fallback (다수결 통과한 결과 더 신뢰)
        if (tAg > pAg) {
          pushHybridLog('ADENA 🟡 tess 채택 (agreement ↑ ' + tAg + '>' + pAg + '): t=' + tVal + ' p=' + pVal);
          return tr;
        }
        if (pAg > tAg) {
          pushHybridLog('ADENA 🟡 paddle 채택 (agreement ↑ ' + pAg + '>' + tAg + '): p=' + pVal + ' t=' + tVal);
          return pr;
        }
      }
      // 자릿수가 둘 다 anchor보다 작은 misread → 일반적으로 reject (anchor 보존)
      //
      // 단 — Cached anchor 복구 휴리스틱 (동일 paddle 값 N회 연속 → anchor 갱신):
      //   사용자 anchor가 이전 misread로 잘못 캐시된 경우 자동 탈출
      //   조건: paddle 4+자리 + anchor보다 1자리 적음 + 같은 값 3회 반복
      if (pDigits < anchorDigits && tDigits < anchorDigits) {
        const pVal = pr.parsed.adena;
        // 정적 카운터 (사용자 ADENA 영역별로)
        if (!ocrAdenaRegionHybrid._dropRecover) ocrAdenaRegionHybrid._dropRecover = { lastVal: 0, count: 0 };
        const dr = ocrAdenaRegionHybrid._dropRecover;
        const sameAsLast = pVal === dr.lastVal;
        if (sameAsLast) dr.count++;
        else { dr.lastVal = pVal; dr.count = 1; }
        const RECOVER_THRESHOLD = 2;  // 3 → 2 (반응성 ↑, 안전성 살짝 ↓)
        const canRecover = dr.count >= RECOVER_THRESHOLD &&
                           pDigits >= 4 &&
                           pDigits === anchorDigits - 1 &&
                           pVal > 0;
        if (canRecover) {
          console.log('[Hybrid ADENA] 🔓 cached anchor 복구: paddle=' + pVal + ' (' + dr.count + '회 연속 digit-drop) vs old anchor=' + anchor);
          pushHybridLog('🔓 ADENA cached anchor 복구: ' + anchor + ' → ' + pVal + ' (' + dr.count + '회 연속)');
          dr.count = 0;
          dr.lastVal = 0;
          return pr;
        }
        console.log('[Hybrid ADENA] both digit-drops vs anchor=' + anchor + ': p=' + pr.parsed.adena + ' t=' + tr.parsed.adena + ' (recover ' + dr.count + '/' + RECOVER_THRESHOLD + ')');
        pushHybridLog('ADENA ❌ 둘 다 digit-drop vs anchor=' + anchor + ' (' + dr.count + '/' + RECOVER_THRESHOLD + ')');
        return { text: 'mismatch p:' + pr.text + ' t:' + tr.text, confidence: 0, parsed: null };
      }
    }
    // 4) 그 외 일반 voting (불일치 → reject)
    return voteHybrid('ADENA', pr, tr, (a, b) => a.adena === b.adena);
  }
  async function ocrExpRegionHybrid() {
    const [prRaw, trRaw] = await Promise.all([ocrExpRegionPaddle(), ocrExpRegionTesseract()]);
    let pr = prRaw, tr = trRaw;
    const matcher = (a, b) => Math.abs(a.exp - b.exp) < 0.01;

    // === Phantom digit sanity check (paddle 51.0432 → 51.84321 같은 phantom "1" 추가 차단) ===
    // anchor가 N자리 소수점이면 OCR 결과도 N자리여야 함. anchor 대비 자릿수 +1 이상 +
    // anchor와 0.3%p 이상 떨어진 결과는 phantom digit으로 판정 → 해당 엔진 결과 폐기.
    const anchorEarly = parseExpPct(dom.trkExpNow.value) || 0;
    if (anchorEarly > 0) {
      const expDecimalDigits = (val) => {
        if (!Number.isFinite(val)) return 0;
        const s = String(val).replace(/0+$/, '');
        const dot = s.indexOf('.');
        return dot < 0 ? 0 : s.length - dot - 1;
      };
      const ad = expDecimalDigits(anchorEarly);
      if (ad >= 2) {
        if (pr && pr.parsed) {
          const pd = expDecimalDigits(pr.parsed.exp);
          const pDelta = Math.abs(pr.parsed.exp - anchorEarly);
          if (pd > ad && pDelta > 0.3) {
            pushHybridLog('EXP ❌ paddle phantom digit (자릿수 ' + pd + ' > anchor ' + ad + ', Δ' + pDelta.toFixed(3) + '%p): paddle 폐기');
            pr = { text: pr.text, confidence: 0, parsed: null };
          }
        }
        if (tr && tr.parsed) {
          const td = expDecimalDigits(tr.parsed.exp);
          const tDelta = Math.abs(tr.parsed.exp - anchorEarly);
          if (td > ad && tDelta > 0.3) {
            pushHybridLog('EXP ❌ tess phantom digit (자릿수 ' + td + ' > anchor ' + ad + ', Δ' + tDelta.toFixed(3) + '%p): tess 폐기');
            tr = { text: tr.text, confidence: 0, parsed: null };
          }
        }
      }
    }

    if (!pr || !tr || !pr.parsed || !tr.parsed) {
      return voteHybrid('EXP', pr, tr, matcher);
    }
    if (matcher(pr.parsed, tr.parsed)) {
      // 둘 다 일치 — 단 anchor에서 0.1%p 이상 점프 시 verification 필요 (사용자 요청)
      const anchorBoth = parseExpPct(dom.trkExpNow.value) || 0;
      const valBoth = pr.parsed.exp;
      if (anchorBoth > 0) {
        const deltaBoth = valBoth - anchorBoth;
        const isLevelUp = anchorBoth > 95 && valBoth < 5;
        if (Math.abs(deltaBoth) > 0.1 && !isLevelUp) {
          // 큰 점프 (둘 다 일치하지만 anchor 대비 >0.1%p) — 검증 큐에 넣기
          if (!ocrExpRegionHybrid._verifyQueue) ocrExpRegionHybrid._verifyQueue = { val: null, count: 0 };
          const vq = ocrExpRegionHybrid._verifyQueue;
          const tol = 0.001;
          if (vq.val !== null && Math.abs(vq.val - valBoth) < tol) {
            vq.count++;
            if (vq.count >= 2) {
              vq.val = null; vq.count = 0;
              pushHybridLog('EXP 🟢 검증 통과 (큰 점프 ' + deltaBoth.toFixed(3) + '%p): ' + valBoth);
              return voteHybrid('EXP', pr, tr, matcher);
            }
            pushHybridLog('EXP ⏳ 검증중 (' + (vq.count + 1) + '/3) 점프 ' + deltaBoth.toFixed(3) + '%p: ' + valBoth);
            return { text: 'verifying ' + valBoth, confidence: 0, parsed: null };
          }
          vq.val = valBoth; vq.count = 1;
          pushHybridLog('EXP ⏳ 검증 시작 (점프 ' + deltaBoth.toFixed(3) + '%p > 0.1%p): ' + valBoth);
          return { text: 'verifying ' + valBoth, confidence: 0, parsed: null };
        }
      }
      return voteHybrid('EXP', pr, tr, matcher);
    }
    // 불일치 — anchor 대비 매우 작은 전진(±0.1%p)만 즉시 채택, 더 큰 변화는 verification 필요
    //
    // 사용자 지시 (2026-05-04): "한틱에 5%는 너무 높고.. 0.1% 이상도 막아줘"
    // 변경: 0.1%p 즉시 허용 / 0.1~3%p 검증 큐 / 그 이상 reject (단 레벨업 예외)
    const anchor = parseExpPct(dom.trkExpNow.value) || 0;
    const isPlausibleForward = (val) => {
      if (anchor <= 0) return val > 0 && val <= 100;  // 첫 인식
      const delta = val - anchor;
      // 즉시 허용: 매우 작은 전진/후진 (±0.1%p) — 정상 OCR 노이즈 범위
      if (Math.abs(delta) <= 0.1) return true;
      // 레벨업 점프: prev > 95% AND new < 5% (level transition)
      if (anchor > 95 && val < 5) return true;
      return false;
    };
    // EXP 검증 큐 — 큰 변화는 1번 더 봐야 인정
    if (!ocrExpRegionHybrid._verifyQueue) ocrExpRegionHybrid._verifyQueue = { val: null, count: 0 };
    const checkVerification = (val) => {
      const vq = ocrExpRegionHybrid._verifyQueue;
      const tol = 0.001;
      if (vq.val !== null && Math.abs(vq.val - val) < tol) {
        vq.count++;
        if (vq.count >= 2) { vq.val = null; vq.count = 0; return true; }
      } else {
        vq.val = val;
        vq.count = 1;
      }
      return false;
    };
    const pp = isPlausibleForward(pr.parsed.exp);
    const tp = isPlausibleForward(tr.parsed.exp);
    if (pp && !tp) {
      console.log('[Hybrid EXP] paddle plausible forward, accept:', pr.parsed.exp, 'anchor=', anchor);
      pushHybridLog('EXP 🟢 paddle 단독 채택 (전진): ' + pr.parsed.exp + ' (anchor=' + anchor + ')');
      return pr;
    }
    if (tp && !pp) {
      console.log('[Hybrid EXP] tess plausible forward, accept:', tr.parsed.exp, 'anchor=', anchor);
      pushHybridLog('EXP 🟢 tess 단독 채택 (전진): ' + tr.parsed.exp + ' (anchor=' + anchor + ')');
      return tr;
    }
    // 둘 다 plausible — anchor 있으면 delta 작은 쪽, 없으면 agreement 높은 쪽
    if (pp && tp) {
      const pAg = pr.parsed.agreementCount || 1;
      const tAg = tr.parsed.agreementCount || 1;
      if (anchor > 0) {
        const pDelta = Math.abs(pr.parsed.exp - anchor);
        const tDelta = Math.abs(tr.parsed.exp - anchor);
        if (pDelta < tDelta) {
          pushHybridLog('EXP 🟡 paddle 채택 (delta ' + pDelta.toFixed(4) + ' < tess ' + tDelta.toFixed(4) + '): ' + pr.parsed.exp);
          return pr;
        }
        if (tDelta < pDelta) {
          pushHybridLog('EXP 🟡 tess 채택 (delta ' + tDelta.toFixed(4) + ' < paddle ' + pDelta.toFixed(4) + '): ' + tr.parsed.exp);
          return tr;
        }
      }
      // anchor 없거나 delta 동률 → agreement 높은 쪽
      if (tAg > pAg) { pushHybridLog('EXP 🟡 tess 채택 (agreement ↑ ' + tAg + '>' + pAg + '): ' + tr.parsed.exp); return tr; }
      if (pAg > tAg) { pushHybridLog('EXP 🟡 paddle 채택 (agreement ↑ ' + pAg + '>' + tAg + '): ' + pr.parsed.exp); return pr; }
      pushHybridLog('EXP 🟡 paddle 채택 (default primary): ' + pr.parsed.exp);
      return pr;
    }
    return voteHybrid('EXP', pr, tr, matcher);
  }

  // Sanity check: confidence가 신뢰성 낮을 때 결과 자체로 검증
  function isValidMpParsed(p) {
    return p && Number.isFinite(p.cur) && Number.isFinite(p.max)
      && p.cur >= 0 && p.max > 0 && p.max <= 99999 && p.cur <= p.max;
  }
  function isValidExpParsed(p) {
    return p && Number.isFinite(p.exp) && p.exp >= 0 && p.exp <= 100;
  }

  // 일관성 검증: 같은 값이 N회 연속 나와야 진짜로 인정 (단발 OCR 오류 거름)
  // autoDetect.stabilityRequired로 사용자가 조정 (0=즉시, 1=1회, 2=2회 연속)
  let mpStableLast = null;     // 'cur/max'
  let mpStableCount = 0;
  let expStableLast = null;    // 'exp'
  let expStableCount = 0;
  let levelStableLast = null;  // 마지막 OCR 레벨 (stability tracking)
  let levelStableCount = 0;
  let adenaStableLast = null;  // 마지막 OCR 아데나
  let adenaStableCount = 0;

  function getStabilityRequired() {
    const v = autoDetect.stabilityRequired;
    if (v === 0 || v === '0') return 0;
    if (v === 1 || v === '1') return 1;
    return 2;  // 기본 2 (안정성 우선)
  }

  function checkStability(key, lastKey, count) {
    const req = getStabilityRequired();
    if (req === 0) return { lastKey: key, count: 1, stable: true };  // 즉시 통과
    if (key === lastKey) return { lastKey, count: count + 1, stable: count + 1 >= req };
    return { lastKey: key, count: 1, stable: 1 >= req };
  }

  async function runDetectionTick() {
    if (detectionRunning) {
      // Watchdog: 10초 이상 hang 상태면 force unlock — paddle/tesseract 호출이 응답 없으면 시스템 영구 정지 방지
      if (detectionRunningSince > 0 && Date.now() - detectionRunningSince > 10000) {
        console.error('[AutoDetect] tick stuck > 10s, force unlocking — 다음 틱 진행');
        detectionRunning = false;
      } else {
        return; // 정상 진행 중 스킵
      }
    }
    detectionRunning = true;
    detectionRunningSince = Date.now();
    const threshold = (typeof autoDetect.confidenceThreshold === 'number') ? autoDetect.confidenceThreshold : 0;
    try {
      // MP 영역 (또는 MP 바 영역) — useMpBar 모드에서는 mpBarRegion만 있어도 측정
      if (autoDetect.mpRegion || (autoDetect.useMpBar && autoDetect.mpBarRegion)) {
        try {
          const r = await ocrMpRegion();
          if (r) {
            const validParsed = isValidMpParsed(r.parsed);
            const passConfidence = r.confidence >= threshold;
            // 일관성 검증
            const key = validParsed ? `${r.parsed.cur}/${r.parsed.max}` : null;
            const stab = checkStability(key, mpStableLast, mpStableCount);
            mpStableLast = stab.lastKey;
            mpStableCount = stab.count;
            console.log('[OCR MP decision]', { parsed: r.parsed, validParsed, conf: r.confidence, threshold, passConfidence, stableCount: mpStableCount, stable: stab.stable });
            if (validParsed && passConfidence && stab.stable) {
              const { cur, max } = r.parsed;
              const prevCur = parseInt(dom.inCurMp.value, 10) || 0;
              const prevMax = parseInt(dom.inMaxMp.value, 10) || 0;
              let curChanged = false, maxChanged = false;
              if (cur !== prevCur) { dom.inCurMp.value = cur; curChanged = true; }
              if (max !== prevMax) { dom.inMaxMp.value = max; maxChanged = true; }
              if (curChanged || maxChanged) {
                if (mpState.running) {
                  if (curChanged) {
                    // OCR이 실제 MP를 잡았으니 시뮬레이션 baseline 자체를 리셋
                    // (기존엔 시뮬값이 매 틱 입력 필드를 덮어쓰면서 OCR이 무시되어 알람이 앞서갔음)
                    mpState.startMp = cur;
                    mpState.accumulatedMp = 0;
                    mpState.segmentStartAt = Date.now();
                    mpState.prevConfigSnapshot = cloneCfg(readMpConfig());
                    tickMp();
                  } else {
                    // maxMp만 변경된 경우 — 회복량/누적 영향 없음, target만 갱신
                    onConfigChangedWhileRunning();
                  }
                } else {
                  renderAll();
                }
                saveLast();
              }
              // 자동 START — idle/done 상태이고 cur < target이면 타이머 시작 (매 틱 체크)
              if (autoDetect.autoStart && !mpState.running && !mpState.paused) {
                const cfgNow = readMpConfig();
                const tgt = effectiveTargetMp(cfgNow);
                if (cfgNow.curMp < tgt && cfgNow.state !== 'blocked' && cfgNow.curMp >= 0) {
                  try { startTimer(); } catch (_) {}
                }
              }
              const confLabel = r.confidence > 0 ? ` · ${Math.round(r.confidence)}%` : '';
              const stableLabel = mpStableCount > 1 ? ` ×${mpStableCount}` : '';
              dom.adMpLast.textContent = `✅ ${cur}/${max}${confLabel}${stableLabel}`;
            } else if (r.parsed && !validParsed) {
              dom.adMpLast.textContent = `🟡 ${r.parsed.cur}/${r.parsed.max} (범위 벗어남)`;
            } else if (r.parsed && validParsed && !stab.stable) {
              dom.adMpLast.textContent = `🔄 ${r.parsed.cur}/${r.parsed.max} (검증 ${mpStableCount}/${getStabilityRequired() || 3})`;
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
            // Stability key를 "정수 + 소수 1자리"로 grouping → 정상 사냥(소수 끝자리만 변함)에서도 count 누적,
            // mis-read 점프(54→59)는 다른 그룹이라 자연스럽게 reset
            const expKey = validParsed ? (Math.round(r.parsed.exp * 10) / 10).toFixed(1) : null;
            const stabExp = checkStability(expKey, expStableLast, expStableCount);
            expStableLast = stabExp.lastKey;
            expStableCount = stabExp.count;
            // Plausibility: 이전 ±3%p 초과 점프는 strict (단, -50%p 이상 음수 변화는 레벨업 점프로 허용)
            // 첫 인식(prev ≤ 0)도 strict 처리 — 자동감지 시작 시 잘못된 첫 인식이 박히지 않게
            const prevExpForJump = parseExpPct(dom.trkExpNow.value);
            const expDelta = (validParsed && Number.isFinite(prevExpForJump)) ? (r.parsed.exp - prevExpForJump) : 0;
            const isLevelUpJump = expDelta < -50;
            const isFirstExp = !(prevExpForJump > 0);
            const isExpJump = !isLevelUpJump && (isFirstExp || Math.abs(expDelta) > 3);
            const userStable = getStabilityRequired() || 3;
            // 5회 = OCR이 일관되게 다른 값 잡으면 빨리 escape (잘못된 anchor에서 빠져나오기)
            const requiredExpStable = isExpJump ? 5 : Math.max(1, userStable);
            const passPlausibility = expStableCount >= requiredExpStable;
            console.log('[OCR EXP decision]', { parsed: r.parsed, validParsed, conf: r.confidence, threshold, passConfidence, stableCount: expStableCount, requiredExpStable, isExpJump, expDelta });
            if (validParsed && passConfidence && passPlausibility) {
              const exp = r.parsed.exp;
              const prev = parseExpPct(dom.trkExpNow.value);
              if (Math.abs(exp - prev) > 0.0001) {
                dom.trkExpNow.value = formatExpPct(exp);
                renderTracker();
                saveTrackerCurrent();
              }
              // 트래커 자동 시작: 트래커 비활성(idle 또는 RESET 직후) + 자동시작 옵션 ON
              // applyInitialSnapshot으로 모든 영역(LEVEL/EXP/ADENA) 시작값 잡힌 뒤 startTracker
              if (autoDetect.autoStartTracker && !tracker.active && !autoStartInProgress) {
                autoStartInProgress = true;
                (async () => {
                  try {
                    await applyInitialSnapshot();
                    if (!tracker.active) {
                      try { startTracker(); console.log('[AutoDetect] 트래커 자동 시작 (재시작 포함)'); } catch (_) {}
                    }
                  } finally {
                    autoStartInProgress = false;
                  }
                })();
              }
              const confLabel = r.confidence > 0 ? ` · ${Math.round(r.confidence)}%` : '';
              dom.adExpLast.textContent = `✅ ${formatExpPct(exp)}%${confLabel}`;
            } else if (r.parsed && !validParsed) {
              dom.adExpLast.textContent = `🟡 ${formatExpPct(r.parsed.exp)}% (범위 벗어남)`;
            } else if (r.parsed && validParsed && !passPlausibility) {
              const jumpHint = isExpJump ? ' 🚧 점프' : '';
              dom.adExpLast.textContent = `🔄 ${formatExpPct(r.parsed.exp)}% (검증 ${expStableCount}/${requiredExpStable})${jumpHint}`;
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
      // 레벨 영역 — 다수결 + stability + plausibility (이전 ±2 초과 점프는 5회 동일 요구)
      if (autoDetect.levelRegion) {
        try {
          const r = await ocrLevelRegion();
          if (r) {
            if (r.parsed) {
              const lv = r.parsed.level;
              const agreement = r.parsed.agreementCount || 1;
              const total = r.parsed.totalAttempts || 1;
              const isHighConfidence = agreement >= 2;  // PSM 3개 중 2개 이상 일치
              if (isHighConfidence) {
                // Stability tracking
                if (lv === levelStableLast) levelStableCount++;
                else { levelStableLast = lv; levelStableCount = 1; }
                // Plausibility: 이전 입력값 대비 큰 점프(±2 초과)면 5회 동일 요구
                // 첫 인식(prev ≤ 1, default값)도 strict — 잘못된 첫 인식 박히는 것 방지
                // 5회 = OCR이 일관되게 다른 값 잡으면 빨리 escape (잘못된 anchor에서 빠져나오기)
                const prev = parseInt(dom.trkLevelNow.value, 10) || 0;
                const isFirstLv = !(prev > 1);
                const isJump = isFirstLv || Math.abs(lv - prev) > 2;
                const requiredStable = isJump ? 5 : 3;
                const offsetLabel = r.parsed.offset ? ` ${r.parsed.offset > 0 ? '+' : ''}${r.parsed.offset}` : '';
                const rawLabel = r.parsed.offset ? ` (raw=${r.parsed.raw}${offsetLabel})` : '';

                if (levelStableCount >= requiredStable) {
                  if (lv !== prev) {
                    dom.trkLevelNow.value = lv;
                    renderTracker();
                    saveTrackerCurrent();
                  }
                  const stableLabel = levelStableCount > 1 ? ` ×${levelStableCount}` : '';
                  dom.adLevelLast.textContent = `✅ Lv.${lv} (${agreement}/${total} 일치)${stableLabel}${rawLabel}`;
                } else {
                  const jumpHint = isJump ? ' 🚧 점프' : '';
                  dom.adLevelLast.textContent = `🔄 Lv.${lv} (${agreement}/${total} · 검증 ${levelStableCount}/${requiredStable})${jumpHint}`;
                  console.log('[OCR LEVEL plausibility]', { lv, prev, isJump, levelStableCount, requiredStable });
                }
              } else {
                dom.adLevelLast.textContent = `🔄 Lv.${lv} (${agreement}/${total} — 다수결 미달)`;
              }
            } else {
              dom.adLevelLast.textContent = `❌ "${(r.text || '???').slice(0, 20)}"`;
            }
          }
        } catch (e) {
          dom.adLevelLast.textContent = '⚠️ ' + (e.message || e);
        }
      }
      // 아데나 영역 — 다수결 + stability + plausibility (큰 점프 시 5회 동일 요구)
      if (autoDetect.adenaRegion) {
        try {
          const r = await ocrAdenaRegion();
          if (r) {
            if (r.parsed) {
              const ad = r.parsed.adena;
              const prev = parseInt(dom.trkAdenaNow.value, 10) || 0;
              // Stability tracking
              if (ad === adenaStableLast) adenaStableCount++;
              else { adenaStableLast = ad; adenaStableCount = 1; }
              // Plausibility: 이전 대비 ±100k 또는 ±20% 초과 점프 시 5회 strict
              // 첫 인식(prev ≤ 0)도 strict — 잘못된 첫 인식 박히는 것 방지
              // 5회 = OCR이 일관되게 다른 값 잡으면 빨리 escape
              const diff = Math.abs(ad - prev);
              const isFirstAd = !(prev > 0);
              const isJump = isFirstAd || diff > 100000 || diff > prev * 0.2;
              const requiredStable = isJump ? 5 : 3;

              if (adenaStableCount >= requiredStable) {
                if (ad !== prev) {
                  dom.trkAdenaNow.value = ad;
                  renderTracker();
                  saveTrackerCurrent();
                }
                const stableLabel = adenaStableCount > 1 ? ` ×${adenaStableCount}` : '';
                dom.adAdenaLast.textContent = `✅ ${formatNumber(ad)}${stableLabel}`;
              } else {
                const jumpHint = isJump ? ' 🚧 점프' : '';
                dom.adAdenaLast.textContent = `🔄 ${formatNumber(ad)} (검증 ${adenaStableCount}/${requiredStable})${jumpHint}`;
                console.log('[OCR ADENA plausibility]', { ad, prev, diff, isJump, adenaStableCount, requiredStable });
              }
            } else {
              dom.adAdenaLast.textContent = `❌ "${(r.text || '???').slice(0, 20)}"`;
            }
          }
        } catch (e) {
          dom.adAdenaLast.textContent = '⚠️ ' + (e.message || e);
        }
      }
    } catch (e) {
      console.error('[AutoDetect] tick error:', e);
    } finally {
      detectionRunning = false;
    }
  }

  // 자동 감지 시작 시 OCR해서 시작값 자동 설정
  // 첫 캡처 프레임이 노이즈/PSM 다수결 미통과로 실패할 수 있어 retry
  async function applyInitialSnapshot() {
    console.log('[AutoDetect] initial snapshot 시작');
    let needExp = !!autoDetect.expRegion;
    let needLevel = !!autoDetect.levelRegion;
    let needAdena = !!autoDetect.adenaRegion;
    const MAX_ITERS = 5;
    const RETRY_DELAY_MS = 800;

    for (let i = 0; i < MAX_ITERS; i++) {
      try {
        if (needExp) {
          const r = await ocrExpRegion();
          if (r && r.parsed && isValidExpParsed(r.parsed)) {
            const formatted = formatExpPct(r.parsed.exp);
            dom.trkExpStart.value = formatted;
            dom.trkExpNow.value = formatted;
            console.log('[AutoDetect] EXP 시작값 설정 (iter ' + (i+1) + '):', formatted);
            needExp = false;
          }
        }
        if (needLevel) {
          const r = await ocrLevelRegion();
          // 다수결 통과한 값만 신뢰 (단발 OCR noise 거름)
          if (r && r.parsed && (r.parsed.agreementCount || 1) >= 2) {
            dom.trkLevelStart.value = r.parsed.level;
            dom.trkLevelNow.value = r.parsed.level;
            console.log('[AutoDetect] LEVEL 시작값 설정 (iter ' + (i+1) + '):', r.parsed.level);
            needLevel = false;
          }
        }
        if (needAdena) {
          const r = await ocrAdenaRegion();
          if (r && r.parsed) {
            dom.trkAdenaStart.value = r.parsed.adena;
            dom.trkAdenaNow.value = r.parsed.adena;
            console.log('[AutoDetect] ADENA 시작값 설정 (iter ' + (i+1) + '):', r.parsed.adena);
            needAdena = false;
          }
        }
        saveTrackerCurrent();
        renderTracker();

        // 모든 영역 잡혔으면 조기 리턴
        if (!needExp && !needLevel && !needAdena) {
          console.log('[AutoDetect] initial snapshot 완료 (' + (i+1) + '회 시도)');
          return;
        }
        if (dom.adInitStatus) {
          const remaining = [needExp && 'EXP', needLevel && 'LEVEL', needAdena && 'ADENA'].filter(Boolean).join(',');
          dom.adInitStatus.textContent = `⏳ 시작값 자동 설정... (${remaining} 재시도 ${i+1}/${MAX_ITERS})`;
        }
        if (i < MAX_ITERS - 1) {
          await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
        }
      } catch (e) {
        console.warn('[AutoDetect] applyInitialSnapshot iter ' + i + ' 실패:', e);
      }
    }
    if (needExp || needLevel || needAdena) {
      console.warn('[AutoDetect] 일부 시작값 설정 실패 (기본값 유지):', { exp: needExp, level: needLevel, adena: needAdena });
    }
  }

  async function startAutoDetect() {
    const hasMp = !!(autoDetect.mpRegion && autoDetect.mpRegion.sourceId);
    const hasMpBar = !!(autoDetect.mpBarRegion && autoDetect.mpBarRegion.sourceId);
    const hasExp = !!(autoDetect.expRegion && autoDetect.expRegion.sourceId);
    if (!hasMp && !hasMpBar && !hasExp) {
      flashHint('먼저 [📷 MP 영역] / [📊 MP 바] / [📷 경험치 영역] 중 하나를 지정하세요.');
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
      // 템플릿 매처 로드 (병렬, 실패해도 OCR 동작은 가능)
      const templateLoadPromise = (window.TemplateMatcher && !window.TemplateMatcher.isLoaded())
        ? window.TemplateMatcher.load('./js/digit-templates.json')
            .then((ok) => {
              if (ok) {
                console.log('[AutoDetect] TemplateMatcher: OK ' + window.TemplateMatcher.templateCount() + ' 템플릿');
                pushHybridLog('✅ Template ' + window.TemplateMatcher.templateCount() + '개 로드');
              } else {
                console.warn('[AutoDetect] TemplateMatcher load returned false');
                pushHybridLog('❌ Template 로드 실패');
              }
            })
            .catch((e) => {
              console.warn('[AutoDetect] TemplateMatcher 로드 실패:', e);
              pushHybridLog('❌ Template 로드 예외: ' + (e.message || e));
            })
        : Promise.resolve();

      if (autoDetect.ocrEngine === 'paddle') {
        if (dom.adInitStatus) dom.adInitStatus.textContent = '⏳ PaddleOCR 모델 로드 중... (첫 실행 시 ~30MB CDN 다운로드)';
        if (!window.MpPaddle) throw new Error('paddle-ocr.js 미로드 (script tag 누락)');
        await Promise.all([window.MpPaddle.init(), templateLoadPromise]);
        console.log('[AutoDetect] paddle ready');
      } else if (autoDetect.ocrEngine === 'hybrid') {
        if (dom.adInitStatus) dom.adInitStatus.textContent = '⏳ Hybrid: paddle + tesseract + 템플릿 동시 초기화...';
        if (!window.MpPaddle) throw new Error('paddle-ocr.js 미로드 (script tag 누락)');
        await Promise.all([window.MpPaddle.init(), initOcrWorker(), templateLoadPromise]);
        console.log('[AutoDetect] hybrid (paddle + tesseract + template) ready');
      } else {
        if (dom.adInitStatus) dom.adInitStatus.textContent = '⏳ Tesseract 워커 + 템플릿 초기화...';
        await Promise.all([initOcrWorker(), templateLoadPromise]);
        console.log('[AutoDetect] tesseract worker + template OK');
      }
      autoDetect.enabled = true;
      S.saveAutoDetect(autoDetect);
      renderAutoDetectInfo();

      // 자동 감지 시작 시 한 번 OCR로 모든 시작값 설정 + 트래커 자동 시작
      if (autoDetect.autoStartTracker) {
        if (dom.adInitStatus) dom.adInitStatus.textContent = '⏳ 시작값 자동 설정...';
        await applyInitialSnapshot();
        if (!tracker.active) {
          try { startTracker(); console.log('[AutoDetect] 트래커 자동 시작'); } catch (_) {}
        }
      }

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
    const labelByKind = kind === 'exp' ? '경험치' : kind === 'mp' ? 'MP' : kind === 'level' ? '레벨' : kind === 'adena' ? '아데나' : '';
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
      else if (kind === 'level') autoDetect.levelRegion = regionData;
      else if (kind === 'adena') autoDetect.adenaRegion = regionData;
      else if (kind === 'mpBar') {
        autoDetect.mpBarRegion = regionData;
        autoDetect.useMpBar = true;  // 바 영역 새로 지정 시 자동 활성화
      }
      else autoDetect.mpRegion = regionData;
      S.saveAutoDetect(autoDetect);
      renderAutoDetectInfo();
      const kindLabel = kind === 'exp' ? '경험치' : kind === 'level' ? '레벨' : kind === 'adena' ? '아데나' : kind === 'mpBar' ? 'MP 바' : 'MP';
      flashHint(`✅ ${kindLabel} 영역 지정 완료 (${selected.label})`);
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
    if (dom.btnCompact) {
      dom.btnCompact.addEventListener('click', () => toggleCompactMode());
    }
    setupTrainingControls();
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

    // 사용자가 트래커 NOW 칸 직접 편집 시 OCR 해당 영역 5초간 skip (덮어쓰기 방지)
    const editKeyOf = { trkLevelNow: 'level', trkExpNow: 'exp', trkAdenaNow: 'adena' };
    Object.keys(editKeyOf).forEach((domKey) => {
      const el = dom[domKey];
      if (!el) return;
      const region = editKeyOf[domKey];
      ['focus', 'input', 'keydown'].forEach((evt) => {
        el.addEventListener(evt, () => markUserEdit(region));
      });
    });

    // 레벨 OCR 자동 학습: 사용자가 trkLevelNow 수정 + OCR이 안정된 상태일 때만 학습
    if (dom.trkLevelNow) {
      dom.trkLevelNow.addEventListener('change', () => {
        const userVal = parseInt(dom.trkLevelNow.value, 10);
        if (!Number.isFinite(userVal) || !autoDetect.levelRegion) return;
        // 안정된 OCR 결과(최근 3+ 번 같은 값)가 있을 때만 학습 — 들쭉날쭉이면 잘못 학습 방지
        if (lastStableRawOcrLevel === null) {
          flashHint('⚠️ OCR이 아직 안정되지 않아 보정 학습 보류. 수동 입력 필드 사용 권장.');
          return;
        }
        const newOffset = userVal - lastStableRawOcrLevel;
        if (newOffset !== (autoDetect.levelOffset || 0) && Math.abs(newOffset) <= 9) {
          autoDetect.levelOffset = newOffset;
          S.saveAutoDetect(autoDetect);
          if (dom.inAdLevelOffset) dom.inAdLevelOffset.value = newOffset;
          console.log('[OCR LEVEL] 보정 자동 학습:', { userVal, stableRaw: lastStableRawOcrLevel, offset: newOffset });
          flashHint(`✅ 레벨 OCR 보정 학습: ${newOffset > 0 ? '+' : ''}${newOffset} (안정 raw=${lastStableRawOcrLevel})`);
        }
      });
    }

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
    if (dom.btnAdMpBarRegion) dom.btnAdMpBarRegion.addEventListener('click', () => onPickRegion('mpBar'));
    if (dom.btnAdMpBarCalibrate) {
      console.warn('[bind v18] 🎯 보정 listener attached');
      dom.btnAdMpBarCalibrate.addEventListener('click', function () {
        // === v18: 결과를 dom.adCalibrateStatus(전용 영역, OCR loop 무관)에 출력 ===
        const writeStatus = (s) => { if (dom.adCalibrateStatus) dom.adCalibrateStatus.textContent = s; };
        writeStatus('🎯 [v18] 보정 시작...');
        console.warn('[click v18] STEP A: handler 진입');
        if (typeof calibrateMpBarMax !== 'function') {
          writeStatus('🎯 [v18] ❌ 함수 미정의 (typeof=' + typeof calibrateMpBarMax + ')');
          return;
        }
        Promise.resolve()
          .then(() => calibrateMpBarMax())
          .then((result) => {
            console.warn('[click v18] STEP D: 정상 종료', result);
          })
          .catch((e) => {
            console.error('[click v18] STEP E: 예외', e);
            writeStatus('🎯 [v18] ❌ 예외: ' + (e && e.message ? e.message : e));
          });
      });
    } else {
      console.warn('[bind v18] btn-ad-mp-bar-calibrate ELEMENT NOT FOUND in DOM');
    }
    if (dom.btnAdExpRegion) dom.btnAdExpRegion.addEventListener('click', () => onPickRegion('exp'));
    if (dom.btnAdLevelRegion) dom.btnAdLevelRegion.addEventListener('click', () => onPickRegion('level'));
    if (dom.btnAdAdenaRegion) dom.btnAdAdenaRegion.addEventListener('click', () => onPickRegion('adena'));
    if (dom.chkAdUseMpBar) dom.chkAdUseMpBar.addEventListener('change', () => {
      autoDetect.useMpBar = dom.chkAdUseMpBar.checked;
      S.saveAutoDetect(autoDetect);
      renderAutoDetectInfo();
    });
    if (dom.btnAdToggle) dom.btnAdToggle.addEventListener('click', toggleAutoDetect);

    // Paddle 비교 테스트: 한 번 캡처해서 paddle로 인식 → 결과 표시
    async function runPaddleTest(regionKey, label) {
      const region = autoDetect[regionKey];
      if (!region) {
        if (dom.paddleTestResult) dom.paddleTestResult.textContent = '⚠️ ' + label + ' 영역 미지정';
        return;
      }
      const Paddle = window.MpPaddle;
      if (!Paddle) {
        if (dom.paddleTestResult) dom.paddleTestResult.textContent = '❌ paddle-ocr.js 미로드';
        return;
      }
      try {
        if (dom.paddleTestResult) dom.paddleTestResult.textContent = '⏳ Paddle init... (첫 실행 시 ~30MB CDN 다운로드)';
        if (region.sourceId) await getCaptureStreamFor(region.sourceId);
        if (dom.paddleTestResult) dom.paddleTestResult.textContent = '⏳ Paddle 인식 중...';
        await Paddle.init();
        // paddle은 자연 이미지를 기대 → tesseract용 가공된 canvas 대신 raw 캡처를 여러 배수로 시도
        // 가공된 이미지(콘트라스트·sharpening)에선 paddle 검출기가 텍스트 영역을 못 찾는 경우 빈번
        const variants = [
          { name: '1x raw',  canvas: captureRegionToRawCanvas(region, 1) },
          { name: '2x raw',  canvas: captureRegionToRawCanvas(region, 2) },
          { name: '4x raw',  canvas: captureRegionToRawCanvas(region, 4) },
          { name: '8x raw',  canvas: captureRegionToRawCanvas(region, 8) },
          { name: 'preprocessed (tesseract용)', canvas: captureRegionToCanvas(region) }
        ];
        const results = [];
        for (const v of variants) {
          if (!v.canvas) continue;
          const t0 = Date.now();
          try {
            const r = await Paddle.recognize(v.canvas);
            const elapsed = Date.now() - t0;
            results.push({ variant: v.name, text: r.text, elapsed, raw: r.raw });
            console.log('[Paddle Test ' + label + ' / ' + v.name + ']', { text: r.text, elapsed, raw: r.raw });
          } catch (err) {
            results.push({ variant: v.name, text: '(error: ' + err.message + ')', elapsed: 0 });
            console.warn('[Paddle Test ' + label + ' / ' + v.name + '] failed:', err);
          }
        }
        if (dom.paddleTestResult) {
          const hit = results.find((r) => r.text && r.text.trim().length > 0);
          if (hit) {
            dom.paddleTestResult.textContent = '✅ ' + label + ' [' + hit.variant + ']: "' + hit.text + '" (' + hit.elapsed + 'ms) · 디버그 펼쳐 모든 변형 보기';
          } else {
            dom.paddleTestResult.textContent = '⚠️ 모든 변형 빈 결과 → 자가진단(🩺) 먼저 실행 권장. 디버그 정보로 paddle 응답 구조 확인.';
          }
        }
        // 디버그 정보를 UI에 출력 (콘솔 안 봐도 알 수 있게)
        if (dom.paddleDebugInfo) {
          const debug = {
            label,
            results: results.map((r) => ({
              variant: r.variant,
              text: r.text,
              elapsed: r.elapsed,
              rawKeys: r.raw ? Object.keys(r.raw) : null,
              rawSample: r.raw ? JSON.stringify(r.raw).slice(0, 500) : null
            }))
          };
          dom.paddleDebugInfo.textContent = JSON.stringify(debug, null, 2);
        }
      } catch (e) {
        console.error('[Paddle Test] error:', e);
        if (dom.paddleTestResult) dom.paddleTestResult.textContent = '❌ ' + (e.message || String(e));
      }
    }
    if (dom.btnPaddleTestExp) dom.btnPaddleTestExp.addEventListener('click', () => runPaddleTest('expRegion', 'EXP'));
    if (dom.btnPaddleTestMp) dom.btnPaddleTestMp.addEventListener('click', () => runPaddleTest('mpRegion', 'MP'));
    if (dom.btnPaddleTestLevel) dom.btnPaddleTestLevel.addEventListener('click', () => runPaddleTest('levelRegion', 'LEVEL'));
    if (dom.btnPaddleTestAdena) dom.btnPaddleTestAdena.addEventListener('click', () => runPaddleTest('adenaRegion', 'ADENA'));

    // Paddle 자가진단: 합성 캔버스("12345")로 paddle이 동작하는지 검증
    // 결과:
    //   "12345" 인식됨 → paddle 작동, 우리 캡처가 문제
    //   빈 결과 → paddle init/모델 로드 실패 (CDN 차단 or WebGL 문제)
    //   에러 → init 자체가 실패한 것
    async function runPaddleSelftest() {
      const Paddle = window.MpPaddle;
      const setDebug = (obj) => {
        if (dom.paddleDebugInfo) {
          dom.paddleDebugInfo.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
          // 자가진단 시 디버그 영역 자동 펼침
          const details = dom.paddleDebugInfo.parentElement;
          if (details && details.tagName.toLowerCase() === 'details') details.open = true;
        }
      };
      if (!Paddle) {
        if (dom.paddleTestResult) dom.paddleTestResult.textContent = '❌ paddle-ocr.js 미로드';
        setDebug('window.MpPaddle 없음');
        return;
      }
      const diag = { steps: [] };
      try {
        // 1) Baidu CDN 직접 fetch — 네트워크/CSP/방화벽 확인
        if (dom.paddleTestResult) dom.paddleTestResult.textContent = '⏳ CDN 도달성 확인 중...';
        const cdnUrls = [
          'https://paddlejs.bj.bcebos.com/models/fuse/ocr/ch_PP-OCRv2_det_fuse_activation/model.json',
          'https://paddlejs.bj.bcebos.com/models/fuse/ocr/ch_PP-OCRv2_rec_fuse_activation/model.json'
        ];
        for (const url of cdnUrls) {
          const t0 = Date.now();
          try {
            const r = await fetch(url, { method: 'GET', cache: 'no-cache' });
            const elapsed = Date.now() - t0;
            diag.steps.push({ url, status: r.status, ok: r.ok, elapsed, size: r.headers.get('content-length') });
          } catch (err) {
            diag.steps.push({ url, error: err.message || String(err), elapsed: Date.now() - t0 });
          }
        }
        setDebug(diag);
        const cdnOk = diag.steps.every((s) => s.ok);
        if (!cdnOk) {
          if (dom.paddleTestResult) {
            dom.paddleTestResult.textContent = '❌ CDN 차단됨 — 모델 다운로드 불가. paddle 사용 불가능 (디버그 펼쳐 확인)';
          }
          return;
        }

        if (dom.paddleTestResult) dom.paddleTestResult.textContent = '⏳ paddle init... (CDN 도달 OK, 모델 로드 중)';
        const initT0 = Date.now();
        await Paddle.init();
        const initElapsed = Date.now() - initT0;
        // 합성 캔버스 — 1024×128, 흰 배경에 검은 "12345 ABC"
        const synth = document.createElement('canvas');
        synth.width = 1024; synth.height = 128;
        const sctx = synth.getContext('2d');
        sctx.fillStyle = '#fff';
        sctx.fillRect(0, 0, synth.width, synth.height);
        sctx.fillStyle = '#000';
        sctx.font = 'bold 80px Arial, sans-serif';
        sctx.textBaseline = 'middle';
        sctx.fillText('12345 ABC', 60, 64);

        // paddle 검출기/인식기 둘 다 별도로 시험 — canvas vs HTMLImageElement vs detect-only
        if (dom.paddleTestResult) dom.paddleTestResult.textContent = '⏳ 다양한 입력 형태 시험 중...';

        // Canvas → data URL → Image element (HTMLImageElement는 paddle이 기대하는 입력 형태일 가능성)
        const dataUrl = synth.toDataURL('image/png');
        const imgEl = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Image load 실패'));
          img.src = dataUrl;
        });

        // 더 큰 합성 이미지 (paddle 검출기가 작은 텍스트 무시할 가능성)
        const bigSynth = document.createElement('canvas');
        bigSynth.width = 1280; bigSynth.height = 480;
        const bctx = bigSynth.getContext('2d');
        bctx.fillStyle = '#fff';
        bctx.fillRect(0, 0, bigSynth.width, bigSynth.height);
        bctx.fillStyle = '#000';
        bctx.font = 'bold 200px Arial, sans-serif';
        bctx.textBaseline = 'middle';
        bctx.fillText('12345 ABC', 100, 240);
        const bigImg = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.src = bigSynth.toDataURL('image/png');
        });

        const variants = [
          { name: 'canvas (1024×128)', input: synth, fn: 'recognize' },
          { name: 'HTMLImageElement (1024×128)', input: imgEl, fn: 'recognize' },
          { name: 'canvas (1280×480 큰글자)', input: bigSynth, fn: 'recognize' },
          { name: 'HTMLImageElement (1280×480 큰글자)', input: bigImg, fn: 'recognize' },
          { name: 'detect 함수 (canvas 1280×480)', input: bigSynth, fn: 'detect' },
          { name: 'detect 함수 (Image 1280×480)', input: bigImg, fn: 'detect' }
        ];
        const attempts = [];
        let finalText = '';
        const ocrApi = window.paddlejs.ocr;
        for (const v of variants) {
          if (dom.paddleTestResult) dom.paddleTestResult.textContent = '⏳ ' + v.name + '...';
          const t0 = Date.now();
          let res = null;
          let err = null;
          try {
            if (v.fn === 'detect') {
              res = await ocrApi.detect(v.input);
            } else {
              // Paddle wrapper 우회 — 직접 ocr.recognize 호출
              res = await ocrApi.recognize(v.input);
            }
          } catch (e) {
            err = e.message || String(e);
          }
          const elapsed = Date.now() - t0;
          // detect는 points만, recognize는 {text, points}
          let textPreview = '';
          if (res) {
            if (Array.isArray(res.text)) textPreview = res.text.join(' ');
            else if (typeof res.text === 'string') textPreview = res.text;
            else if (Array.isArray(res)) textPreview = '[배열 길이=' + res.length + ']';
          }
          attempts.push({
            variant: v.name,
            fn: v.fn,
            elapsed,
            text: textPreview,
            error: err,
            rawSample: res ? JSON.stringify(res).slice(0, 400) : null
          });
          if (textPreview && textPreview.trim().length > 0) {
            if (!finalText) finalText = textPreview;
          }
        }

        const debug = {
          phase: 'self-test',
          cdnReachability: diag.steps,
          initElapsed,
          attempts,
          finalText,
          paddleGlobalKeys: window.paddlejs ? Object.keys(window.paddlejs) : null,
          paddleOcrKeys: (window.paddlejs && window.paddlejs.ocr) ? Object.keys(window.paddlejs.ocr) : null,
          paddleOcrInitType: (window.paddlejs && window.paddlejs.ocr && typeof window.paddlejs.ocr.init) || null,
          paddleOcrRecognizeType: (window.paddlejs && window.paddlejs.ocr && typeof window.paddlejs.ocr.recognize) || null,
          paddleOcrDetectType: (window.paddlejs && window.paddlejs.ocr && typeof window.paddlejs.ocr.detect) || null
        };
        setDebug(debug);
        const successAttempt = attempts.find((a) => a.text && a.text.length > 0);
        if (successAttempt) {
          if (dom.paddleTestResult) {
            dom.paddleTestResult.textContent = '✅ "' + successAttempt.variant + '" 변형에서 작동: "' + successAttempt.text + '" → 이 입력 형태 사용하면 됨';
          }
        } else {
          if (dom.paddleTestResult) {
            dom.paddleTestResult.textContent = '❌ 6가지 변형 모두 빈 결과 → paddle 모델/검출 자체 문제 (디버그의 attempts 확인)';
          }
        }
      } catch (e) {
        console.error('[Paddle Selftest] error:', e);
        if (dom.paddleTestResult) dom.paddleTestResult.textContent = '❌ 자가진단 에러: ' + (e.message || String(e));
        setDebug({ error: e.message || String(e), stack: e.stack });
      }
    }
    if (dom.btnPaddleSelftest) dom.btnPaddleSelftest.addEventListener('click', runPaddleSelftest);

    // DevTools 열기 — Ctrl+Shift+I 인식 안 되는 환경 대응
    function openDevToolsClick() {
      if (api && api.openDevTools) {
        api.openDevTools().catch((e) => flashHint('DevTools 열기 실패: ' + (e.message || e)));
      } else {
        flashHint('DevTools API 미노출 (preload 누락)');
      }
    }
    if (dom.btnOpenDevtools) dom.btnOpenDevtools.addEventListener('click', openDevToolsClick);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'F12') { e.preventDefault(); openDevToolsClick(); }
      if (e.key === 'F3') { e.preventDefault(); toggleCompactMode(); }
    });

    // 디버그 정보 클립보드 복사
    if (dom.btnPaddleDebugCopy) {
      dom.btnPaddleDebugCopy.addEventListener('click', async () => {
        const text = dom.paddleDebugInfo ? dom.paddleDebugInfo.textContent : '';
        if (!text) {
          if (dom.paddleDebugCopied) dom.paddleDebugCopied.textContent = '복사할 내용 없음';
          return;
        }
        try {
          await navigator.clipboard.writeText(text);
          if (dom.paddleDebugCopied) {
            dom.paddleDebugCopied.textContent = '✅ 클립보드 복사됨';
            setTimeout(() => { if (dom.paddleDebugCopied) dom.paddleDebugCopied.textContent = ''; }, 2000);
          }
        } catch (e) {
          // fallback: select the pre, user can Ctrl+C
          try {
            const range = document.createRange();
            range.selectNodeContents(dom.paddleDebugInfo);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            if (dom.paddleDebugCopied) dom.paddleDebugCopied.textContent = '⚠️ 자동 복사 실패 — 영역 선택됨, Ctrl+C 누르세요';
          } catch (err2) {
            if (dom.paddleDebugCopied) dom.paddleDebugCopied.textContent = '❌ 복사 실패: ' + (err2.message || err2);
          }
        }
      });
    }
    if (dom.chkAdAutoStart) {
      dom.chkAdAutoStart.checked = !!autoDetect.autoStart;
      dom.chkAdAutoStart.addEventListener('change', () => {
        autoDetect.autoStart = dom.chkAdAutoStart.checked;
        S.saveAutoDetect(autoDetect);
      });
    }
    if (dom.chkAdAutoStartTracker) {
      dom.chkAdAutoStartTracker.checked = !!autoDetect.autoStartTracker;
      dom.chkAdAutoStartTracker.addEventListener('change', () => {
        autoDetect.autoStartTracker = dom.chkAdAutoStartTracker.checked;
        S.saveAutoDetect(autoDetect);
      });
    }
    if (dom.selAdStability) {
      const cur = (typeof autoDetect.stabilityRequired === 'number') ? String(autoDetect.stabilityRequired) : '1';
      dom.selAdStability.value = cur;
      dom.selAdStability.addEventListener('change', () => {
        autoDetect.stabilityRequired = parseInt(dom.selAdStability.value, 10);
        S.saveAutoDetect(autoDetect);
      });
    }
    if (dom.selAdEngine) {
      const validEngine = (v) => (v === 'tesseract' || v === 'paddle' || v === 'hybrid') ? v : 'paddle';
      dom.selAdEngine.value = validEngine(autoDetect.ocrEngine);
      dom.selAdEngine.addEventListener('change', () => {
        autoDetect.ocrEngine = validEngine(dom.selAdEngine.value);
        S.saveAutoDetect(autoDetect);
        const labels = { paddle: 'PaddleOCR', tesseract: 'Tesseract', hybrid: 'Hybrid (paddle ∩ tesseract)' };
        flashHint('OCR 엔진: ' + labels[autoDetect.ocrEngine] + ' (자동 감지 재시작 시 적용)');
      });
    }
    if (dom.inAdLevelOffset) {
      dom.inAdLevelOffset.value = parseInt(autoDetect.levelOffset, 10) || 0;
      dom.inAdLevelOffset.addEventListener('change', () => {
        const v = parseInt(dom.inAdLevelOffset.value, 10) || 0;
        autoDetect.levelOffset = Math.max(-9, Math.min(9, v));
        dom.inAdLevelOffset.value = autoDetect.levelOffset;
        S.saveAutoDetect(autoDetect);
        flashHint(`레벨 보정: ${autoDetect.levelOffset > 0 ? '+' : ''}${autoDetect.levelOffset}`);
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
    // 컴팩트 모드 복원 (이전 세션 ON 상태였으면)
    if (s.compactMode) {
      // 약간 delay — DOM 준비 + window setSize race 방지
      setTimeout(() => setCompactMode(true), 100);
    }
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

  // ========== Tabs + Summary Bar ==========
  const TAB_KEY = 'lmp.activeTab.v1';
  function activateTab(tabId) {
    if (!tabId) tabId = 'main';
    const buttons = document.querySelectorAll('.tab-btn');
    const panes = document.querySelectorAll('.tab-pane');
    let matched = false;
    buttons.forEach((b) => {
      const isActive = b.getAttribute('data-tab') === tabId;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      if (isActive) matched = true;
    });
    panes.forEach((p) => {
      p.classList.toggle('active', p.getAttribute('data-tab-content') === tabId);
    });
    if (matched) {
      try { localStorage.setItem(TAB_KEY, tabId); } catch (_) {}
    }
  }
  function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => activateTab(btn.getAttribute('data-tab')));
    });
    let saved = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch (_) {}
    activateTab(saved || 'main');
  }

  // 핵심 라이브 값을 어느 탭에서든 항상 보이게 — DOM에서 직접 읽어 mirror
  function updateSummaryBar() {
    if (!dom.summaryBar) return;
    if (dom.summaryMp && dom.mpCurrent && dom.mpMax) {
      dom.summaryMp.textContent = `${dom.mpCurrent.textContent}/${dom.mpMax.textContent}`;
    }
    if (dom.summaryMpPct && dom.mpPercent) {
      dom.summaryMpPct.textContent = dom.mpPercent.textContent;
    }
    if (dom.summaryRemaining && dom.timeRemaining) {
      dom.summaryRemaining.textContent = dom.timeRemaining.textContent;
    }
    if (dom.summaryExpRate && dom.trkExpRate) {
      dom.summaryExpRate.textContent = dom.trkExpRate.textContent;
    }
    if (dom.summaryAdenaRate && dom.trkAdenaRate) {
      dom.summaryAdenaRate.textContent = dom.trkAdenaRate.textContent;
    }
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
                         (autoDetect.expRegion && autoDetect.expRegion.sourceId) ||
                         (autoDetect.levelRegion && autoDetect.levelRegion.sourceId) ||
                         (autoDetect.adenaRegion && autoDetect.adenaRegion.sourceId);
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
    bindTabs();
    updateSummaryBar();
    setInterval(() => {
      if (!mpState.running) renderAll();
      renderTracker();
      updateSummaryBar();
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
