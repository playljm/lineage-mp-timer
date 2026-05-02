const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  Notification,
  globalShortcut,
  screen,
  desktopCapturer,
  shell
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// dev / packaged 모두 같은 userData 디렉토리 사용 → localStorage / window-bounds 공유
// (없으면 dev는 %APPDATA%\lineage-mp-timer, packaged는 %APPDATA%\LineageMPTimer 로 분리됨)
try { app.setName('LineageMPTimer'); } catch (_) {}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let minimizeToTrayOnClose = false;

const DEV = process.argv.includes('--dev') || !app.isPackaged;
const boundsFile = () => path.join(app.getPath('userData'), 'window-bounds.json');

const DEFAULT_GLOBAL_HOTKEYS = {
  alwaysOnTop: 'F1',
  toggleHide: 'F2'
};

let activeGlobalHotkeys = { ...DEFAULT_GLOBAL_HOTKEYS };

function loadBounds() {
  try {
    const raw = fs.readFileSync(boundsFile(), 'utf-8');
    const b = JSON.parse(raw);
    if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) return b;
  } catch (_) { /* ignore */ }
  return null;
}

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getBounds();
    fs.writeFileSync(boundsFile(), JSON.stringify(bounds), 'utf-8');
  } catch (_) { /* ignore */ }
}

function fitToWorkArea(preferredW, preferredH) {
  try {
    const { workAreaSize } = screen.getPrimaryDisplay();
    return {
      width: Math.min(preferredW, Math.max(440, workAreaSize.width - 40)),
      height: Math.min(preferredH, Math.max(560, workAreaSize.height - 80))
    };
  } catch (_) {
    return { width: preferredW, height: preferredH };
  }
}

function isWithinDisplay(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  try {
    return screen.getAllDisplays().some((d) => {
      return (
        x >= d.bounds.x - 10 &&
        x < d.bounds.x + d.bounds.width - 10 &&
        y >= d.bounds.y - 10 &&
        y < d.bounds.y + d.bounds.height - 10
      );
    });
  } catch (_) {
    return false;
  }
}

function resolveIcon() {
  const icoPath = path.join(__dirname, '..', 'build', 'icon.ico');
  const pngPath = path.join(__dirname, '..', 'build', 'icon.png');
  try {
    if (fs.existsSync(icoPath)) {
      const img = nativeImage.createFromPath(icoPath);
      if (!img.isEmpty()) return img;
    }
    if (fs.existsSync(pngPath)) {
      const img = nativeImage.createFromPath(pngPath);
      if (!img.isEmpty()) return img;
    }
  } catch (_) { /* fall through */ }
  return nativeImage.createEmpty();
}

