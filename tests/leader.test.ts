import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import type { Channel } from '../packages/shared';

import { ScriptAdapter } from './fixtures/leader-adapter';
let root: string, repo: Repository, service: NexusService, projectId: string, leader: ScriptAdapter, worker: ScriptAdapter;
beforeEach(async () => { root = mkdtempSync(join(tmpdir(), 'Nexus leader ')); repo = await Repository.open(join(root, 'db.sqlite')); projectId = repo.addProject('Synthetic', root).id; leader = new ScriptAdapter('codex'); worker = new ScriptAdapter('dsh'); service = new NexusService(repo, { get: p => p === 'codex' ? leader : worker, dispose: async () => { await leader.dispose(); await worker.dispose(); } }); });
afterEach(async () => { vi.restoreAllMocks(); await service.dispose(); repo.close(); rmSync(root, { recursive: true, force: true }); });
// Exercise the unknown IPC boundary before Leader channels exist.
const call = (c: string, a: unknown): Promise<any> => service.call(c as Channel, a); // eslint-disable-line @typescript-eslint/no-explicit-any
const start = (extra = {}) => call('leader.start', { projectId, goal: 'Synthetic two-step analysis', leader: 'codex', workers: ['dsh'], mode: 'mock', ...extra });
async function wait(id: string, predicate: (v: any) => boolean) { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < 200; i++) { const v = await call('leader.get', { runId: id }); if (predicate(v)) return v; await new Promise(r => setTimeout(r, 15)); } throw Error('Run did not reach expected state');
}
const approve = (id: string) => call('leader.approve', { runId: id, expectedRevision: 1, decision: 'approve' });
it('requires first-plan approval, then completes a serial loop with source and durable native task refs', async () => {
  const r = await start(); const pending = await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); expect(pending.tasks).toHaveLength(2); expect(worker.workerCalls).toBe(0); expect(repo.activeTasks()).toHaveLength(0);
  await approve(r.id); const done = await wait(r.id, v => v.run.status === 'completed'); expect(worker.workerCalls).toBe(2);
  expect(done.tasks.every((n: any) => n.result.source === 'mock' && n.result.rawEventRefs.length > 0)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(done.run.report).toContain('Fixture worker output'); expect(done.run.report).toContain('费用未知');
  expect(done.tasks.every((n: any) => repo.task(n.providerTaskId).leaderRunId === r.id)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
});
it('pins the authorized goal and run identity in the native output schema', async () => {
  const sent = vi.spyOn(leader, 'sendPrompt'); const r = await start(); await wait(r.id, v => v.run.status === 'awaiting_plan_approval');
  const schema = sent.mock.calls[0][0].outputSchema as { properties: Record<string, { const?: unknown }> };
  expect(schema.properties.goal.const).toBe(r.goal); expect(schema.properties.runId.const).toBe(r.id); expect(schema.properties.revision.const).toBe(1);
});
it('Manual mode rejects stale revisions and deduplicates actions without dispatching dependent work', async () => {
  const r = await start({ control: 'manual' }); await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); await approve(r.id);
  const action = { actionId: 'manual-a', runId: r.id, expectedRevision: 1, type: 'assign_task', taskId: 'a', agentId: 'dsh', reason: 'User dispatch' };
  expect(await call('leader.action', { ...action, actionId: 'stale', expectedRevision: 2 })).toMatchObject({ ok: false });
  expect(await call('leader.action', action)).toMatchObject({ ok: true }); expect(await call('leader.action', action)).toMatchObject({ ok: true });
  expect(await call('leader.action', { ...action, reason: 'Changed key payload' })).toMatchObject({ ok: false });
  const v = await wait(r.id, v => v.tasks[0].status === 'completed'); expect(worker.workerCalls).toBe(1); expect(v.tasks[1].status).toBe('pending');
  expect(v.events.some((e: any) => e.type === 'action.rejected')).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
});
it('blocks after bounded invalid JSON responses and never fabricates a plan', async () => { leader.invalid = true; const r = await start(); const v = await wait(r.id, v => v.run.status === 'blocked'); expect(v.run.plannerAttempts).toBe(2); expect(v.plan).toBeUndefined(); expect(worker.workerCalls).toBe(0); });
it('does not dispatch dependents after failure', async () => { worker.failure = true; const r = await start(); await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); await approve(r.id); const v = await wait(r.id, v => v.run.status === 'failed'); expect(worker.workerCalls).toBe(1); expect(v.tasks[1].status).toBe('pending'); });
it('Pause stops future dispatch while collecting an in-flight task, then Resume continues', async () => { worker.delay = 250; const r = await start(); await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); await approve(r.id); await wait(r.id, v => v.tasks[0].status === 'running'); await call('leader.pause', { runId: r.id }); const v = await wait(r.id, v => v.tasks[0].status === 'completed'); expect(v.run.status).toBe('paused'); expect(worker.workerCalls).toBe(1); await call('leader.resume', { runId: r.id }); await wait(r.id, v => v.run.status === 'completed'); expect(worker.workerCalls).toBe(2); });
it('Stop-all prevents later dispatch and preserves provider cancellation truth', async () => { worker.delay = 1000; const r = await start(); await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); await approve(r.id); await wait(r.id, v => v.tasks[0].status === 'running'); await call('tasks.stopAll', {}); const v = await wait(r.id, v => v.run.status === 'cancelled'); expect(v.tasks[0].status).toBe('cancelled'); expect(worker.workerCalls).toBe(0); expect(repo.activeTasks()).toHaveLength(0); });
it('Stop during asynchronous session startup does not send a native prompt', async () => { leader.startupDelay = 150; const r = await start(); await call('leader.stop', { runId: r.id }); await wait(r.id, v => v.run.status === 'cancelled'); expect(leader.jobs.size).toBe(0); expect(worker.workerCalls).toBe(0); });
it('refuses concurrent runs and removal of an active run project', async () => { leader.startupDelay = 200; const r = await start(); await expect(start()).rejects.toThrow(); await expect(call('project.remove', { projectId })).rejects.toThrow('Leader'); await call('leader.stop', { runId: r.id }); });
it('does not dispatch when the action cannot be durably recorded', async () => {
  const r = await start({ control: 'manual' }); await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); await approve(r.id);
  vi.spyOn(repo, 'leaderSave').mockImplementationOnce(() => { throw Error('disk failed'); });
  await expect(call('leader.action', { actionId: 'no-write', runId: r.id, expectedRevision: 1, type: 'assign_task', taskId: 'a', reason: 'test' })).rejects.toThrow('disk failed'); expect(worker.workerCalls).toBe(0);
});
it('Pause during Worker session startup defers the unsent prompt until explicit resume and dispatch', async () => {
  worker.startupDelay = 250; const sent = vi.spyOn(worker, 'sendPrompt'); const r = await start({ control: 'manual' }); await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); await approve(r.id);
  await call('leader.action', { actionId: 'before-pause', runId: r.id, expectedRevision: 1, type: 'assign_task', taskId: 'a', reason: 'test' });
  await wait(r.id, v => v.tasks[0].status === 'assigned'); await call('leader.pause', { runId: r.id }); await new Promise(r => setTimeout(r, 350));
  const paused = await call('leader.get', { runId: r.id }); expect(sent).not.toHaveBeenCalled(); expect(paused.run.status).toBe('paused'); expect(paused.tasks[0].status).toBe('pending');
  await call('leader.resume', { runId: r.id }); await call('leader.action', { actionId: 'after-pause', runId: r.id, expectedRevision: 1, type: 'assign_task', taskId: 'a', reason: 'test' }); await wait(r.id, v => v.tasks[0].status === 'completed'); expect(sent).toHaveBeenCalledTimes(1);
});
it('paused invalid planning does not send the next request until Resume', async () => {
  leader.invalid = true; leader.planningDelay = 150; const sent = vi.spyOn(leader, 'sendPrompt'); const r = await start(); await wait(r.id, v => !!v.run.currentTaskId); await call('leader.pause', { runId: r.id }); await new Promise(r => setTimeout(r, 300)); expect(sent).toHaveBeenCalledTimes(1);
  leader.invalid = false; await call('leader.resume', { runId: r.id }); await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); expect(sent).toHaveBeenCalledTimes(2);
});
it('review retains every acceptance criterion and the complete bounded worker evidence', async () => {
  const r = await start({ control: 'manual' }); await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); await approve(r.id);
  const nodes = repo.leaderNodes(r.id).map(n => ({ ...n, status: 'completed' as const, acceptance: ['One', 'Two', 'Three', 'FOURTH_REQUIRED'], result: { runId: r.id, taskId: n.taskId, agentId: n.assignedAgentId, source: 'mock' as const, outcome: 'success' as const, summary: 'x'.repeat(550) + 'FAILURE_EVIDENCE', artifacts: [], tests: [], rawEventRefs: [], providerTaskId: 'fixture' } }));
  repo.leaderSave(repo.leaderRun(r.id), 'fixture.seed', 'Synthetic completed nodes', { nodes }); const sent = vi.spyOn(leader, 'sendPrompt');
  await call('leader.action', { actionId: 'review-complete-evidence', runId: r.id, expectedRevision: 1, type: 'request_review', reason: 'test' }); await wait(r.id, v => v.run.status === 'completed');
  const prompt = JSON.parse(sent.mock.calls[0][0].prompt); expect(prompt.results[0].acceptance).toContain('FOURTH_REQUIRED'); expect(prompt.results[0].summary).toContain('FAILURE_EVIDENCE');
});
it('timeout reconciles the Leader node with the actual cancelled Provider task', async () => {
  worker.delay = 10000; const r = await start({ control: 'manual' }); await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); await approve(r.id);
  const now = Date.now(); repo.leaderSave({ ...repo.leaderRun(r.id), deadline: now + 150 }, 'fixture.deadline', 'Short synthetic deadline');
  await call('leader.action', { actionId: 'timeout-node', runId: r.id, expectedRevision: 1, type: 'assign_task', taskId: 'a', reason: 'test' }); const v = await wait(r.id, v => v.run.status === 'blocked');
  expect(repo.task(v.tasks[0].providerTaskId).status).toBe('cancelled'); expect(v.tasks[0].status).toBe('cancelled'); expect(v.run.currentNodeId).toBeUndefined();
});
it('marks redaction-expanded output as truncated and blocks automatic review', async () => {
  worker.workerOutput = 'Bearer a '.repeat(550) + 'FAILURE_EVIDENCE';
  const r = await start(); await wait(r.id, v => v.run.status === 'awaiting_plan_approval'); await approve(r.id);
  const v = await wait(r.id, v => ['completed', 'blocked'].includes(v.run.status));
  expect(v.tasks[0].result.summaryTruncated).toBe(true); expect(v.run.status).toBe('blocked');
  expect(v.run.reason).toContain('完整审查上下文');
});
