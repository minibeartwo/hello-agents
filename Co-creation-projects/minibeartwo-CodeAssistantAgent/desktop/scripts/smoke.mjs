/** Full Electron -> IPC -> Python -> HelloAgents -> local SSE provider smoke test. */
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chooseCustomProvider } from './provider-settings-helpers.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const artifacts = path.join(root, '.test-artifacts', `desktop-${Date.now()}`);
const workspace = path.join(artifacts, 'calculator-demo');
await mkdir(artifacts, { recursive: true });
await cp(path.join(root, 'examples/buggy-calculator'), workspace, { recursive: true });
const original = (await readFile(path.join(workspace, 'calculator.py'), 'utf8'))
  .replace('return left - right', 'return left + right');
await writeFile(path.join(workspace, 'calculator.py'), original);
await writeFile(path.join(workspace, 'notes.md'), '# 项目备注\n');
const updated = original.replace('    return left + right', '    """返回两个整数之和，保留原有加法逻辑。"""\n    return left + right');
const documentation = '# 项目说明\n\n本项目提供整数加法函数 `add(left, right)`。\n\n运行测试：`python -m pytest -q`。\n';
let modelCalls = 0;
let discoveryMode = 'ok';
const discoveryRequests = [];
const requests = [];
const provider = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url.endsWith('/models')) {
      const mode = discoveryMode;
      discoveryRequests.push({ url: request.url, authorization: request.headers.authorization });
      if (mode === 'delayed') await new Promise((resolve) => setTimeout(resolve, 400));
      response.writeHead(mode === 'unauthorized' ? 401 : mode === 'unsupported' ? 404 : 200,
        { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(mode === 'unauthorized' ? { error: 'model-list-test-key' } :
        { data: mode === 'empty' ? [] : (mode === 'delayed' ? ['stale-model'] :
          ['local-protocol-test', 'another-model', 'local-protocol-test']).map((id) => ({ id })) }));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    const actions = [
      { action: 'read', args: { path: 'calculator.py' }, summary: '读取加法函数与文件版本。' },
      {
        action: 'propose_patch',
        args: {
          changes: [
            {
              path: 'calculator.py',
              base_hash: createHash('sha256').update(original).digest('hex'),
              content: updated,
            },
          ],
        },
        summary: '为加法函数添加中文说明，保留计算逻辑，准备审阅。',
      },
      { action: 'test', args: {}, summary: '运行当前任务授权的 pytest 测试。' },
      {
        action: 'final',
        args: {
          message:
            '已为 calculator.py 的加法函数添加中文注释并保留原有逻辑。测试结果见运行输出。',
        },
        summary: '整理修改与验证结果。',
      },
      { action: 'read', args: { path: 'calculator.py' }, summary: '读取项目入口，依据实际代码整理说明。' },
      {
        action: 'propose_patch',
        args: { changes: [{ path: 'PROJECT.md', base_hash: 'missing', content: documentation }] },
        summary: '生成项目说明文档，准备审阅。',
      },
      {
        action: 'final',
        args: { message: '已生成 PROJECT.md，说明项目用途、核心函数与测试方式。' },
        summary: '整理项目解析结果。',
      },
    ];
    const output = JSON.stringify(actions[modelCalls++] || actions.at(-1));
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    for (let offset = 0; offset < output.length; offset += 50) {
      response.write(
        `data: ${JSON.stringify({ id: 'local-smoke', object: 'chat.completion.chunk', created: 0, model: input.model, choices: [{ index: 0, delta: { content: output.slice(offset, offset + 50) }, finish_reason: null }] })}\n\n`,
      );
    }
    response.end('data: [DONE]\n\n');
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
const env = {
  ...process.env,
  CODE_ASSISTANT_HIDDEN: '1',
  CODE_ASSISTANT_ALLOW_MULTIPLE: '1',
  CODE_ASSISTANT_DISABLE_KEYRING: '1',
  CODE_ASSISTANT_DATA_DIR: path.join(artifacts, 'service'),
  CODE_ASSISTANT_USER_DATA_DIR: path.join(artifacts, 'profile'),
  LLM_API_KEY: '',
  LLM_MODEL_ID: '',
  LLM_BASE_URL: '',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODE_ASSISTANT_DEV_URL;
delete env.PYTHONHOME;
delete env.PYTHONPATH;
let app;
const errors = [];
const homeChecks = [];
async function launch() {
  const instance = await electron.launch({ args: [desktop], cwd: desktop, env, timeout: 60000 });
  app = instance;
  await instance.evaluate(({ app, BrowserWindow }) => {
    const isolateWindow = (window) => {
      window.setOpacity(0);
      window.setIgnoreMouseEvents(true);
    };
    app.on('browser-window-created', (_event, window) => isolateWindow(window));
    for (const window of BrowserWindow.getAllWindows()) isolateWindow(window);
  });
  await instance.firstWindow({ timeout: 60000 });
  let page;
  const deadline = Date.now() + 60000;
  while (!page && Date.now() < deadline) {
    for (const candidate of instance.windows()) {
      if (await candidate.title() === 'CodeAssistantAgent · 代码助手') { page = candidate; break; }
    }
    if (!page) await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.ok(page, 'the native client renderer is available independently of launcher load order');
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (entry) => {
    if (entry.type() === 'error') errors.push(entry.text());
  });
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => !!window.codeAssistant);
  await page.locator('.project-drop:not(:disabled)').waitFor();
  return { instance, page };
}

async function dropNativePath(page, nativePath) {
  await page.evaluate(() => {
    window.__dropEvents = [];
    if (window.__dropObserved) return;
    window.__dropObserved = true;
    for (const type of ['dragenter', 'dragover', 'drop'])
      document.addEventListener(
        type,
        (event) => {
          window.__dropEvents.push({
            type,
            target: event.target.tagName,
            files: event.dataTransfer.files.length,
            disabled: document.querySelector('.project-drop').disabled,
          });
        },
        true,
      );
  });
  const target = await page.locator('.project-drop').boundingBox();
  assert.ok(target, 'the project drop target is visible');
  const client = await page.context().newCDPSession(page);
  try {
    const data = { items: [], files: [nativePath], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await client.send('Input.dispatchDragEvent', {
        type,
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
        data,
      });
    }
  } finally {
    await client.detach();
  }
  await page.waitForFunction(() =>
    window.__dropEvents.some((event) => event.type === 'drop' && event.files > 0),
  );
  await page.locator('.project-drop:not(:disabled)').waitFor();
  await writeFile(
    path.join(artifacts, `drop-${Date.now()}.json`),
    JSON.stringify(
      await page.evaluate(() => ({
        events: window.__dropEvents,
        text: document.querySelector('.project-drop').innerText,
      })),
      null,
      2,
    ),
  );
}

async function waitForNativeState(application, property, expected) {
  const deadline = Date.now() + 10000;
  let state;
  while (Date.now() < deadline) {
    state = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手');
      return { maximized: window.isMaximized(), minimized: window.isMinimized() };
    });
    if (state[property] === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(state[property], expected, `native ${property} changes after titlebar action`);
}

async function nativeScreenshot(application, name) {
  const image = await application.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手');
    const capture = await main.webContents.capturePage();
    return { size: capture.getSize(), png: capture.toPNG().toString('base64') };
  });
  await writeFile(path.join(artifacts, name), Buffer.from(image.png, 'base64'));
  return image.size;
}