function createMainWindow() {
  const icon = resolveIcon();
  const fitted = fitToWorkArea(580, 980);
  const last = loadBounds();

  const useLastSize = last && Number.isFinite(last.width) && Number.isFinite(last.height);
  const useLastPos = last && isWithinDisplay(last.x, last.y);

  const opts = {
    width: useLastSize ? Math.max(440, last.width) : fitted.width,
    height: useLastSize ? Math.max(560, last.height) : fitted.height,
    minWidth: 440,
    minHeight: 540,
    title: 'Lineage MP Timer',
    backgroundColor: '#0a0f0a',
    icon: icon.isEmpty() ? undefined : icon,
    autoHideMenuBar: true,
    resizable: true,
    show: false,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  };

  if (useLastPos) {
    opts.x = last.x;
    opts.y = last.y;
  } else {
    opts.center = true;
  }

  mainWindow = new BrowserWindow(opts);
  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    try {
      const { workAreaSize } = screen.getPrimaryDisplay();
      const [w, h] = mainWindow.getSize();
      const newW = Math.min(w, workAreaSize.width - 40);
      const newH = Math.min(h, workAreaSize.height - 80);
      if (newW !== w || newH !== h) {
        mainWindow.setSize(newW, newH);
        mainWindow.center();
      }
    } catch (_) { /* ignore */ }

    mainWindow.show();
    if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  let saveTimer = null;
  const debouncedSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 400);
  };
  mainWindow.on('resize', debouncedSave);
  mainWindow.on('move', debouncedSave);

  mainWindow.on('close', (e) => {
    saveBounds();
    if (!isQuitting && minimizeToTrayOnClose) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const icon = resolveIcon();
  tray = new Tray(icon);
  tray.setToolTip('Lineage MP Timer');

  const rebuildMenu = () => {
    const alwaysOnTop = !!mainWindow && mainWindow.isAlwaysOnTop();
    const menu = Menu.buildFromTemplate([
      {
        label: '창 복원',
        click: () => {
          if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        }
      },
      {
        label: alwaysOnTop ? '✓ 항상 위' : '항상 위',
        click: () => {
          if (!mainWindow) return;
          const next = !mainWindow.isAlwaysOnTop();
          mainWindow.setAlwaysOnTop(next);
          mainWindow.webContents.send('always-on-top-changed', next);
          rebuildMenu();
        }
      },
      { type: 'separator' },
      {
        label: '종료',
        click: () => { isQuitting = true; app.quit(); }
      }
    ]);
    tray.setContextMenu(menu);
  };

  rebuildMenu();
  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ========== Global Hotkeys ==========
function dispatchHotkey(name) {
  if (!mainWindow) return;
  if (name === 'alwaysOnTop') {
    const next = !mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(next);
    mainWindow.webContents.send('always-on-top-changed', next);
  } else if (name === 'toggleHide') {
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  }
}

/**
 * @param {Object} map e.g. { alwaysOnTop: 'F1', toggleHide: 'F2' } — null/'' 이면 비활성
 * @returns {{ success: object, failures: Array<{name, accel, reason}> }}
 */
function registerGlobalHotkeys(map) {
  try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }

  const success = {};
  const failures = [];
  const seen = new Set();

  for (const [name, accel] of Object.entries(map || {})) {
    if (!accel || typeof accel !== 'string') continue;
    if (seen.has(accel)) {
      failures.push({ name, accel, reason: 'duplicate' });
      continue;
    }
    try {
      const ok = globalShortcut.register(accel, () => dispatchHotkey(name));
      if (ok) {
        success[name] = accel;
        seen.add(accel);
      } else {
        failures.push({ name, accel, reason: 'register-failed' });
      }
    } catch (e) {
      failures.push({ name, accel, reason: e.message || 'error' });
    }
  }
  activeGlobalHotkeys = success;
  return { success, failures };
}

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  // 기본 단축키 등록 (renderer가 saved 값으로 갱신 가능)
  registerGlobalHotkeys(DEFAULT_GLOBAL_HOTKEYS);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !minimizeToTrayOnClose) app.quit();
});

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (_) {}
});

// ========== IPC ==========
ipcMain.handle('app:set-always-on-top', (_, value) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(!!value);
  return !!(mainWindow && mainWindow.isAlwaysOnTop());
});

ipcMain.handle('app:get-always-on-top', () => {
  return !!(mainWindow && mainWindow.isAlwaysOnTop());
});

ipcMain.handle('app:minimize-to-tray', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.handle('app:set-minimize-on-close', (_, value) => {
  minimizeToTrayOnClose = !!value;
  return minimizeToTrayOnClose;
});

ipcMain.handle('app:show-notification', (_, payload) => {
  const { title, body } = payload || {};
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: title || '🎉 MP 충전 완료!',
        body: body || '리니지 MP가 가득 찼습니다.',
        urgency: 'critical',
        timeoutType: 'default'
      });
      n.show();
    }
  } catch (e) { console.error('notify failed', e); }
  if (mainWindow) {
    try {
      mainWindow.flashFrame(true);
      setTimeout(() => { if (mainWindow) mainWindow.flashFrame(false); }, 4000);
    } catch (_) {}
  }
});

ipcMain.handle('app:reset-window-size', () => {
  if (!mainWindow) return;
  const fitted = fitToWorkArea(580, 980);
  mainWindow.setSize(fitted.width, fitted.height);
  mainWindow.center();
  saveBounds();
});

