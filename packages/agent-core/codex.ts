import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import type { AgentAdapter } from './index';
import { capabilities } from './index';
import { ProcessManager } from './process-manager';
import { JsonRpcProcess, waitWithin, type Launch, type RpcMessage } from './rpc';
import { sanitize } from './sanitize';
import { appVersion } from '../shared/constants';
import type { AgentEvent, AgentInstallation, AgentSession, Approval, SendPromptRequest, StartSessionRequest, Usage } from '../shared';

interface NativeThread { thread: { id: string }; cwd: string; model: string; sandbox: { type: string }; approvalPolicy: unknown; approvalsReviewer: string }
interface NativeItem { id: string; type: string; command?: string; aggregatedOutput?: string; changes?: { path: string; diff?: string }[] }
interface Run { taskId: string; session: AgentSession; sequence: number; turnId?: string; cancelling: boolean; delta: string; timer?: ReturnType<typeof setTimeout>; resolve: () => void; finished: Promise<void>; items: Map<string, NativeItem> }
export function findCodex(): string | null {
  const nativeFile = (file: string) => { try { return isAbsolute(file) && statSync(file).isFile(); } catch { return false; } };
  const onPath = (process.env.PATH ?? '').split(delimiter).filter(p => p.trim()).map(p => join(p.trim().replace(/^"|"$/g, ''), process.platform === 'win32' ? 'codex.exe' : 'codex')).find(nativeFile);
  if (onPath) return onPath;
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  // Desktop launches do not inherit Codex's injected PATH. Use its installed
  // native CLI, preserving PATH priority and the no-shell-wrapper boundary.
  const bin = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  if (!isAbsolute(bin)) return null;
  try {
    const candidates = [join(bin, 'codex.exe'), ...readdirSync(bin, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(bin, e.name, 'codex.exe'))];
    return candidates.flatMap(file => { try { const stat = statSync(file); return stat.isFile() ? [{ file, modified: stat.mtimeMs }] : []; } catch { return []; } }).sort((a, b) => b.modified - a.modified)[0]?.file ?? null;
  } catch { return null; }
}
function within(root: string, path: string) { const rel = relative(realpathSync(root), realpathSync(path)); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); }
function samePath(a: string, b: string) { const x = realpathSync(a); const y = realpathSync(b); return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; }
function fileWithin(root: string, path: string) {
  const target = resolvePath(root, path); const rel = relative(realpathSync(root), target);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  let ancestor = target; while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) return false; ancestor = parent; }
  return within(root, ancestor);
}
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  private rpc?: JsonRpcProcess;
  private connecting?: Promise<JsonRpcProcess>;
  private sessions = new Map<string, AgentSession>();
  private runs = new Map<string, Run>();
  private listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private approvals = new Map<string, { run: Run; rpcId: string | number; approval: Approval; responding: boolean }>();
  private auth: 'authenticated' | 'needs_auth' | 'unknown' = 'unknown';
  constructor(private launch?: Launch) {}
  async getCapabilities() {
    const c = capabilities(['detect', 'sendPrompt', 'streamEvents', 'resumeSession', 'cancel', 'toolApproval', 'fileChanges', 'usage', 'structuredOutput', 'leaderEligible']);
    if (!this.launch && !findCodex()) for (const [key, value] of Object.entries(c)) if (key !== 'detect') Object.assign(value, { supported: false, reason: 'not_installed' });
    if (this.auth === 'needs_auth') { c.sendPrompt = { supported: false, reason: 'needs_auth' }; c.resumeSession = { supported: false, reason: 'needs_auth' }; }
    return c;
  }
  private async connect(cwd: string) {
    if (this.rpc) return this.rpc;
    if (this.connecting) return this.connecting;
    const connecting = (async () => {
      const executable = findCodex(); if (!this.launch && !executable) throw new Error('未发现原生 Codex CLI');
      const rpc = new JsonRpcProcess(this.launch ?? { executable: executable!, args: ['app-server', '--listen', 'stdio://'] }, cwd);
      rpc.onMessage = m => this.handle(m);
      rpc.onClose = error => { if (this.rpc === rpc) this.rpc = undefined; for (const run of [...this.runs.values()]) this.finish(run, 'task.failed', error.message); };
      try {
        await rpc.request('initialize', { clientInfo: { name: 'agent_nexus', title: 'Agent Nexus', version: appVersion }, capabilities: null });
        rpc.send({ method: 'initialized' });
        const account = await rpc.request<{ account: unknown; requiresOpenaiAuth: boolean }>('account/read', { refreshToken: false });
        this.auth = account.account || !account.requiresOpenaiAuth ? 'authenticated' : 'needs_auth';
        this.rpc = rpc; return rpc;
      } catch (error) { await rpc.dispose(); throw error; }
    })();
    this.connecting = connecting;
    try { return await connecting; } finally { this.connecting = undefined; }
  }
  async detect(): Promise<AgentInstallation> {
    const executablePath = this.launch?.executable ?? findCodex(); let version: string | null = null; let detail = '未发现原生 Codex CLI';
    if (executablePath) {
      const manager = new ProcessManager();
      try {
        if (!this.launch) { const result = await manager.run(executablePath, ['--version'], process.cwd()); version = result.stdout.trim().slice(0, 200); }
        const rpc = await this.connect(process.cwd());
        const account = await rpc.request<{ account: unknown; requiresOpenaiAuth: boolean }>('account/read', { refreshToken: false });
        this.auth = account.account || !account.requiresOpenaiAuth ? 'authenticated' : 'needs_auth';
        detail = this.auth === 'authenticated' ? 'App Server 已连接；原生登录。只读会话拒绝扩权；项目写入需 Git 和单次审批' : '需要先在原生 Codex 登录，再重新检测';
      } catch (error) { detail = `入口已发现，协议探测失败：${error instanceof Error ? error.message : '未知错误'}`; this.auth = 'unknown'; }
      finally { await manager.dispose(); }
    }
    const c = await this.getCapabilities();
    if (this.auth === 'unknown') for (const [key, value] of Object.entries(c)) if (key !== 'detect') Object.assign(value, { supported: false, reason: 'unsupported' });
    return { id: this.id, executablePath, version, detail, state: executablePath ? 'detected' : 'not_installed', probeAt: new Date().toISOString(), capabilities: c, auth: this.auth };
  }
  private validateThread(response: NativeThread, root: string, sandbox: AgentSession['sandbox']) {
    if (!response.thread?.id || !samePath(response.cwd, root) || response.sandbox?.type !== (sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly') || response.approvalPolicy !== 'on-request' || response.approvalsReviewer !== 'user') throw new Error('原生会话未采用请求的目录或权限策略，已拒绝发送');
  }
  async startSession(args: StartSessionRequest): Promise<AgentSession> {
    const root = realpathSync(args.rootPath); const sandbox = args.sandbox ?? 'read-only';
    const rpc = await this.connect(root); if (this.auth !== 'authenticated') throw new Error('请先在原生 Codex 登录');
    const response = await rpc.request<NativeThread>('thread/start', { cwd: root, sandbox, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    this.validateThread(response, root, sandbox);
    const session: AgentSession = { id: randomUUID(), projectId: args.projectId, provider: this.id, mode: 'real', status: 'idle', createdAt: new Date().toISOString(), externalSessionId: response.thread.id, rootPath: root, sandbox, model: response.model };
    this.sessions.set(session.id, session); return session;
  }
  async resumeSession(session: AgentSession, rootPath: string) {
    if (session.provider !== this.id || session.mode !== 'real' || !session.externalSessionId || !session.rootPath || !samePath(session.rootPath, rootPath) || !session.sandbox) throw new Error('会话不属于当前项目或缺少可恢复的原生 ID');
    if ([...this.runs.values()].some(r => r.session.id === session.id)) throw new Error('会话仍在运行');
    const rpc = await this.connect(rootPath);
    const response = await rpc.request<NativeThread>('thread/resume', { threadId: session.externalSessionId, cwd: realpathSync(rootPath), sandbox: session.sandbox, approvalPolicy: 'on-request', approvalsReviewer: 'user', excludeTurns: true });
    this.validateThread(response, rootPath, session.sandbox);
    if (response.thread.id !== session.externalSessionId) throw new Error('原生恢复返回了不同的会话 ID');
    const restored = { ...session, model: response.model, status: 'idle' as const }; this.sessions.set(session.id, restored); return restored;
  }
  subscribeEvents(sessionId: string, handler: (event: AgentEvent) => void) {
    const set = this.listeners.get(sessionId) ?? new Set(); set.add(handler); this.listeners.set(sessionId, set);
    return () => { set.delete(handler); if (!set.size) this.listeners.delete(sessionId); };
  }
  private emit(run: Run, type: AgentEvent['type'], payload: AgentEvent['payload'], native?: unknown) {
    const eventId = randomUUID();
    const event: AgentEvent = { eventId, taskId: run.taskId, sessionId: run.session.id, agentId: this.id, timestamp: new Date().toISOString(), sequence: ++run.sequence, type, payload: sanitize({ ...payload, mock: false, ...(native ? { native } : {}) }) as AgentEvent['payload'], ...(native ? { rawRef: `sqlite:event:${eventId}` } : {}) };
    this.listeners.get(run.session.id)?.forEach(h => h(event));
  }
  private flush(run: Run) {
    if (run.timer) clearTimeout(run.timer); run.timer = undefined;
    if (run.delta) { const text = run.delta; run.delta = ''; this.emit(run, 'message.delta', { text }); }
  }
  private finish(run: Run, type: 'task.completed' | 'task.failed' | 'task.cancelled', text: string, native?: unknown) {
    if (!this.runs.has(run.taskId)) return;
    this.flush(run);
    this.runs.delete(run.taskId); run.session.status = 'idle';
    for (const [id, pending] of this.approvals) if (pending.run === run) { this.approvals.delete(id); try { this.rpc?.send({ id: pending.rpcId, result: { decision: 'cancel' } }); } catch { /* server already closed */ } }
    this.emit(run, type, { text }, native); run.resolve();
  }
  async sendPrompt(args: SendPromptRequest) {
    const session = this.sessions.get(args.sessionId); if (!session || !this.rpc) throw new Error('原生会话不存在或连接已断开');
    if (session.status === 'running') throw new Error('此会话已有任务运行中');
    const taskId = args.taskId ?? randomUUID(); let resolve = () => {};
    const finished = new Promise<void>(done => { resolve = done; });
    const run: Run = { taskId, session, sequence: 0, cancelling: false, delta: '', resolve, finished, items: new Map() };
    this.runs.set(taskId, run); session.status = 'running';
    this.emit(run, 'task.started', { text: `真实 Codex 任务开始 · ${session.model ?? '原生默认模型'} · ${session.sandbox}`, model: session.model });
    try {
      const response = await this.rpc.request<{ turn: { id: string } }>('turn/start', { threadId: session.externalSessionId, input: [{ type: 'text', text: args.prompt, text_elements: [] }], cwd: session.rootPath, approvalPolicy: 'on-request', approvalsReviewer: 'user', ...(args.outputSchema ? { outputSchema: args.outputSchema } : {}), sandboxPolicy: session.sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [session.rootPath], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: 'readOnly', networkAccess: false } });
      run.turnId = response.turn.id;
    } catch (error) { this.finish(run, 'task.failed', error instanceof Error ? error.message : '请求失败'); const rpc = this.rpc; this.rpc = undefined; await rpc?.dispose(); }
    return { taskId };
  }
  private handle(message: RpcMessage) {
    const p = message.params ?? {};
    const run = [...this.runs.values()].find(r => r.session.externalSessionId === p.threadId);
    if (!run) { if (message.id !== undefined && message.method) this.rpc?.send({ id: message.id, error: { code: -32601, message: 'No active Nexus task for this request' } }); return; }
    if (p.turnId && run.turnId && p.turnId !== run.turnId) return;
    if (message.method === 'turn/started') { const turn = p.turn as { id: string }; run.turnId = turn.id; return; }
    if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      run.delta += p.delta; if (!run.timer) run.timer = setTimeout(() => this.flush(run), 100); return;
    }
    this.flush(run);
    if (message.method === 'turn/completed') {
      const turn = p.turn as { id: string; status: string; error?: { message: string } };
      if (run.turnId && turn.id !== run.turnId) return;
      if (turn.status === 'completed') this.finish(run, 'task.completed', '原生 turn/completed：任务完成', p);
      else if (turn.status === 'interrupted') this.finish(run, run.cancelling ? 'task.cancelled' : 'task.failed', run.cancelling ? '原生任务已停止' : '原生任务意外中断', p);
      else this.finish(run, 'task.failed', turn.error?.message ?? `原生终态：${turn.status}`, p);
    } else if (message.id !== undefined && message.method) {
      const kind = message.method === 'item/commandExecution/requestApproval' ? 'command' : message.method === 'item/fileChange/requestApproval' ? 'file' : null;
      let scoped = false;
      const changes = typeof p.itemId === 'string' ? run.items.get(p.itemId)?.changes : undefined;
      try { scoped = kind === 'command' ? run.session.sandbox === 'workspace-write' && (!p.kind || p.kind === 'command') && typeof p.command === 'string' && typeof p.cwd === 'string' && within(run.session.rootPath!, p.cwd) && !p.networkApprovalContext && !p.environmentId : kind === 'file' && run.session.sandbox === 'workspace-write' && !!changes?.length && changes.every(c => typeof c.path === 'string' && fileWithin(run.session.rootPath!, c.path)) && (!p.grantRoot || typeof p.grantRoot === 'string' && within(run.session.rootPath!, p.grantRoot)); } catch { scoped = false; }
      if (!kind || !scoped || run.cancelling) {
        this.rpc?.send(kind ? { id: message.id, result: { decision: 'decline' } } : { id: message.id, error: { code: -32601, message: 'Unsupported permission or interactive request; Nexus does not grant it' } });
        this.emit(run, 'tool.result', { text: '原生交互或项目外扩权请求已拒绝；此权限不在当前会话范围内' }); return;
      }
      const approval: Approval = { id: randomUUID(), taskId: run.taskId, kind, command: typeof p.command === 'string' ? p.command : changes?.map(c => `${c.path}\n${c.diff ?? '原生未提供 diff，请先在项目中核对'}`).join('\n'), cwd: typeof p.cwd === 'string' ? p.cwd : run.session.rootPath, reason: typeof p.reason === 'string' ? p.reason : '原生 Agent 请求单次批准', status: 'pending', createdAt: new Date().toISOString() };
      this.approvals.set(approval.id, { run, rpcId: message.id, approval, responding: false });
      this.emit(run, 'approval.required', { text: approval.reason, approval }, p);
    } else if (message.method === 'thread/tokenUsage/updated') {
      const tokens = (p.tokenUsage as { total: Omit<Usage, 'cost' | 'source'> }).total;
      const usage: Usage = { ...tokens, cost: null, source: 'Codex thread/tokenUsage/updated (thread cumulative)' };
      this.emit(run, 'usage', { text: `会话累计 Token：${usage.totalTokens} · 费用未知`, usage }, p);
    } else if (message.method === 'turn/diff/updated') this.emit(run, 'file.changes', { text: typeof p.diff === 'string' ? p.diff : '原生文件差异' }, p);
    else if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = p.item as NativeItem; run.items.set(item.id, item);
      if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall') this.emit(run, message.method === 'item/started' ? 'tool.request' : 'tool.result', { text: item.command ?? item.aggregatedOutput ?? item.type }, p);
    }
  }
  async respondApproval(approvalId: string, decision: 'accept' | 'decline') {
    const pending = this.approvals.get(approvalId);
    if (!pending || pending.responding || !this.runs.has(pending.run.taskId) || !this.rpc) throw new Error('审批已过期或已处理');
    pending.responding = true;
    // Persist the decision before native execution can proceed.
    this.emit(pending.run, 'approval.resolved', { text: decision === 'accept' ? '已单次批准原生请求' : '已拒绝原生请求', approval: { ...pending.approval, status: decision } });
    if (!this.runs.has(pending.run.taskId) || pending.run.cancelling) throw new Error('审批记录失败，任务已停止');
    this.rpc.send({ id: pending.rpcId, result: { decision } }); this.approvals.delete(approvalId);
    return { ok: true };
  }
  async cancelTask(taskId: string) {
    const run = this.runs.get(taskId); if (!run || !this.rpc) return { ok: false, reason: '任务已结束' };
    run.cancelling = true;
    try { if (!run.turnId) throw new Error('尚未收到原生 turn ID'); await this.rpc.request('turn/interrupt', { threadId: run.session.externalSessionId, turnId: run.turnId }, 3000); await waitWithin(run.finished, 3000); }
    catch { /* Fall back to process-tree cleanup; never claim a native interrupt succeeded. */ }
    if (this.runs.has(taskId)) { this.finish(run, 'task.cancelled', '原生停止未及时确认，已终止 App Server 进程树'); const rpc = this.rpc; this.rpc = undefined; await rpc?.dispose(); }
    return { ok: true };
  }
  async getStatus(sessionId: string) { const session = this.sessions.get(sessionId); if (!session) throw new Error('会话不存在'); return { status: session.status }; }
  async dispose() { for (const id of [...this.runs.keys()]) await this.cancelTask(id); const rpc = this.rpc; this.rpc = undefined; await rpc?.dispose(); this.listeners.clear(); this.sessions.clear(); }
}