async function assertNoLegacyInterface(page) {
  assert.equal(await page.locator('.workspace-layout, .editor-area, .sidebar, .assistant-panel, .monaco-editor').count(), 0,
    'only the approved blue client and its feature dialogs are rendered');
}

const exists = async (file) => access(file).then(() => true, () => false);

async function inspectHome(page, application) {
  await assertNoLegacyInterface(page);
  const native = await application.evaluate(({ BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows();
    const main = windows.find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手');
    const bubble = windows.find((entry) => entry.getTitle() === 'CodeAssistantAgent · 菲比桌面助手');
    return { bounds: main.getContentBounds(), zoom: main.webContents.getZoomFactor(),
      displayScale: screen.getDisplayMatching(main.getBounds()).scaleFactor,
      bubbleZoom: bubble.webContents.getZoomFactor() };
  });
  // Windows may round both rectangle edges when converting fractional display scales.
  assert.ok(Math.abs(native.bounds.width - 650) <= 2, 'the client opens at the requested width within display rounding');
  assert.ok(Math.abs(native.bounds.height - 500) <= 2, 'the client opens at the requested height within display rounding');
  assert.equal(native.zoom, 0.65625, 'the whole client scales uniformly with its window');
  assert.equal(native.bubbleZoom, 1, 'client scaling does not change the desktop mascot');
  const title = await page.locator('.client-titlebar').innerText();
  assert.match(title, /代码助手/);
  assert.match(title, /CodeAssistantAgent/);
  assert.doesNotMatch(title, /菲比/);
  const layout = await page.evaluate(() => {
    const boxes = ['.project-drop', '.home-action-comment', '.home-action-analysis'].map((selector) => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    });
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight, boxes };
  });
  assert.ok(Math.abs(layout.width * native.zoom - native.bounds.width) < 1, 'the renderer fits the native client width');
  assert.ok(Math.abs(layout.height * native.zoom - native.bounds.height) < 1, 'the renderer fits the native client height');
  assert.ok(layout.scrollWidth <= layout.width && layout.scrollHeight <= layout.height,
    'the three home controls fit without scrolling');
  const [drop, comment, analysis] = layout.boxes;
  assert.ok(drop.x + drop.width <= comment.x, 'drop panel is beside the action cards');
  assert.ok(comment.y + comment.height <= analysis.y, 'the action cards are vertically stacked');
  for (const box of layout.boxes) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= layout.width && box.y + box.height <= layout.height,
      'every home control fits inside the window');
  }
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(artifacts, 'home.png') });
  const capture = await nativeScreenshot(application, 'home-native.png');
  assert.ok(Math.abs(capture.width - native.bounds.width * native.displayScale) <= 1 &&
    Math.abs(capture.height - native.bounds.height * native.displayScale) <= 1,
    'native capture confirms the requested client size within physical-pixel rounding');
  homeChecks.push('650×500 native client at 65.625% scale; mascot scale unchanged');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手').setSize(640, 480));
  await page.waitForFunction(() => Math.abs(innerWidth * 0.65625 - 640) <= 2 && Math.abs(innerHeight * 0.65625 - 480) <= 2);
  const minimumSize = await application.evaluate(({ BrowserWindow }) => {
    const { width, height } = BrowserWindow.getAllWindows().find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手').getContentBounds();
    return { width, height };
  });
  assert.ok(Math.abs(minimumSize.width - 640) <= 2 && Math.abs(minimumSize.height - 480) <= 2,
    'the resized native client reaches its supported minimum within display rounding');
  const minimumFits = await page.evaluate(() => {
    const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.top >= outer.top - 1 &&
      inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const controls = [...document.querySelectorAll('.project-drop, .home-action')];
    const texts = [...document.querySelectorAll('.drop-interior > strong, .drop-description, .action-copy strong, .action-copy > span')];
    return document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight &&
      controls.every((element) => inside(element.getBoundingClientRect(), viewport)) && texts.every((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const card = element.closest('button').getBoundingClientRect();
        return [...range.getClientRects()].every((rect) => inside(rect, card));
      });
  });
  assert.equal(minimumFits, true, 'home controls and labels fit at the minimum supported window size');
  await page.screenshot({ path: path.join(artifacts, 'home-min.png') });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手').setSize(650, 500));
  await page.waitForFunction(() => Math.abs(innerWidth * 0.65625 - 650) <= 2 && Math.abs(innerHeight * 0.65625 - 500) <= 2);
  homeChecks.push('minimum 640×480 native home keeps all controls and labels inside the window');
  const syntheticRejected = await page.evaluate(async () => {
    try { await window.codeAssistant.openDroppedProject(new File(['x'], 'fake.py')); return false; }
    catch { return true; }
  });
  assert.equal(syntheticRejected, true, 'a synthetic File cannot supply an arbitrary disk path');
  homeChecks.push('filesystem-backed drop bridge rejects synthetic files');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手').show());
  const restoreSize = await application.evaluate(({ BrowserWindow }) => {
    const { width, height } = BrowserWindow.getAllWindows()
      .find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手').getContentBounds();
    return { width, height };
  });
  await page.getByRole('button', { name: '最大化或还原', exact: true }).click();
  await page.waitForFunction(({ width, height }) => innerWidth > width || innerHeight > height,
    { width: layout.width, height: layout.height });
  await waitForNativeState(application, 'maximized', true);
  await page.getByRole('button', { name: '最大化或还原', exact: true }).click();
  await waitForNativeState(application, 'maximized', false);
  // Compare with the pre-maximize size: Windows rounds transparent-window bounds
  // again on restore at fractional display scales.
  await page.waitForFunction(({ width, height }) =>
    Math.abs(innerWidth * 0.65625 - width) <= 2 && Math.abs(innerHeight * 0.65625 - height) <= 2,
    restoreSize);
  await page.getByRole('button', { name: '最小化', exact: true }).click();
  await waitForNativeState(application, 'minimized', true);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手').restore());
  await waitForNativeState(application, 'minimized', false);
  homeChecks.push('custom titlebar maximizes, restores, and minimizes the native client');
}

