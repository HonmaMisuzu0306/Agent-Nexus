// Actual production EXE + real Codex login, with desktop-equivalent PATH and
// isolated userData copied from the owned native acceptance fixture.
import { _electron as electron, expect } from 'playwright/test';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, delimiter } from 'node:path';
const source = JSON.parse(readFileSync('test-results/local-1-workflow-native-report.json', 'utf8'));
if (source.status !== 'PASSED') throw Error('Current local native workflow evidence is required');
const inheritedCodex = (process.env.PATH ?? '').split(delimiter).filter(Boolean).some(p => existsSync(join(p.replace(/^"|"$/g, ''), 'codex.exe')));
if (inheritedCodex) throw Error('Launch this test with Windows User/Machine PATH only; injected Codex PATH invalidates the regression');
const readback = process.env.NEXUS_LOCAL_DESKTOP_READBACK;
const root = readback ? resolve(readback) : mkdtempSync(join(resolve('.runtime'), 'local-1 desktop '));
const scope = relative(resolve('.runtime'), root); if (scope.startsWith('..') || isAbsolute(scope)) throw Error('Readback must use an owned .runtime fixture');
const data = join(root, 'data'); if (!readback) { mkdirSync(data); copyFileSync(join(source.root, 'data', 'nexus.sqlite'), join(data, 'nexus.sqlite')); }
const env = { ...process.env, NEXUS_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
let app; const errors = [], checks = []; const expectedVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const api = (page, channel, args) => page.evaluate(async ({ channel, args }) => { const r = await window.nexus.call(channel, args); if (!r.ok) throw Error(r.error); return r.data; }, { channel, args });
async function launch() { app = await electron.launch({ executablePath: resolve('release/win-unpacked/Agent Nexus.exe'), args: [], env, timeout: 45000 }); const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible({ timeout: 45000 }); return page; }
try {
  let page = await launch(); expect(await app.evaluate(({ app }) => app.getVersion())).toBe(expectedVersion);
  const snapshot = await api(page, 'snapshot.get', {}), codex = snapshot.installations.find(i => i.id === 'codex');
  expect(codex.auth).toBe('authenticated'); expect(codex.capabilities.sendPrompt.supported).toBe(true); expect(codex.executablePath).toContain('OpenAI');
  const projectId = source.view.run.projectId; await api(page, 'settings.set', { projectId }); await page.reload();
  const panel = page.locator('[data-agent="codex"]'); await expect(panel.locator('.agent-mode')).toContainText('原生已连接');
  const before = await api(page, 'tasks.list', { projectId, offset: 0, limit: 100 });
  if (!readback) {
  await panel.getByLabel('Codex 任务输入').fill('Do not use tools, inspect files, access network or call other agents. Reply exactly NEXUS_LOCAL_DESKTOP_OK.'); await panel.getByRole('button', { name: '发送任务', exact: true }).click();
  // Match the existing 180-second native workflow step budget; cold starts can include tool initialization.
  const startedAt = Date.now(), deadline = startedAt + 180000;
  for (;;) {
    const pageTasks = await api(page, 'tasks.list', { projectId, offset: 0, limit: 100 });
    const current = pageTasks.tasks.find(t => !before.tasks.some(old => old.id === t.id));
    if (current?.status === 'completed') break;
    if (current && ['failed', 'cancelled', 'interrupted'].includes(current.status)) { const events = await api(page, 'events.tail', { taskId: current.id, limit: 10 }); throw Error('Native UI task ' + current.status + ': ' + events.at(-1)?.payload.text); }
    if (Date.now() >= deadline) throw Error('Native UI task timeout');
    await page.waitForTimeout(250);
  }
  }
  await expect.poll(async () => (await panel.locator('.console-line > span:last-child').allTextContents()).join('')).toContain('NEXUS_LOCAL_DESKTOP_OK');
  await expect(panel.locator('.agent-mode')).toContainText('原生已连接');
  await expect(page.locator('.task-info strong')).toHaveText('真实完成', { timeout: 15000 });
  const after = await api(page, 'tasks.list', { projectId, offset: 0, limit: 100 }); expect(after.tasks).toHaveLength(before.tasks.length + (readback ? 0 : 1)); expect(after.tasks[0]).toMatchObject({ mode: 'real', provider: 'codex', status: 'completed', sandbox: 'read-only' });
  const nativeTask = after.tasks[0]; const nativeEvents = await api(page, 'events.list', { taskId: nativeTask.id, after: 0, limit: 100 }); expect(nativeEvents.filter(e => e.type === 'message.delta').map(e => e.payload.text).join('')).toBe('NEXUS_LOCAL_DESKTOP_OK');
  checks.push('Production EXE discovers and authenticates bundled Codex without an injected PATH; real UI task succeeds in read-only mode');
  await page.screenshot({ path: 'test-results/local-1-native-desktop.png' });
  await page.getByRole('button', { name: 'Leader Mode', exact: true }).click(); await expect(page.getByRole('status', { name: 'Leader Run 当前状态' })).toHaveText('审查通过');
  await page.getByRole('button', { name: '任务历史', exact: true }).click(); await page.getByLabel('历史全文搜索').fill('NEXUS_LOCAL_WRITE_OK'); await page.getByRole('button', { name: '搜索历史', exact: true }).click(); await expect(page.locator('.history-item').first()).toBeVisible();
  await app.close(); app = null; page = await launch(); const final = await api(page, 'tasks.list', { projectId, offset: 0, limit: 100 }); expect(final.tasks).toHaveLength(after.tasks.length); expect(final.tasks[0].status).toBe('completed');
  checks.push('Real workflow evidence and full-text history render in production; a fresh process preserves tasks and sends no replay'); expect(errors).toEqual([]);
  writeFileSync('test-results/local-1-desktop-report.json', JSON.stringify({ passed: true, native: true, version: expectedVersion, systemPathOnly: true, nativeRequestsSent: readback ? 0 : 1, reusedCompletedNativeTask: readback ? nativeTask.id : undefined, taskElapsedMs: Date.parse(nativeTask.finishedAt) - Date.parse(nativeTask.createdAt), root, installations: snapshot.installations, checks, errors }, null, 2)); console.log(JSON.stringify({ passed: true, version: expectedVersion, checks }));
} finally { if (app) await app.close(); }
