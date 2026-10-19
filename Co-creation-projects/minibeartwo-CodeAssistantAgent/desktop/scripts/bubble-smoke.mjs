/** Isolated native-window test. Never attaches to or quits the user's running client. */
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(desktop);
const artifacts = path.join(root, '.test-artifacts', `bubble-${Date.now()}`);
const profile = path.join(artifacts, 'profile');
const workspace = path.join(artifacts, 'bubble-workspace');
const positionFile = path.join(profile, 'bubble-position.json');
const mainTitle = 'CodeAssistantAgent · 代码助手';
const bubbleTitle = 'CodeAssistantAgent · 桌面气泡';
const checks = [];
const errors = [];
let application;
let mainPage;
let bubblePage;

await mkdir(profile, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'notes.md'), '# Floating launcher integration test\n');
// A disconnected monitor's saved position must never make the launcher inaccessible.
await writeFile(positionFile, JSON.stringify({ x: 1000000, y: 1000000 }));

const env = {
  ...process.env,
  CODE_ASSISTANT_HIDDEN: '1',
  CODE_ASSISTANT_ALLOW_MULTIPLE: '1',
  CODE_ASSISTANT_DISABLE_KEYRING: '1',
  CODE_ASSISTANT_DATA_DIR: path.join(artifacts, 'service'),
  CODE_ASSISTANT_USER_DATA_DIR: profile,
  LLM_API_KEY: '',
  LLM_BASE_URL: '',
  LLM_MODEL_ID: '',
  OPENAI_API_KEY: '',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODE_ASSISTANT_DEV_URL;
delete env.PYTHONHOME;
delete env.PYTHONPATH;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(operation, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await pause(80);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function nativeState() {
  return application.evaluate(
    ({ BrowserWindow, screen }, titles) => {
      const windows = BrowserWindow.getAllWindows();
      const main = windows.find((window) => window.getTitle() === titles.main);
      const bubble = windows.find((window) => window.getTitle() === titles.bubble);
      if (!main || !bubble) return null;
      const bounds = bubble.getBounds();
      return {
        mainId: main.webContents.id,
        mainVisible: main.isVisible(),
        mainMinimized: main.isMinimized(),
        bubbleVisible: bubble.isVisible(),
        bubbleBounds: bounds,
        workArea: screen.getDisplayMatching(bounds).workArea,
        alwaysOnTop: bubble.isAlwaysOnTop(),
        resizable: bubble.isResizable(),
        background: bubble.getBackgroundColor(),
        webPreferences: bubble.webContents.getLastWebPreferences(),
      };
    },
    { main: mainTitle, bubble: bubbleTitle },
  );
}

function assertWithinWorkArea(state) {
  const box = state.bubbleBounds;
  const area = state.workArea;
  const marginX = area.width >= box.width + 16 ? 8 : 0;
  const marginY = area.height >= box.height + 16 ? 8 : 0;
  assert.ok(box.x >= area.x + marginX, 'launcher left edge is visible');
  assert.ok(box.y >= area.y + marginY, 'launcher top edge is visible');
  assert.ok(
    box.x + box.width <= area.x + area.width - marginX,
    `launcher right edge is visible: ${JSON.stringify({ box, area })}`,
  );
  assert.ok(
    box.y + box.height <= area.y + area.height - marginY,
    `launcher bottom edge is visible: ${JSON.stringify({ box, area })}`,
  );
}

async function launch() {
  application = await electron.launch({ args: [desktop], cwd: desktop, env, timeout: 60000 });
  await eventually(
    async () => {
      const pages = application.windows();
      for (const page of pages) {
        const title = await page.title();
        if (title === mainTitle) mainPage = page;
        if (title === bubbleTitle) bubblePage = page;
      }
      return mainPage && bubblePage;
    },
    'Both renderer windows must be created',
    60000,
  );
  for (const page of [mainPage, bubblePage]) {
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (entry) => {
      if (entry.type() === 'error') errors.push(entry.text());
    });
  }
  await mainPage.waitForFunction(() => !!window.codeAssistant);
  await mainPage.locator('.model-button:not(:disabled)').waitFor();
  await bubblePage.waitForFunction(() => !!window.assistantBubble);
  await bubblePage.getByRole('button').first().waitFor({ state: 'attached' });
  return eventually(nativeState, 'Native windows must be available');
}

async function showBubble() {
  await application.evaluate(({ BrowserWindow }, title) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle() === title)
      .show();
  }, bubbleTitle);
}

