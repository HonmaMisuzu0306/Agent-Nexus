import { appVersion } from '../../../../packages/shared/constants';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { AgentRegistry } from '../../../../packages/agent-core';
import type { AgentAdapter } from '../../../../packages/agent-core';
import { WorkBuddyAdapter } from '../../../../packages/agent-core/workbuddy';
import type { PairingStore } from '../../../../packages/agent-core/workbuddy-pairing';
import { Orchestrator } from '../../../../packages/orchestrator';
import type { TaskLink } from '../../../../packages/orchestrator/team-task';
import { ModelHub } from '../../../../packages/model-core/hub';
import type { ModelSecrets } from '../../../../packages/model-core/secrets';
import { openDesktop, requireGitProject } from '../../../../packages/agent-core/installed';
import { Repository } from '../../../../packages/persistence';
import { activeStatuses, parseRequest, providers, type AgentEvent, type Channel, type RequestMap, type ResponseMap, type ServiceIssue, type Task } from '../../../../packages/shared';

export class NexusService {
  private locks = new Set<string>();
  private unsubscribers = new Map<string, () => void>();
  private disposing = false;
  private fatalError: string | null = null;
  private workbuddy: WorkBuddyAdapter;
  readonly leader: Orchestrator;
  readonly models:ModelHub;
  onEvent: (event: AgentEvent) => void = () => {};
  onIssue: (issue: ServiceIssue) => void = () => {};
  constructor(readonly repository: Repository, private registry: { get: (provider: Task['provider'], mode: Task['mode']) => AgentAdapter; dispose: () => Promise<void> } = new AgentRegistry(join(repository.directory, 'provider-config')), pairingStore?: PairingStore,modelSecrets?:ModelSecrets) {
    this.workbuddy = new WorkBuddyAdapter(pairingStore);
    this.models=new ModelHub(repository,modelSecrets);
    this.leader = new Orchestrator(repository, { detect: (p, mode) => this.registry.get(p, mode).detect(), launch: (a, link) => this.start(a, link), cancel: id => this.cancel(id), validateReasoning:s=>this.models.validate(s),decide:(id,prompt,options)=>this.models.generate(randomUUID(),repository.leaderRun(id).reasoning!,prompt,{...options,runId:id}),cancelModels:id=>this.models.cancelRun(id),issue: message => { this.models.dispose();this.fatalError = message; this.onIssue({ fatal: true, message }); } });
  }
  async restoreWorkBuddy() { try { await this.workbuddy.restore(this.repository.projects().map(p => p.id)); } catch { /* Restore errors remain visible in bridge status; other providers can still start. */ } }
  async detect() {
    const installations = await Promise.all(providers.map(p => this.registry.get(p, 'real').detect()));
    this.repository.setInstallations(installations); return installations;
  }
  async call<K extends Channel>(channel: K, input: unknown): Promise<ResponseMap[K]> {
    if (this.disposing) throw new Error('应用正在关闭');
    if (this.fatalError && !['snapshot.get', 'tasks.list', 'events.list', 'events.tail', 'task.cancel', 'tasks.stopAll', 'leader.get', 'leader.list', 'leader.events', 'leader.stop'].includes(channel)) throw new Error(this.fatalError);
    const args = parseRequest(channel, input);
    return await this.dispatch(channel, args) as ResponseMap[K];
  }
  private async dispatch(channel: Channel, input: RequestMap[Channel]): Promise<ResponseMap[Channel]> {
    const r = this.repository;
    switch (channel) {
      case 'history.search': { const a = input as RequestMap['history.search']; const tasks = r.historySearch(a.projectId, a.query, a.offset, a.limit + 1); return { tasks: tasks.slice(0, a.limit), hasMore: tasks.length > a.limit }; }
      case 'diagnostics.get': return { formatVersion: 1, applicationVersion: appVersion, exportedAt: new Date().toISOString(), ...r.diagnosticCounts() };
      case 'diagnostics.export': throw Error('诊断导出需要桌面保存对话框');
      case 'workflow.list': return r.workflowDrafts((input as RequestMap['workflow.list']).projectId);
      case 'workflow.save': { const a = input as RequestMap['workflow.save']; return r.workflowSave(a.projectId, a.draft, a.expectedVersion); }
      case 'workflow.remove': { const a = input as RequestMap['workflow.remove']; r.workflowRemove(a.projectId, a.id, a.expectedVersion); return { ok: true }; }
      case 'leader.plan.update': return this.leader.updatePlan(input as RequestMap['leader.plan.update']);
      case 'models.list':return this.models.list();
      case 'models.save':{const a=input as RequestMap['models.save'];return this.models.save(a.config,a.apiKey,a.clearSecret);}
      case 'models.remove':return this.models.remove((input as RequestMap['models.remove']).providerId);
      case 'models.health':return this.models.health((input as RequestMap['models.health']).providerId);
      case 'models.calls':{const a=input as RequestMap['models.calls'];return r.modelCalls(a.runId,a.limit);}
      case 'models.generate':{const a=input as RequestMap['models.generate'];return this.models.generate(a.id,{primary:a.selection,externalAcknowledged:a.externalAcknowledged},a.prompt,{purpose:'probe'});}
      case 'models.cancel':{const a=input as RequestMap['models.cancel'];const call=r.modelCall(`model:${a.id}`);if(call?.runId)throw Error('Run 模型调用请通过停止 Run 管理');return this.models.cancel(`model:${a.id}`);}
      case 'snapshot.get': return { projects: r.projects(), settings: r.settings(), installations: r.installations(), activeTaskCount: r.activeTasks().length };
      case 'project.add': {
        const a = input as RequestMap['project.add']; return r.addProject(a.name, a.rootPath);
      }
      case 'project.create': {
        const a = input as RequestMap['project.create'];
        if (!isAbsolute(a.parentPath) || !existsSync(a.parentPath) || !statSync(a.parentPath).isDirectory()) throw new Error('父目录不存在');
        const root = join(realpathSync(a.parentPath), a.name);
        if (existsSync(root)) throw new Error('该目录已存在，请使用导入项目');
        mkdirSync(root);
        try { return r.addProject(a.name, root); }
        catch (e) { rmdirSync(root); throw e; }
      }
      case 'project.remove': {
        const a = input as RequestMap['project.remove'];
        if (r.leaderActive().some(run => run.projectId === a.projectId)) throw new Error('请先停止当前项目的 Leader Run，再移除项目');
        if (r.activeTasks().some(t => t.projectId === a.projectId && t.mode === 'bridge' && t.status === 'running')) throw new Error('请先在 WorkBuddy 停止任务并确认取消，或撤销项目桥接后再移除项目');
        for (const t of r.activeTasks().filter(t => t.projectId === a.projectId)) await this.cancel(t.id);
        this.workbuddy.revoke(a.projectId);
        r.removeProject(a.projectId); return { ok: true };
      }
      case 'settings.set': return r.setSettings(input as RequestMap['settings.set']);
      case 'agents.detect': return this.detect();
      case 'tasks.list': {
        const a = input as RequestMap['tasks.list']; r.project(a.projectId);
        const tasks = r.tasks(a.projectId, a.offset, a.limit + 1); return { tasks: tasks.slice(0, a.limit), hasMore: tasks.length > a.limit };
      }
      case 'task.start': return this.start(input as RequestMap['task.start']);
      case 'task.cancel': return this.cancel((input as RequestMap['task.cancel']).taskId);
      case 'tasks.stopAll': { this.models.cancelAll(); const results = []; const runIds = new Set([...r.leaderActive().map(run=>run.id), ...r.activeTasks().flatMap(t=>t.leaderRunId?[t.leaderRunId]:[])]); for (const id of runIds) results.push(await this.leader.stop(id)); for (const t of r.activeTasks().filter(t => !t.leaderRunId)) results.push(await this.cancel(t.id)); return { ok: results.every(r => r.ok), pending: results.some(r => r.pending), reason: results.filter(r => r.reason).map(r => r.reason).join('；') || undefined }; }
      case 'leader.start': return this.leader.start(input as RequestMap['leader.start']);
      case 'leader.list': { const a = input as RequestMap['leader.list']; r.project(a.projectId); return r.leaderRuns(a.projectId, a.offset, a.limit); }
      case 'leader.get': return r.leaderView((input as RequestMap['leader.get']).runId);
      case 'leader.events': { const a = input as RequestMap['leader.events']; return r.leaderEvents(a.runId, a.after, a.limit, a.query); }
      case 'leader.handoff': return this.leader.team.handoff(input as RequestMap['leader.handoff']);
      case 'leader.recover': return this.leader.team.recover(input as RequestMap['leader.recover']);
      case 'leader.merge.preview': return this.leader.team.previewMerge((input as RequestMap['leader.merge.preview']).runId);
      case 'leader.merge.apply': return this.leader.team.applyMerge(input as RequestMap['leader.merge.apply']);
      case 'leader.pauseAll': { for (const run of r.leaderActive().filter(run => !['paused','stopping'].includes(run.status))) this.leader.pause(run.id); return { ok: true }; }
      case 'leader.approve': return this.leader.approve(input as RequestMap['leader.approve']);
      case 'leader.action': return this.leader.action(input as RequestMap['leader.action']);
      case 'leader.pause': return this.leader.pause((input as RequestMap['leader.pause']).runId);
      case 'leader.resume': return this.leader.resume((input as RequestMap['leader.resume']).runId);
      case 'leader.stop': return this.leader.stop((input as RequestMap['leader.stop']).runId);
      case 'events.list': {
        const a = input as RequestMap['events.list']; r.task(a.taskId); return r.events(a.taskId, a.after, a.limit, a.query);
      }
      case 'events.tail': { const a = input as RequestMap['events.tail']; r.task(a.taskId); return r.eventsTail(a.taskId, a.limit); }
      case 'approvals.list': { const a = input as RequestMap['approvals.list']; r.task(a.taskId); return r.approvals(a.taskId); }
      case 'approval.respond': {
        const a = input as RequestMap['approval.respond']; const approval = r.approval(a.approvalId); const task = r.task(approval.taskId);
        if (approval.status !== 'pending' || !activeStatuses.includes(task.status)) throw new Error('审批已过期或已处理');
        const adapter = this.adapter(task.provider, task.mode); if (!adapter.respondApproval) throw new Error('此 Provider 不支持审批');
        return adapter.respondApproval(a.approvalId, a.decision);
      }
      case 'handoff.prepare': { const a = input as RequestMap['handoff.prepare']; r.project(a.projectId); return r.addHandoff({ id: randomUUID(), ...a, result: null, source: 'manual', status: 'prepared', createdAt: new Date().toISOString(), importedAt: null }); }
      case 'handoffs.list': { const a = input as RequestMap['handoffs.list']; r.project(a.projectId); return r.handoffs(a.projectId, a.provider); }
      case 'handoff.import': { const a = input as RequestMap['handoff.import']; return r.importHandoff(a.handoffId, a.result); }
      case 'handoff.copy': { const a = input as RequestMap['handoff.copy']; const h = r.handoff(a.handoffId); const p = r.project(h.projectId); return `项目目录：${p.rootPath}\n\n任务目标：${h.prompt}\n\n请在原生应用中确认目录和权限后手动提交。先使用只读 / Ask；结果由用户审核后导入 Agent Nexus。`; }
      case 'provider.open': return openDesktop((input as RequestMap['provider.open']).provider);
      case 'workbuddy.enable': { const a = input as RequestMap['workbuddy.enable']; r.project(a.projectId); const status = await this.workbuddy.enable(a.projectId); try { r.project(a.projectId); } catch (e) { this.workbuddy.revoke(a.projectId); throw e; } return status; }
      case 'workbuddy.status': { const a = input as RequestMap['workbuddy.status']; r.project(a.projectId); return this.workbuddy.status(a.projectId); }
      case 'workbuddy.revoke': { const a = input as RequestMap['workbuddy.revoke']; r.project(a.projectId); return this.workbuddy.revoke(a.projectId); }
      case 'workbuddy.config.copy': { const a = input as RequestMap['workbuddy.config.copy']; r.project(a.projectId); return this.workbuddy.configuration(a.projectId); }
      case 'workbuddy.bootstrap.copy': {
        const a = input as RequestMap['workbuddy.bootstrap.copy']; const p = r.project(a.projectId);
        return `请使用已配置的 agent-nexus-workbuddy MCP 桥接，领取并处理一项 Agent Nexus 任务。\n预期项目目录：${p.rootPath}\n先确认当前目录和原生权限；首轮联调只执行合成只读任务。调用 nexus_claim_task；若 task=null 就停止，请我在 Nexus 提交任务后再试。领取后核对返回的 rootPath，保留 taskId 和 lease（不要写入文件或最终答案）。每次重要操作前及每 3 分钟调用 nexus_task_status 或 nexus_report_progress，检查 cancelRequested；进度 sequence 从 1 连续递增。收到取消、中断、过期或工具错误时停止原生操作。完成后用 nexus_report_result 如实报告 completed/failed；确认停止后报告 cancelled。只做这一项，不自动重复领取、不无限轮询。项目权限由 WorkBuddy 管理，桥接无法代替原生授权。`;
      }
      case 'project.pick': throw new Error('目录选择需要桌面窗口');
    }
  }
  private async start(a: RequestMap['task.start'] & { outputSchema?: Record<string, unknown> }, link?: TaskLink) {
    if (!link && this.repository.leaderActive().some(run => run.projectId === a.projectId && (run.leader === a.provider || run.workers.includes(a.provider)))) throw new Error('此 Agent 已分配给活动 Leader Run，请先暂停并停止该 Run');
    const key = `${a.projectId}:${a.provider}${link?.slotId ? `:${link.runId}:${link.slotId}` : ''}`;
    if (this.locks.has(key)) throw new Error(`${a.provider} 已有任务运行中`);
    const project = this.repository.project(a.projectId);
    const rootPath = link?.rootPath ?? project.rootPath;
    if (rootPath !== project.rootPath) {
      const run = link ? this.repository.leaderRun(link.runId) : undefined;
      const workspace = link?.nodeId ? this.repository.leaderNodes(link.runId).find(n => n.taskId === link.nodeId)?.workspace : undefined;
      if (!run?.team || run.projectId !== project.id || !workspace || workspace.path !== rootPath || workspace.projectRoot !== run.rootPath) throw new Error('未授权的隔离目录');
      await this.leader.team.workspace.validate(workspace);
    }
    if (!existsSync(project.rootPath) || !statSync(project.rootPath).isDirectory()) throw new Error('项目目录已不存在，请重新导入');
    if (a.mode === 'real' && a.sandbox === 'workspace-write') await requireGitProject(rootPath);
    if (this.locks.has(key)) throw new Error(`${a.provider} 已有任务运行中`);
    this.locks.add(key);
    const adapter = this.adapter(a.provider, a.mode);
    let task: Task | null = null;
    try {
      let session;
      if (a.sessionId) {
        const owned = this.repository.session(a.sessionId);
        if (owned.projectId !== project.id || owned.provider !== a.provider || owned.mode !== a.mode || a.sandbox && owned.sandbox !== a.sandbox) throw new Error('只能继续当前项目的相同权限会话');
        if (!adapter.resumeSession) throw new Error('此 Provider 不支持恢复');
        if (owned.sandbox === 'workspace-write') await requireGitProject(project.rootPath);
        session = await adapter.resumeSession(owned, project.rootPath); this.repository.updateSession(session);
      } else { session = await adapter.startSession({ projectId: project.id, rootPath, sandbox: a.sandbox }); this.repository.addSession(session); }
      task = this.repository.addTask({ id: randomUUID(), projectId: project.id, sessionId: session.id, provider: a.provider, prompt: a.prompt, status: 'queued', mode: a.mode, createdAt: new Date().toISOString(), finishedAt: null, sandbox: session.sandbox, model: session.model, ...(link ? { leaderRunId: link.runId, parentId: link.nodeId } : {}) });
      const taskId = task.id;
      link?.beforeSend(task);
      const unsubscribe = adapter.subscribeEvents(session.id, event => {
        try {
          this.repository.recordEvent(event);
          this.leader.observe(event);
          this.onEvent(event);
          if (event.type.startsWith('task.') && event.type !== 'task.started') {
            this.locks.delete(key); this.unsubscribers.get(taskId)?.(); this.unsubscribers.delete(taskId);
          }
        } catch {
          // Stop before reporting: the adapter must not keep emitting unpersisted work.
          unsubscribe(); this.unsubscribers.delete(taskId); this.locks.delete(key);
          if (a.mode === 'bridge') this.workbuddy.abandon(taskId); else void adapter.cancelTask(taskId);
          let fatal = false;
          try {
            const failure: AgentEvent = { eventId: randomUUID(), taskId, sessionId: session.id, agentId: a.provider, timestamp: new Date().toISOString(), sequence: this.repository.nextSequence(taskId), type: 'task.failed', payload: { mock: a.mode === 'mock', code: 'EVENT_PERSISTENCE_FAILED', text: '任务因事件持久化失败而停止。' } };
            this.repository.recordEvent(failure); this.onEvent(failure);
          } catch { fatal = true; this.fatalError = '事件持久化失败，请检查本地存储并重启工作台'; }
          this.onIssue({ taskId, agentId: a.provider, fatal, message: a.mode === 'bridge' ? '桥接记录失败，已使租约失效；请在 WorkBuddy 检查原生执行' : '任务事件持久化失败，已停止该任务' });
        }
      });
      this.unsubscribers.set(taskId, unsubscribe);
      await adapter.sendPrompt({ sessionId: session.id, taskId, prompt: a.prompt, scenario: a.scenario, outputSchema: a.outputSchema });
      return this.repository.task(taskId);
    } catch (error) {
      this.locks.delete(key);
      if (task) {
        this.unsubscribers.get(task.id)?.(); this.unsubscribers.delete(task.id);
        if (activeStatuses.includes(this.repository.task(task.id).status)) this.repository.recordEvent({ eventId: randomUUID(), taskId: task.id, sessionId: task.sessionId, agentId: task.provider, timestamp: new Date().toISOString(), sequence: this.repository.nextSequence(task.id), type: 'task.failed', payload: { mock: a.mode === 'mock', text: '任务未能启动' } });
      }
      throw error;
    }
  }
  private adapter(provider: Task['provider'], mode: Task['mode']): AgentAdapter { return mode === 'bridge' ? this.workbuddy : this.registry.get(provider, mode); }
  private async cancel(taskId: string) {
    const task = this.repository.task(taskId);
    if (!activeStatuses.includes(task.status)) return { ok: false, reason: '任务已结束' };
    return this.adapter(task.provider, task.mode).cancelTask(taskId);
  }
  async dispose() {
    this.disposing = true;
    this.models.dispose();
    try { this.leader.dispose(); } catch { this.onIssue({ fatal: true, message: '关闭时 Leader 状态未能保存；仍清理原生进程' }); }
    await Promise.allSettled([this.workbuddy.dispose(), this.registry.dispose(),this.models.settled()]);
    await this.leader.settled();
    this.unsubscribers.forEach(fn => fn()); this.unsubscribers.clear(); this.locks.clear();
  }
}
