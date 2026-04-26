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
  desktopCapturer
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

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
      preload: path.join(__dirname, 'overlay-preload.js')
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