async function ownBackend() {
  const parent = application.process().pid;
  let children;
  if (process.platform === 'win32') {
    const { stdout } = await runFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process -Filter "Name LIKE \'python%\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const value = JSON.parse(stdout.trim() || '[]');
    children = (Array.isArray(value) ? value : [value]).map((entry) => ({
      pid: entry.ProcessId,
      command: entry.CommandLine || '',
    }));
  } else {
    const { stdout } = await runFile('ps', ['-Ao', 'pid=,ppid=,args=']);
    children = stdout.split('\n').flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match && Number(match[2]) === parent
        ? [{ pid: Number(match[1]), command: match[3] }]
        : [];
    });
  }
  const child = children.find((entry) => {
    const command = entry.command.replaceAll('"', '');
    return (
      /(?:^|\s)-m\s+backend(?:\s|$)/.test(command) &&
      command.toLowerCase().includes(env.CODE_ASSISTANT_DATA_DIR.toLowerCase())
    );
  });
  assert.ok(child, 'the test owns a separate Python sidecar');
  const port = Number(child.command.replaceAll('"', '').match(/--port\s+(\d+)/)?.[1]);
  assert.ok(port > 0, 'sidecar port is discoverable without exposing its credential');
  return { pid: child.pid, endpoint: `http://127.0.0.1:${port}` };
}

