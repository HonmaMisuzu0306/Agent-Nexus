import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DshAdapter } from '../packages/agent-core/dsh';
import type { AgentEvent } from '../packages/shared';
it.skipIf(process.env.NEXUS_TEST_NATIVE !== '1')('native DSH: verified ACP completion, restart/resume, cancellation in an empty project', async () => {
  const root = resolve('.runtime'); mkdirSync(root, { recursive: true }); const testRoot = mkdtempSync(join(root, 'native dsh ')); const project = join(testRoot, 'empty project'); mkdirSync(project);
  const report: Record<string, unknown> = { testRoot, status: 'RUNNING' }; let adapter = new DshAdapter(join(testRoot, 'config'));
  async function run(sessionId: string, prompt: string, cancel = false) {
    const events: AgentEvent[] = []; let done = () => {}; const finished = new Promise<void>(resolve => { done = resolve; });
    const unsubscribe = adapter.subscribeEvents(sessionId, e => { events.push(e); if (['task.completed', 'task.failed', 'task.cancelled'].includes(e.type)) done(); });
    const task = await adapter.sendPrompt({ sessionId, prompt, scenario: 'success' }); if (cancel) await adapter.cancelTask(task.taskId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([finished, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Native DSH task timeout')), 90000); })]); } finally { if (timer) clearTimeout(timer); unsubscribe(); }
    return events;
  }
  try {
    const installation = await adapter.detect(); report.installation = installation; expect(installation.capabilities.sendPrompt.supported).toBe(true);
    const session = await adapter.startSession({ projectId: 'native-dsh', rootPath: project }); report.session = session;
    const first = await run(session.id, 'Do not use tools, inspect files, call agents or access the web. Reply with exactly NEXUS_DSH_OK.'); report.completion = first;
    expect(first.at(-1)?.type).toBe('task.completed'); expect(first.filter(e => e.type === 'message.delta').map(e => e.payload.text).join('')).toContain('NEXUS_DSH_OK');
    await adapter.dispose(); adapter = new DshAdapter(join(testRoot, 'config'));
    const restored = await adapter.resumeSession(session, project);
    const next = await run(restored.id, 'Do not use tools. Repeat your previous exact response.'); report.resume = next; expect(next.at(-1)?.type).toBe('task.completed');
    expect(next.filter(e => e.type === 'message.delta').map(e => e.payload.text).join('')).toContain('NEXUS_DSH_OK');
    const cancelled = await run(restored.id, 'Do not use tools. Count integers from 1 to 3000 on separate lines.', true); report.cancel = cancelled; expect(cancelled.at(-1)?.type).toBe('task.cancelled'); report.status = 'PASSED';
  } catch (error) { report.status = 'FAILED'; report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { await adapter.dispose(); mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/dsh-native-report.json', JSON.stringify(report, null, 2)); }
}, 240000);
