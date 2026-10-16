import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodexAdapter } from '../packages/agent-core/codex';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import { parseRequest, type Channel } from '../packages/shared';
import { sanitize } from '../packages/agent-core/sanitize';

it('rejects arbitrary executable, permanent approvals and unsafe sandbox values over IPC', () => {
  expect(() => parseRequest('task.start', { projectId: 'p', provider: 'codex', mode: 'real', prompt: 'x', sandbox: 'danger-full-access' })).toThrow();
  expect(() => parseRequest('approval.respond', { approvalId: 'a', decision: 'acceptForSession' })).toThrow();
  expect(() => parseRequest('provider.open', { provider: 'workbuddy', executable: 'C:\\evil.exe' })).toThrow();
  expect(() => parseRequest('raw.rpc' as Channel, { method: 'turn/start' })).toThrow();
  expect(sanitize({ accessToken: 'private', email: 'private@invalid', text: 'Bearer secret sk-proj-12345678901234567890', totalTokens: 16 })).toEqual({ accessToken: '[REDACTED]', email: '[REDACTED]', text: 'Bearer [REDACTED] [REDACTED]', totalTokens: 16 });
});
it('does not approve native execution when persisting the approval decision fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'Nexus approval disk ')); const decision = join(root, 'decision.txt');
  const adapter = new CodexAdapter({ executable: process.execPath, args: [resolve('tests/fixtures/codex-server.mjs')], env: { ...process.env, NEXUS_FIXTURE_DECISION: decision } });
  const repo = await Repository.open(join(root, 'db.sqlite')); const service = new NexusService(repo, { get: () => adapter, dispose: () => adapter.dispose() });
  try {
    expect(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status).toBe(0);
    const p = await service.call('project.add', { name: 'disk', rootPath: root });
    const task = await service.call('task.start', { projectId: p.id, provider: 'codex', mode: 'real', sandbox: 'workspace-write', prompt: 'approval' });
    await new Promise(r => setTimeout(r, 40)); const approval = repo.approvals(task.id)[0];
    const record = repo.recordEvent.bind(repo); vi.spyOn(repo, 'recordEvent').mockImplementation(event => { if (event.type === 'approval.resolved') throw new Error('simulated disk failure'); record(event); });
    await expect(service.call('approval.respond', { approvalId: approval.id, decision: 'accept' })).rejects.toThrow('记录失败');
    await new Promise(r => setTimeout(r, 80));
    expect(repo.task(task.id).status).toBe('failed'); expect(readFileSync(decision, 'utf8')).not.toBe('accept');
  } finally { await service.dispose(); repo.close(); rmSync(root, { recursive: true, force: true }); }
});
it('requires a real Git repository and rejects resuming another project session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'Nexus scopes ')); const other = join(root, 'other'); mkdirSync(other);
  const adapter = new CodexAdapter({ executable: process.execPath, args: [resolve('tests/fixtures/codex-server.mjs')] });
  const repo = await Repository.open(join(root, 'db.sqlite')); const service = new NexusService(repo, { get: () => adapter, dispose: () => adapter.dispose() });
  try {
    const p = await service.call('project.add', { name: 'one', rootPath: root }); const p2 = await service.call('project.add', { name: 'two', rootPath: other }); mkdirSync(join(root, '.git'));
    await expect(service.call('task.start', { projectId: p.id, provider: 'codex', mode: 'real', sandbox: 'workspace-write', prompt: 'hello' })).rejects.toThrow('Git');
    const task = await service.call('task.start', { projectId: p.id, provider: 'codex', mode: 'real', prompt: 'hello' });
    await new Promise(r => setTimeout(r, 40));
    await expect(service.call('task.start', { projectId: p2.id, provider: 'codex', mode: 'real', sessionId: task.sessionId, prompt: 'resume' })).rejects.toThrow('当前项目');
  } finally { await service.dispose(); repo.close(); rmSync(root, { recursive: true, force: true }); }
});