async function assertBackendStopped(sidecar) {
  await eventually(
    async () => {
      try {
        const response = await fetch(`${sidecar.endpoint}/health`, {
          signal: AbortSignal.timeout(400),
        });
        if (response.ok) return false;
      } catch {
        /* The owned service has stopped listening. */
      }
      try {
        process.kill(sidecar.pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    'Exiting must stop the owned Python sidecar',
    20000,
  );
}

async function closeThroughMenu() {
  // Intercept presentation only: still exercise the real renderer IPC and native menu callbacks.
  await application.evaluate(({ Menu }) => {
    global.__bubbleSmokePopup = Menu.prototype.popup;
    Menu.prototype.popup = function () {
      global.__bubbleSmokeMenu = this;
    };
  });
  await bubblePage.evaluate(() => window.assistantBubble.menu());
  await eventually(
    () => application.evaluate(() => !!global.__bubbleSmokeMenu),
    'Launcher menu must open',
  );
  const labels = await application.evaluate(() =>
    global.__bubbleSmokeMenu.items.map((item) => item.label),
  );
  assert.ok(
    labels.some((label) => /退出/.test(label)),
    'native menu includes exit',
  );
  const closed = application.waitForEvent('close', { timeout: 30000 });
  await application
    .evaluate(() => {
      const menu = global.__bubbleSmokeMenu;
      const exit = menu.items.find((item) => /退出/.test(item.label));
      exit.click(exit, null, {});
    })
    .catch((error) => {
      if (!/closed|destroyed/i.test(error.message)) throw error;
    });
  await closed;
  application = null;
}

try {
  let state = await launch();
  const initialMainId = state.mainId;
  assert.equal(state.mainVisible, false, 'client starts hidden');
  assert.equal(state.bubbleVisible, false, 'QA hidden mode hides the bubble as well');
  assert.equal(state.bubbleBounds.width, 96);
  assert.equal(state.bubbleBounds.height, 96);
  assert.equal(state.alwaysOnTop, true);
  assert.equal(state.resizable, false);
  // getBackgroundColor() reports RGB without alpha on Windows.
  assert.match(state.background.toLowerCase(), /^#000000(?:00)?$/);
  assert.equal(state.webPreferences.contextIsolation, true);
  assert.equal(state.webPreferences.nodeIntegration, false);
  assert.equal(state.webPreferences.sandbox, true);
  assertWithinWorkArea(state);
  checks.push(
    'hidden startup; 96 DIP transparent, isolated, always-on-top launcher; stale position clamping',
  );
  const sidecar = await ownBackend();

  await showBubble();
  await bubblePage.getByRole('button').first().click();
  await eventually(
    async () => (await nativeState()).mainVisible,
    'Clicking the bubble must open the client',
  );
  await application.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, workspace);
  await mainPage.locator('.header-actions > button').first().click();
  await mainPage.locator('.header-workspace').filter({ hasText: 'bubble-workspace' }).waitFor();
  await mainPage.locator('.model-button').click();
  await mainPage.locator('input[name="base_url"]').fill('http://127.0.0.1:12345/v1');
  await mainPage.locator('input[name="model"]').fill('bubble-state-test');
  await mainPage.getByRole('button', { name: '保存连接', exact: true }).click();
  await mainPage.locator('.settings-dialog').waitFor({ state: 'hidden' });
  await mainPage.locator('.model-button').filter({ hasText: 'bubble-state-test' }).waitFor();
  await mainPage
    .getByRole('textbox', { name: '任务需求', exact: true })
    .fill('Keep this unsent draft while the client is tucked away.');
  await bubblePage.getByRole('button').first().click();
  await eventually(
    async () => !(await nativeState()).mainVisible,
    'Second bubble click must hide the client',
  );
  await bubblePage.getByRole('button').first().click();
  await eventually(
    async () => (await nativeState()).mainVisible,
    'Bubble must reopen the same client',
  );
  assert.equal((await nativeState()).mainId, initialMainId);
  assert.equal(
    await mainPage.getByRole('textbox', { name: '任务需求', exact: true }).inputValue(),
    'Keep this unsent draft while the client is tucked away.',
  );
  assert.match(await mainPage.locator('.header-workspace').innerText(), /bubble-workspace/);
  assert.match(await mainPage.locator('.model-button').innerText(), /bubble-state-test/);
  checks.push(
    'bubble clicks toggle the client while preserving project, model settings, and unsent draft',
  );

  await application.evaluate(({ BrowserWindow }, title) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle() === title)
      .close();
  }, mainTitle);
  state = await nativeState();
  assert.equal(state.mainVisible, false);
  assert.equal(state.bubbleVisible, true);
  assert.equal(state.mainId, initialMainId, 'close hides rather than destroys the renderer');
  assert.equal((await fetch(`${sidecar.endpoint}/health`)).status, 200);
  await bubblePage.getByRole('button').first().click();
  await eventually(
    async () => (await nativeState()).mainVisible,
    'Client must reopen after its close button',
  );
  assert.equal(
    await mainPage.getByRole('textbox', { name: '任务需求', exact: true }).inputValue(),
    'Keep this unsent draft while the client is tucked away.',
  );
  checks.push('client close hides its window and keeps the Python service and draft alive');

  // Playwright's synthetic pointer events do not move the OS cursor. Supply deterministic
  // screen coordinates while exercising the actual renderer pointer handlers and IPC.
  await application.evaluate(({ screen }) => {
    global.__bubbleSmokeRealCursor = screen.getCursorScreenPoint;
    global.__bubbleSmokeCursor = { x: 300, y: 300 };
    screen.getCursorScreenPoint = () => ({ ...global.__bubbleSmokeCursor });
  });
  await bubblePage.getByRole('button').first().click();
  await eventually(
    async () => !(await nativeState()).mainVisible,
    'Client must be hidden before drag',
  );
  const beforeDrag = (await nativeState()).bubbleBounds;
  const center = await bubblePage.getByRole('button').first().boundingBox();
  assert.ok(center);
  await bubblePage.mouse.move(center.x + center.width / 2, center.y + center.height / 2);
  await bubblePage.mouse.down();
  // This invoke is an ordered IPC barrier after the renderer's pointerdown handler.
  await bubblePage.evaluate(() => window.assistantBubble.startDrag());
  await application.evaluate(() => {
    global.__bubbleSmokeCursor = { x: 240, y: 240 };
  });
  await bubblePage.mouse.move(center.x + center.width / 2 - 12, center.y + center.height / 2 - 12, {
    steps: 3,
  });
  await eventually(async () => {
    const moved = (await nativeState()).bubbleBounds;
    return moved.x !== beforeDrag.x || moved.y !== beforeDrag.y;
  }, 'Dragging must move the native bubble');
  const movedBounds = (await nativeState()).bubbleBounds;
  await application.evaluate(() => {
    global.__bubbleSmokeCursor = { x: 220, y: 220 };
  });
  await bubblePage.mouse.up();
  await eventually(async () => {
    const released = (await nativeState()).bubbleBounds;
    return released.x < movedBounds.x && released.y < movedBounds.y;
  }, 'Pointer release must sample the final native cursor position');
  state = await nativeState();
  assert.equal(state.mainVisible, false, 'releasing a drag must not also toggle the client');
  assertWithinWorkArea(state);
  await eventually(async () => {
    const saved = JSON.parse(await readFile(positionFile, 'utf8'));
    return saved.x === state.bubbleBounds.x && saved.y === state.bubbleBounds.y;
  }, 'Drag position must be persisted');
  await application.evaluate(({ screen }) => {
    screen.getCursorScreenPoint = global.__bubbleSmokeRealCursor;
  });
  checks.push(
    'renderer drag moves the native window, persists coordinates, and suppresses accidental toggle',
  );

  await application.evaluate(({ BrowserWindow }, title) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle() === title)
      .setPosition(1000000, 1000000);
  }, bubbleTitle);
  // Windows applies native position changes asynchronously. Model a later display event.
  await pause(150);
  await application.evaluate(({ screen }) => {
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea']);
  });
  state = await eventually(async () => {
    const current = await nativeState();
    assertWithinWorkArea(current);
    assert.equal(
      current.bubbleBounds.width,
      96,
      'DPI changes must preserve the 96 DIP launcher width',
    );
    assert.equal(
      current.bubbleBounds.height,
      96,
      'DPI changes must preserve the 96 DIP launcher height',
    );
    return current;
  }, 'Display changes must clamp the launcher');
  assertWithinWorkArea(state);
  const remembered = { x: state.bubbleBounds.x, y: state.bubbleBounds.y };
  await bubblePage.screenshot({ path: path.join(artifacts, 'bubble.png'), omitBackground: true });
  checks.push('display change reclamps the full bubble within the work area');

  await closeThroughMenu();
  await assertBackendStopped(sidecar);
  checks.push('native menu exit shuts down the application and its owned Python sidecar');
  mainPage = null;
  bubblePage = null;
  state = await launch();
  assert.deepEqual({ x: state.bubbleBounds.x, y: state.bubbleBounds.y }, remembered);
  const restartedSidecar = await ownBackend();
  await showBubble();
  await bubblePage.getByRole('button').first().click();
  await mainPage.locator('.header-workspace').filter({ hasText: 'bubble-workspace' }).waitFor();
  assert.match(await mainPage.locator('.model-button').innerText(), /bubble-state-test/);
  await application.close();
  application = null;
  await assertBackendStopped(restartedSidecar);
  checks.push('restart restores the remembered bubble position, project, and model settings');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(artifacts, 'result.json'),
    JSON.stringify({ status: 'passed', checks, errors }, null, 2),
  );
  console.log(`Bubble smoke passed. Artifacts: ${artifacts}`);
} catch (error) {
  for (const [name, page] of [
    ['client', mainPage],
    ['bubble', bubblePage],
  ]) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifacts, `${name}-failure.png`) }).catch(() => {});
      await writeFile(
        path.join(artifacts, `${name}-failure.txt`),
        await page.locator('body').innerText(),
      ).catch(() => {});
    }
  }
  await writeFile(
    path.join(artifacts, 'result.json'),
    JSON.stringify(
      { status: 'failed', checks, errors, error: error.stack || String(error) },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (application) await application.close().catch(() => {});
}