async function inspectImportedProject(page, application) {
  await page.locator('.project-drop.is-ready').waitFor();
  assert.equal(await page.locator('.project-drop [role="status"]').innerText(), '项目已就绪');
  await page.locator('.is-celebrating .project-success-badge').waitFor();
  await page.waitForTimeout(350);
  await nativeScreenshot(application, 'project-import-success.png');
  await page.locator('.home-grid.is-celebrating').waitFor({ state: 'detached' });
  const animations = await page
    .locator('.project-drop')
    .evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running').length,
    );
  assert.equal(animations, 0, 'the success animation settles rather than looping');
  for (const [width, height] of [
    [650, 500],
    [640, 480],
  ]) {
    await application.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()
          .find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手')
          .setSize(size.width, size.height),
      { width, height },
    );
    await page.waitForFunction(
      ({ width, height }) =>
        Math.abs(innerWidth * 0.65625 - width) <= 2 &&
        Math.abs(innerHeight * 0.65625 - height) <= 2,
      { width, height },
    );
    const fits = await page.locator('.project-drop').evaluate((card) => {
      const bounds = card.getBoundingClientRect();
      return (
        [
          ...card.querySelectorAll(
            '.project-ready-art, strong, .selected-project, .drop-description, .project-ready-hint, .project-replace-hint',
          ),
        ].every((element) => {
          const box = element.getBoundingClientRect();
          return (
            box.left >= bounds.left &&
            box.right <= bounds.right &&
            box.top >= bounds.top &&
            box.bottom <= bounds.bottom
          );
        }) &&
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight
      );
    });
    assert.ok(fits, `success illustration and labels fit at ${width}×${height}`);
    await nativeScreenshot(application, `project-ready-${width}.png`);
  }
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((entry) => entry.getTitle() === 'CodeAssistantAgent · 代码助手')
      .setSize(650, 500),
  );
  homeChecks.push(
    'project import changes illustration, success badge, headline and name; finite motion fits normal and minimum client sizes',
  );

  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole('button', { name: '导入项目', exact: true }).click();
  await page.locator('.project-drop.is-ready').waitFor();
  assert.equal(
    await page.locator('.home-grid.is-celebrating').count(),
    0,
    'cancelling selection does not replay success',
  );
  await application.evaluate(
    ({ dialog }, missing) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [missing] });
    },
    path.join(artifacts, 'missing-project'),
  );
  await page.getByRole('button', { name: '导入项目', exact: true }).click();
  await page.locator('.error-banner').waitFor();
  await page.locator('.project-drop.is-ready').waitFor();
  assert.match(await page.locator('.selected-project').innerText(), /calculator-demo/);
  assert.equal(
    await page.locator('.home-grid.is-celebrating').count(),
    0,
    'failed import preserves the previous project without a new success pulse',
  );
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
  homeChecks.push(
    'cancelled or failed replacement preserves the selected project without claiming new import success',
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dropNativePath(page, workspace);
  await page.locator('.project-drop.is-ready').waitFor();
  await page.waitForFunction(() => document.querySelector('.home-grid')
    .getAnimations({ subtree: true }).every((animation) => animation.playState !== 'running'));
  const reducedAnimations = await page
    .locator('.home-grid')
    .evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running').length,
    );
  assert.equal(reducedAnimations, 0, 'reduced motion keeps the success state static');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.home-grid.is-celebrating').waitFor({ state: 'detached' });
  await dropNativePath(page, workspace);
  await page.locator('.is-celebrating .project-success-badge').waitFor();
  homeChecks.push(
    'reimporting the same folder replays success; reduced motion retains clear static confirmation',
  );
}

