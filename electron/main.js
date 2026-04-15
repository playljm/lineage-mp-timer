const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  Notification,
  globalShortcut,
  screen
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let minimizeToTrayOnClose = false;

const DEV = process.argv.includes('--dev') || !app.isPackaged;
const boundsFile = () => path.join(app.getPath('userData'), 'window-bounds.json');

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
  const fitted = fitToWorkArea(580, 920);
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
    // 사이즈 클램프: workArea보다 큰 경우 자동 축소
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
    if (DEV) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
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
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
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
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(menu);
  };

  rebuildMenu();

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  createMainWindow();
  createTray();

  globalShortcut.register('F1', () => {
    if (!mainWindow) return;
    const next = !mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(next);
    mainWindow.webContents.send('always-on-top-changed', next);
  });

  globalShortcut.register('F2', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !minimizeToTrayOnClose) {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
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
  } catch (e) {
    console.error('notify failed', e);
  }
  if (mainWindow) {
    try {
      mainWindow.flashFrame(true);
      setTimeout(() => {
        if (mainWindow) mainWindow.flashFrame(false);
      }, 4000);
    } catch (_) { /* ignore */ }
  }
});

ipcMain.handle('app:reset-window-size', () => {
  if (!mainWindow) return;
  const fitted = fitToWorkArea(580, 920);
  mainWindow.setSize(fitted.width, fitted.height);
  mainWindow.center();
  saveBounds();
});

ipcMain.handle('app:quit', () => {
  isQuitting = true;
  app.quit();
});
