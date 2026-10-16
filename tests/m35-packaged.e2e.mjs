import { _electron as electron, expect } from 'playwright/test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Production readback of a copied REAL database. No new model requests.
const native = JSON.parse(readFileSync('test-results/m35-native-report.json', 'utf8'));
expect(native.status).toBe('PASSED'); expect(native.native).toBe(true);
const run = native.view.run;
const root = mkdtempSync(join(resolve('.runtime'), 'm35 packaged '));
const data = join(root, 'data'); mkdirSync(data);
copyFileSync(join(dirname(native.fixtureRoot), 'data', 'nexus.sqlite'), join(data, 'nexus.sqlite'));
const env = { ...process.env, NEXUS_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const errors = []; const checks = []; let app;
const api = (page, channel, args) => page.evaluate(async ({ channel, args }) => {
  const r = await window.nexus.call(channel, args); if (!r.ok) throw Error(r.error); return r.data;
}, { channel, args });
async function launch() {
  app = await electron.launch({ executablePath: resolve('release/win-unpacked/Agent Nexus.exe'), env, timeout: 30000 });
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1520, 980));
  return page;
}
try {
  let page = await launch();
  const version = await app.evaluate(({ app }) => app.getVersion());
  expect(version).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
  const security = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox };
  });
  expect(security).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });
  await api(page, 'settings.set', { projectId: run.projectId }); await page.reload();
  await page.getByRole('button', { name: 'Leader Mode', exact: true }).click();
  await page.getByLabel('Leader Run 历史').selectOption(run.id);
  await expect(page.getByRole('status', { name: 'Leader Run 当前状态' })).toHaveText('审查通过');
  const view = await api(page, 'leader.get', { runId: run.id });
  expect(view.run.status).toBe('completed'); expect(view.run.mode).toBe('real');
  expect(view.run.review.verdict).toBe('passed');
  expect(view.tasks.map(n => ({ id: n.taskId, attempt: n.attempt, task: n.providerTaskId, history: n.history.map(h => h.review.verdict), diff: n.diff.hash })))
    .toEqual(native.view.tasks.map(n => ({ id: n.taskId, attempt: n.attempt, task: n.providerTaskId, history: n.history.map(h => h.review.verdict), diff: n.diff.hash })));
  expect(view.tasks.every(n => n.status === 'completed' && n.result.source === 'real' && n.review.verdict === 'passed')).toBe(true);
  const report = page.getByRole('region', { name: 'Leader 验收报告' });
  await expect(report).toContainText(run.id); await expect(report).toContainText('来源：real');
  for (const d of await page.locator('.leader-task-tree details').all()) await d.evaluate(e => { e.open = true; });
  await page.screenshot({ path: 'test-results/m35-packaged-real-history.png', fullPage: true });
  await report.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/m35-packaged-real-report.png' });
  checks.push('production sandboxed UI reads real parallel Run, both isolated worktrees, rejection/rework/review history, diffs and native IDs');
  await page.getByRole('button', { name: 'Agent 会议', exact: true }).click();
  const mr = native.meetingView.run; const meeting = native.meetingView.meeting;
  await page.getByLabel('会议历史').selectOption(mr.id);
  await expect(page.getByRole('status', { name: '会议当前状态' })).toHaveText('completed');
  const record = page.getByRole('region', { name: '会议记录' });
  await expect(record).toContainText(meeting.id);
  for (const message of meeting.messages) await expect(record).toContainText(message.nativeTaskId);
  const stored = await api(page, 'leader.get', { runId: mr.id });
  expect(stored.meeting).toEqual(meeting); expect(stored.tasks.every(n => n.attempt === 0)).toBe(true);
  await expect(page.getByRole('region', { name: '会议决策与草案' })).toBeVisible();
  await page.screenshot({ path: 'test-results/m35-packaged-real-meeting.png', fullPage: true });
  checks.push('production reads real Codex/DSH meeting agenda, two messages, summary and unapproved drafts; no Worker dispatched');
  const tasksBefore = (await api(page, 'tasks.list', { projectId: run.projectId, offset: 0, limit: 100 })).tasks;
  expect(tasksBefore).toHaveLength(native.providerTasks.length + native.meetingProviderTasks.length);
  expect((await api(page, 'snapshot.get', {})).activeTaskCount).toBe(0);
  await app.close(); app = null; page = await launch();
  expect((await api(page, 'leader.get', { runId: run.id })).run.status).toBe('completed');
  expect((await api(page, 'leader.get', { runId: mr.id })).meeting).toEqual(meeting);
  const tasksAfter = (await api(page, 'tasks.list', { projectId: run.projectId, offset: 0, limit: 100 })).tasks;
  expect(tasksAfter.map(t => t.id)).toEqual(tasksBefore.map(t => t.id));
  expect((await api(page, 'snapshot.get', {})).activeTaskCount).toBe(0); expect(errors).toEqual([]);
  checks.push('packaged restart preserves all real records, adds no tasks and replays no prompts');
  writeFileSync('test-results/m35-packaged-report.json', JSON.stringify({ passed: true, version, runId: run.id, meetingId: meeting.id, taskCount: tasksBefore.length, additionalModelRequests: false, copiedDatabase: true, security, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, version, checks, additionalModelRequests: false }));
} finally { if (app) await app.close(); }
