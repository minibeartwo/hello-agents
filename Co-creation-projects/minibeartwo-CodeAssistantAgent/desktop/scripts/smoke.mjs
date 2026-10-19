/** Full Electron -> IPC -> Python -> HelloAgents -> local SSE provider smoke test. */
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const artifacts = path.join(root, '.test-artifacts', `desktop-${Date.now()}`);
const workspace = path.join(artifacts, 'calculator-demo');
await mkdir(artifacts, { recursive: true });
await cp(path.join(root, 'examples/buggy-calculator'), workspace, { recursive: true });
await writeFile(path.join(workspace, 'notes.md'), 'draft\n');
const original = await readFile(path.join(workspace, 'calculator.py'), 'utf8');
const updated = original.replace('return left - right', 'return left + right');
let modelCalls = 0;
const requests = [];
const provider = createServer(async (request, response) => {
  try {
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
        summary: '将错误的减法改为加法，准备审阅。',
      },
      { action: 'test', args: {}, summary: '运行当前任务授权的 pytest 测试。' },
      {
        action: 'final',
        args: {
          message:
            '已将 calculator.py 中的减法改为加法。测试命令执行完成；具体输出见运行输出面板。',
        },
        summary: '整理修改与验证结果。',
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
async function launch() {
  const instance = await electron.launch({ args: [desktop], cwd: desktop, env, timeout: 60000 });
  const page = await instance.firstWindow({ timeout: 60000 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (entry) => {
    if (entry.type() === 'error') errors.push(entry.text());
  });
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => !!window.codeAssistant);
  return { instance, page };
}

try {
  let opened = await launch();
  app = opened.instance;
  let page = opened.page;
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, workspace);
  await page.getByRole('button', { name: '＋ 打开项目', exact: true }).click();
  await page.locator('.tree-entry[title="notes.md"]').click();
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('saved in the real editor\n');
  await page.waitForFunction(() => document.querySelector('.save-button')?.disabled === false);
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForFunction(() => document.querySelector('.save-button')?.disabled === true);
  assert.equal(
    await readFile(path.join(workspace, 'notes.md'), 'utf8'),
    'saved in the real editor\n',
  );
  await page.locator('.tree-entry[title="calculator.py"]').click();
  await page.getByRole('button', { name: '设置模型', exact: true }).click();
  await page.locator('input[name="base_url"]').fill(baseUrl);
  await page.locator('input[name="model"]').fill('local-protocol-test');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await page
    .getByRole('textbox', { name: '任务需求', exact: true })
    .fill('修复 add 的计算错误，保留函数签名，并运行测试验证。');
  await page.getByRole('checkbox', { name: '允许此任务运行测试', exact: true }).check();
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await page.getByRole('button', { name: '接受并应用', exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await readFile(path.join(workspace, 'calculator.py'), 'utf8'), original);
  await page.locator('.monaco-diff-editor').waitFor();
  await page.getByRole('button', { name: '接受并应用', exact: true }).click();
  await page.locator('.task-status.completed').waitFor({ timeout: 60000 });
  assert.equal(await readFile(path.join(workspace, 'calculator.py'), 'utf8'), updated);
  await page.getByRole('button', { name: /运行输出/ }).click();
  assert.match(await page.locator('.terminal-output').innerText(), /2 passed/);
  assert.equal(modelCalls, 4);
  assert.equal(requests[0].stream, true);
  await page.screenshot({ path: path.join(artifacts, 'client.png') });
  await page.getByRole('button', { name: '撤销此补丁', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.diff-toolbar')?.textContent.includes('已撤销'),
  );
  assert.equal(await readFile(path.join(workspace, 'calculator.py'), 'utf8'), original);
  await app.close();
  app = null;
  opened = await launch();
  app = opened.instance;
  page = opened.page;
  await page.locator('.session-entry').first().click();
  await page.locator('.task-status.completed').waitFor();
  await page.getByRole('button', { name: /修改审阅/ }).click();
  assert.match(await page.locator('.diff-toolbar').innerText(), /已撤销/);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(artifacts, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        modelCalls,
        checks: [
          'native folder bridge',
          'Monaco save',
          'HelloAgents SSE',
          'patch review',
          'real pytest',
          'undo',
          'restart history',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Desktop smoke passed. Screenshot: ${path.join(artifacts, 'client.png')}`);
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
