/** Native floating launcher: the renderer can only drag, toggle, or open its menu. */
const { BrowserWindow, Menu, ipcMain, screen } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const SIZE = 96;

function createBubble({ mainWindow, userData, hidden, onQuit }) {
  const positionFile = path.join(userData, 'bubble-position.json');
  let ready = false;
  let drag = null;
  let disposed = false;
  const area = screen.getPrimaryDisplay().workArea;
  let initial = { x: area.x + area.width - SIZE - 24, y: area.y + area.height * 0.55 - SIZE / 2 };
  try {
    const saved = JSON.parse(readFileSync(positionFile, 'utf8'));
    if (
      Number.isSafeInteger(saved.x) &&
      Number.isSafeInteger(saved.y) &&
      Math.abs(saved.x) < 2_000_000_000 &&
      Math.abs(saved.y) < 2_000_000_000
    )
      initial = saved;
  } catch {
    // First launch and invalid preference files use the default desktop position.
  }

  function boundedPosition(point) {
    const rectangle = { x: Math.round(point.x), y: Math.round(point.y), width: SIZE, height: SIZE };
    const work = screen.getDisplayMatching(rectangle).workArea;
    const marginX = work.width >= SIZE + 16 ? 8 : 0;
    const marginY = work.height >= SIZE + 16 ? 8 : 0;
    return {
      x: Math.round(
        Math.max(work.x + marginX, Math.min(rectangle.x, work.x + work.width - SIZE - marginX)),
      ),
      y: Math.round(
        Math.max(work.y + marginY, Math.min(rectangle.y, work.y + work.height - SIZE - marginY)),
      ),
    };
  }

  const bubble = new BrowserWindow({
    ...boundedPosition(initial),
    width: SIZE,
    height: SIZE,
    title: 'CodeAssistantAgent · 桌面气泡',
    frame: false,
    thickFrame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'bubble-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      partition: 'floating-launcher',
    },
  });
  function maintainNativeBounds() {
    // Electron on Windows can ignore an explicit floating level before first show.
    if (process.platform === 'win32') {
      bubble.setAlwaysOnTop(true);
      if (!bubble.isAlwaysOnTop()) bubble.setAlwaysOnTop(true, 'screen-saver');
    } else bubble.setAlwaysOnTop(true, 'floating');
    const bounds = bubble.getBounds();
    if (bounds.width !== SIZE || bounds.height !== SIZE) {
      bubble.setBounds({ ...boundedPosition(bounds), width: SIZE, height: SIZE }, false);
    }
  }
  maintainNativeBounds();
  bubble.on('show', maintainNativeBounds);
  bubble.setMenu(null);
  bubble.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bubble.webContents.on('will-navigate', (event) => event.preventDefault());
  // Prevent a client page's zoom setting from resizing the launcher on file://.
  bubble.webContents.on('did-finish-load', () => {
    bubble.webContents.setZoomFactor(1);
    notify();
    if (!hidden) bubble.showInactive();
  });
  bubble.loadFile(path.join(__dirname, 'bubble.html')).catch((error) => {
    console.error('Floating launcher failed to load:', error.message);
    onQuit();
  });

  function savePosition() {
    if (bubble.isDestroyed()) return;
    try {
      const { x, y } = bubble.getBounds();
      mkdirSync(userData, { recursive: true });
      writeFileSync(positionFile, JSON.stringify({ x, y }) + '\n', 'utf8');
    } catch (error) {
      console.error('Could not remember launcher position:', error.message);
    }
  }

  function notify() {
    if (!bubble.isDestroyed()) {
      bubble.webContents.send('bubble:state', {
        ready,
        clientVisible:
          !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized(),
      });
    }
  }

  function showClient() {
    if (!ready || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.focus();
    notify();
  }

  function hideClient() {
    if (mainWindow.isDestroyed()) return;
    mainWindow.hide();
    mainWindow.setSkipTaskbar(true);
    notify();
  }

  function toggle() {
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) hideClient();
    else showClient();
  }

  function menu() {
    if (drag?.moved) savePosition();
    drag = null;
    Menu.buildFromTemplate([
      {
        label: mainWindow.isVisible() && !mainWindow.isMinimized() ? '收起客户端' : '打开客户端',
        enabled: ready,
        click: toggle,
      },
      { type: 'separator' },
      { label: '退出代码助手', click: onQuit },
    ]).popup({ window: bubble });
  }

  function trust(event) {
    if (bubble.isDestroyed() || event.sender !== bubble.webContents) {
      throw new Error('未知的气泡窗口。');
    }
  }

  function moveDrag() {
    if (!drag) return;
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - drag.cursor.x;
    const dy = cursor.y - drag.cursor.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    const next = boundedPosition({ x: drag.origin.x + dx, y: drag.origin.y + dy });
    bubble.setBounds({ ...next, width: SIZE, height: SIZE }, false);
  }

  const handlers = {
    'bubble:toggle': (event) => {
      trust(event);
      toggle();
    },
    'bubble:drag-start': (event) => {
      trust(event);
      drag = { cursor: screen.getCursorScreenPoint(), origin: bubble.getBounds(), moved: false };
    },
    'bubble:drag-end': (event) => {
      trust(event);
      moveDrag();
      const dragged = !!drag?.moved;
      drag = null;
      if (dragged) savePosition();
      return { dragged };
    },
  };
  const listeners = {
    'bubble:drag-move': (event) => {
      trust(event);
      moveDrag();
    },
    'bubble:menu': (event) => {
      trust(event);
      menu();
    },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler);
  for (const [name, listener] of Object.entries(listeners)) ipcMain.on(name, listener);

  function keepOnScreen() {
    if (bubble.isDestroyed()) return;
    const next = boundedPosition(bubble.getBounds());
    // Windows can change frameless bounds slightly during a monitor DPI transition.
    bubble.setBounds({ ...next, width: SIZE, height: SIZE }, false);
    savePosition();
  }
  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);
  for (const event of ['show', 'hide', 'minimize', 'restore']) mainWindow.on(event, notify);
  bubble.on('blur', () => {
    if (drag?.moved) savePosition();
    drag = null;
  });
  bubble.on('closed', onQuit);

  return {
    window: bubble,
    showClient,
    hideClient,
    setReady(value) {
      ready = value;
      notify();
    },
    show() {
      if (!bubble.isDestroyed()) bubble.showInactive();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      savePosition();
      for (const name of Object.keys(handlers)) ipcMain.removeHandler(name);
      for (const [name, listener] of Object.entries(listeners))
        ipcMain.removeListener(name, listener);
      screen.removeListener('display-removed', keepOnScreen);
      screen.removeListener('display-metrics-changed', keepOnScreen);
    },
  };
}

module.exports = { createBubble };
