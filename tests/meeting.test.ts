import { expect, it } from 'vitest';
import { agendaSchema, conductMeeting, summarySchema, type MeetingPorts, type MeetingState } from '../packages/orchestrator/meeting';

const initial = (): MeetingState => ({ id: 'm', runId: 'r', topic: 'Choose a safe local workflow', leader: 'codex', participants: ['codex', 'dsh'], roundLimit: 2, mode: 'real', status: 'draft', messages: [], createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' });
const agenda = { runId: 'r', topic: 'Choose a safe local workflow', participants: ['codex', 'dsh'], rounds: 2, questions: ['How do we protect user changes?'] };
const summary = { runId: 'r', summary: 'Use isolated workspaces.', consensus: ['Keep user changes.'], disagreements: ['Review cadence.'], taskDrafts: [{ title: 'Draft safeguards', instruction: 'Describe the safeguards for review.', acceptance: ['States the approval boundary.'] }] };
let fixtureSequence = 0;
function fixture(overrides: Partial<MeetingPorts> = {}) {
  const namespace = ++fixtureSequence;
  const calls: { provider: string; prompt: Record<string, unknown>; schema?: object }[] = [];
  const saves: MeetingState[] = [];
  const ports: MeetingPorts = {
    async request(provider, prompt, schema) {
      const p = prompt as Record<string, unknown>; calls.push({ provider, prompt: p, schema });
      return { text: p.phase === 'agenda' ? JSON.stringify(agenda) : p.phase === 'summary' ? JSON.stringify(summary) : `View from ${provider} at ${p.round}`, taskId: `native-${namespace}-${calls.length}`, refs: [`sqlite:event:${calls.length}`], source: 'real' };
    },
    save(state) { saves.push(structuredClone(state)); }, ...overrides
  };
  return { ports, calls, saves };
}

it('runs a bounded read-only meeting and checkpoints each real response with source evidence', async () => {
  const f = fixture(); const result = await conductMeeting(initial(), f.ports);
  expect(result.status).toBe('completed'); expect(result.messages).toHaveLength(4);
  expect(result.messages.map(m => [m.round, m.provider])).toEqual([[1, 'codex'], [1, 'dsh'], [2, 'codex'], [2, 'dsh']]);
  expect(result.messages.every(m => m.source === 'real' && m.nativeTaskId && m.rawEventRefs.length)).toBe(true);
  expect(result.summary).toEqual(summary); expect(f.calls).toHaveLength(6);
  expect(f.calls.every(c => c.prompt.readOnly === true)).toBe(true);
  expect(f.calls[0].schema).toBeDefined(); expect(f.calls.at(-1)?.schema).toBeDefined();
  expect(f.saves.filter(s => s.messages.length > 0).map(s => s.messages.length)).toContain(1);
  expect(initial().messages).toEqual([]);
});

it('stops before the next request and resumes at the next unsaid participant', async () => {
  const f = fixture(); f.ports.canContinue = () => f.calls.length < 2;
  const paused = await conductMeeting(initial(), f.ports);
  expect(paused.status).toBe('interrupted'); expect(paused.messages).toHaveLength(1);
  const next = fixture(); const result = await conductMeeting(paused, next.ports);
  expect(result.status).toBe('completed'); expect(next.calls[0].provider).toBe('dsh');
  expect(next.calls[0].prompt.round).toBe(1); expect(next.calls).toHaveLength(4);
  expect(result.messages[0].nativeTaskId).toBe(paused.messages[0].nativeTaskId);
});

it.each([
  ['participants outside selection', { ...agenda, participants: ['codex', 'workbuddy'] }],
  ['changed topic', { ...agenda, topic: 'A different goal' }],
  ['wrong run', { ...agenda, runId: 'other' }],
  ['too many rounds', { ...agenda, rounds: 3 }],
  ['unknown command key', { ...agenda, command: 'write files' }]
])('blocks an agenda with %s without participant dispatch', async (_, output) => {
  let requests = 0; const f = fixture({ async request() { requests++; return { text: JSON.stringify(output), taskId: 'a', refs: [], source: 'real' }; } });
  const result = await conductMeeting(initial(), f.ports);
  expect(result.status).toBe('blocked'); expect(result.messages).toEqual([]); expect(requests).toBe(1);
});

it.each(['bad json', 'mock source', 'missing task identity', 'native failure'])('does not fabricate completion after %s', async kind => {
  const f = fixture({ async request() {
    if (kind === 'native failure') throw new Error('Bearer confidential-value');
    return { text: kind === 'bad json' ? '```json\n{}\n```' : JSON.stringify(agenda), taskId: kind === 'missing task identity' ? '' : 'a', refs: [], source: kind === 'mock source' ? 'mock' : 'real' };
  } });
  const result = await conductMeeting(initial(), f.ports);
  expect(result.status).toBe('blocked'); expect(result.summary).toBeUndefined(); expect(result.messages).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('confidential-value');
});

it('forwards only sanitized bounded views, without task ids or raw event references', async () => {
  const f = fixture(); const base = f.ports.request;
  f.ports.request = async (provider, prompt, schema) => { const result = await base(provider, prompt, schema); return (prompt as Record<string, unknown>).phase === 'discussion' ? { ...result, text: 'Keep changes. Bearer top-secret sk-abcdefghijklmnopqrst password=hunter2' } : result; };
  const result = await conductMeeting(initial(), f.ports);
  expect(result.status).toBe('completed'); const sent = JSON.stringify(f.calls.slice(2).map(c => c.prompt));
  expect(sent).toContain('[REDACTED]'); expect(sent).not.toContain('top-secret'); expect(sent).not.toContain('hunter2');
  expect(sent).not.toContain('native-'); expect(sent).not.toContain('sqlite:event:');
  expect(sent).toContain('untrusted');
});

it('blocks oversized views instead of silently clipping important viewpoints', async () => {
  const f = fixture(); const base = f.ports.request;
  f.ports.request = async (provider, prompt, schema) => { const reply = await base(provider, prompt, schema); return (prompt as Record<string, unknown>).phase === 'discussion' ? { ...reply, text: 'x'.repeat(2001) } : reply; };
  const result = await conductMeeting(initial(), f.ports);
  expect(result.status).toBe('blocked'); expect(result.messages).toHaveLength(0); expect(f.calls).toHaveLength(2);
});

it('refuses invalid selected participants, round limits and duplicate checkpoints before dispatch', async () => {
  for (const patch of [{ participants: ['codex'] }, { participants: ['codex', 'codex'] }, { roundLimit: 4 }]) {
    const f = fixture(); const result = await conductMeeting({ ...initial(), ...patch } as MeetingState, f.ports);
    expect(result.status).toBe('blocked'); expect(f.calls).toHaveLength(0);
  }
  const f = fixture(); const m = { round: 1, provider: 'codex' as const, text: 'view', source: 'real' as const, nativeTaskId: 'a', rawEventRefs: [], timestamp: initial().createdAt };
  const result = await conductMeeting({ ...initial(), agenda, messages: [m, m] } as MeetingState, f.ports);
  expect(result.status).toBe('blocked'); expect(f.calls).toHaveLength(0);
});

it('does not dispatch if durable storage fails, and does not swallow the storage error', async () => {
  const f = fixture({ save() { throw new Error('disk full'); } });
  await expect(conductMeeting(initial(), f.ports)).rejects.toThrow('disk full'); expect(f.calls).toHaveLength(0);
});

it('strictly rejects executable extra fields in summaries and remains idempotent after completion', async () => {
  expect(() => agendaSchema.parse({ ...agenda, rounds: 0 })).toThrow();
  expect(() => summarySchema.parse({ ...summary, taskDrafts: [{ ...summary.taskDrafts[0], shell: 'whoami' }] })).toThrow();
  const f = fixture(); const done = await conductMeeting(initial(), f.ports); const next = fixture();
  expect(await conductMeeting(done, next.ports)).toEqual(done); expect(next.calls).toHaveLength(0);
});

it.each([{ ...summary, runId: 'other' }, { ...summary, executable: 'write files' }, { ...summary, taskDrafts: [{ ...summary.taskDrafts[0], acceptance: [] }] }])('blocks invalid summary output without losing completed participant evidence', async invalid => {
  const f = fixture(); const base = f.ports.request;
  f.ports.request = async (provider, prompt, schema) => { const reply = await base(provider, prompt, schema); return (prompt as Record<string, unknown>).phase === 'summary' ? { ...reply, text: JSON.stringify(invalid) } : reply; };
  const result = await conductMeeting(initial(), f.ports);
  expect(result.status).toBe('blocked'); expect(result.messages).toHaveLength(4); expect(result.summary).toBeUndefined();
});

it('rejects reused native task identity and preserves the saved agenda', async () => {
  const f = fixture(); const base = f.ports.request;
  f.ports.request = async (provider, prompt, schema) => ({ ...await base(provider, prompt, schema), taskId: 'reused' });
  const result = await conductMeeting(initial(), f.ports);
  expect(result.status).toBe('blocked'); expect(result.agenda).toEqual(agenda); expect(result.messages).toEqual([]);
});

it('checkpoints an in-flight real reply when pause arrives and starts no next task', async () => {
  const f = fixture(); const base = f.ports.request; let enabled = true;
  f.ports.canContinue = () => enabled;
  f.ports.request = async (provider, prompt, schema) => { const reply = await base(provider, prompt, schema); if ((prompt as Record<string, unknown>).phase === 'discussion') enabled = false; return reply; };
  const result = await conductMeeting(initial(), f.ports);
  expect(result.status).toBe('interrupted'); expect(result.messages).toHaveLength(1); expect(f.calls).toHaveLength(2);
  expect(f.saves.at(-1)?.messages[0].text).toBe('View from codex at 1');
});

it('blocks aggregate context overflow without omitting an earlier viewpoint', async () => {
  const f = fixture(); const base = f.ports.request;
  const input = { ...initial(), participants: ['codex', 'dsh', 'workbuddy'], roundLimit: 3 } as MeetingState;
  f.ports.request = async (provider, prompt, schema) => {
    const reply = await base(provider, prompt, schema); const phase = (prompt as Record<string, unknown>).phase;
    return { ...reply, text: phase === 'agenda' ? JSON.stringify({ ...agenda, participants: input.participants, rounds: 3 }) : phase === 'discussion' ? 'v'.repeat(2000) : reply.text };
  };
  const result = await conductMeeting(input, f.ports);
  expect(result.status).toBe('blocked'); expect(result.messages.length).toBeGreaterThan(0);
  expect(result.messages.every(m => m.text.length === 2000)).toBe(true); expect(result.summary).toBeUndefined();
  expect(f.calls.every(c => JSON.stringify(c.prompt).length <= 16000)).toBe(true);
});

it('keeps mock evidence visibly mock and does not confuse it with a real meeting', async () => {
  const f = fixture(); const base = f.ports.request;
  f.ports.request = async (provider, prompt, schema) => ({ ...await base(provider, prompt, schema), source: 'mock' });
  const result = await conductMeeting({ ...initial(), mode: 'mock' }, f.ports);
  expect(result.status).toBe('completed'); expect(result.messages.every(m => m.source === 'mock')).toBe(true);
  expect(result.agendaEvidence?.source).toBe('mock'); expect(result.summaryEvidence?.source).toBe('mock');
});

it('aborts immediately after a response checkpoint cannot be saved', async () => {
  const f = fixture(); f.ports.save = state => { if (state.messages.length) throw new Error('checkpoint IO failure'); };
  await expect(conductMeeting(initial(), f.ports)).rejects.toThrow('checkpoint IO failure');
  expect(f.calls).toHaveLength(2);
});