async function inspectProviderSelection(page, application) {
  const before = await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings);
  const provider = page.getByRole('combobox', { name: 'API 服务商', exact: true });
  await provider.selectOption('deepseek');
  assert.equal(await page.locator('.provider-address > span').innerText(), 'https://api.deepseek.com');
  await page.locator('input[name="model"]').fill('deepseek-draft-model');
  await page.locator('input[name="api_key"]').fill('deepseek-draft-key');
  await provider.selectOption('kimi');
  assert.equal(await page.locator('.provider-address > span').innerText(), 'https://api.moonshot.cn/v1');
  assert.equal(await page.locator('input[name="model"]').inputValue(), '');
  assert.equal(await page.locator('input[name="api_key"]').inputValue(), '');
  await page.locator('input[name="model"]').fill('kimi-draft-model');
  await provider.selectOption('custom');
  const popup = page.getByRole('dialog', { name: '自定义服务商', exact: true });
  await popup.waitFor();
  await page.waitForFunction(() => document.activeElement.id === 'custom-api-address');
  await popup.locator('input[name="base_url"]').fill('ftp://invalid.example/v1');
  await popup.getByRole('button', { name: '使用此地址', exact: true }).click();
  await popup.getByRole('alert').filter({ hasText: 'HTTP(S)' }).waitFor();
  await page.keyboard.press('Escape');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog', { name: '模型设置', exact: true }).count(), 1);
  assert.equal(await provider.inputValue(), 'kimi', 'cancelling custom input preserves the previous provider');
  assert.equal(await page.locator('input[name="model"]').inputValue(), 'kimi-draft-model');
  await chooseCustomProvider(page, '  ' + baseUrl + '/draft/  ');
  assert.equal(await provider.inputValue(), 'custom');
  assert.equal(await page.locator('.provider-address > span').innerText(), baseUrl + '/draft');
  await page.getByRole('button', { name: '编辑地址', exact: true }).click();
  await popup.waitFor();
  assert.equal(await popup.locator('input[name="base_url"]').inputValue(), baseUrl + '/draft');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await nativeScreenshot(application, 'custom-provider-native.png');
  await popup.locator('input[name="base_url"]').fill(baseUrl + '/not-confirmed');
  await popup.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.provider-address > span').innerText(), baseUrl + '/draft');
  await provider.selectOption('deepseek');
  await provider.selectOption('custom');
  await popup.waitFor();
  assert.equal(await popup.locator('input[name="base_url"]').inputValue(), baseUrl + '/draft');
  await popup.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await provider.inputValue(), 'deepseek');
  assert.deepEqual(await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings), before,
    'provider selection remains a draft until saving');
  await chooseCustomProvider(page, baseUrl);
  homeChecks.push('provider dropdown presets, custom popup validation and Escape, cancelled edits and custom address recall preserve unsaved settings');
}

