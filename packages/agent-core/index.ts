import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentCapabilities, AgentEvent, AgentInstallation, AgentSession, Capability, Mode, OperationResult, Provider, SendPromptRequest, SessionStatus, StartSessionRequest } from '../shared';
import { ProcessManager } from './process-manager';
import { CodexAdapter } from './codex';
import { DshAdapter } from './dsh';
import { desktopExecutable } from './installed';
export { ProcessManager } from './process-manager';

export interface AgentAdapter {
  readonly id: Provider;
  detect(): Promise<AgentInstallation>;
  getCapabilities(): Promise<AgentCapabilities>;
  startSession(args: StartSessionRequest): Promise<AgentSession>;
  sendPrompt(args: SendPromptRequest): Promise<{ taskId: string }>;
  subscribeEvents(sessionId: string, handler: (event: AgentEvent) => void): () => void;
  cancelTask(taskId: string): Promise<OperationResult>;
  getStatus(sessionId: string): Promise<SessionStatus>;
  resumeSession?(session: AgentSession, rootPath: string): Promise<AgentSession>;
  respondApproval?(approvalId: string, decision: 'accept' | 'decline'): Promise<OperationResult>;
  dispose(): Promise<void>;
}
const capabilityNames: Capability[] = ['detect', 'sendPrompt', 'streamEvents', 'resumeSession', 'cancel', 'structuredOutput', 'toolApproval', 'fileChanges', 'usage', 'leaderEligible'];
export function capabilities(supported: Capability[]): AgentCapabilities {
  return Object.fromEntries(capabilityNames.map(c => [c, supported.includes(c) ? { supported: true } : { supported: false, reason: 'unsupported' }])) as AgentCapabilities;
}

export class MockAdapter implements AgentAdapter {
  private sessions = new Map<string, AgentSession>();
  private listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private tasks = new Map<string, { sessionId: string; timer: ReturnType<typeof setTimeout> | null; sequence: number; step: number }>();
  constructor(readonly id: Provider, private interval = 650) {}
  async getCapabilities() { return capabilities(['detect', 'sendPrompt', 'streamEvents', 'cancel']); }
  async detect(): Promise<AgentInstallation> {
    return { id: this.id, state: 'detected', executablePath: null, version: 'mock/1', detail: '内置模拟器，不连接真实 Agent', probeAt: new Date().toISOString(), capabilities: await this.getCapabilities() };
  }
  async startSession(args: StartSessionRequest): Promise<AgentSession> {
    const s: AgentSession = { id: randomUUID(), projectId: args.projectId, provider: this.id, mode: 'mock', status: 'idle', createdAt: new Date().toISOString() };
    this.sessions.set(s.id, s); return s;
  }
  subscribeEvents(sessionId: string, handler: (event: AgentEvent) => void) {
    let handlers = this.listeners.get(sessionId);
    if (!handlers) { handlers = new Set(); this.listeners.set(sessionId, handlers); }
    handlers.add(handler);
    return () => { handlers?.delete(handler); if (!handlers?.size) this.listeners.delete(sessionId); };
  }
  private emit(taskId: string, type: AgentEvent['type'], text: string) {
    const t = this.tasks.get(taskId); if (!t) return;
    const e: AgentEvent = { eventId: randomUUID(), taskId, sessionId: t.sessionId, agentId: this.id, timestamp: new Date().toISOString(), sequence: ++t.sequence, type, payload: { mock: true, text } };
    this.listeners.get(t.sessionId)?.forEach(h => h(e));
  }
  async sendPrompt(args: SendPromptRequest) {
    const session = this.sessions.get(args.sessionId);
    if (!session) throw new Error('会话不存在');
    if (session.status === 'running') throw new Error('此 Agent 已有模拟任务运行中');
    const taskId = args.taskId ?? randomUUID();
    if (this.tasks.has(taskId)) throw new Error('重复任务 ID');
    session.status = 'running';
    const t = { sessionId: args.sessionId, timer: null as ReturnType<typeof setTimeout> | null, sequence: 0, step: 0 };
    this.tasks.set(taskId, t);
    const steps: [AgentEvent['type'], string][] = [
      ['task.started', '模拟任务开始；未向任何真实 Provider 发送内容。'],
      ['message.delta', '正在模拟理解目标与检查项目上下文…'],
      ['message.delta', '模拟计划：分析需求 → 组织结果 → 校验终态。'],
      ['message.delta', '这是一段演示事件流。没有执行命令或修改项目文件。'],
      [args.scenario === 'failure' ? 'task.failed' : 'task.completed', args.scenario === 'failure' ? '模拟失败：DEMO_FAILURE，用于验证错误处理。' : '模拟完成：事件流与状态演示已结束。']
    ];
    const tick = () => {
      if (!this.tasks.has(taskId)) return;
      const [type, text] = steps[t.step++]; this.emit(taskId, type, text);
      if (!this.tasks.has(taskId)) return;
      if (t.step < steps.length) t.timer = setTimeout(tick, this.interval);
      else { this.tasks.delete(taskId); session.status = 'idle'; }
    };
    // Asynchronous first event lets the service persist the task before subscription delivery.
    t.timer = setTimeout(tick, this.interval);
    return { taskId };
  }
  async cancelTask(taskId: string): Promise<OperationResult> {
    const t = this.tasks.get(taskId); if (!t) return { ok: false, reason: '任务已结束或不存在' };
    if (t.timer) clearTimeout(t.timer);
    this.emit(taskId, 'task.cancelled', '模拟任务已取消；后续事件计时器已清理。');
    const s = this.sessions.get(t.sessionId); if (s) s.status = 'idle';
    this.tasks.delete(taskId); return { ok: true };
  }
  async getStatus(sessionId: string): Promise<SessionStatus> {
    const s = this.sessions.get(sessionId); if (!s) throw new Error('会话不存在'); return { status: s.status };
  }
  async dispose() {
    for (const id of [...this.tasks.keys()]) await this.cancelTask(id);
    this.listeners.clear(); this.sessions.clear();
  }
}

