import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentAdapter } from './index';
import { capabilities } from './index';
import { McpHttpServer, type McpGrant } from './mcp-http';
import { sanitize } from './sanitize';
import type { PairingStore, WorkBuddyPairing } from './workbuddy-pairing';
import type { AgentEvent, AgentInstallation, AgentSession, OperationResult, SendPromptRequest, StartSessionRequest, TaskStatus, WorkBuddyStatus } from '../shared';

const owned = { taskId: z.string().uuid(), lease: z.string().min(32).max(100) };
const schemas = {
  nexus_claim_task: z.object({}).strict(),
  nexus_task_status: z.object(owned).strict(),
  nexus_report_progress: z.object({ ...owned, sequence: z.number().int().min(1).max(1000), text: z.string().min(1).max(8000) }).strict(),
  nexus_report_result: z.object({ ...owned, status: z.enum(['completed', 'failed', 'cancelled']), text: z.string().trim().min(1).max(50000) }).strict()
};
const descriptions: Record<keyof typeof schemas, string> = {
  nexus_claim_task: 'Claim ONE queued task for the paired project. Repeated claim returns your active task. If task is null, stop and ask the user to queue a task; do not poll indefinitely. Confirm rootPath and native permissions before execution.',
  nexus_task_status: 'Check cancellation and renew the task lease. Call before each significant action and at least once every 3 minutes (the lease expires after 5 minutes). Stop work on cancelRequested, interruption, or any tool error.',
  nexus_report_progress: 'Report plain-text progress, renewing the lease. sequence starts at 1 and increases by 1; exact retry is idempotent. Never report credentials.',
  nexus_report_result: 'Report actual completion/failure, or confirm work has stopped with cancelled. If cancellation was requested, completed is rejected. Reports are client-reported, not independent verification. Stop after one task.'
};
type Job = { id: string; session: AgentSession; prompt: string; sequence: number; state: TaskStatus; owner?: string; lease?: string; deadline: number; lastContact?: number; cancelRequested: boolean; cancelDeadline?: number; progressSequence: number; progressDigest?: string; finalDigest?: string; bytes: number };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class WorkBuddyAdapter implements AgentAdapter {
  readonly id = 'workbuddy' as const;
  private grants = new Map<string, McpGrant>();
  private sessions = new Map<string, AgentSession>();
  private listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private jobs = new Map<string, Job>();
  private disposed = false;
  private saved?: WorkBuddyPairing;
  private loaded = false;
  private restoreError?: string;
  private server = new McpHttpServer(Object.entries(schemas).map(([name, schema]) => ({ name, description: descriptions[name as keyof typeof schemas], inputSchema: z.toJSONSchema(schema) })), (project, client, name, args) => this.execute(project, client, name, args), client => { for (const job of this.jobs.values()) if (job.owner === client && this.active(job)) this.finish(job, 'interrupted', 'MCP 会话断开；原生执行状态未知，请在 WorkBuddy 中检查。'); });
  private timer = setInterval(() => this.expire(), 1000);
  constructor(private store?: PairingStore) { this.timer.unref(); }
  private loadPairing() { if (!this.loaded) { this.saved = this.store?.load(); this.loaded = true; } }
  private savePairing(state: WorkBuddyPairing) { if (this.store) { this.store.save(state); this.saved = state; } }
  async restore(projectIds?: string[]) {
    if (this.disposed) throw new Error('桥接已关闭');
    try {
      this.loadPairing();
      if (this.saved && projectIds) {
        const grants = this.saved.grants.filter(g => projectIds.includes(g.projectId));
        if (grants.length !== this.saved.grants.length) this.savePairing({ ...this.saved, grants });
      }
      if (this.saved?.grants.length) {
        await this.server.start(this.saved.port);
        if (this.disposed) throw new Error('桥接已关闭');
        for (const grant of this.saved.grants) { this.grants.set(grant.projectId, grant); this.server.add(grant); }
      }
      this.restoreError = undefined;
    } catch (e) { this.restoreError = e instanceof Error ? e.message : '桥接恢复失败'; throw e; }
  }
  private active(job: Job) { return job.state === 'queued' || job.state === 'running'; }
  private renew(job: Job) { job.lastContact = Date.now(); job.deadline = job.lastContact + 5 * 60_000; }
  async enable(projectId: string) {
    if (this.disposed) throw new Error('桥接已关闭');
    await this.restore();
    await this.server.start();
    if (this.disposed) throw new Error('桥接已关闭');
    if (!this.grants.has(projectId)) {
      if (this.grants.size >= 64) throw new Error('配对数量已达到上限，请撤销闲置项目');
      const grant = { projectId, path: `/mcp/${randomUUID()}`, token: randomBytes(32).toString('hex') };
      this.savePairing({ version: 1, port: this.server.listeningPort, grants: [...this.grants.values(), grant] });
      this.grants.set(projectId, grant); this.server.add(grant);
    }
    return this.status(projectId);
  }
  status(projectId: string): WorkBuddyStatus {
    this.expire(); const grant = this.grants.get(projectId);
    const job = [...this.jobs.values()].find(j => j.session.projectId === projectId && this.active(j));
    const activeTask = job ? { taskId: job.id, status: job.state as 'queued' | 'running', expiresAt: new Date(job.deadline).toISOString(), ...(job.lastContact !== undefined ? { lastContactAt: new Date(job.lastContact).toISOString() } : {}), ...(job.cancelDeadline !== undefined ? { cancelDeadline: new Date(job.cancelDeadline).toISOString() } : {}) } : undefined;
    return { enabled: !!grant, ...(grant ? { url: this.server.url(grant.path) } : {}), ...this.server.status(projectId), cancelRequested: !!job?.cancelRequested, persistence: this.store ? 'encrypted' : 'session', saved: !!this.saved?.grants.some(g => g.projectId === projectId), ...(activeTask ? { activeTask } : {}), ...(this.restoreError ? { error: this.restoreError } : {}) };
  }
  configuration(projectId: string) {
    const grant = this.grants.get(projectId); if (!grant) throw new Error('请先启用项目桥接');
    return JSON.stringify({ mcpServers: { 'agent-nexus-workbuddy': { type: 'http', url: this.server.url(grant.path), headers: { Authorization: `Bearer ${grant.token}` } } } }, null, 2);
  }
  revoke(projectId: string): OperationResult {
    this.loadPairing();
    if (this.saved) this.savePairing({ ...this.saved, grants: this.saved.grants.filter(g => g.projectId !== projectId) });
    const pending = [...this.jobs.values()].some(j => j.session.projectId === projectId && j.state === 'running');
    for (const job of this.jobs.values()) if (job.session.projectId === projectId && this.active(job)) this.finish(job, 'interrupted', '配对已撤销；Nexus 无法确认原生执行已停止，请在 WorkBuddy 中检查。');
    this.grants.delete(projectId); this.server.remove(projectId); if (!this.saved?.grants.length) this.restoreError = undefined;
    return { ok: true, ...(pending ? { reason: '配对已撤销；请到 WorkBuddy 确认原生任务已停止' } : {}) };
  }
  async getCapabilities() { return capabilities(['sendPrompt', 'streamEvents']); }
  async detect(): Promise<AgentInstallation> { return { id: this.id, state: 'unverified', executablePath: null, version: null, detail: '本地 MCP 桥接；原生登录和权限由 WorkBuddy 管理', probeAt: new Date().toISOString(), capabilities: await this.getCapabilities(), auth: 'unknown' }; }
  async startSession(args: StartSessionRequest): Promise<AgentSession> {
    if (this.disposed || !this.grants.has(args.projectId)) throw new Error('请先启用当前项目的 WorkBuddy 桥接');
    const session: AgentSession = { id: randomUUID(), projectId: args.projectId, provider: this.id, mode: 'bridge', status: 'idle', createdAt: new Date().toISOString(), rootPath: args.rootPath }; this.sessions.set(session.id, session); return session;
  }
  subscribeEvents(sessionId: string, handler: (event: AgentEvent) => void) {
    const handlers = this.listeners.get(sessionId) ?? new Set(); handlers.add(handler); this.listeners.set(sessionId, handlers);
    return () => { handlers.delete(handler); if (!handlers.size) this.listeners.delete(sessionId); };
  }
  async sendPrompt(args: SendPromptRequest) {
    const session = this.sessions.get(args.sessionId); if (!session || !this.grants.has(session.projectId) || this.disposed) throw new Error('桥接会话不可用');
    if ([...this.jobs.values()].some(j => j.session.projectId === session.projectId && this.active(j))) throw new Error('WorkBuddy 已有任务运行中');
    const id = args.taskId ?? randomUUID(); if (this.jobs.has(id)) throw new Error('重复任务 ID');
    const job: Job = { id, session, prompt: args.prompt, sequence: 0, state: 'queued', deadline: Date.now() + 10 * 60_000, cancelRequested: false, progressSequence: 0, bytes: 0 };
    session.status = 'running'; this.jobs.set(id, job); this.emit(job, 'bridge.queued', '任务已排队；请在 WorkBuddy 对话中领取。10 分钟未领取将中断。'); return { taskId: id };
  }
  private emit(job: Job, type: AgentEvent['type'], text: string, source: 'bridge' | 'mcp-client' = 'bridge') {
    // Never persist this bridge's pairing credentials or task lease if echoed by a client.
    let cleaned = text; for (const grant of this.grants.values()) cleaned = cleaned.split(grant.token).join('[REDACTED]'); if (job.lease) cleaned = cleaned.split(job.lease).join('[REDACTED]');
    const event: AgentEvent = { eventId: randomUUID(), taskId: job.id, sessionId: job.session.id, agentId: this.id, timestamp: new Date().toISOString(), sequence: ++job.sequence, type, payload: { mock: false, source, text: sanitize(cleaned) as string } };
    this.listeners.get(job.session.id)?.forEach(h => h(event));
  }
  private finish(job: Job, state: 'completed' | 'failed' | 'cancelled' | 'interrupted', text: string, source: 'bridge' | 'mcp-client' = 'bridge') {
    job.state = state; job.session.status = state === 'interrupted' ? 'interrupted' : 'idle'; this.emit(job, `task.${state}`, text, source);
  }
  private expire() {
    for (const job of this.jobs.values()) if (this.active(job) && Date.now() > Math.min(job.deadline, job.cancelDeadline ?? Infinity)) this.finish(job, 'interrupted', '桥接任务或取消确认超时；没有自动重跑，已领取的原生任务可能仍在执行。');
    // Recent terminal jobs only, for bounded idempotent retries; all history lives in SQLite.
    const terminal = [...this.jobs.values()].filter(j => !this.active(j));
    for (const job of terminal.slice(0, Math.max(0, terminal.length - 128))) { this.jobs.delete(job.id); this.sessions.delete(job.session.id); }
  }
  private execute(projectId: string, clientId: string, name: string, input: unknown): unknown {
    this.expire();
    const key = name as keyof typeof schemas;
    const parsed = schemas[key]?.safeParse(input); if (!parsed?.success) throw new Error('工具参数无效');
    if (key === 'nexus_claim_task') {
      const own = [...this.jobs.values()].find(j => j.session.projectId === projectId && j.owner === clientId && this.active(j));
      const job = own ?? [...this.jobs.values()].find(j => j.session.projectId === projectId && j.state === 'queued');
      if (!job) return { task: null };
      if (!own) { job.owner = clientId; job.lease = randomBytes(32).toString('hex'); job.state = 'running'; this.emit(job, 'task.started', 'MCP 客户端已领取；原生登录、权限和模型未独立验证。', 'mcp-client'); }
      if (!this.active(job)) throw new Error('任务记录失败或任务已中断；停止执行');
      this.renew(job);
      return { task: { taskId: job.id, lease: job.lease, prompt: job.prompt, rootPath: job.session.rootPath, cancelRequested: job.cancelRequested, leaseSeconds: 300, permission: 'Confirm in WorkBuddy; Nexus cannot enforce native permissions' } };
    }
    const args = parsed.data as z.infer<typeof schemas.nexus_report_result> & z.infer<typeof schemas.nexus_report_progress>;
    const job = this.jobs.get(args.taskId);
    if (!job || job.session.projectId !== projectId || job.owner !== clientId || job.lease !== args.lease) throw new Error('任务不属于此配对或会话，或租约已失效');
    if (key === 'nexus_task_status') {
      if (this.active(job)) this.renew(job);
      return { status: job.state, cancelRequested: job.cancelRequested, leaseSeconds: this.active(job) ? 300 : 0 };
    }
    const signature = digest(parsed.data);
    if (key === 'nexus_report_result' && job.finalDigest === signature) return { accepted: true, status: job.state };
    if (job.state !== 'running') throw new Error('任务已结束或未领取；停止执行');
    if (key === 'nexus_report_progress') {
      if (args.sequence === job.progressSequence && signature === job.progressDigest) { this.renew(job); return { accepted: true, cancelRequested: job.cancelRequested }; }
      if (args.sequence !== job.progressSequence + 1 || job.bytes + args.text.length > 500_000) throw new Error('进度序号重复、不连续或超出总量限制');
      job.progressSequence = args.sequence; job.progressDigest = signature; job.bytes += args.text.length;
      this.emit(job, 'message.delta', args.text, 'mcp-client');
    } else {
      if (job.cancelRequested && args.status === 'completed') throw new Error('用户已请求取消；请停止原生执行后回传 cancelled，或如实回传 failed');
      this.finish(job, args.status, args.text, 'mcp-client');
      if (this.jobs.get(job.id)?.state === args.status) job.finalDigest = signature;
    }
    if (this.jobs.get(job.id)?.state === 'interrupted') throw new Error('任务记录失败或任务已中断；停止执行');
    if (this.active(job)) this.renew(job); return { accepted: true, status: job.state, cancelRequested: job.cancelRequested };
  }
  async cancelTask(taskId: string): Promise<OperationResult> {
    const job = this.jobs.get(taskId); if (!job || !this.active(job)) return { ok: false, reason: '任务已结束或不存在' };
    if (job.state === 'queued') { this.finish(job, 'cancelled', '排队任务已撤回，未被 MCP 客户端领取。'); return { ok: true }; }
    if (!job.cancelRequested) { job.cancelRequested = true; job.cancelDeadline = Date.now() + 120_000; this.emit(job, 'bridge.cancel_requested', '已请求取消；等待客户端确认。2 分钟未确认将记为中断。必要时请在 WorkBuddy 中停止任务。'); }
    return { ok: true, pending: true, reason: '等待 WorkBuddy 客户端确认取消；Nexus 无法强制停止原生执行' };
  }
  abandon(taskId: string) { const job = this.jobs.get(taskId); if (job) { job.state = 'interrupted'; job.cancelRequested = true; } }
  async getStatus(sessionId: string) { const session = this.sessions.get(sessionId); if (!session) throw new Error('会话不存在'); return { status: session.status }; }
  async dispose() {
    if (this.disposed) return; this.disposed = true; clearInterval(this.timer);
    for (const job of this.jobs.values()) if (this.active(job)) this.finish(job, 'interrupted', 'Nexus 已关闭桥接；原生任务状态未知，没有自动重跑。');
    await this.server.dispose(); this.grants.clear(); this.listeners.clear(); this.sessions.clear(); this.jobs.clear();
  }
}
