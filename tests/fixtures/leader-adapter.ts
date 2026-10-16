import { randomUUID } from 'node:crypto';
import { capabilities, type AgentAdapter } from '../../packages/agent-core';
import type { AgentEvent, AgentSession, Provider, SendPromptRequest, StartSessionRequest } from '../../packages/shared';
export class ScriptAdapter implements AgentAdapter {
  sessions = new Map<string, AgentSession>(); listeners = new Map<string, Set<(e: AgentEvent) => void>>(); jobs = new Map<string, { timer: ReturnType<typeof setTimeout>; session: AgentSession; sequence: number }>();
  workerCalls = 0; workerOutput = 'Fixture worker output'; invalid = false; failure = false; delay = 30; planningDelay = 15; startupDelay = 0;
  constructor(readonly id: Provider) {}
  async getCapabilities() { return capabilities(['detect', 'sendPrompt', 'cancel', 'streamEvents', 'leaderEligible']); }
  async detect() { return { id: this.id, state: 'detected' as const, executablePath: null, version: 'offline-fixture', detail: 'Synthetic protocol fixture', probeAt: new Date().toISOString(), capabilities: await this.getCapabilities(), auth: 'authenticated' as const }; }
  async startSession(a: StartSessionRequest) { if (this.startupDelay) await new Promise(r => setTimeout(r, this.startupDelay)); const s: AgentSession = { ...a, id: randomUUID(), provider: this.id, mode: 'mock', status: 'idle', createdAt: new Date().toISOString() }; this.sessions.set(s.id, s); return s; }
  subscribeEvents(id: string, fn: (e: AgentEvent) => void) { const set = this.listeners.get(id) ?? new Set(); set.add(fn); this.listeners.set(id, set); return () => { set.delete(fn); }; }
  emit(taskId: string, type: AgentEvent['type'], text: string) { const job = this.jobs.get(taskId); if (!job) return; this.listeners.get(job.session.id)?.forEach(fn => fn({ eventId: randomUUID(), taskId, sessionId: job.session.id, agentId: this.id, sequence: ++job.sequence, type, timestamp: new Date().toISOString(), payload: { mock: true, text } })); }
  async sendPrompt(a: SendPromptRequest) {
    const p = JSON.parse(a.prompt); const session = this.sessions.get(a.sessionId)!; const id = a.taskId!;
    const timer = setTimeout(() => {
      let response: unknown;
      if (p.role === 'NEXUS_LEADER_PLAN') response = this.invalid ? 'Not a JSON decision' : { runId: p.scope.runId, revision: p.scope.revision, goal: p.scope.goal, tasks: [{ taskId: 'a', title: 'First', instruction: 'First', assignedAgentId: p.scope.workers[0], dependsOn: [], acceptance: ['Evidence'], needsWriteAccess: false, paths: [] }, { taskId: 'b', title: 'Second', instruction: 'Second', assignedAgentId: p.scope.workers[0], dependsOn: ['a'], acceptance: ['Evidence'], needsWriteAccess: false, paths: [] }] };
      else if (p.role === 'NEXUS_LEADER_REVIEW') response = { runId: p.runId, revision: p.revision, verdict: 'passed', summary: 'Fixture review with actual stored event refs', unmet: [] };
      else { this.workerCalls++; response = this.workerOutput; }
      this.emit(id, 'message.delta', typeof response === 'string' ? response : JSON.stringify(response)); this.emit(id, this.failure && p.role === 'NEXUS_WORKER' ? 'task.failed' : 'task.completed', 'fixture terminal'); this.jobs.delete(id);
    }, p.role === 'NEXUS_WORKER' ? this.delay : p.role === 'NEXUS_LEADER_PLAN' ? this.planningDelay : 15);
    this.jobs.set(id, { timer, session, sequence: 0 }); this.emit(id, 'task.started', 'fixture started'); return { taskId: id };
  }
  async cancelTask(id: string) { const job = this.jobs.get(id); if (!job) return { ok: false }; clearTimeout(job.timer); this.emit(id, 'task.cancelled', 'fixture cancellation acknowledged'); this.jobs.delete(id); return { ok: true }; }
  async getStatus(id: string) { return { status: this.sessions.get(id)!.status }; }
  async dispose() { for (const id of this.jobs.keys()) await this.cancelTask(id); }
}
