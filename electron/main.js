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

// [v1.5.3 fix] 창 전체(x,y,width,height)가 어떤 모니터의 workArea 안에 들어가는지 검증.
//   사용자 보고: 처음 실행 시 화면이 너무 커 모니터 밖에까지 나감.
//   기존 isWithinDisplay는 좌상단 (x,y)만 검증 → 창 우측이 모니터 밖이어도 통과.
//   멀티모니터 + 이전 bounds 복원 시 창이 경계를 넘어가는 문제 차단.
function isWithinDisplay(x, y, w, h) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  try {
    return screen.getAllDisplays().some((d) => {
      const wa = d.workArea || d.bounds;
      const ww = Number.isFinite(w) ? w : 100;
      const hh = Number.isFinite(h) ? h : 100;
      return (
        x >= wa.x - 10 &&
        y >= wa.y - 10 &&
        x + ww <= wa.x + wa.width + 10 &&
        y + hh <= wa.y + wa.height + 10
      );
    });
  } catch (_) {
    return false;
  }
}

// [v1.5.3 fix] 창을 가장 가까운 모니터의 workArea 안으로 강제 클램프.
//   bounds가 부분적으로 화면 밖일 때 해당 모니터 안으로 끌어옴.
function clampToNearestDisplay(x, y, w, h) {
  try {
    const cursor = (Number.isFinite(x) && Number.isFinite(y))
      ? { x: x + Math.floor((w || 0) / 2), y: y + Math.floor((h || 0) / 2) }
      : screen.getCursorScreenPoint();
    const target = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
    const wa = target.workArea || target.bounds;
    const finalW = Math.min(w || wa.width, wa.width - 20);
    const finalH = Math.min(h || wa.height, wa.height - 40);
    let finalX = Number.isFinite(x) ? x : wa.x + Math.floor((wa.width - finalW) / 2);
    let finalY = Number.isFinite(y) ? y : wa.y + Math.floor((wa.height - finalH) / 2);
    if (finalX < wa.x + 10) finalX = wa.x + 10;
    if (finalY < wa.y + 10) finalY = wa.y + 10;
    if (finalX + finalW > wa.x + wa.width - 10) finalX = wa.x + wa.width - finalW - 10;
    if (finalY + finalH > wa.y + wa.height - 10) finalY = wa.y + wa.height - finalH - 10;
    return { x: finalX, y: finalY, width: finalW, height: finalH };
  } catch (_) {
    return { x, y, width: w, height: h };
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
  // [v1.5.3] default 1100x820 — 1280x900은 1080p workArea(1920x1040)에서도 너무 커
  //   상하 작업표시줄 + 창 chrome 합산 시 일부 환경에서 모니터 경계 넘어감.
  const DEFAULT_W = 1100;
  const DEFAULT_H = 820;
  const last = loadBounds();
  const hasLastSize = last && Number.isFinite(last.width) && Number.isFinite(last.height);
  const candW = hasLastSize ? Math.max(440, last.width) : DEFAULT_W;
  const candH = hasLastSize ? Math.max(560, last.height) : DEFAULT_H;
  const candX = last && Number.isFinite(last.x) ? last.x : NaN;
  const candY = last && Number.isFinite(last.y) ? last.y : NaN;
  // [v1.5.3 fix] 창 전체(width/height 포함)를 가장 가까운 모니터 workArea 안으로 클램프.
  //   기존 isWithinDisplay(x,y)는 좌상단만 검증 → 우측이 화면 밖이어도 통과.
  //   사용자 보고(처음 실행 시 화면이 너무 커 모니터 밖) 차단.
  const clamped = clampToNearestDisplay(candX, candY, candW, candH);

  const opts = {
    x: clamped.x,
    y: clamped.y,
    width: clamped.width,
    height: clamped.height,
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

  mainWindow = new BrowserWindow(opts);
  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    try {
      // [v1.5.3 fix] ready-to-show 시점에도 위치+크기 모두 다시 클램프.
      //   useContentSize+chrome 합산으로 outer가 인자보다 커지는 케이스 방어.
      const [w, h] = mainWindow.getSize();
      const [x, y] = mainWindow.getPosition();
      const cl = clampToNearestDisplay(x, y, w, h);
      if (cl.width !== w || cl.height !== h) mainWindow.setSize(cl.width, cl.height);
      if (cl.x !== x || cl.y !== y) mainWindow.setPosition(cl.x, cl.y);
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
  if (mainWindow) {
    // [v1.3.1] level='screen-saver' — Always on top 최고 레벨 (게임 fullscreen/borderless 위에 떠 있게)
    //   기본 'floating'은 일부 게임 창보다 낮아 뒤로 빠지는 문제. 'screen-saver'가 가장 높음.
    mainWindow.setAlwaysOnTop(!!value, 'screen-saver');
    if (value) {
      // 켤 때는 즉시 위로 올리고 포커스 — 사용자 클릭이 의도한 결과
      try { mainWindow.moveTop(); } catch (_) {}
      try { mainWindow.focus(); } catch (_) {}
    }
  }
  return !!(mainWindow && mainWindow.isAlwaysOnTop());
});

ipcMain.handle('app:get-always-on-top', () => {
  return !!(mainWindow && mainWindow.isAlwaysOnTop());
});

// [v1.3.6] 진단 리포트 저장 — 캡처 4개 + report.json + 폴더 자동 열기
ipcMain.handle('app:save-diagnostic-report', async (_, payload) => {
  try {
    const { imageBuffers, report } = payload || {};
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(app.getPath('userData'), 'diagnostic', ts);
    fs.mkdirSync(dir, { recursive: true });

    if (imageBuffers && typeof imageBuffers === 'object') {
      for (const [region, buf] of Object.entries(imageBuffers)) {
        if (buf && buf.byteLength > 0) {
          fs.writeFileSync(path.join(dir, region + '.png'), Buffer.from(buf));
        }
      }
    }
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report || {}, null, 2), 'utf-8');

    // 탐색기에서 폴더 자동 열기
    try { shell.openPath(dir); } catch (_) {}
    return { ok: true, path: dir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
    // [v1.4.0+] 사용자 진단 (2026-05-05T12-31-34): exp.png/adena.png 완전 흰색 → 캡처가 잘못된 모니터를 잡음
    //   원인: 기존 list-displays는 display_id 매칭 실패 시 인덱스 fallback만 사용.
    //         하지만 screen.getAllDisplays()와 desktopCapturer.getSources()는 다른 순서로 반환될 수 있음.
    //   해결: start-region-select와 동일한 3-tier 매칭 (display_id → 해상도 → 인덱스)
    //         thumbnail은 작게(미리보기 표시용)지만, 해상도 매칭용으로는 별도 high-res sources 호출
    const previewSources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 200 }
    });
    let highResSources = previewSources;
    try {
      // 해상도 매칭에 필요한 physical 해상도 얻기 위해 큰 thumbnail 요청
      highResSources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 4096, height: 4096 }
      });
    } catch (_) { /* fallback to previewSources */ }

    return displays.map((d, i) => {
      // 1순위: display_id 매칭 (Electron이 빈 문자열 줄 수 있어 truthy 체크)
      let src = highResSources.find((s) => s.display_id && String(s.display_id) === String(d.id));
      // 2순위: physical 해상도 매칭 — 듀얼 모니터에서 인덱스 순서가 다를 때
      if (!src) {
        const sf = d.scaleFactor || 1;
        const targetW = Math.round(d.bounds.width * sf);
        const targetH = Math.round(d.bounds.height * sf);
        src = highResSources.find((s) => {
          try {
            const sz = s.thumbnail && s.thumbnail.getSize ? s.thumbnail.getSize() : { width: 0, height: 0 };
            return Math.abs(sz.width - targetW) <= 2 && Math.abs(sz.height - targetH) <= 2;
          } catch (_) { return false; }
        });
        if (src) console.log('[list-displays] matched by resolution:', targetW + 'x' + targetH, '→', src.name);
      }
      // 3순위: 인덱스 fallback
      if (!src) {
        src = highResSources[i] || highResSources[0];
        console.warn('[list-displays] using index fallback:', i, '— sourceId may not match physical monitor');
      }
      // preview thumbnail은 별도(가벼운 거)
      const previewSrc = previewSources.find((p) => p.id === (src && src.id)) || previewSources[i];
      return {
        id: d.id,
        label: d.label || `모니터 ${i + 1}`,
        primary: d.bounds.x === 0 && d.bounds.y === 0,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor || 1,
        sourceId: src && src.id ? src.id : null,
        thumbnail: previewSrc && previewSrc.thumbnail ? previewSrc.thumbnail.toDataURL() : null
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