// 컴팩트 모드 — ON: 작은 창 (560×190, 트래커 행 포함), OFF: 이전 크기 복원
let savedBoundsBeforeCompact = null;
ipcMain.handle('app:set-compact-mode', (_, enabled) => {
  if (!mainWindow) return;
  if (enabled) {
    // 현재 크기 저장
    if (!savedBoundsBeforeCompact) {
      const [w, h] = mainWindow.getSize();
      savedBoundsBeforeCompact = { width: w, height: h };
    }
    // minimumSize 임시 완화 (기본 440×540 → 360×130) — 트래커 행 추가로 최소 높이 ↑
    mainWindow.setMinimumSize(360, 130);
    const fitted = fitToWorkArea(560, 190);
    mainWindow.setSize(fitted.width, fitted.height);
  } else {
    // minimumSize 원복
    mainWindow.setMinimumSize(440, 540);
    if (savedBoundsBeforeCompact) {
      const fitted = fitToWorkArea(savedBoundsBeforeCompact.width, savedBoundsBeforeCompact.height);
      mainWindow.setSize(fitted.width, fitted.height);
      savedBoundsBeforeCompact = null;
    } else {
      const fitted = fitToWorkArea(580, 980);
      mainWindow.setSize(fitted.width, fitted.height);
    }
  }
  saveBounds();
});

ipcMain.handle('app:set-global-hotkeys', (_, map) => {
  return registerGlobalHotkeys(map || {});
});

ipcMain.handle('app:get-global-hotkeys', () => {
  return activeGlobalHotkeys;
});

ipcMain.handle('app:get-version', () => {
  try { return app.getVersion(); } catch (_) { return ''; }
});

ipcMain.handle('app:quit', () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle('app:open-devtools', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.openDevTools({ mode: 'detach' }); } catch (e) { console.error('openDevTools failed', e); }
  }
});

ipcMain.handle('app:get-resource-paths', () => {
  // 패키징: process.resourcesPath/tesseract/  (extraResources)
  // dev:    node_modules + build/tessdata 에서 직접 로드 (CDN 차단 환경 대응)
  try {
    const { pathToFileURL } = require('node:url');
    const toUrl = (p) => pathToFileURL(p).href;

    if (app.isPackaged) {
      const tessBase = path.join(process.resourcesPath, 'tesseract');
      if (!fs.existsSync(tessBase)) return null;
      return {
        workerPath: toUrl(path.join(tessBase, 'worker.min.js')),
        corePath: toUrl(path.join(tessBase, 'core')),
        langPath: toUrl(path.join(tessBase, 'tessdata'))
      };
    }

    // dev 모드: 프로젝트 루트의 node_modules / build 디렉토리 사용
    const projectRoot = app.getAppPath();
    const workerPath = path.join(projectRoot, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
    const corePath = path.join(projectRoot, 'node_modules', 'tesseract.js-core');
    const langPath = path.join(projectRoot, 'build', 'tessdata');
    if (!fs.existsSync(workerPath) || !fs.existsSync(corePath) || !fs.existsSync(langPath)) {
      console.warn('[get-resource-paths] dev local files missing, fallback to CDN');
      return null;
    }
    return {
      workerPath: toUrl(workerPath),
      corePath: toUrl(corePath),
      langPath: toUrl(langPath)
    };
  } catch (e) {
    console.error('get-resource-paths failed', e);
    return null;
  }
});

// ========== MP Auto-detect (Display + Region select) ==========
let overlayWindow = null;

ipcMain.handle('app:list-displays', async () => {
  try {
    const displays = screen.getAllDisplays();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 200 }
    });
    return displays.map((d, i) => {
      let src = sources.find((s) => String(s.display_id) === String(d.id));
      if (!src && sources[i]) src = sources[i];
      return {
        id: d.id,
        label: d.label || `모니터 ${i + 1}`,
        primary: d.bounds.x === 0 && d.bounds.y === 0,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor || 1,
        sourceId: src && src.id ? src.id : null,
        thumbnail: src && src.thumbnail ? src.thumbnail.toDataURL() : null
      };
    });
  } catch (e) {
    console.error('list-displays failed', e);
    return [];
  }
});

