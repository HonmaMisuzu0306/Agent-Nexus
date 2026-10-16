import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../packages/agent-core/codex';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import type { AgentEvent } from '../packages/shared';

const dirs: string[] = []; const adapters: CodexAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.dispose(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'Nexus Codex 中文 & ')); dirs.push(root);
  const adapter = new CodexAdapter({ executable: process.execPath, args: [resolve('tests/fixtures/codex-server.mjs')], env: { ...process.env, NEXUS_FIXTURE_DECISION: join(root, 'decision.txt') } }); adapters.push(adapter);
  return { root, adapter };
}
async function run(prompt: string) {
  const { root, adapter } = setup(); const session = await adapter.startSession({ projectId: 'p', rootPath: root });
  const events: AgentEvent[] = [];
  const finished = new Promise<void>(resolve => adapter.subscribeEvents(session.id, e => { events.push(e); if (['task.completed', 'task.failed', 'task.cancelled'].includes(e.type)) resolve(); }));
  const { taskId } = await adapter.sendPrompt({ sessionId: session.id, prompt, scenario: 'success' });
  return { adapter, session, events, finished, taskId };
}
it('decodes UTF-8, maps usage and succeeds only on an explicit native terminal', async () => {
  const r = await run('hello'); await r.finished;
  expect(r.events.map(e => e.sequence)).toEqual(r.events.map((_, i) => i + 1));
  expect(r.events.find(e => e.type === 'message.delta')?.payload.text).toBe('真实中文输出');
  expect(r.events.find(e => e.type === 'usage')?.payload.usage).toMatchObject({ totalTokens: 16, cost: null });
  expect(r.events.at(-1)?.type).toBe('task.completed');
  expect(r.events.every(e => e.payload.mock === false)).toBe(true);
});
it.each(['fail', 'exit'])('treats %s as failure rather than exit-zero success', async prompt => {
  const r = await run(prompt); await r.finished; expect(r.events.at(-1)?.type).toBe('task.failed');
});
it('requires an identified single-use approval and persists its resolution', async () => {
  const { adapter, root } = setup(); const repo = await Repository.open(join(root, 'db.sqlite'));
  const service = new NexusService(repo, { get: () => adapter, dispose: () => adapter.dispose() });
  try {
    const project = await service.call('project.add', { name: 'fixture', rootPath: root });
    expect(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status).toBe(0);
    await service.call('task.start', { projectId: project.id, provider: 'codex', mode: 'real', prompt: 'approval', sandbox: 'workspace-write' });
    await new Promise(r => setTimeout(r, 40));
    const task = repo.tasks(project.id)[0]; expect(task.status).toBe('waiting_approval');
    const approval = (await service.call('approvals.list', { taskId: task.id }))[0];
    expect(approval.command).toBe('echo fixture');
    await service.call('approval.respond', { approvalId: approval.id, decision: 'accept' });
    await new Promise(r => setTimeout(r, 40));
    expect(repo.task(task.id).status).toBe('completed');
    await expect(service.call('approval.respond', { approvalId: approval.id, decision: 'accept' })).rejects.toThrow();
    expect(repo.approvals(task.id)[0].status).toBe('accept');
  } finally { await service.dispose(); repo.close(); }
});
it('rejects escalation in a read-only session rather than surfacing an accept button', async () => {
  const r = await run('approval'); await r.finished;
  expect(r.events.some(e => e.type === 'approval.required')).toBe(false);
  expect(readFileSync(join(r.session.rootPath!, 'decision.txt'), 'utf8')).toBe('decline');
});
it('cancels with interrupt and resumes only a persisted owned session', async () => {
  const r = await run('wait'); expect((await r.adapter.cancelTask(r.taskId)).ok).toBe(true); await r.finished;
  expect(r.events.at(-1)?.type).toBe('task.cancelled');
  expect((await r.adapter.resumeSession(r.session, r.session.rootPath!)).externalSessionId).toBe(r.session.externalSessionId);
  await expect(r.adapter.resumeSession({ ...r.session, externalSessionId: undefined }, r.session.rootPath!)).rejects.toThrow();
});
