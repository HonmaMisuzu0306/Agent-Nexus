import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import { registerNexusIpc } from '../apps/desktop/src/main/ipc';
import type { Reply, Snapshot, Task } from '../packages/shared';

let window: BrowserWindow | null = null;
let repository: Repository | null = null;
let service: NexusService | null = null;
const checks: string[] = [];
const preloadErrors: string[] = [];
const runtime = resolve('.runtime'); mkdirSync(runtime, { recursive: true });
const testRoot = process.env.NEXUS_CORE_TEST_ROOT ?? mkdtempSync(join(runtime, 'electron core 中文 & '));
app.setPath('userData', join(testRoot, 'user data'));
const call = async <T>(channel: string, args: unknown): Promise<Reply<T>> => window!.webContents.executeJavaScript(`window.nexus.call(${JSON.stringify(channel)}, ${JSON.stringify(args)})`);
async function request<T>(channel: string, args: unknown) {
  const reply = await call<T>(channel, args); if (!reply.ok) throw new Error(reply.error); return reply.data;
}
async function waitTerminal(id: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const t = repository!.task(id); if (['completed', 'failed', 'cancelled'].includes(t.status)) return t;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('模拟任务终态等待超时');
}

void app.whenReady().then(async () => {
  const fixture = join(testRoot, 'fixture.html');
  writeFileSync(fixture, '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'" /></head><body>Core test fixture</body></html>');
  const db = join(testRoot, 'nexus.sqlite'); repository = await Repository.open(db); service = new NexusService(repository);
  window = new BrowserWindow({ show: false, webPreferences: { preload: resolve('.runtime/core/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.on('preload-error', (_event, _path, error) => { preloadErrors.push(error.message); console.error('preload-error:', error.message); });
  const unregister = registerNexusIpc(ipcMain, dialog, () => window, service, pathToFileURL(fixture).href);
  await window.loadFile(fixture);
  assert.deepEqual(preloadErrors, []);
  assert.equal(await window.webContents.executeJavaScript('typeof window.nexus.call'), 'function');
  assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await window.webContents.executeJavaScript('typeof process'), 'undefined');
  assert.equal((await call('execute', { command: 'whoami' })).ok, false);
  assert.equal((await call('task.start', { shell: true })).ok, false);
  checks.push('真实 Electron sandbox preload 可用；Node API 隔离；IPC 白名单及输入校验');

  if (process.env.NEXUS_CORE_TEST_PHASE === 'restart') {
    repository.recoverInterrupted();
    const snapshot = await request<Snapshot>('snapshot.get', {});
    assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.settings.projectId, snapshot.projects[0].id);
    assert.equal(snapshot.settings.layout, 'columns'); assert.equal(snapshot.settings.theme, 'light');
    assert.deepEqual(repository.tasks(snapshot.projects[0].id).map(t => t.status).sort(), ['cancelled', 'completed', 'failed']);
    assert.equal(repository.activeTasks().length, 0);
    assert.equal(snapshot.installations.length, 4);
    const report = JSON.parse(readFileSync('test-results/core-electron-report.json', 'utf8'));
    report.checks.push('全新 Electron 进程重启：项目/主题/布局/会话/任务/事件均保存，没有自动重跑');
    report.freshProcessRestart = true;
    writeFileSync('test-results/core-electron-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: true, freshProcessRestart: true, testRoot }, null, 2));
    await service.dispose(); repository.close(); service = null; repository = null; unregister(); window.destroy(); window = null;
    app.exit(0); return;
  }

  const first = await request<{ id: string }>('project.create', { name: 'Project One', parentPath: testRoot });
  const second = await request<{ id: string; rootPath: string }>('project.create', { name: '项目 Two', parentPath: testRoot });
  await request('settings.set', { projectId: first.id, layout: 'columns', theme: 'light' });
  assert.equal((await request<Snapshot>('snapshot.get', {})).projects.length, 2);
  const success = await request<Task>('task.start', { projectId: first.id, provider: 'codex', prompt: '模拟成功', scenario: 'success' });
  assert.equal((await waitTerminal(success.id)).status, 'completed');
  const failure = await request<Task>('task.start', { projectId: first.id, provider: 'dsh', prompt: '模拟失败', scenario: 'failure' });
  assert.equal((await waitTerminal(failure.id)).status, 'failed');
  const cancel = await request<Task>('task.start', { projectId: first.id, provider: 'antigravity', prompt: '模拟取消', scenario: 'success' });
  await request('task.cancel', { taskId: cancel.id }); assert.equal((await waitTerminal(cancel.id)).status, 'cancelled');
  const events = repository.events(success.id, 0, 100); assert.equal(events.length, 5);
  assert.equal(events.every(e => e.payload.mock === true), true);
  assert.equal(events.at(-1)?.type, 'task.completed');
  checks.push('真实 IPC → Service → Mock → SQLite：两项目、成功/失败/取消、连续事件');

  const installations = await service.detect();
  assert.equal(installations.length, 4);
  assert.equal(installations.filter(i => i.id === 'antigravity' || i.id === 'workbuddy').every(i => !i.capabilities.sendPrompt.supported), true);
  checks.push('四 Provider 分能力探测；受限桌面端不静默回退');
  const rogue = new BrowserWindow({ show: false, webPreferences: { preload: resolve('.runtime/core/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await rogue.loadFile(fixture);
  const rogueReply: Reply<unknown> = await rogue.webContents.executeJavaScript('window.nexus.call("snapshot.get", {})');
  assert.equal(rogueReply.ok, false); rogue.destroy(); checks.push('拒绝非授权窗口的 IPC 来源');

  await service.dispose(); repository.close(); unregister();
  repository = await Repository.open(db); repository.recoverInterrupted(); service = new NexusService(repository);
  const unregisterRestored = registerNexusIpc(ipcMain, dialog, () => window, service, pathToFileURL(fixture).href);
  const restored = await request<Snapshot>('snapshot.get', {});
  assert.equal(restored.settings.layout, 'columns'); assert.equal(restored.settings.projectId, first.id);
  assert.equal(repository.tasks(first.id).length, 3); assert.equal(repository.activeTasks().length, 0);
  await request('project.remove', { projectId: second.id }); assert.equal(existsSync(second.rootPath), true);
  checks.push('关闭/重开 SQLite 后数据和布局保存；没有重跑；移除项目保留磁盘目录');
  await service.dispose(); repository.close(); service = null; repository = null; unregisterRestored(); window.destroy(); window = null;
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/core-electron-report.json', JSON.stringify({ passed: true, checks, versions: process.versions, installations, testRoot }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, testRoot }, null, 2)); app.exit(0);
}).catch(async error => {
  console.error(error); await service?.dispose(); repository?.close(); window?.destroy(); app.exit(1);
});
