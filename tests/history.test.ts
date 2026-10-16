import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import { TeamAdapter } from './fixtures/team-adapter';
import type { Channel } from '../packages/shared';
let root: string, repo: Repository, service: NexusService, projectId: string;
const call = (c: string, a: unknown): Promise<any> => service.call(c as Channel, a); // eslint-disable-line @typescript-eslint/no-explicit-any
beforeEach(async () => { root = mkdtempSync(join(tmpdir(), 'Nexus history ')); repo = await Repository.open(join(root, 'db.sqlite')); projectId = repo.addProject('PRIVATE_PROJECT_NAME', root).id; const adapter = new TeamAdapter('codex'); service = new NexusService(repo, { get: () => adapter, dispose: () => adapter.dispose() }); });
afterEach(async () => { await service.dispose(); repo.close(); rmSync(root, { recursive: true, force: true }); });
function task(id: string, p = projectId, text = 'Synthetic task') {
  repo.addSession({ id: 's' + id, projectId: p, provider: 'codex', mode: 'mock', status: 'idle', createdAt: 'now' });
  repo.addTask({ id, projectId: p, sessionId: 's' + id, provider: 'codex', mode: 'mock', prompt: text, status: 'queued', createdAt: 'now', finishedAt: null });
  repo.recordEvent({ eventId: 'e' + id, taskId: id, sessionId: 's' + id, agentId: 'codex', timestamp: 'now', sequence: 1, type: 'task.started', payload: { text: 'unique 历史日志 evidence' } });
}
it('searches full persisted logs beyond the loaded page and isolates projects', async () => {
  task('old'); task('new'); mkdirSync(join(root, 'other')); const other = repo.addProject('Other', join(root, 'other')); task('private', other.id);
  const page = await call('history.search', { projectId, query: '历史日志', offset: 0, limit: 1 });
  expect(page.tasks.map((t: { id: string }) => t.id)).toEqual(['new']); expect(page.hasMore).toBe(true);
  const next = await call('history.search', { projectId, query: '历史日志', offset: 1, limit: 1 }); expect(next.tasks.map((t: { id: string }) => t.id)).toEqual(['old']); expect(next.hasMore).toBe(false);
  expect((await call('history.search', { projectId, query: "' OR 1=1 --", offset: 0, limit: 30 })).tasks).toEqual([]);
});
it('filters event pages without losing sequence or treating query as executable SQL', async () => {
  task('a'); repo.recordEvent({ eventId: 'e2', taskId: 'a', sessionId: 'sa', agentId: 'codex', timestamp: 'now', sequence: 2, type: 'message.delta', payload: { text: 'other' } });
  expect((await call('events.list', { taskId: 'a', after: 0, limit: 50, query: '历史' })).map((e: { sequence: number }) => e.sequence)).toEqual([1]);
  expect(await call('events.list', { taskId: 'a', after: 1, limit: 50, query: '历史' })).toEqual([]);
});
it('exports only aggregate diagnostics, excluding all user text, paths and credentials', async () => {
  task('diagnostic', projectId, 'PRIVATE_PROMPT Bearer SECRET_PASSWORD');
  const report = await call('diagnostics.get', {}); const text = JSON.stringify(report);
  for (const secret of ['PRIVATE_PROJECT_NAME', 'PRIVATE_PROMPT', 'SECRET_PASSWORD', root, '历史日志', 'unique', 'diagnostic']) expect(text).not.toContain(secret);
  expect(report.schemaVersion).toBe(7); expect(report.projectCount).toBe(1); expect(report.taskCount).toBe(1);
});