async function inspectModelDiscovery(page, application) {
  const before = await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings);
  await chooseCustomProvider(page, baseUrl);
  await page.locator('input[name="api_key"]').fill('model-list-test-key');
  await page.locator('input[name="model"]').fill('');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.locator('.api-connection-status.is-success').filter({ hasText: '连接成功' }).waitFor();
  assert.match(await page.locator('.api-connection-status').innerText(), /毫秒/);
  assert.equal(await page.locator('.model-name-row select').count(), 0,
    'testing the API does not replace the model entry or require a model name');
  assert.deepEqual(await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings), before);
  discoveryMode = 'unauthorized';
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.locator('.api-connection-status.is-error').filter({ hasText: 'API Key' }).waitFor();
  assert.doesNotMatch(await page.locator('.api-connection-status').innerText(), /model-list-test-key/);
  discoveryMode = 'unsupported';
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.locator('.api-connection-status.is-warning').filter({ hasText: '尚未确认调用权限' }).waitFor();
  discoveryMode = 'delayed';
  const connectionRequests = discoveryRequests.length;
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  const connectionDeadline = Date.now() + 5000;
  while (discoveryRequests.length === connectionRequests && Date.now() < connectionDeadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(discoveryRequests.length > connectionRequests);
  await page.locator('input[name="api_key"]').fill('changed-draft-key');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.api-connection-status').innerText(), '',
    'a late connection result cannot validate edited credentials');
  await page.locator('input[name="api_key"]').fill('model-list-test-key');
  discoveryMode = 'ok';
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.locator('.api-connection-status.is-success').waitFor();
  homeChecks.push('API test button uses draft credentials without a model or save, shows elapsed time and handles auth, unsupported detection and stale results');
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
  const selector = page.getByRole('combobox', { name: '模型名称', exact: true });
  await selector.waitFor();
  assert.equal(await selector.locator('option').count(), 3, 'duplicate provider IDs are removed');
  assert.equal(discoveryRequests.at(-1).authorization, 'Bearer model-list-test-key');
  assert.equal(discoveryRequests.at(-1).url, '/v1/models');
  assert.deepEqual(await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings), before,
    'fetching with draft credentials does not save the configuration');
  await selector.selectOption('local-protocol-test');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await nativeScreenshot(application, 'model-list-native.png');
  await page.getByRole('button', { name: '手动填写', exact: true }).click();
  assert.equal(await page.locator('input[name="model"]').inputValue(), 'local-protocol-test');
  await page.getByRole('button', { name: '从列表选择', exact: true }).click();
  assert.equal(await selector.inputValue(), 'local-protocol-test');
  discoveryMode = 'empty';
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await page.locator('.model-fetch-status').filter({ hasText: '未返回可用模型' }).waitFor();
  assert.equal(await page.locator('input[name="model"]').inputValue(), 'local-protocol-test');
  discoveryMode = 'unauthorized';
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await page.locator('.model-fetch-error').filter({ hasText: 'API Key' }).waitFor();
  assert.doesNotMatch(await page.locator('.model-fetch-error').innerText(), /model-list-test-key/);
  discoveryMode = 'unsupported';
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await page.locator('.model-fetch-error').filter({ hasText: '不支持' }).waitFor();
  discoveryMode = 'delayed';
  const previousRequests = discoveryRequests.length;
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
  const deadline = Date.now() + 5000;
  while (discoveryRequests.length === previousRequests && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(discoveryRequests.length > previousRequests);
  await chooseCustomProvider(page, baseUrl + '/changed');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.model-name-row select').count(), 0, 'late responses cannot populate a changed provider');
  assert.equal(await page.locator('.model-fetch-status').innerText(), '');
  assert.equal(await page.locator('input[name="model"]').inputValue(), '',
    'changing a provider endpoint clears the previous model selection');
  discoveryMode = 'ok';
  await page.locator('input[name="api_key"]').fill('');
  await chooseCustomProvider(page, baseUrl);
  assert.equal(modelCalls, 0, 'model discovery never starts a generation task');
  homeChecks.push('draft model discovery uses the native IPC and HTTP route, deduplicates IDs, selects models and supports manual input without saving');
  homeChecks.push('empty, unsupported and unauthorized model lists preserve manual input; stale provider responses are ignored');
}

