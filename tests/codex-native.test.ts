import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../packages/agent-core/codex';
import type { AgentEvent, AgentSession } from '../packages/shared';

it.skipIf(process.env.NEXUS_TEST_NATIVE !== '1')('native Codex: completion, restart/resume and interrupt in an empty isolated project', async () => {
  const root = resolve('.runtime'); mkdirSync(root, { recursive: true });
  const testRoot = mkdtempSync(join(root, 'native codex ')); const project = join(testRoot, 'empty project'); mkdirSync(project);
  const report: Record<string, unknown> = { testRoot, checks: [], status: 'RUNNING' };
  let adapter = new CodexAdapter();
  async function task(session: AgentSession, prompt: string, cancel = false) {
    const events: AgentEvent[] = []; let done = () => {};
    const finished = new Promise<void>(resolve => { done = resolve; });
    const unsubscribe = adapter.subscribeEvents(session.id, e => { events.push(e); if (['task.completed', 'task.failed', 'task.cancelled'].includes(e.type)) done(); });
    const result = await adapter.sendPrompt({ sessionId: session.id, prompt, scenario: 'success' });
    if (cancel) await adapter.cancelTask(result.taskId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([finished, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Native task did not terminate within 90 seconds')), 90000); })]); }
    finally { if (timer) clearTimeout(timer); unsubscribe(); }
    return events;
  }
  try {
    const installation = await adapter.detect(); report.installation = installation;
    expect(installation.auth).toBe('authenticated');
    const session = await adapter.startSession({ projectId: 'native-test', rootPath: project }); report.session = session;
    const first = await task(session, 'Do not use any tools, inspect files, or call other agents. Reply with exactly NEXUS_M2_OK.'); report.completion = first;
    expect(first.at(-1)?.type).toBe('task.completed'); expect(first.filter(e => e.type === 'message.delta').map(e => e.payload.text).join('')).toContain('NEXUS_M2_OK');
    await adapter.dispose(); adapter = new CodexAdapter();
    const restored = await adapter.resumeSession(session, project);
    const next = await task(restored, 'Do not use any tools or inspect files. Repeat the exact text from your preceding response.'); report.resume = next;
    expect(next.at(-1)?.type).toBe('task.completed'); expect(next.filter(e => e.type === 'message.delta').map(e => e.payload.text).join('')).toContain('NEXUS_M2_OK');
    const interrupted = await task(restored, 'Do not use tools. Write the integers from 1 to 3000, one per line.', true); report.cancel = interrupted;
    expect(interrupted.at(-1)?.type).toBe('task.cancelled'); report.status = 'PASSED';
  } catch (error) { report.status = 'FAILED'; report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { await adapter.dispose(); mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/codex-native-report.json', JSON.stringify(report, null, 2)); }
}, 240000);