ipcMain.handle('app:start-region-select', async (_, displayId) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.close(); } catch (_) {}
    overlayWindow = null;
  }
  const target = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  // overlay loupe용 sourceId 미리 조회
  // 1순위: display_id 매칭   2순위: physical 해상도(thumbnail size) 매칭   3순위: 인덱스 fallback
  let loupeSourceId = '';
  try {
    // thumbnail을 monitor 해상도만큼 크게 요청 → thumbnail.getSize()로 physical 해상도 얻음
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 4096, height: 4096 }
    });

    // 1순위: display_id 매칭 (Electron이 빈 문자열 줄 수 있어 truthy 체크)
    let src = sources.find((s) => s.display_id && String(s.display_id) === String(target.id));

    // 2순위: physical 해상도(monitor 실제 픽셀 크기) 매칭
    if (!src) {
      const sf = target.scaleFactor || 1;
      const targetW = Math.round(target.bounds.width * sf);
      const targetH = Math.round(target.bounds.height * sf);
      src = sources.find((s) => {
        try {
          const sz = s.thumbnail && s.thumbnail.getSize ? s.thumbnail.getSize() : { width: 0, height: 0 };
          return Math.abs(sz.width - targetW) <= 2 && Math.abs(sz.height - targetH) <= 2;
        } catch (_) { return false; }
      });
      if (src) console.log('[loupe] matched by resolution:', targetW + 'x' + targetH, '→', src.name);
    }

    // 3순위: 인덱스 fallback (위 둘 다 실패)
    if (!src) {
      const idx = screen.getAllDisplays().findIndex((d) => d.id === target.id);
      src = sources[idx] || sources[0];
      console.warn('[loupe] using index fallback:', idx, '/', sources.length, '— may show wrong monitor');
    }
    if (src && src.id) loupeSourceId = src.id;
    // 모든 source ID/이름/해상도도 함께 패스 — 사용자가 수동으로 사이클 가능
    var loupeAllSources = sources.map((s) => ({
      id: s.id,
      name: s.name || '',
      w: s.thumbnail && s.thumbnail.getSize ? s.thumbnail.getSize().width : 0,
      h: s.thumbnail && s.thumbnail.getSize ? s.thumbnail.getSize().height : 0
    }));
  } catch (e) { console.error('[loupe] sourceId resolve failed:', e); }
  if (typeof loupeAllSources === 'undefined') loupeAllSources = [];

  // expected video size — 매칭된 source의 monitor physical 해상도
  const sf = target.scaleFactor || 1;
  const expectedW = Math.round(target.bounds.width * sf);
  const expectedH = Math.round(target.bounds.height * sf);

  overlayWindow = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'overlay-preload.js'),
      additionalArguments: [
        '--loupe-source-id=' + loupeSourceId,
        '--loupe-expected-w=' + expectedW,
        '--loupe-expected-h=' + expectedH,
        '--loupe-display-x=' + target.bounds.x,
        '--loupe-display-y=' + target.bounds.y,
        '--loupe-scale=' + sf,
        '--loupe-all-sources=' + Buffer.from(JSON.stringify(loupeAllSources || [])).toString('base64')
      ]
    }
  });
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.once('ready-to-show', () => {
    overlayWindow && overlayWindow.show();
    overlayWindow && overlayWindow.focus();
  });

  return new Promise((resolve) => {
    const onSelected = (_e, region) => { cleanup(); resolve({ region, displayId: target.id, displayBounds: target.bounds, scaleFactor: target.scaleFactor || 1 }); };
    const onCancel = () => { cleanup(); resolve(null); };
    function cleanup() {
      ipcMain.removeListener('overlay:region-selected', onSelected);
      ipcMain.removeListener('overlay:cancelled', onCancel);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        try { overlayWindow.close(); } catch (_) {}
      }
      overlayWindow = null;
    }
    ipcMain.once('overlay:region-selected', onSelected);
    ipcMain.once('overlay:cancelled', onCancel);
  });
});

