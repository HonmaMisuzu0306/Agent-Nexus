import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../packages/persistence';
import type { AgentEvent, Task } from '../packages/shared';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'Nexus integrity ')); dirs.push(dir);
  const r = await Repository.open(join(dir, 'db.sqlite'));
  const p = r.addProject('P', dir);
  r.addSession({ id: 's', projectId: p.id, provider: 'codex', mode: 'mock', status: 'idle', createdAt: new Date().toISOString() });
  const task: Task = { id: 't', projectId: p.id, sessionId: 's', provider: 'codex', mode: 'mock', status: 'queued', prompt: 'demo', createdAt: new Date().toISOString(), finishedAt: null };
  r.addTask(task);
  const event: AgentEvent = { eventId: 'e1', taskId: 't', sessionId: 's', agentId: 'codex', sequence: 1, type: 'task.started', timestamp: new Date().toISOString(), payload: { text: 'started', mock: true } };
  return { r, task, event, dir };
}
it('rejects mismatched event identity and sequence gaps without changing task state', async () => {
  const { r, event } = await setup();
  expect(() => r.recordEvent({ ...event, sessionId: 'another' })).toThrow();
  expect(() => r.recordEvent({ ...event, agentId: 'workbuddy' })).toThrow();
  expect(() => r.recordEvent({ ...event, sequence: 2 })).toThrow();
  expect(r.task('t').status).toBe('queued'); expect(r.events('t')).toHaveLength(0);
  r.recordEvent(event);
  for (let i = 2; i <= 107; i++) r.recordEvent({ ...event, eventId: `event-${i}`, sequence: i, type: 'message.delta' });
  expect(r.eventsTail('t', 5).map(e => e.sequence)).toEqual([103, 104, 105, 106, 107]);
  expect(r.nextSequence('t')).toBe(108);
  expect(() => r.recordEvent({ ...event, eventId: 'duplicate', type: 'task.completed' })).toThrow();
  expect(r.task('t').status).toBe('running');
  expect(r.events('t')).toHaveLength(50); r.close();
});
it('rejects cross-project tasks linked to another project session', async () => {
  const { r, task } = await setup();
  const otherDir = mkdtempSync(join(tmpdir(), 'Nexus other ')); dirs.push(otherDir);
  const other = r.addProject('Other', otherDir);
  expect(() => r.addTask({ ...task, id: 'cross', projectId: other.id })).toThrow();
  expect(r.tasks(other.id)).toHaveLength(0); r.close();
});
it('cascades task history on removal and still enforces foreign keys after file export', async () => {
  const { r, event, task } = await setup(); r.recordEvent(event); r.removeProject(task.projectId);
  expect(r.events(task.id)).toHaveLength(0);
  expect(() => r.addTask({ ...task, id: 'invalid' })).toThrow(); r.close();
});
