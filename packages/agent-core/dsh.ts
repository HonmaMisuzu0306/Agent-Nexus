import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentAdapter } from './index';
import { capabilities } from './index';
import { dshLaunch, desktopExecutable } from './installed';
import { JsonRpcProcess, waitWithin, type Launch, type RpcMessage } from './rpc';
import { ProcessManager } from './process-manager';
import { sanitize } from './sanitize';
import type { AgentSession, AgentEvent, AgentInstallation, SendPromptRequest, StartSessionRequest } from '../shared';

const readonlyPatch = `- id: sandbox-policy
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: ask
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
    defaultPreset: read-only
- id: agent-loop
  config:
    agents: []
`;
interface Run { session: AgentSession; taskId: string; sequence: number; cancelling: boolean; finished: Promise<void>; resolve: () => void }
interface ConfigOption { id: string; currentValue: string }
export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh' as const;
  private connections = new Map<string, JsonRpcProcess>();
  private sessions = new Map<string, AgentSession>();
  private runs = new Map<string, Run>();
  private listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private verified = false;
  constructor(private configDir: string, private launchOverride?: Launch) {}
  async getCapabilities() { return capabilities(this.verified ? ['detect', 'sendPrompt', 'streamEvents', 'resumeSession', 'cancel', 'leaderEligible'] : ['detect']); }
  private launch() {
    const launch = this.launchOverride ?? dshLaunch(); if (!launch) throw new Error('未找到已核实的 DSH 原生入口');
    if (this.launchOverride) return launch;
    mkdirSync(this.configDir, { recursive: true }); const patch = resolve(this.configDir, 'dsh-readonly.yml'); writeFileSync(patch, readonlyPatch, 'utf8');
    return { ...launch, args: [...launch.args, '--profile', 'acp', '--patch', patch] };
  }
  private async connect(cwd: string) {
    const rpc = new JsonRpcProcess(this.launch(), cwd);
    try {
      const response = await rpc.request<{ protocolVersion: number; agentInfo: { name: string }; agentCapabilities: { sessionCapabilities?: { resume?: object } } }>('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Agent Nexus', version: '0.2.0' } });
      if (response.protocolVersion !== 1 || response.agentInfo?.name !== 'deepseek-harness-acp' || !response.agentCapabilities?.sessionCapabilities?.resume) throw new Error('DSH ACP 协议能力不匹配');
      return rpc;
    } catch (error) { await rpc.dispose(); throw error; }
  }
  async detect(): Promise<AgentInstallation> {
    const launch = this.launchOverride ?? dshLaunch(); const executablePath = launch?.executable ?? desktopExecutable('dsh'); let version: string | null = null;
    let detail = executablePath ? '桌面端已安装；未找到可核实的 ACP 入口' : '未找到 DSH 桌面端或 CLI';
    this.verified = false;
    if (launch) {
      const manager = new ProcessManager();
      try {
        if (!this.launchOverride) { const response = await manager.run(launch.executable, [...launch.args, '--version'], process.cwd(), 5000, launch.env); version = response.stdout.trim(); if (version !== '0.2.0-rc.2') throw new Error('此安装版本尚未核实权限配置'); }
        const rpc = await this.connect(process.cwd()); await rpc.dispose(); this.verified = true;
        detail = 'ACP 已验证；只读，扩权请求自动拒绝。上游模型授权未知，以实际请求结果为准';
      } catch (error) { detail = `已安装，ACP 探测失败：${error instanceof Error ? error.message : '未知'}`; }
      finally { await manager.dispose(); }
    }
    return { id: this.id, executablePath, version, state: executablePath ? 'detected' : 'not_installed', detail, probeAt: new Date().toISOString(), capabilities: await this.getCapabilities(), auth: 'unknown' };
  }
  private attach(session: AgentSession, rpc: JsonRpcProcess) {
    this.sessions.set(session.id, session); this.connections.set(session.id, rpc);
    rpc.onMessage = message => this.handle(session.id, message);
    rpc.onClose = error => { this.connections.delete(session.id); for (const run of [...this.runs.values()]) if (run.session.id === session.id) this.finish(run, 'task.failed', error.message); };
  }
  async startSession(args: StartSessionRequest) {
    if (args.sandbox && args.sandbox !== 'read-only') throw new Error('DSH 当前只支持只读；扩权审批不可可靠展示，不能允许写入');
    if (!this.verified) await this.detect(); if (!this.verified) throw new Error('DSH ACP 尚未验证');
    // Keep at most one idle server. Active sessions remain isolated in their own processes.
    for (const [id, connection] of [...this.connections]) if (!this.runs.size || ![...this.runs.values()].some(r => r.session.id === id)) {
      const old = this.sessions.get(id); if (old) await connection.request('session/close', { sessionId: old.externalSessionId }).catch(() => {});
      this.connections.delete(id); await connection.dispose();
    }
    const cwd = realpathSync(args.rootPath); const rpc = await this.connect(cwd);
    try {
      const result = await rpc.request<{ sessionId: string; configOptions?: ConfigOption[] }>('session/new', { cwd, mcpServers: [] });
      if (!result.sessionId) throw new Error('ACP 返回缺少会话 ID');
      const session: AgentSession = { id: randomUUID(), projectId: args.projectId, rootPath: cwd, sandbox: 'read-only', mode: 'real', provider: this.id, status: 'idle', createdAt: new Date().toISOString(), externalSessionId: result.sessionId, model: result.configOptions?.find(o => o.id === 'model')?.currentValue };
      this.attach(session, rpc); return session;
    } catch (error) { await rpc.dispose(); throw error; }
  }
  async resumeSession(session: AgentSession, rootPath: string) {
    if (session.provider !== this.id || session.mode !== 'real' || !session.externalSessionId || !session.rootPath || realpathSync(rootPath).toLowerCase() !== realpathSync(session.rootPath).toLowerCase() || session.sandbox !== 'read-only') throw new Error('会话不属于此项目的只读 DSH 会话');
    if ([...this.runs.values()].some(r => r.session.id === session.id)) throw new Error('会话仍在运行');
    const existing = this.connections.get(session.id); if (existing) { await existing.request('session/close', { sessionId: session.externalSessionId }); await existing.dispose(); }
    if (!this.verified) await this.detect(); if (!this.verified) throw new Error('DSH ACP 尚未验证');
    const rpc = await this.connect(rootPath);
    try {
      const result = await rpc.request<{ configOptions?: ConfigOption[] }>('session/resume', { sessionId: session.externalSessionId, cwd: realpathSync(rootPath), mcpServers: [] });
      const restored = { ...session, status: 'idle' as const, model: result.configOptions?.find(o => o.id === 'model')?.currentValue ?? session.model }; this.attach(restored, rpc); return restored;
    } catch (error) { await rpc.dispose(); throw error; }
  }
  subscribeEvents(id: string, handler: (event: AgentEvent) => void) { const set = this.listeners.get(id) ?? new Set(); set.add(handler); this.listeners.set(id, set); return () => { set.delete(handler); if (!set.size) this.listeners.delete(id); }; }
  private emit(run: Run, type: AgentEvent['type'], text: string, native?: unknown) {
    const eventId = randomUUID(); const event: AgentEvent = { eventId, taskId: run.taskId, sessionId: run.session.id, agentId: this.id, sequence: ++run.sequence, timestamp: new Date().toISOString(), type, payload: sanitize({ text, mock: false, ...(native ? { native } : {}) }) as AgentEvent['payload'], ...(native ? { rawRef: `sqlite:event:${eventId}` } : {}) };
    this.listeners.get(run.session.id)?.forEach(h => h(event));
  }
  private finish(run: Run, type: 'task.completed' | 'task.failed' | 'task.cancelled', text: string, native?: unknown) { if (!this.runs.has(run.taskId)) return; this.runs.delete(run.taskId); run.session.status = 'idle'; this.emit(run, type, text, native); run.resolve(); }
  private handle(sessionId: string, message: RpcMessage) {
    const run = [...this.runs.values()].find(r => r.session.id === sessionId); const rpc = this.connections.get(sessionId); const p = message.params ?? {};
    if (message.id !== undefined && message.method) {
      if (message.method === 'session/request_permission') { rpc?.send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } }); if (run) this.emit(run, 'tool.result', '已拒绝 DSH 扩权请求：ACP 未提供足以核对的命令/目录；保持只读'); }
      else rpc?.send({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } }); return;
    }
    if (!run || p.sessionId !== run.session.externalSessionId || message.method !== 'session/update') return;
    const update = p.update as { sessionUpdate: string; content?: { type: string; text?: string }; title?: string; status?: string; toolCallId?: string };
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') this.emit(run, 'message.delta', update.content.text ?? '', p);
    else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') this.emit(run, update.sessionUpdate === 'tool_call' ? 'tool.request' : 'tool.result', `${update.title ?? update.toolCallId ?? '工具'} · ${update.status ?? ''}`, p);
  }
  async sendPrompt(args: SendPromptRequest) {
    const session = this.sessions.get(args.sessionId); const rpc = this.connections.get(args.sessionId); if (!session || !rpc) throw new Error('DSH 会话未连接');
    if (session.status === 'running') throw new Error('DSH 会话已有任务运行中');
    const taskId = args.taskId ?? randomUUID(); let done = () => {}; const finished = new Promise<void>(resolve => { done = resolve; });
    const run: Run = { session, taskId, sequence: 0, cancelling: false, finished, resolve: done }; this.runs.set(taskId, run); session.status = 'running';
    this.emit(run, 'task.started', `真实 DSH 任务开始 · ${session.model ?? '原生默认模型'} · 只读`);
    // ACP prompt response is the semantic terminal. Do not block the IPC call on inference.
    void rpc.request<{ stopReason: string }>('session/prompt', { sessionId: session.externalSessionId, prompt: [{ type: 'text', text: args.prompt }] }, 180000).then(result => {
      if (result.stopReason === 'end_turn') this.finish(run, 'task.completed', '原生 ACP end_turn：任务完成', result);
      else if (result.stopReason === 'cancelled') this.finish(run, run.cancelling ? 'task.cancelled' : 'task.failed', '原生 ACP 任务停止', result);
      else this.finish(run, 'task.failed', `原生 ACP 终态：${result.stopReason}`, result);
    }).catch(error => { this.finish(run, 'task.failed', error instanceof Error ? error.message : '原生请求失败'); if (this.connections.get(session.id) === rpc) { this.connections.delete(session.id); void rpc.dispose(); } });
    return { taskId };
  }
  async cancelTask(taskId: string) {
    const run = this.runs.get(taskId); if (!run) return { ok: false, reason: '任务已结束' }; run.cancelling = true;
    const rpc = this.connections.get(run.session.id);
    try { rpc?.send({ method: 'session/cancel', params: { sessionId: run.session.externalSessionId } }); await waitWithin(run.finished, 3000); } catch { /* Cleanup below */ }
    if (this.runs.has(taskId)) { this.finish(run, 'task.cancelled', 'ACP 未及时确认，已终止本会话原生进程树'); await rpc?.dispose(); }
    return { ok: true };
  }
  async getStatus(id: string) { const session = this.sessions.get(id); if (!session) throw new Error('会话不存在'); return { status: session.status }; }
  async dispose() { for (const id of [...this.runs.keys()]) await this.cancelTask(id); await Promise.all([...this.connections.values()].map(rpc => rpc.dispose())); this.connections.clear(); this.sessions.clear(); this.listeners.clear(); }
}