export class UnconnectedAdapter implements AgentAdapter {
  constructor(readonly id: Provider) {}
  async getCapabilities() { return capabilities(['detect']); }
  async detect(): Promise<AgentInstallation> {
    const command = { codex: 'codex', antigravity: 'agy', dsh: 'dsh', workbuddy: 'workbuddy' }[this.id];
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    const candidates = paths.flatMap(p => extensions.map(ext => join(p.replace(/^"|"$/g, ''), command + ext)));
    const cliPath = candidates.find(p => existsSync(p)) ?? null;
    const guiPath = desktopExecutable(this.id);
    const executablePath = guiPath ?? cliPath;
    let version: string | null = null;
    // Only trusted native Codex binary gets a read-only version probe in M1.
    // Windows command wrappers and other providers await version-specific M2 review.
    if (this.id === 'codex' && executablePath && !/\.(cmd|bat)$/i.test(executablePath)) {
      const manager = new ProcessManager();
      try { const result = await manager.run(executablePath, ['--version'], process.cwd(), 5000); if (result.exitCode === 0) version = result.stdout.trim().slice(0, 200); }
      catch { /* Detection remains usable even if the read-only version probe fails. */ }
      finally { await manager.dispose(); }
    }
    return { id: this.id, executablePath, version, state: executablePath ? 'detected' : 'not_installed', detail: this.id === 'workbuddy' ? guiPath ? 'WorkBuddy 桌面端已安装；可配置本地 MCP 桥接或人工交接，登录和权限由原生应用管理' : '未找到 WorkBuddy 桌面端；不以 CodeBuddy CLI 代替 GUI 接口' : this.id === 'antigravity' ? guiPath ? 'Antigravity 桌面端已安装；本机未发现经过验证的 agy headless CLI，使用人工交接' : '未找到经过验证的 agy CLI；受限接入' : '已发现入口；此 Adapter 未接入真实任务', probeAt: new Date().toISOString(), capabilities: await this.getCapabilities(), auth: 'unknown' };
  }
  async startSession(_args: StartSessionRequest): Promise<AgentSession> { throw new Error('unsupported: 真实 Provider 待 M2 适配'); }
  async sendPrompt(_args: SendPromptRequest): Promise<{ taskId: string }> { throw new Error('unsupported: 真实任务未接入'); }
  subscribeEvents(_sessionId: string, _handler: (event: AgentEvent) => void) { return () => {}; }
  async cancelTask(_taskId: string): Promise<OperationResult> { return { ok: false, reason: 'unsupported' }; }
  async getStatus(_sessionId: string): Promise<SessionStatus> { throw new Error('unsupported'); }
  async dispose() {}
}

export class AgentRegistry {
  private mocks = new Map<Provider, MockAdapter>();
  private real = new Map<Provider, AgentAdapter>();
  constructor(private configDir = join(process.cwd(), '.runtime', 'provider-config')) {}
  get(id: Provider, mode: Mode): AgentAdapter {
    if (mode === 'bridge') throw new Error('桥接由项目服务管理');
    if (mode === 'mock') { if (!this.mocks.has(id)) this.mocks.set(id, new MockAdapter(id)); return this.mocks.get(id)!; }
    if (!this.real.has(id)) this.real.set(id, id === 'codex' ? new CodexAdapter() : id === 'dsh' ? new DshAdapter(this.configDir) : new UnconnectedAdapter(id)); return this.real.get(id)!;
  }
  async dispose() { await Promise.all([...this.mocks.values(), ...this.real.values()].map(a => a.dispose())); }
}