async function inspectSavedConnections(page, application) {
  const current = await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings);
  const originalId = current.connection_id;
  const open = async () => {
    await page.locator('.feature-dialog').getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('dialog', { name: '模型设置', exact: true }).waitFor();
    await page.getByRole('button', { name: '新建配置', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.connection-presets-heading button').disabled);
  };
  await open();
  const list = page.getByRole('combobox', { name: '配置列表', exact: true });
  assert.equal(await list.inputValue(), originalId);
  await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('日常代码助手');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await page.getByRole('dialog', { name: '模型设置', exact: true }).waitFor({ state: 'hidden' });
  await open();
  assert.equal(await list.locator('option').count(), 2, 'editing a saved configuration does not duplicate it');
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  assert.equal(await list.inputValue(), '');
  assert.equal(await page.locator('input[name="model"]').inputValue(), '');
  assert.equal(await page.locator('input[name="api_key"]').inputValue(), '');
  assert.equal(await page.getByRole('combobox', { name: 'API 服务商', exact: true }).inputValue(), '');
  assert.equal(await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings.connection_id), originalId,
    'creating a draft does not change the active connection');
  await chooseCustomProvider(page, baseUrl);
  await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('备用配置');
  await page.locator('input[name="model"]').fill('alternate-local-model');
  await page.locator('input[name="api_key"]').fill('secondary-test-key');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await page.getByRole('dialog', { name: '模型设置', exact: true }).waitFor({ state: 'hidden' });
  const second = await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings);
  assert.notEqual(second.connection_id, originalId);
  await open();
  assert.equal(await list.locator('option').count(), 3);
  await list.selectOption(originalId);
  await page.waitForFunction(() => document.querySelector('input[name="model"]').value === 'local-protocol-test');
  assert.equal(await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings.connection_id), originalId);
  await list.selectOption(second.connection_id);
  await page.waitForFunction(() => document.querySelector('input[name="model"]').value === 'alternate-local-model');
  assert.equal(await page.locator('input[name="api_key"]').inputValue(), '');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.locator('.api-connection-status.is-success').waitFor();
  assert.equal(discoveryRequests.at(-1).authorization, 'Bearer secondary-test-key',
    'selecting a saved connection restores its separate key without exposing it to the renderer');
  await list.selectOption(originalId);
  await page.waitForFunction(() => document.querySelector('input[name="model"]').value === 'local-protocol-test');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await nativeScreenshot(application, 'saved-connections-native.png');
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('未保存的新配置');
  assert.equal(await page.getByRole('button', { name: '删除配置', exact: true }).isDisabled(), true);
  await chooseCustomProvider(page, baseUrl);
  await page.locator('input[name="model"]').fill('temporary-delete-model');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await page.getByRole('dialog', { name: '模型设置', exact: true }).waitFor({ state: 'hidden' });
  await open();
  assert.equal(await list.locator('option').count(), 4);
  await page.getByRole('button', { name: '删除配置', exact: true }).click();
  await page.waitForFunction((id) => document.querySelector('#saved-connection').value === id, originalId);
  assert.equal(await list.locator('option').count(), 3);
  assert.equal(await page.locator('input[name="model"]').inputValue(), 'local-protocol-test');
  assert.equal(await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings.connection_id), originalId);
  await nativeScreenshot(application, 'delete-connection-native.png');
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('未保存的新配置');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(async () => (await window.codeAssistant.bootstrap()).settings.connection_id), originalId);
  homeChecks.push('saved connection list edits in place, creates separate profiles, switches active models and keys immediately, and cancels unsaved new drafts');
  homeChecks.push('delete configuration uses native IPC, removes the saved entry, restores the remaining active configuration and is disabled for unsaved drafts');
}

