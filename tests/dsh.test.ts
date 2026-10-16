import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DshAdapter } from '../packages/agent-core/dsh';
import type { AgentEvent } from '../packages/shared';
const dirs: string[] = []; const adapters: DshAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.dispose(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
async function setup(prompt: string) {
  const root = mkdtempSync(join(tmpdir(), 'Nexus DSH 中文 ')); dirs.push(root);
  const adapter = new DshAdapter(root, { executable: process.execPath, args: [resolve('tests/fixtures/dsh-server.mjs')] }); adapters.push(adapter);
  expect((await adapter.detect()).capabilities.sendPrompt.supported).toBe(true);
  await expect(adapter.startSession({ projectId: 'p', rootPath: root, sandbox: 'workspace-write' })).rejects.toThrow('只读');
  const session = await adapter.startSession({ projectId: 'p', rootPath: root });
  const events: AgentEvent[] = []; const done = new Promise<void>(resolve => adapter.subscribeEvents(session.id, e => { events.push(e); if (['task.completed', 'task.failed', 'task.cancelled'].includes(e.type)) resolve(); }));
  const { taskId } = await adapter.sendPrompt({ sessionId: session.id, prompt, scenario: 'success' }); return { adapter, root, session, events, done, taskId };
}
it('uses ACP end_turn, committed output and persisted own-session resume', async () => {
  const r = await setup('hello'); await r.done;
  expect(r.events.at(-1)?.type).toBe('task.completed'); expect(r.events.find(e => e.type === 'message.delta')?.payload.text).toBe('DSH 真实中文');
  expect((await r.adapter.resumeSession(r.session, r.root)).externalSessionId).toBe(r.session.externalSessionId);
});
it.each(['fail', 'exit', 'permission'])('maps %s to failure and never approves opaque permission', async prompt => {
  const r = await setup(prompt); await r.done; expect(r.events.at(-1)?.type).toBe('task.failed');
});
it('cancels the correlated ACP prompt without a late success', async () => {
  const r = await setup('wait'); await r.adapter.cancelTask(r.taskId); await r.done;
  expect(r.events.at(-1)?.type).toBe('task.cancelled'); expect((await r.adapter.getStatus(r.session.id)).status).toBe('idle');
});
