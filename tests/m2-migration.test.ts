import { expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../packages/persistence';
it('upgrades an existing M1 database without losing projects, events or settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'Nexus migration ')); const file = join(root, 'db.sqlite');
  try {
    const repo = await Repository.open(file); const project = repo.addProject('M1 existing', root); repo.setSettings({ projectId: project.id, theme: 'dark' });
    repo.addSession({ id: 'old-session', projectId: project.id, provider: 'codex', mode: 'mock', status: 'idle', createdAt: '2026-10-12T00:00:00Z' });
    repo.addTask({ id: 'old-task', projectId: project.id, sessionId: 'old-session', provider: 'codex', mode: 'mock', prompt: 'Existing history', status: 'queued', createdAt: '2026-10-12T00:00:00Z', finishedAt: null });
    repo.recordEvent({ eventId: 'old-event', taskId: 'old-task', sessionId: 'old-session', agentId: 'codex', type: 'task.started', sequence: 1, timestamp: '2026-10-12T00:00:01Z', payload: { mock: true, text: 'Existing event' } }); repo.close();
    const require = createRequire(import.meta.url); const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') }); const old = new SQL.Database(readFileSync(file));
    old.run('DROP TABLE workflow_drafts; DROP TABLE model_calls; DROP TABLE model_configs; DROP TABLE meetings; DROP TABLE leader_handoffs; DROP TABLE workspace_merges; DROP TABLE run_events; DROP TABLE leader_approvals; DROP TABLE leader_actions; DROP TABLE leader_tasks; DROP TABLE leader_plans; DROP TABLE leader_runs; DROP TABLE approvals; DROP TABLE manual_handoffs; PRAGMA user_version=1;'); writeFileSync(file, old.export()); old.close();
    const migrated = await Repository.open(file);
    try { expect(migrated.migrationVersion()).toBe(7); expect(migrated.settings()).toMatchObject({ projectId: project.id, theme: 'dark' }); expect(migrated.events('old-task')[0].payload.text).toBe('Existing event'); migrated.recoverInterrupted(); expect(migrated.task('old-task').status).toBe('interrupted'); expect(migrated.approvals('old-task')).toEqual([]); expect(migrated.handoffs(project.id, 'workbuddy')).toEqual([]); }
    finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
