import { workflowSchema, validateDependencies, type WorkflowDraft } from '../shared/workflows';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeRunStatuses, type ActionRecord, type LeaderNode, type LeaderPlan, type LeaderRun, type LeaderView, type PlanApproval, type RunEvent, type LeaderTransfer, type WorkspaceMerge } from '../shared/leader';
import { modelConfigSchema, type StoredModelConfig, type ModelCall } from '../shared/models';
import type { MeetingState } from '../orchestrator/meeting';
import { activeStatuses, transition, type AgentEvent, type AgentInstallation, type AgentSession, type Approval, type Handoff, type Project, type Settings, type Task, type TaskStatus } from '../shared';

const defaultSettings: Settings = { theme: 'light', layout: 'grid', projectId: null, focusedAgent: 'codex' };
export class Repository {
  private constructor(private db: Database, private filename: string, private restoreDb: (bytes: Uint8Array) => Database) {}
  get directory() { return dirname(this.filename); }
  static async open(filename: string) {
    const require = createRequire(import.meta.url);
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const db = new SQL.Database(existsSync(filename) ? readFileSync(filename) : undefined);
    db.run('PRAGMA foreign_keys = ON');
    const repository = new Repository(db, filename, bytes => new SQL.Database(bytes));
    repository.migrate(); return repository;
  }
  private rows(sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
    const statement = this.db.prepare(sql);
    try { statement.bind(params); const result: Record<string, SqlValue>[] = []; while (statement.step()) result.push(statement.getAsObject()); return result; }
    finally { statement.free(); }
  }
  private save() {
    mkdirSync(dirname(this.filename), { recursive: true });
    const bytes = this.db.export(); this.db.run('PRAGMA foreign_keys = ON');
    writeFileSync(`${this.filename}.tmp`, bytes); renameSync(`${this.filename}.tmp`, this.filename);
  }
  private transaction<T>(fn: () => T): T {
    const previous = this.db.export(); this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('BEGIN IMMEDIATE');
    let result: T;
    try { result = fn(); this.db.run('COMMIT'); }
    catch (e) { this.db.run('ROLLBACK'); throw e; }
    try { this.save(); }
    catch (e) { this.db.close(); this.db = this.restoreDb(previous); this.db.run('PRAGMA foreign_keys = ON'); throw e; }
    return result;
  }
  migrationVersion() { return Number(this.rows('PRAGMA user_version')[0].user_version); }
  private migrate() {
    const version = this.migrationVersion();
    if (version > 7) throw new Error('数据库来自较新版本，请使用兼容版本，不能覆盖');
    if (version === 7) return;
    if (version > 0 && existsSync(this.filename) && !existsSync(this.filename + '.before-v7.bak')) writeFileSync(this.filename + '.before-v7.bak', readFileSync(this.filename), { flag: 'wx' });
    if (version === 0) this.transaction(() => this.db.run(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, rootPath TEXT NOT NULL UNIQUE COLLATE NOCASE, createdAt TEXT NOT NULL, lastOpenedAt TEXT NOT NULL);
      CREATE TABLE agent_installations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, sessionId TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX tasks_project ON tasks(projectId);
      CREATE TABLE task_events (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, type TEXT NOT NULL, sanitizedPayload TEXT NOT NULL, createdAt TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(taskId, sequence));
      CREATE INDEX events_task ON task_events(taskId, sequence);
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
    `));
    if (version < 2) this.transaction(() => this.db.run(`CREATE TABLE approvals (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, data TEXT NOT NULL); PRAGMA user_version = 2;`));
    if (version < 3) this.transaction(() => this.db.run(`CREATE TABLE manual_handoffs (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, provider TEXT NOT NULL, data TEXT NOT NULL); PRAGMA user_version = 3;`));
    if (version < 4) this.transaction(() => this.db.run(`
      CREATE TABLE leader_runs (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX leader_project ON leader_runs(projectId);
      CREATE UNIQUE INDEX leader_single_active ON leader_runs((1)) WHERE status IN ('draft','awaiting_plan_approval','running','paused','waiting_approval','stopping');
      CREATE TABLE leader_plans (runId TEXT NOT NULL REFERENCES leader_runs(id) ON DELETE CASCADE, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(runId,revision));
      CREATE TABLE leader_tasks (runId TEXT NOT NULL REFERENCES leader_runs(id) ON DELETE CASCADE, taskId TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(runId,taskId));
      CREATE TABLE leader_actions (actionId TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES leader_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE leader_approvals (id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES leader_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE run_events (id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES leader_runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(runId,sequence));
      PRAGMA user_version = 4;
    `));
    if (version < 5) this.transaction(() => this.db.run(`
      CREATE TABLE meetings (id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES leader_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE leader_handoffs (id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES leader_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE workspace_merges (id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES leader_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      PRAGMA user_version = 5;
    `));
    if (version < 6) this.transaction(()=>this.db.run(`CREATE TABLE model_configs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE model_calls (id TEXT PRIMARY KEY, runId TEXT REFERENCES leader_runs(id) ON DELETE CASCADE, status TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX model_calls_run ON model_calls(runId); PRAGMA user_version=6;`));
    this.transaction(() => this.db.run(`CREATE TABLE workflow_drafts (projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(projectId,id)); PRAGMA user_version=7;`));
  }
  projects(): Project[] { return this.rows('SELECT * FROM projects ORDER BY lastOpenedAt DESC, rowid DESC') as unknown as Project[]; }
  project(id: string): Project { const p = this.projects().find(p => p.id === id); if (!p) throw new Error('项目不存在'); return p; }
  addProject(name: string, rootPath: string): Project {
    if (!isAbsolute(rootPath) || !existsSync(rootPath) || !statSync(rootPath).isDirectory()) throw new Error('请选择存在的本地绝对目录');
    const canonical = realpathSync(rootPath);
    const now = new Date().toISOString(); const p = { id: randomUUID(), name, rootPath: canonical, createdAt: now, lastOpenedAt: now };
    return this.transaction(() => { this.db.run('INSERT INTO projects VALUES(?,?,?,?,?)', [p.id, p.name, p.rootPath, now, now]); return p; });
  }
  removeProject(id: string) {
    this.project(id);
    this.transaction(() => { this.db.run('DELETE FROM projects WHERE id=?', [id]); if (this.settings().projectId === id) this.db.run('INSERT OR REPLACE INTO app_settings VALUES(?,?)', ['projectId', 'null']); });
  }
  settings(): Settings {
    return { ...defaultSettings, ...Object.fromEntries(this.rows('SELECT * FROM app_settings').map(r => [String(r.key), JSON.parse(String(r.value))])) };
  }
  setSettings(partial: Partial<Settings>): Settings {
    if (partial.projectId) this.project(partial.projectId);
    return this.transaction(() => {
      for (const [k, v] of Object.entries(partial)) this.db.run('INSERT OR REPLACE INTO app_settings VALUES(?,?)', [k, JSON.stringify(v)]);
      if (partial.projectId) this.db.run('UPDATE projects SET lastOpenedAt=? WHERE id=?', [new Date().toISOString(), partial.projectId]);
      return this.settings();
    });
  }
  installations(): AgentInstallation[] { return this.rows('SELECT data FROM agent_installations').map(r => JSON.parse(String(r.data))); }
  setInstallations(installations: AgentInstallation[]) { this.transaction(() => { for (const i of installations) this.db.run('INSERT OR REPLACE INTO agent_installations VALUES(?,?)', [i.id, JSON.stringify(i)]); }); }
  addSession(s: AgentSession): AgentSession { return this.transaction(() => { this.db.run('INSERT INTO agent_sessions VALUES(?,?,?)', [s.id, s.projectId, JSON.stringify(s)]); return s; }); }
  session(id: string): AgentSession { const row = this.rows('SELECT data FROM agent_sessions WHERE id=?', [id])[0]; if (!row) throw new Error('会话不存在'); return JSON.parse(String(row.data)); }
  updateSession(session: AgentSession) {
    const previous = this.session(session.id);
    if (previous.projectId !== session.projectId || previous.provider !== session.provider || previous.mode !== session.mode || previous.externalSessionId !== session.externalSessionId) throw new Error('不能改变会话身份');
    this.transaction(() => this.db.run('UPDATE agent_sessions SET data=? WHERE id=?', [JSON.stringify(session), session.id]));
  }
  addTask(t: Task): Task {
    return this.transaction(() => {
      const srow = this.rows('SELECT data FROM agent_sessions WHERE id=?', [t.sessionId])[0];
      if (!srow) throw new Error('任务会话不存在');
      const session: AgentSession = JSON.parse(String(srow.data));
      if (session.projectId !== t.projectId || session.provider !== t.provider || session.mode !== t.mode) throw new Error('任务与会话身份不一致');
      this.db.run('INSERT INTO tasks VALUES(?,?,?,?,?)', [t.id, t.projectId, t.sessionId, t.status, JSON.stringify(t)]); return t;
    });
  }
  task(id: string): Task { const r = this.rows('SELECT data,status FROM tasks WHERE id=?', [id])[0]; if (!r) throw new Error('任务不存在'); return { ...JSON.parse(String(r.data)), status: String(r.status) }; }
  tasks(projectId: string, offset = 0, limit = 30): Task[] { return this.rows('SELECT data,status FROM tasks WHERE projectId=? ORDER BY rowid DESC LIMIT ? OFFSET ?', [projectId, limit, offset]).map(r => ({ ...JSON.parse(String(r.data)), status: String(r.status) })); }
  activeTasks(): Task[] { return this.rows("SELECT data,status FROM tasks WHERE status IN ('queued','running','waiting_approval')").map(r => ({ ...JSON.parse(String(r.data)), status: String(r.status) })); }
  events(taskId: string, after = 0, limit = 50, query = ''): AgentEvent[] { return this.rows('SELECT data FROM task_events WHERE taskId=? AND sequence>? AND instr(lower(data),lower(?))>0 ORDER BY sequence LIMIT ?', [taskId, after, query, Math.min(100, Math.max(1, limit))]).map(r => JSON.parse(String(r.data))); }
  eventsTail(taskId: string, limit = 50): AgentEvent[] { return this.rows('SELECT data FROM task_events WHERE taskId=? ORDER BY sequence DESC LIMIT ?', [taskId, Math.min(100, Math.max(1, limit))]).map(r => JSON.parse(String(r.data))).reverse(); }
  nextSequence(taskId: string) { return Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM task_events WHERE taskId=?', [taskId])[0].next); }
  approvals(taskId: string): Approval[] { return this.rows('SELECT data FROM approvals WHERE taskId=? ORDER BY rowid', [taskId]).map(r => JSON.parse(String(r.data))); }
  approval(id: string): Approval { const row = this.rows('SELECT data FROM approvals WHERE id=?', [id])[0]; if (!row) throw new Error('审批不存在'); return JSON.parse(String(row.data)); }
  handoffs(projectId: string, provider: Handoff['provider']): Handoff[] { return this.rows('SELECT data FROM manual_handoffs WHERE projectId=? AND provider=? ORDER BY rowid DESC LIMIT 20', [projectId, provider]).map(r => JSON.parse(String(r.data))); }
  handoff(id: string): Handoff { const row = this.rows('SELECT data FROM manual_handoffs WHERE id=?', [id])[0]; if (!row) throw new Error('交接记录不存在'); return JSON.parse(String(row.data)); }
  addHandoff(handoff: Handoff): Handoff { this.project(handoff.projectId); return this.transaction(() => { this.db.run('INSERT INTO manual_handoffs VALUES(?,?,?,?)', [handoff.id, handoff.projectId, handoff.provider, JSON.stringify(handoff)]); return handoff; }); }
  importHandoff(id: string, result: string) { const handoff = { ...this.handoff(id), result, status: 'imported' as const, importedAt: new Date().toISOString() }; return this.transaction(() => { this.db.run('UPDATE manual_handoffs SET data=? WHERE id=?', [JSON.stringify(handoff), id]); return handoff; }); }
  recordEvent(e: AgentEvent) {
    const statusByEvent: Partial<Record<AgentEvent['type'], TaskStatus>> = { 'task.started': 'running', 'approval.required': 'waiting_approval', 'approval.resolved': 'running', 'task.completed': 'completed', 'task.failed': 'failed', 'task.cancelled': 'cancelled', 'task.interrupted': 'interrupted' };
    this.transaction(() => {
      const t = this.task(e.taskId);
      if (e.sessionId !== t.sessionId || e.agentId !== t.provider) throw new Error('事件与任务身份不一致');
      const nextSequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM task_events WHERE taskId=?', [t.id])[0].next);
      if (e.sequence !== nextSequence) throw new Error('事件序号重复或不连续');
      if (!activeStatuses.includes(t.status)) throw new Error('不能向已结束任务追加事件');
      if (e.type === 'approval.required' || e.type === 'approval.resolved') {
        const a = e.payload.approval;
        if (!a || a.taskId !== t.id) throw new Error('审批与任务身份不一致');
        if (e.type === 'approval.required') { if (a.status !== 'pending') throw new Error('无效审批'); this.db.run('INSERT INTO approvals VALUES(?,?,?)', [a.id, t.id, JSON.stringify(a)]); }
        else { const old = this.approval(a.id); if (old.taskId !== t.id || old.status !== 'pending' || !['accept', 'decline'].includes(a.status)) throw new Error('审批已过期或无效'); this.db.run('UPDATE approvals SET data=? WHERE id=?', [JSON.stringify({ ...old, status: a.status }), a.id]); }
      }
      let nextStatus = statusByEvent[e.type];
      if (e.type === 'approval.resolved' && this.approvals(t.id).some(a => a.status === 'pending')) nextStatus = 'waiting_approval';
      if (nextStatus && (nextStatus !== t.status || !e.type.startsWith('approval.'))) { t.status = transition(t.status, nextStatus); if (!activeStatuses.includes(t.status)) t.finishedAt = e.timestamp; }
      if (!activeStatuses.includes(t.status)) for (const a of this.approvals(t.id).filter(a => a.status === 'pending')) this.db.run('UPDATE approvals SET data=? WHERE id=?', [JSON.stringify({ ...a, status: 'expired' }), a.id]);
      this.db.run('INSERT INTO task_events VALUES(?,?,?,?,?,?,?)', [e.eventId, e.taskId, e.sequence, e.type, JSON.stringify(e.payload), e.timestamp, JSON.stringify(e)]);
      this.db.run('UPDATE tasks SET status=?,data=? WHERE id=?', [t.status, JSON.stringify(t), t.id]);
      const srow = this.rows('SELECT data FROM agent_sessions WHERE id=?', [t.sessionId])[0];
      const s: AgentSession = JSON.parse(String(srow.data)); s.status = activeStatuses.includes(t.status) ? 'running' : t.status === 'interrupted' ? 'interrupted' : 'idle';
      this.db.run('UPDATE agent_sessions SET data=? WHERE id=?', [JSON.stringify(s), s.id]);
    });
  }
  recoverInterrupted() {
    for (const call of this.modelCalls(undefined, 100000).filter(c=>c.status==='running')) this.modelCallSave({...call,status:'interrupted',finishedAt:new Date().toISOString(),error:'应用中断；不自动重放模型请求'});
    const affected = new Set([...this.leaderActive().map(r=>r.id), ...this.activeTasks().flatMap(t=>t.leaderRunId?[t.leaderRunId]:[])]);
    for (const t of this.activeTasks()) {
      const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0) AS sequence FROM task_events WHERE taskId=?', [t.id])[0].sequence) + 1;
      this.recordEvent({ eventId: randomUUID(), taskId: t.id, agentId: t.provider, sessionId: t.sessionId, timestamp: new Date().toISOString(), sequence, type: 'task.interrupted', payload: { mock: t.mode === 'mock', text: '应用退出或异常中断；没有自动重跑任务。' } });
    }
    for (const id of affected) { const run=this.leaderRun(id); const meeting=run.meetingId?this.meeting(run.meetingId):undefined; this.leaderSave({ ...run, status: activeRunStatuses.includes(run.status)?'interrupted':run.status, currentTaskId: undefined, currentNodeId: undefined, activeTaskIds: [], reason: run.reason??'应用中断；不自动恢复或重放未知任务' }, 'run.interrupted', '应用中断；未知节点已收敛，没有自动重跑', { nodes: this.leaderNodes(run.id).map(n => ['assigned', 'running', 'waiting_approval','reviewing'].includes(n.status) ? { ...n, status: 'interrupted' } : n), ...(meeting&&meeting.status!=='completed'?{meeting:{...meeting,status:'interrupted' as const}}:{}) }); }
  }
  leaderRun(id: string): LeaderRun { const row = this.rows('SELECT data FROM leader_runs WHERE id=?', [id])[0]; if (!row) throw new Error('Leader Run 不存在'); return JSON.parse(String(row.data)); }
  leaderRuns(projectId: string, offset = 0, limit = 20): LeaderRun[] { return this.rows('SELECT data FROM leader_runs WHERE projectId=? ORDER BY rowid DESC LIMIT ? OFFSET ?', [projectId, limit, offset]).map(r => JSON.parse(String(r.data))); }
  leaderActive(): LeaderRun[] { return this.rows("SELECT data FROM leader_runs WHERE status IN ('draft','awaiting_plan_approval','running','paused','waiting_approval','stopping')").map(r => JSON.parse(String(r.data))); }
  leaderNodes(runId: string): LeaderNode[] { return this.rows('SELECT data FROM leader_tasks WHERE runId=? ORDER BY rowid', [runId]).map(r => JSON.parse(String(r.data))); }
  leaderPlan(runId: string): LeaderPlan | undefined { const r = this.rows('SELECT data FROM leader_plans WHERE runId=? ORDER BY revision DESC LIMIT 1', [runId])[0]; return r ? JSON.parse(String(r.data)) : undefined; }
  leaderApprovals(runId: string): PlanApproval[] { return this.rows('SELECT data FROM leader_approvals WHERE runId=? ORDER BY rowid', [runId]).map(r => JSON.parse(String(r.data))); }
  leaderAction(id: string): ActionRecord | undefined { const r = this.rows('SELECT data FROM leader_actions WHERE actionId=?', [id])[0]; return r ? JSON.parse(String(r.data)) : undefined; }
  leaderEvents(runId: string, after = 0, limit = 50, query = ''): RunEvent[] { this.leaderRun(runId); return this.rows('SELECT data FROM run_events WHERE runId=? AND sequence>? AND instr(lower(data),lower(?))>0 ORDER BY sequence LIMIT ?', [runId, after, query, Math.min(100, Math.max(1, limit))]).map(r => JSON.parse(String(r.data))); }
  meeting(id: string): MeetingState | undefined { const r = this.rows('SELECT data FROM meetings WHERE id=?',[id])[0]; return r ? JSON.parse(String(r.data)) : undefined; }
  leaderTransfers(runId: string): LeaderTransfer[] { return this.rows('SELECT data FROM leader_handoffs WHERE runId=? ORDER BY rowid',[runId]).map(r=>JSON.parse(String(r.data))); }
  workspaceMerges(runId: string): WorkspaceMerge[] { return this.rows('SELECT data FROM workspace_merges WHERE runId=? ORDER BY rowid',[runId]).map(r=>JSON.parse(String(r.data))); }
  leaderView(id: string): LeaderView { const run = this.leaderRun(id); return { run, plan: this.leaderPlan(id), tasks: this.leaderNodes(id), approvals: this.leaderApprovals(id), events: this.rows('SELECT data FROM run_events WHERE runId=? ORDER BY sequence DESC LIMIT 100', [id]).map(r => JSON.parse(String(r.data))).reverse(), ...(run.team ? { meeting: run.meetingId ? this.meeting(run.meetingId) : undefined, handoffs: this.leaderTransfers(id), merges: this.workspaceMerges(id) } : {}) }; }
  leaderSave(run: LeaderRun, type: string, text: string, extra: { replaceDraft?: boolean; nodes?: LeaderNode[]; plan?: LeaderPlan; approval?: PlanApproval; action?: ActionRecord; source?: RunEvent['source']; taskId?: string; meeting?: MeetingState; transfer?: LeaderTransfer; merge?: WorkspaceMerge } = {}) {
    this.project(run.projectId);
    this.transaction(() => {
      const previous = this.rows('SELECT data FROM leader_runs WHERE id=?', [run.id])[0];
      if (previous) { const old: LeaderRun = JSON.parse(String(previous.data)); if (old.projectId !== run.projectId || old.rootPath !== run.rootPath || old.allowWrites !== run.allowWrites || old.mode !== run.mode || JSON.stringify(old.team) !== JSON.stringify(run.team) || JSON.stringify(old.reasoning) !== JSON.stringify(run.reasoning)) throw new Error('不能改变 Run 身份或权限'); if (old.leader !== run.leader && (!old.team || old.status !== 'paused' || !extra.transfer || extra.transfer.from !== old.leader || extra.transfer.to !== run.leader || extra.transfer.revision !== old.planRevision + 1 || run.planRevision !== extra.transfer.revision)) throw new Error('更换 Leader 需要有效用户交接'); }
      const saved = { ...run, updatedAt: new Date().toISOString() };
      this.db.run('INSERT INTO leader_runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data', [run.id, run.projectId, run.status, JSON.stringify(saved)]);
      if (extra.plan) { if (extra.plan.runId !== run.id || extra.plan.revision !== run.planRevision) throw new Error('计划与 Run 不一致'); this.db.run('INSERT INTO leader_plans VALUES(?,?,?)', [run.id, extra.plan.revision, JSON.stringify(extra.plan)]); }
      if (extra.replaceDraft) {
        this.db.run('DELETE FROM leader_tasks WHERE runId=?', [run.id]);
        for (const a of this.leaderApprovals(run.id).filter(a => a.status === 'pending')) this.db.run('UPDATE leader_approvals SET data=? WHERE id=?', [JSON.stringify({ ...a, status: 'expired' }), a.id]);
      }
      for (const node of extra.nodes ?? []) { if (node.runId !== run.id) throw new Error('节点与 Run 不一致'); this.db.run('INSERT INTO leader_tasks VALUES(?,?,?) ON CONFLICT(runId,taskId) DO UPDATE SET data=excluded.data', [run.id, node.taskId, JSON.stringify(node)]); }
      if (extra.approval) { if (extra.approval.runId !== run.id) throw new Error('审批与 Run 不一致'); this.db.run('INSERT INTO leader_approvals VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', [extra.approval.id, run.id, JSON.stringify(extra.approval)]); }
      if (extra.action) { if (extra.action.action.runId !== run.id) throw new Error('动作与 Run 不一致'); this.db.run('INSERT INTO leader_actions VALUES(?,?,?)', [extra.action.action.actionId, run.id, JSON.stringify(extra.action)]); }
      if (extra.meeting) { if (extra.meeting.runId !== run.id || extra.meeting.id !== run.meetingId) throw new Error('会议与 Run 不一致'); this.db.run('INSERT INTO meetings VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',[extra.meeting.id,run.id,JSON.stringify(extra.meeting)]); }
      if (extra.transfer) { if (extra.transfer.runId !== run.id) throw new Error('交接与 Run 不一致'); this.db.run('INSERT INTO leader_handoffs VALUES(?,?,?)',[extra.transfer.id,run.id,JSON.stringify(extra.transfer)]); }
      if (extra.merge) { if (extra.merge.runId !== run.id) throw new Error('合并与 Run 不一致'); this.db.run('INSERT INTO workspace_merges VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',[extra.merge.id,run.id,JSON.stringify(extra.merge)]); }
      if (!activeRunStatuses.includes(run.status)) for (const a of this.leaderApprovals(run.id).filter(a => a.status === 'pending')) this.db.run('UPDATE leader_approvals SET data=? WHERE id=?', [JSON.stringify({ ...a, status: 'expired' }), a.id]);
      const event: RunEvent = { id: randomUUID(), runId: run.id, sequence: Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM run_events WHERE runId=?', [run.id])[0].next), type, text, timestamp: new Date().toISOString(), source: extra.source ?? 'orchestrator', ...(extra.taskId ? { taskId: extra.taskId } : {}) };
      this.db.run('INSERT INTO run_events VALUES(?,?,?,?)', [event.id, run.id, event.sequence, JSON.stringify(event)]);
    });
  }
  modelConfigs():StoredModelConfig[]{return this.rows('SELECT data FROM model_configs ORDER BY rowid').map(r=>JSON.parse(String(r.data)));}
  modelConfig(id:string):StoredModelConfig{const config=this.modelConfigs().find(c=>c.id===id);if(!config)throw Error('Model Provider 配置不存在');return config;}
  modelConfigSave(config:StoredModelConfig){const value={...modelConfigSchema.parse(Object.fromEntries(Object.entries(config).filter(([k])=>k!=='createdAt'&&k!=='updatedAt'))),createdAt:config.createdAt,updatedAt:config.updatedAt};this.transaction(()=>this.db.run('INSERT INTO model_configs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',[config.id,JSON.stringify(value)]));}
  modelConfigRemove(id:string){this.transaction(()=>this.db.run('DELETE FROM model_configs WHERE id=?',[id]));}
  modelCall(id:string):ModelCall|undefined{const row=this.rows('SELECT data FROM model_calls WHERE id=?',[id])[0];return row?JSON.parse(String(row.data)):undefined;}
  modelCalls(runId?:string,limit=30):ModelCall[]{return this.rows(`SELECT data FROM model_calls ${runId?'WHERE runId=?':''} ORDER BY rowid DESC LIMIT ?`,runId?[runId,limit]:[limit]).map(r=>JSON.parse(String(r.data)));}
  modelCallSave(call:ModelCall){this.transaction(()=>{const old=this.modelCall(call.id);if(old&&(old.providerId!==call.providerId||old.runId!==call.runId||old.model!==call.model||old.status!=='running'))throw Error('模型调用身份或终态不可修改');this.db.run('INSERT INTO model_calls VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data',[call.id,call.runId??null,call.status,JSON.stringify(call)]);});}
  workflowDrafts(projectId: string): WorkflowDraft[] { this.project(projectId); return this.rows('SELECT data FROM workflow_drafts WHERE projectId=? ORDER BY rowid DESC', [projectId]).map(r => JSON.parse(String(r.data))); }
  historySearch(projectId: string, query: string, offset: number, limit: number): Task[] {
    this.project(projectId);
    return this.rows(`SELECT t.data,t.status FROM tasks t WHERE t.projectId=? AND (instr(lower(json_extract(t.data,'$.prompt')),lower(?))>0 OR EXISTS (SELECT 1 FROM task_events e WHERE e.taskId=t.id AND instr(lower(e.sanitizedPayload),lower(?))>0)) ORDER BY t.rowid DESC LIMIT ? OFFSET ?`, [projectId, query, query, limit, offset]).map(r => ({ ...JSON.parse(String(r.data)), status: String(r.status) }));
  }
  diagnosticCounts() {
    const count = (table: string) => Number(this.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);
    return { schemaVersion: this.migrationVersion(), projectCount: count('projects'), taskCount: count('tasks'), eventCount: count('task_events'), runCount: count('leader_runs'), interruptedTasks: Number(this.rows("SELECT COUNT(*) AS n FROM tasks WHERE status='interrupted'")[0].n), workflowCount: count('workflow_drafts') };
  }
  workflowSave(projectId: string, input: unknown, expectedVersion: number): WorkflowDraft {
    this.project(projectId); const draft = workflowSchema.parse(input); validateDependencies(draft.tasks);
    return this.transaction(() => {
      const previous = this.workflowDrafts(projectId).find(d => d.id === draft.id);
      if ((previous?.version ?? 0) !== expectedVersion) throw Error('草案版本已改变，请重新载入后编辑');
      if (!previous && this.workflowDrafts(projectId).length >= 100) throw Error('当前项目最多保存 100 个草案');
      const saved = { ...draft, projectId, version: expectedVersion + 1, updatedAt: new Date().toISOString() };
      this.db.run('INSERT INTO workflow_drafts VALUES(?,?,?) ON CONFLICT(projectId,id) DO UPDATE SET data=excluded.data', [projectId, draft.id, JSON.stringify(saved)]); return saved;
    });
  }
  workflowRemove(projectId: string, id: string, expectedVersion: number) {
    this.project(projectId);
    this.transaction(() => { if (this.workflowDrafts(projectId).find(d => d.id === id)?.version !== expectedVersion) throw Error('草案版本已改变或不存在'); this.db.run('DELETE FROM workflow_drafts WHERE projectId=? AND id=?', [projectId, id]); });
  }
  close() { this.db.close(); }
}
