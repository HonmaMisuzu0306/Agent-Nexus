import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { Repository } from '../packages/persistence';
import type { LeaderRun } from '../packages/shared/leader';
it('persists ordered run history and recovers an uncertain run without replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'Nexus leader store ')); const file = join(root, 'db.sqlite'); let repo = await Repository.open(file);
  try {
    expect(repo.migrationVersion()).toBe(7); const project = repo.addProject('Existing', root);
    const run: LeaderRun = { id: 'r', projectId: project.id, rootPath: root, goal: 'G', leader: 'codex', workers: ['dsh'], mode: 'real', control: 'supervised', allowWrites: false, status: 'draft', phase: 'planning', planRevision: 0, planApproved: false, plannerAttempts: 0, stepTimeoutMs: 180000, deadline: Date.now() + 900000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    repo.leaderSave(run, 'run.created', 'Created'); repo.leaderSave({ ...run, status: 'running' }, 'run.running', 'Running'); repo.close(); repo = await Repository.open(file); repo.recoverInterrupted();
    expect(repo.leaderRun('r').status).toBe('interrupted'); expect(repo.leaderEvents('r', 0, 2).map(e => e.sequence)).toEqual([1, 2]); expect(repo.leaderEvents('r', 2, 10).at(-1)?.type).toBe('run.interrupted');
    repo.recoverInterrupted(); expect(repo.leaderEvents('r', 0, 100)).toHaveLength(3); expect(repo.projects()[0].id).toBe(project.id);
  } finally { repo.close(); rmSync(root, { recursive: true, force: true }); }
});
it('upgrades a v3 database and refuses a newer schema', async () => {
  const root = mkdtempSync(join(tmpdir(), 'Nexus leader migration ')); const file = join(root, 'db.sqlite');
  try {
    let repo = await Repository.open(file); const project = repo.addProject('M2 project', root); repo.close();
    const require = createRequire(import.meta.url); const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const db = new SQL.Database(readFileSync(file)); for (const table of ['workflow_drafts', 'model_calls', 'model_configs', 'meetings', 'leader_handoffs', 'workspace_merges', 'run_events', 'leader_approvals', 'leader_actions', 'leader_tasks', 'leader_plans', 'leader_runs']) db.run(`DROP TABLE ${table}`); db.run('PRAGMA user_version=3'); writeFileSync(file, db.export()); db.close();
    repo = await Repository.open(file); expect(repo.migrationVersion()).toBe(7); expect(repo.project(project.id).name).toBe('M2 project'); repo.close();
    const future = new SQL.Database(readFileSync(file)); future.run('PRAGMA user_version=99'); writeFileSync(file, future.export()); future.close();
    await expect(Repository.open(file)).rejects.toThrow('较新版本');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('restores memory after actual disk save failure so an action can be safely retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'Nexus leader durability ')); const file = join(root, 'db.sqlite'); const repo = await Repository.open(file);
  try {
    const p = repo.addProject('Durability', root); const now = new Date().toISOString(); const run: LeaderRun = { id: 'r', projectId: p.id, rootPath: root, goal: 'G', leader: 'codex', workers: ['dsh'], mode: 'mock', control: 'manual', allowWrites: false, status: 'running', phase: 'workers', planRevision: 1, planApproved: true, plannerAttempts: 1, stepTimeoutMs: 180000, deadline: Date.now() + 900000, createdAt: now, updatedAt: now }; repo.leaderSave(run, 'run.created', 'Created');
    const action = { action: { actionId: 'a', runId: 'r', expectedRevision: 1, type: 'assign_task' as const, taskId: 'node', reason: 'test' }, result: { ok: true, pending: true }, createdAt: now };
    mkdirSync(file + '.tmp'); expect(() => repo.leaderSave(run, 'action.accepted', 'Test', { action })).toThrow(); expect(repo.leaderAction('a')).toBeUndefined(); expect(repo.leaderEvents('r')).toHaveLength(1);
    rmSync(file + '.tmp', { recursive: true }); repo.leaderSave(run, 'action.accepted', 'Test', { action }); const reopened = await Repository.open(file); try { expect(reopened.leaderAction('a')).toEqual(action); } finally { reopened.close(); }
  } finally { repo.close(); rmSync(root, { recursive: true, force: true }); }
});