// ========== 학습 데이터 수집 (Tesseract LSTM 학습용) ==========
//   저장 위치: %APPDATA%/LineageMPTimer/training-data/{mp,exp,level,adena}/
//   파일 형식: <safe-label>_<timestamp>.png + <safe-label>_<timestamp>.gt.txt
//   - .gt.txt 는 Tesseract LSTM `lstm.train` 호환 ground truth 파일
const TRAINING_REGIONS = ['mp', 'exp', 'level', 'adena'];
function trainingDataDir(region) {
  const base = path.join(app.getPath('userData'), 'training-data');
  return region ? path.join(base, region) : base;
}
function ensureTrainingDirs() {
  for (const r of TRAINING_REGIONS) {
    try { fs.mkdirSync(trainingDataDir(r), { recursive: true }); } catch (_) {}
  }
}
function safeLabel(s) {
  // 파일명에 안전한 문자만 — 숫자, 점, 슬래시→of, 그 외→_
  return String(s ?? '')
    .replace(/\//g, 'of')
    .replace(/\./g, 'p')
    .replace(/[^0-9A-Za-z_-]/g, '_')
    .slice(0, 32) || 'unlabeled';
}
function timestampStr() {
  const d = new Date();
  return d.getFullYear()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0')
    + '_'
    + String(d.getHours()).padStart(2, '0')
    + String(d.getMinutes()).padStart(2, '0')
    + String(d.getSeconds()).padStart(2, '0')
    + '_'
    + String(d.getMilliseconds()).padStart(3, '0');
}

ipcMain.handle('app:save-training-sample', (_, payload) => {
  try {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid payload' };
    const { region, dataUrl, label, gtText } = payload;
    if (!TRAINING_REGIONS.includes(region)) return { ok: false, error: 'invalid region' };
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return { ok: false, error: 'invalid dataUrl' };
    if (typeof label !== 'string' || !label.trim()) return { ok: false, error: 'label required' };

    ensureTrainingDirs();
    const dir = trainingDataDir(region);
    const safe = safeLabel(label);
    const stamp = timestampStr();
    const baseName = `${safe}_${stamp}`;
    const pngPath = path.join(dir, baseName + '.png');
    const gtPath = path.join(dir, baseName + '.gt.txt');

    // dataURL → buffer (data:image/png;base64,...)
    const m = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
    if (!m) return { ok: false, error: 'invalid dataUrl format' };
    const buf = Buffer.from(m[2], 'base64');
    fs.writeFileSync(pngPath, buf);
    // ground truth — gtText 우선, 없으면 label
    fs.writeFileSync(gtPath, String(gtText || label).trim() + '\n', 'utf-8');
    return { ok: true, file: pngPath, baseName };
  } catch (e) {
    console.error('save-training-sample failed', e);
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('app:get-training-stats', () => {
  try {
    ensureTrainingDirs();
    const stats = { total: 0, byRegion: {}, dir: trainingDataDir() };
    for (const r of TRAINING_REGIONS) {
      let count = 0;
      try {
        const files = fs.readdirSync(trainingDataDir(r));
        count = files.filter((f) => f.endsWith('.png')).length;
      } catch (_) { /* ignore */ }
      stats.byRegion[r] = count;
      stats.total += count;
    }
    return stats;
  } catch (e) {
    return { total: 0, byRegion: {}, error: String(e && e.message || e) };
  }
});

ipcMain.handle('app:open-training-folder', () => {
  try {
    ensureTrainingDirs();
    shell.openPath(trainingDataDir());
    return { ok: true, dir: trainingDataDir() };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

// ========== 미라벨 샘플 (자동 캡처 → 사후 라벨링용) ==========
//   _pending/{region}/<timestamp>__<safeOcr>.png + 같은이름.json (OCR 메타)
//   라벨링 후에는 정식 region 폴더로 이동 + .gt.txt 생성
function pendingDir(region) {
  const base = path.join(app.getPath('userData'), 'training-data', '_pending');
  return region ? path.join(base, region) : base;
}
function ensurePendingDirs() {
  for (const r of TRAINING_REGIONS) {
    try { fs.mkdirSync(pendingDir(r), { recursive: true }); } catch (_) {}
  }
}

ipcMain.handle('app:save-pending-sample', (_, payload) => {
  try {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid payload' };
    const { region, dataUrl, ocrSuggestion } = payload;
    if (!TRAINING_REGIONS.includes(region)) return { ok: false, error: 'invalid region' };
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return { ok: false, error: 'invalid dataUrl' };
    ensurePendingDirs();
    const dir = pendingDir(region);
    const stamp = timestampStr();
    const safeOcr = ocrSuggestion ? safeLabel(ocrSuggestion) : 'noocr';
    const baseName = `${stamp}__${safeOcr}`;
    const pngPath = path.join(dir, baseName + '.png');
    const jsonPath = path.join(dir, baseName + '.json');
    const m = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
    if (!m) return { ok: false, error: 'invalid dataUrl format' };
    fs.writeFileSync(pngPath, Buffer.from(m[2], 'base64'));
    fs.writeFileSync(jsonPath, JSON.stringify({
      region, ocrSuggestion: ocrSuggestion || null, capturedAt: new Date().toISOString()
    }, null, 2), 'utf-8');
    return { ok: true, baseName, file: pngPath };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('app:list-pending-samples', (_, opts) => {
  try {
    ensurePendingDirs();
    const includeImage = !!(opts && opts.includeImage);
    const result = { total: 0, byRegion: {}, samples: [] };
    for (const r of TRAINING_REGIONS) {
      const dir = pendingDir(r);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')); } catch (_) { files = []; }
      result.byRegion[r] = files.length;
      result.total += files.length;
      // sort by timestamp asc
      files.sort();
      for (const f of files) {
        const baseName = f.replace(/\.png$/i, '');
        const jsonPath = path.join(dir, baseName + '.json');
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch (_) {}
        const sample = {
          region: r,
          baseName,
          ocrSuggestion: meta.ocrSuggestion || '',
          capturedAt: meta.capturedAt || ''
        };
        if (includeImage) {
          try {
            const png = fs.readFileSync(path.join(dir, f));
            sample.dataUrl = 'data:image/png;base64,' + png.toString('base64');
          } catch (_) { sample.dataUrl = null; }
        }
        result.samples.push(sample);
      }
    }
    return result;
  } catch (e) {
    return { total: 0, byRegion: {}, samples: [], error: String(e && e.message || e) };
  }
});

ipcMain.handle('app:confirm-pending-sample', (_, payload) => {
  try {
    const { region, baseName, label } = payload || {};
    if (!TRAINING_REGIONS.includes(region)) return { ok: false, error: 'invalid region' };
    if (typeof baseName !== 'string' || !baseName) return { ok: false, error: 'invalid baseName' };
    if (typeof label !== 'string' || !label.trim()) return { ok: false, error: 'label required' };
    const srcPng = path.join(pendingDir(region), baseName + '.png');
    const srcJson = path.join(pendingDir(region), baseName + '.json');
    if (!fs.existsSync(srcPng)) return { ok: false, error: 'png not found' };
    ensureTrainingDirs();
    const dstDir = trainingDataDir(region);
    const safe = safeLabel(label);
    const stamp = timestampStr();
    const dstBase = `${safe}_${stamp}`;
    const dstPng = path.join(dstDir, dstBase + '.png');
    const dstGt = path.join(dstDir, dstBase + '.gt.txt');
    fs.copyFileSync(srcPng, dstPng);
    fs.writeFileSync(dstGt, label.trim() + '\n', 'utf-8');
    // pending에서 제거
    try { fs.unlinkSync(srcPng); } catch (_) {}
    try { fs.unlinkSync(srcJson); } catch (_) {}
    return { ok: true, file: dstPng };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('app:delete-pending-sample', (_, payload) => {
  try {
    const { region, baseName } = payload || {};
    if (!TRAINING_REGIONS.includes(region)) return { ok: false, error: 'invalid region' };
    if (typeof baseName !== 'string' || !baseName) return { ok: false, error: 'invalid baseName' };
    const png = path.join(pendingDir(region), baseName + '.png');
    const json = path.join(pendingDir(region), baseName + '.json');
    try { fs.unlinkSync(png); } catch (_) {}
    try { fs.unlinkSync(json); } catch (_) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('app:clear-all-pending', () => {
  try {
    ensurePendingDirs();
    let removed = 0;
    for (const r of TRAINING_REGIONS) {
      const dir = pendingDir(r);
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (_) {}
        }
      } catch (_) {}
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});
