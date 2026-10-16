import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import { TeamAdapter } from './fixtures/team-adapter';
import type { Channel } from '../packages/shared';
import type { LeaderPlan } from '../packages/shared/leader';

let root: string, repo: Repository, service: NexusService, projectId: string, codex: TeamAdapter, dsh: TeamAdapter;
const tasks: LeaderPlan['tasks'] = ['a', 'b'].map((taskId, i) => ({ taskId, title: taskId, instruction: 'Inspect evidence', assignedAgentId: 'codex', dependsOn: i ? ['a'] : [], acceptance: ['Report actual evidence'], needsWriteAccess: false, paths: [] }));
// Test raw IPC inputs as a renderer could send them, including invalid schemas.
const call = (channel: string, input: unknown): Promise<any> => service.call(channel as Channel, input); // eslint-disable-line @typescript-eslint/no-explicit-any
const start = (extra = {}) => call('leader.start', { projectId, goal: 'Inspect', leader: 'codex', workers: ['codex'], mode: 'mock', control: 'manual', initialTasks: tasks, ...extra });
beforeEach(async () => { root = mkdtempSync(join(tmpdir(), 'Nexus workflow ')); repo = await Repository.open(join(root, 'data', 'nexus.sqlite')); projectId = repo.addProject('Workflow', root).id; codex = new TeamAdapter('codex'); dsh = new TeamAdapter('dsh'); service = new NexusService(repo, { get: p => p === 'codex' ? codex : dsh, dispose: async () => { await codex.dispose(); await dsh.dispose(); } }); });
afterEach(async () => { await service.dispose(); repo.close(); rmSync(root, { recursive: true, force: true }); });

it('saves project-scoped versioned drafts durably without launching any Provider', async () => {
  const draft = { id: 'flow', name: 'Review', goal: 'Inspect', tasks };
  const saved = await call('workflow.save', { projectId, expectedVersion: 0, draft });
  expect(saved.version).toBe(1);
  await expect(call('workflow.save', { projectId, expectedVersion: 0, draft: { ...draft, name: 'Stale' } })).rejects.toThrow();
  expect((await call('workflow.list', { projectId }))[0].name).toBe('Review');
  mkdirSync(join(root, 'other')); const other = repo.addProject('Other', join(root, 'other'));
  expect(await call('workflow.list', { projectId: other.id })).toEqual([]);
  const reopened = await Repository.open(join(root, 'data', 'nexus.sqlite'));
  try { expect(reopened.workflowDrafts(projectId)[0].tasks[1].dependsOn).toEqual(['a']); } finally { reopened.close(); }
  expect(repo.activeTasks()).toEqual([]); expect(codex.requests).toEqual([]);
  await expect(call('workflow.remove', { projectId, id: 'flow', expectedVersion: 2 })).rejects.toThrow();
  await call('workflow.remove', { projectId, id: 'flow', expectedVersion: 1 });
  expect(await call('workflow.list', { projectId })).toEqual([]);
});
it('rejects cycles and missing dependencies before persisting any draft', async () => {
  for (const bad of [[{ ...tasks[0], dependsOn: ['a'] }], [{ ...tasks[0], dependsOn: ['absent'] }], [tasks[0], tasks[0]]]) {
    await expect(call('workflow.save', { projectId, expectedVersion: 0, draft: { id: 'bad', name: 'Bad', goal: 'Inspect', tasks: bad } })).rejects.toThrow();
  }
  expect(await call('workflow.list', { projectId })).toEqual([]);
});
it.each([false, true])('creates a pending approval without a planner or Worker (team=%s)', async team => {
  const run = await start(team ? { team: { reviewer: 'dsh', concurrency: 2, maxReworks: 2, maxDispatches: 20 } } : {});
  expect(repo.leaderView(run.id).run).toMatchObject({ status: 'awaiting_plan_approval', planApproved: false, planRevision: 1 });
  expect(codex.requests).toEqual([]); expect(repo.activeTasks()).toEqual([]);
  await service.call('leader.approve', { runId: run.id, expectedRevision: 1, decision: 'approve' });
  expect(repo.leaderRun(run.id).status).toBe('running');
});
it('atomically replaces draft nodes, increments revision and expires the old approval', async () => {
  const run = await start(); const initial = repo.leaderView(run.id);
  const revised = { ...initial.plan!, tasks: [{ ...tasks[0], taskId: 'replacement', title: 'Revised' }] };
  await call('leader.plan.update', { runId: run.id, expectedRevision: 1, tasks: revised.tasks });
  const view = repo.leaderView(run.id);
  expect(view.run.planRevision).toBe(2); expect(view.tasks.map(n => n.taskId)).toEqual(['replacement']);
  expect(view.approvals.map(a => a.status)).toEqual(['expired', 'pending']);
  await expect(call('leader.approve', { runId: run.id, expectedRevision: 1, decision: 'approve' })).rejects.toThrow();
  await expect(call('leader.plan.update', { runId: run.id, expectedRevision: 1, tasks })).rejects.toThrow();
  await call('leader.approve', { runId: run.id, expectedRevision: 2, decision: 'approve' });
  await expect(call('leader.plan.update', { runId: run.id, expectedRevision: 2, tasks })).rejects.toThrow();
  expect(repo.leaderRun(run.id).planRevision).toBe(2);
});
it('enforces write scope, selected Workers and project paths for manual plans before creating a Run', async () => {
  for (const node of [{ ...tasks[0], needsWriteAccess: true }, { ...tasks[0], assignedAgentId: 'dsh' }, { ...tasks[0], paths: ['../private'] }]) {
    await expect(start({ initialTasks: [node] })).rejects.toThrow();
    expect(repo.leaderRuns(projectId)).toEqual([]);
  }
});
it('preserves the prior revision and approvals when saving a revised plan fails on disk', async () => {
  const run = await start(); mkdirSync(join(root, 'data', 'nexus.sqlite.tmp'));
  await expect(call('leader.plan.update', { runId: run.id, expectedRevision: 1, tasks: [tasks[0]] })).rejects.toThrow();
  expect(repo.leaderView(run.id).tasks).toHaveLength(2); expect(repo.leaderRun(run.id).planRevision).toBe(1);
  expect(repo.leaderApprovals(run.id).map(a => a.status)).toEqual(['pending']);
});
it.each([false, true])('includes the overall goal in isolated template Worker requests (team=%s)', async team => {
  const run = await start({ control: 'supervised', ...(team ? { team: { reviewer: 'dsh', concurrency: 2, maxReworks: 2, maxDispatches: 20 } } : {}) });
  await call('leader.approve', { runId: run.id, expectedRevision: 1, decision: 'approve' });
  for (let i = 0; i < 100 && repo.leaderRun(run.id).status === 'running'; i++) await new Promise(done => setTimeout(done, 20));
  expect(repo.leaderRun(run.id).status).toBe('completed');
  expect(codex.requests.find(r => r.role === 'NEXUS_WORKER')?.prompt.goal).toBe('Inspect');
});
