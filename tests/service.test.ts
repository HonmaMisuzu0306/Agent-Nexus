import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import { ProcessManager } from '../packages/agent-core';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function temp() { const d = mkdtempSync(join(tmpdir(), 'Nexus test & 中文 ')); dirs.push(d); return d; }
it('runs literal args from a path with spaces and cleans up timed-out processes', async () => {
  const root = temp(); const script = join(root, 'my child.js');
  writeFileSync(script, 'console.log(process.argv[2]);');
  const manager = new ProcessManager();
  const result = await manager.run(process.execPath, [script, '& whoami $(calc)'], root);
  expect(result.stdout.trim()).toBe('& whoami $(calc)');
  expect(manager.activeCount).toBe(0);
  await expect(manager.run(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], root, 30)).rejects.toThrow('timed out');
  expect(manager.activeCount).toBe(0);
  await expect(manager.run('cmd.exe', [], root)).rejects.toThrow();
  await manager.dispose();
});
it('validates project creation, cancels on removal and retains the project directory', async () => {
  const root = temp(); const repo = await Repository.open(join(root, 'db.sqlite')); const service = new NexusService(repo);
  const p = await service.call('project.create', { name: '项目 One', parentPath: root });
  expect(existsSync(p.rootPath)).toBe(true);
  await expect(service.call('project.create', { name: '../escape', parentPath: root })).rejects.toThrow();
  await expect(service.call('project.create', { name: '项目 One', parentPath: root })).rejects.toThrow();
  await service.call('task.start', { projectId: p.id, provider: 'codex', prompt: 'demo', scenario: 'success' });
  await expect(service.call('task.start', { projectId: p.id, provider: 'codex', prompt: 'again', scenario: 'success' })).rejects.toThrow('运行中');
  await service.call('project.remove', { projectId: p.id });
  expect(existsSync(p.rootPath)).toBe(true);
  expect(repo.activeTasks()).toHaveLength(0);
  await service.dispose(); repo.close();
});
it('stop all leaves only cancelled terminal tasks and does not restart on reopen', async () => {
  const root = temp(); const db = join(root, 'db.sqlite'); const repo = await Repository.open(db); const service = new NexusService(repo);
  const p = await service.call('project.add', { name: 'demo', rootPath: root });
  const a = await service.call('task.start', { projectId: p.id, provider: 'codex', prompt: 'demo', scenario: 'success' });
  await service.call('task.start', { projectId: p.id, provider: 'dsh', prompt: 'demo', scenario: 'failure' });
  expect((await service.call('snapshot.get', {})).activeTaskCount).toBe(2);
  await service.call('tasks.stopAll', {});
  expect((await service.call('snapshot.get', {})).activeTaskCount).toBe(0);
  expect(repo.tasks(p.id).map(t => t.status)).toEqual(['cancelled', 'cancelled']);
  expect(repo.events(a.id, 0, 50).at(-1)?.type).toBe('task.cancelled');
  await service.dispose(); repo.close();
  const restored = await Repository.open(db); restored.recoverInterrupted();
  expect(restored.activeTasks()).toHaveLength(0); restored.close();
});

it('reports a failed event write with task identity and stops the affected mock', async () => {
  const root = temp(); const repo = await Repository.open(join(root, 'db.sqlite')); const service = new NexusService(repo);
  const p = await service.call('project.add', { name: 'demo', rootPath: root });
  const issues: { taskId?: string; agentId?: string }[] = [];
  const issue = new Promise<void>(resolve => { service.onIssue = e => { issues.push(e); resolve(); }; });
  const task = await service.call('task.start', { projectId: p.id, provider: 'codex', prompt: 'failure injection', scenario: 'success' });
  vi.spyOn(repo, 'recordEvent').mockImplementationOnce(() => { throw new Error('disk write failed'); });
  await issue;
  expect(issues[0]).toMatchObject({ taskId: task.id, agentId: 'codex' });
  expect(repo.task(task.id).status).toBe('failed');
  expect(repo.activeTasks()).toHaveLength(0);
  await service.dispose(); repo.close();
});
