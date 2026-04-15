const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  Notification,
  globalShortcut
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let minimizeToTrayOnClose = false;

const DEV = process.argv.includes('--dev') || !app.isPackaged;

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
  } catch (_) {
    /* fall through */
  }
  return nativeImage.createEmpty();
}

function createMainWindow() {
  const icon = resolveIcon();

  mainWindow = new BrowserWindow({
    width: 540,
    height: 760,
    minWidth: 460,
    minHeight: 620,
    title: 'Lineage MP Timer',
    backgroundColor: '#0a0f0a',
    icon: icon.isEmpty() ? undefined : icon,
    autoHideMenuBar: true,
    resizable: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (DEV) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.on('close', (e) => {
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

ipcMain.handle('app:quit', () => {
  isQuitting = true;
  app.quit();
});
