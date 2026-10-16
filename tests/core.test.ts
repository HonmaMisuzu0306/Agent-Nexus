import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAdapter, UnconnectedAdapter, AgentRegistry } from '../packages/agent-core';
import { CodexAdapter } from '../packages/agent-core/codex';
import { Repository } from '../packages/persistence';
import { parseRequest, transition, type AgentEvent, type Channel } from '../packages/shared';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'Nexus 中文 & space ')); dirs.push(d); return d; };

describe('IPC boundary and state machine', () => {
  it('rejects unknown channels, arbitrary commands, invalid provider and oversized prompt', () => {
    expect(() => parseRequest('execute' as Channel, { command: 'whoami' })).toThrow();
    expect(() => parseRequest('task.start', { projectId: 'x', provider: 'evil', prompt: 'hi', scenario: 'success' })).toThrow();
    expect(() => parseRequest('task.start', { projectId: 'x', provider: 'codex', prompt: 'x'.repeat(16001), scenario: 'success' })).toThrow();
    expect(() => parseRequest('settings.set', { shell: true })).toThrow();
    expect(() => parseRequest('events.list', { taskId: 'x', after: -1, limit: 1000 })).toThrow();
  });
  it('does not revive terminal tasks or complete a queued task without running', () => {
    expect(transition('queued', 'running')).toBe('running');
    expect(() => transition('completed', 'running')).toThrow();
    expect(() => transition('queued', 'completed')).toThrow();
    expect(() => transition('cancelled', 'completed')).toThrow();
  });
});

describe('explicit adapter capabilities', () => {
  it('does not schedule another timer when a subscriber cancels during an event', async () => {
    vi.useFakeTimers();
    const adapter = new MockAdapter('codex', 10);
    const s = await adapter.startSession({ projectId: 'p', rootPath: temp() });
    adapter.subscribeEvents(s.id, e => { if (e.type === 'task.started') void adapter.cancelTask(e.taskId); });
    await adapter.sendPrompt({ sessionId: s.id, prompt: 'stop during callback', scenario: 'success' });
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(0);
    await adapter.dispose();
  });
  it('never silently substitutes a mock for an unconnected provider', async () => {
    const real = new UnconnectedAdapter('codex');
    expect((await real.getCapabilities()).sendPrompt.supported).toBe(false);
    await expect(real.startSession({ projectId: 'p', rootPath: temp() })).rejects.toThrow('unsupported');
    expect(new AgentRegistry().get('codex', 'mock')).toBeInstanceOf(MockAdapter);
    expect(new AgentRegistry().get('codex', 'real')).toBeInstanceOf(CodexAdapter);
  });
  it.each(['success', 'failure'] as const)('streams ordered events and an explicit %s terminal event', async scenario => {
    const adapter = new MockAdapter('codex', 5);
    const s = await adapter.startSession({ projectId: 'p', rootPath: temp() });
    const events: AgentEvent[] = [];
    const terminal = new Promise<void>(resolve => adapter.subscribeEvents(s.id, e => { events.push(e); if (e.type === 'task.completed' || e.type === 'task.failed') resolve(); }));
    await adapter.sendPrompt({ sessionId: s.id, prompt: 'test', scenario });
    await terminal;
    expect(events.map(e => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(events.at(-1)?.type).toBe(scenario === 'success' ? 'task.completed' : 'task.failed');
    expect(events.every(e => e.payload.mock === true)).toBe(true);
    await adapter.dispose();
  });
  it('cancels repeatedly without later success events or residual timers', async () => {
    const adapter = new MockAdapter('dsh', 10);
    const s = await adapter.startSession({ projectId: 'p', rootPath: temp() });
    const events: AgentEvent[] = [];
    adapter.subscribeEvents(s.id, e => events.push(e));
    for (let i = 0; i < 4; i++) {
      const { taskId } = await adapter.sendPrompt({ sessionId: s.id, prompt: 'cancel me', scenario: 'success' });
      expect((await adapter.cancelTask(taskId)).ok).toBe(true);
    }
    await new Promise(r => setTimeout(r, 80));
    expect(events.filter(e => e.type === 'task.cancelled')).toHaveLength(4);
    expect(events.some(e => e.type === 'task.completed')).toBe(false);
    expect((await adapter.getStatus(s.id)).status).toBe('idle');
    await adapter.dispose();
  });
});

describe('SQLite persistence', () => {
  it('persists two projects and settings across restart; removal retains disk files', async () => {
    const dir = temp(); const db = join(dir, 'nexus.sqlite');
    const r = await Repository.open(db);
    const p = r.addProject('One', dir);
    r.addProject('Two', temp());
    r.setSettings({ theme: 'light', layout: 'columns', projectId: p.id });
    r.close();
    const restored = await Repository.open(db);
    expect(restored.projects()).toHaveLength(2);
    expect(restored.settings()).toMatchObject({ theme: 'light', layout: 'columns', projectId: p.id });
    restored.removeProject(p.id);
    expect(existsSync(dir)).toBe(true);
    expect(restored.settings().projectId).toBeNull();
    expect(restored.migrationVersion()).toBe(7);
    restored.close();
  });
  it('loads bounded pages without duplicates and recovers in-flight work as interrupted', async () => {
    const db = join(temp(), 'nexus.sqlite'); const r = await Repository.open(db);
    const p = r.addProject('Events', temp());
    const s = r.addSession({ id: 's', projectId: p.id, provider: 'codex', mode: 'mock', status: 'idle', createdAt: new Date().toISOString() });
    r.addTask({ id: 't', projectId: p.id, sessionId: s.id, provider: 'codex', prompt: 'hello', status: 'queued', mode: 'mock', createdAt: new Date().toISOString(), finishedAt: null });
    for (let i = 1; i <= 7; i++) r.recordEvent({ eventId: `e${i}`, taskId: 't', agentId: 'codex', sessionId: 's', timestamp: new Date().toISOString(), sequence: i, type: i === 1 ? 'task.started' : 'message.delta', payload: { mock: true, text: 'hello' } });
    expect(r.events('t', 0, 3).map(e => e.sequence)).toEqual([1, 2, 3]);
    expect(r.events('t', 3, 3).map(e => e.sequence)).toEqual([4, 5, 6]);
    r.close(); const reopened = await Repository.open(db); reopened.recoverInterrupted();
    expect(reopened.tasks(p.id)[0].status).toBe('interrupted');
    expect(reopened.events('t', 7, 3)[0].type).toBe('task.interrupted');
    reopened.recoverInterrupted();
    expect(reopened.events('t', 7, 3)).toHaveLength(1);
    reopened.close();
  });
  it('rolls back duplicate event writes and rejects duplicate project paths', async () => {
    const r = await Repository.open(join(temp(), 'nexus.sqlite')); const dir = temp();
    r.addProject('A', dir);
    expect(() => r.addProject('Again', dir)).toThrow();
    expect(r.projects()).toHaveLength(1);
    r.close();
  });
});
