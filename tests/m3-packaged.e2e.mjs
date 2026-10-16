import { _electron as electron, expect } from 'playwright/test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Read the completed REAL run in a copied database. Never sends another model request.
const native = JSON.parse(readFileSync('test-results/m3-native-report.json', 'utf8'));
expect(native.status).toBe('PASSED'); expect(native.native).toBe(true);
const run = native.view.run;
const root = mkdtempSync(join(resolve('.runtime'), 'm3 packaged ')); const data = join(root, 'data'); mkdirSync(data);
copyFileSync(join(dirname(native.fixtureRoot), 'data', 'nexus.sqlite'), join(data, 'nexus.sqlite'));
const env = { ...process.env, NEXUS_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const errors = []; const checks = []; let app;
const api = (page, channel, args) => page.evaluate(async ({ channel, args }) => { const r = await window.nexus.call(channel, args); if (!r.ok) throw Error(r.error); return r.data; }, { channel, args });
async function launch() {
  app = await electron.launch({ executablePath: resolve('release/win-unpacked/Agent Nexus.exe'), env, timeout: 30000 });
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1520, 980));
  return page;
}
try {
  let page = await launch();
  const version = await app.evaluate(({ app }) => app.getVersion()); expect(version).toBe(JSON.parse(readFileSync('package.json','utf8')).version);
  const security = await app.evaluate(({ BrowserWindow }) => { const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox }; });
  expect(security).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });
  await api(page, 'settings.set', { projectId: run.projectId }); await page.reload();
  await page.getByRole('button', { name: 'Leader Mode', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Leader Run 当前状态' })).toHaveText('审查通过');
  const view = await api(page, 'leader.get', { runId: run.id }); expect(view.run.mode).toBe('real'); expect(view.run.review.verdict).toBe('passed');
  expect(view.tasks.map(n => n.providerTaskId)).toEqual(native.view.tasks.map(n => n.providerTaskId));
  expect(view.tasks.every(n => n.status === 'completed' && n.result.source === 'real' && n.result.rawEventRefs.length > 0)).toBe(true);
  const report = page.getByRole('region', { name: 'Leader 验收报告' }); await expect(report).toContainText(run.id); await expect(report).toContainText('来源：real');
  for (const details of await page.locator('.leader-task-tree details').all()) await details.evaluate(e => { e.open = true; });
  await page.screenshot({ path: 'test-results/m3-packaged-real-history.png', fullPage: true });
  await report.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/m3-packaged-real-report.png' });
  const tasksBefore = (await api(page, 'tasks.list', { projectId: run.projectId, offset: 0, limit: 30 })).tasks;
  expect(tasksBefore).toHaveLength(4); expect(tasksBefore.every(t => t.status === 'completed' && t.mode === 'real')).toBe(true);
  expect((await api(page, 'snapshot.get', {})).activeTaskCount).toBe(0);
  checks.push(`production ${version} sandboxed renderer reads legacy M3 completed real Run, two Worker results, four native task IDs and ordered audit events`);
  await app.close(); app = null; page = await launch();
  expect((await api(page, 'leader.get', { runId: run.id })).run.status).toBe('completed');
  const tasksAfter = (await api(page, 'tasks.list', { projectId: run.projectId, offset: 0, limit: 30 })).tasks;
  expect(tasksAfter.map(t => t.id)).toEqual(tasksBefore.map(t => t.id)); expect((await api(page, 'snapshot.get', {})).activeTaskCount).toBe(0);
  checks.push('packaged restart preserves completed real history, adds no tasks, never replays native prompts'); expect(errors).toEqual([]);
  writeFileSync('test-results/m3-packaged-report.json', JSON.stringify({ passed: true, version, runId: run.id, additionalModelRequests: false, copiedDatabase: true, security, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, version, checks, additionalModelRequests: false }));
} finally { if (app) await app.close(); }