try {
  let opened = await launch();
  app = opened.instance;
  let page = opened.page;
  await inspectHome(page, app);
  await app.evaluate(({ dialog }, folder) => {
    global.__nativeFolderSelections = 0;
    dialog.showOpenDialog = async () => {
      global.__nativeFolderSelections++;
      return { canceled: false, filePaths: [folder] };
    };
  }, workspace);
  await page.getByRole('button', { name: '导入项目', exact: true }).click();
  await page.locator('.selected-project').filter({ hasText: 'calculator-demo' }).waitFor();
  assert.equal(await app.evaluate(() => global.__nativeFolderSelections), 1);
  homeChecks.push('native folder picker imports the project on the blue client');
  await inspectImportedProject(page, app);
  await app.evaluate(({ dialog }) => {
    global.__clearChooserCalls = 0;
    dialog.showOpenDialog = async () => {
      global.__clearChooserCalls++;
      return { canceled: true, filePaths: [] };
    };
  });
  await page.getByRole('button', { name: '清除当前项目', exact: true }).click();
  await page.locator('.project-drop:not(.is-ready)').waitFor();
  assert.equal(await page.locator('.project-drop [role="status"]').innerText(), '将项目拖入这里');
  assert.equal(await page.locator('.project-clear, .selected-project, .home-grid.is-celebrating').count(), 0);
  assert.equal(await app.evaluate(() => global.__clearChooserCalls), 0,
    'the separate clear button never opens the project picker');
  assert.equal(await readFile(path.join(workspace, 'calculator.py'), 'utf8'), original,
    'clearing the selection leaves project files unchanged');
  await nativeScreenshot(app, 'project-cleared.png');
  homeChecks.push('clear button resets the drop panel during success feedback without opening the picker or deleting files');
  await dropNativePath(page, workspace);
  await page.locator('.selected-project').filter({ hasText: 'calculator-demo' }).waitFor();
  await page.locator('.home-action-comment').click();
  await page.getByRole('dialog', { name: '代码注释', exact: true }).waitFor();
  await assertNoLegacyInterface(page);
  assert.match(await page.getByRole('textbox', { name: '任务需求', exact: true }).inputValue(), /中文.*注释|注释/);
  assert.equal(modelCalls, 0, 'choosing an action prepares the task without sending it');
  homeChecks.push('native folder drop opens the Chinese annotation dialog without a legacy workbench');
  await page.getByRole('textbox', { name: '任务需求', exact: true }).fill('保留这份未发送的任务草稿。');
  await page.getByRole('button', { name: '关闭任务面板', exact: true }).click();
  await assertNoLegacyInterface(page);
  await page.getByRole('button', { name: '继续任务', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '任务需求', exact: true }).inputValue(), '保留这份未发送的任务草稿。');
  homeChecks.push('closing a feature panel and continuing preserves an unsent task draft');
  await page.getByRole('button', { name: '关闭任务面板', exact: true }).click();
  await dropNativePath(page, path.join(workspace, 'calculator.py'));
  await page.locator('.home-action-analysis').click();
  await page.getByRole('dialog', { name: '项目解析', exact: true }).waitFor();
  await assertNoLegacyInterface(page);
  assert.match(await page.getByRole('textbox', { name: '任务需求', exact: true }).inputValue(), /说明文档|解析|分析/);
  assert.equal(modelCalls, 0);
  homeChecks.push('native code-file drop prepares documentation inside the blue client');
  await page.getByRole('button', { name: '关闭任务面板', exact: true }).click();
  await page.locator('.home-action-comment').click();
  await page.locator('.feature-dialog').getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('dialog', { name: '模型设置', exact: true }).waitFor();
  await inspectProviderSelection(page, app);
  await inspectModelDiscovery(page, app);
  await chooseCustomProvider(page, baseUrl);
  await page.locator('input[name="model"]').fill('local-protocol-test');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await page.getByRole('dialog', { name: '模型设置', exact: true }).waitFor({ state: 'hidden' });
  await inspectSavedConnections(page, app);
  await page
    .getByRole('textbox', { name: '任务需求', exact: true })
    .fill('为 add 函数添加清晰的中文注释，保留原有计算逻辑，并运行测试验证。');
  await page.getByRole('checkbox', { name: '允许此任务运行测试', exact: true }).check();
  await page.getByRole('textbox', { name: '授权测试命令', exact: true }).fill('python -m pytest -q');
  await page.getByRole('button', { name: '开始注释', exact: true }).click();
  await page.getByRole('button', { name: '接受并应用', exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await readFile(path.join(workspace, 'calculator.py'), 'utf8'), original);
  assert.match(await page.locator('.patch-review').innerText(), /calculator\.py|中文/);
  await assertNoLegacyInterface(page);
  await page.getByRole('button', { name: '接受并应用', exact: true }).click();
  await page.locator('.task-status.completed').waitFor({ timeout: 60000 });
  assert.equal(await readFile(path.join(workspace, 'calculator.py'), 'utf8'), updated);
  assert.match(await page.getByLabel('运行输出', { exact: true }).innerText(), /2 passed/);
  const annotationTaskId = await page.getByRole('combobox', { name: '历史任务', exact: true }).inputValue();
  assert.ok(annotationTaskId, 'the annotation task is available in persisted history');
  const savedTask = await page.evaluate((id) => window.codeAssistant.request('GET', `/api/tasks/${id}`), annotationTaskId);
  assert.equal(savedTask.selected_file, 'calculator.py', 'a dropped code file remains the selected task context');
  assert.equal(modelCalls, 4);
  assert.equal(requests[0].stream, true);
  await nativeScreenshot(app, 'annotation-native.png');
  homeChecks.push('annotation uses local HelloAgents SSE, reviews a logic-preserving Chinese comment, and runs real pytest');
  await page.getByRole('button', { name: '撤销此补丁', exact: true }).click();
  await page.locator('.patch-status').filter({ hasText: '已撤销' }).waitFor();
  assert.equal(await readFile(path.join(workspace, 'calculator.py'), 'utf8'), original);
  homeChecks.push('annotation undo restores the original source file');
  await page.getByRole('button', { name: '关闭任务面板', exact: true }).click();
  await page.locator('.home-action-analysis').click();
  await page.getByRole('dialog', { name: '项目解析', exact: true }).waitFor();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByRole('textbox', { name: '任务需求', exact: true })
    .fill('依据实际代码生成 PROJECT.md，说明项目用途、核心函数及测试方式。');
  await page.getByRole('checkbox', { name: '允许此任务运行测试', exact: true }).uncheck();
  await page.getByRole('button', { name: '开始解析', exact: true }).click();
  await page.getByRole('button', { name: '接受并应用', exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await exists(path.join(workspace, 'PROJECT.md')), false, 'document creation waits for patch approval');
  assert.match(await page.locator('.patch-review').innerText(), /PROJECT\.md/);
  await assertNoLegacyInterface(page);
  await page.getByRole('button', { name: '接受并应用', exact: true }).click();
  await page.locator('.task-status.completed').waitFor({ timeout: 60000 });
  assert.equal(await readFile(path.join(workspace, 'PROJECT.md'), 'utf8'), documentation);
  const analysisTaskId = await page.getByRole('combobox', { name: '历史任务', exact: true }).inputValue();
  assert.ok(analysisTaskId && analysisTaskId !== annotationTaskId);
  assert.equal(modelCalls, 7);
  await nativeScreenshot(app, 'analysis-native.png');
  homeChecks.push('project analysis creates an actual project document only after review');
  await page.getByRole('button', { name: '关闭任务面板', exact: true }).click();
  await dropNativePath(page, path.join(workspace, 'notes.md'));
  await page.locator('.home-action-analysis').click();
  await page.getByRole('dialog', { name: '项目解析', exact: true }).waitFor();
  assert.match(await page.locator('.feature-project').innerText(), /notes\.md/);
  assert.equal(await page.locator('.task-status, .patch-review').count(), 0,
    'a newly dropped file starts a fresh task rather than relabeling the previous task');
  assert.equal(await page.getByRole('textbox', { name: '任务需求', exact: true }).isEditable(), true);
  assert.equal(await page.getByRole('combobox', { name: '历史任务', exact: true }).locator('option').count(), 3,
    'importing a file keeps both previous tasks in history');
  assert.equal(modelCalls, 7, 'importing another file does not send a new model request');
  await assertNoLegacyInterface(page);
  homeChecks.push('importing another file in the same project clears the active result and retains task history');
  await app.close();
  app = null;
  opened = await launch();
  app = opened.instance;
  page = opened.page;
  await assertNoLegacyInterface(page);
  await page.locator('.project-drop.is-ready').waitFor();
  assert.equal(
    await page.locator('.home-grid.is-celebrating').count(),
    0,
    'restoring an existing project after restart does not pretend a new drop occurred',
  );
  await page.locator('.home-action-comment').click();
  await page.getByRole('combobox', { name: '历史任务', exact: true }).selectOption(annotationTaskId);
  await page.locator('.task-status.completed').waitFor();
  assert.match(await page.locator('.patch-status').innerText(), /已撤销/);
  await page.getByRole('combobox', { name: '历史任务', exact: true }).selectOption(analysisTaskId);
  await page.getByRole('dialog', { name: '项目解析', exact: true }).waitFor();
  await page.locator('.task-status.completed').waitFor();
  assert.match(await page.locator('.patch-review').innerText(), /PROJECT\.md/);
  assert.match(await page.locator('.patch-status').innerText(), /已应用/);
  assert.equal(await readFile(path.join(workspace, 'PROJECT.md'), 'utf8'), documentation);
  await assertNoLegacyInterface(page);
  await page.locator('.feature-dialog').getByRole('button', { name: '模型设置', exact: true }).click();
  assert.equal(await page.locator('input[name="model"]').inputValue(), 'local-protocol-test');
  assert.equal(await page.getByRole('combobox', { name: 'API 服务商', exact: true }).inputValue(), 'custom');
  assert.equal(await page.locator('.provider-address > span').innerText(), baseUrl);
  await page.waitForFunction(() => !document.querySelector('#saved-connection').disabled);
  assert.equal(await page.getByRole('combobox', { name: '配置列表', exact: true }).locator('option').count(), 3,
    'both saved connections survive application restart');
  assert.equal(await page.getByRole('textbox', { name: '配置名称', exact: true }).inputValue(), '日常代码助手');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  homeChecks.push('restart restores annotation and documentation history plus the saved model connection');
  await page.getByRole('button', { name: '关闭任务面板', exact: true }).click();
  await page.getByRole('button', { name: '清除当前项目', exact: true }).click();
  await page.locator('.project-drop:not(.is-ready)').waitFor();
  assert.equal(await page.getByRole('button', { name: '继续任务', exact: true }).count(), 0,
    'clearing a project also clears its active task and unsent context');
  await app.close();
  app = null;
  opened = await launch();
  app = opened.instance;
  page = opened.page;
  assert.equal(await page.locator('.project-drop [role="status"]').innerText(), '将项目拖入这里');
  assert.equal(await page.locator('.project-clear, .selected-project').count(), 0,
    'a cleared project stays cleared across restart');
  await dropNativePath(page, workspace);
  await page.locator('.project-drop.is-ready').waitFor();
  await page.locator('.home-action-comment').click();
  await page.getByRole('combobox', { name: '历史任务', exact: true }).waitFor();
  const retainedTasks = await page.getByRole('combobox', { name: '历史任务', exact: true }).locator('option').evaluateAll(
    (options) => options.map((option) => option.value));
  assert.ok(retainedTasks.includes(annotationTaskId) && retainedTasks.includes(analysisTaskId),
    'reimporting after clear restores the existing task history');
  assert.equal(await readFile(path.join(workspace, 'PROJECT.md'), 'utf8'), documentation);
  homeChecks.push('cleared selection persists after restart; reimport restores project history and leaves generated files intact');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(artifacts, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        modelCalls,
        checks: [
          ...homeChecks,
          'retired IDE elements remain absent throughout both feature workflows',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Desktop smoke passed. Artifacts: ${artifacts}`);
} catch (error) {
  console.error('Renderer errors:', errors);
  if (app) {
    const pages = app.windows();
    if (pages[0]) {
      await pages[0].screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
      await writeFile(
        path.join(artifacts, 'failure.txt'),
        await pages[0].locator('body').innerText(),
      ).catch(() => {});
    }
  }
  throw error;
} finally {
  if (app) await app.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
}
