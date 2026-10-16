import { lazy, Suspense, useEffect, useState } from 'react';
import type { Provider } from '../../../../../../packages/shared';
import { providers } from '../../../../../../packages/shared/constants';
import { activeRunStatuses, type LeaderRun, type LeaderView, type TeamSettings } from '../../../../../../packages/shared/leader';
import { act, request, useStore } from '../store';
import { providerMeta } from './AgentPanel';
import { Approvals } from './Approvals';
import { Button } from './ui/button';
import { ModelReasoning } from './ModelReasoning';
import { ModelCalls } from './ModelHubPage';
import type { ModelReasoning as ReasoningValue } from '../../../../../../packages/shared/models';
import { TeamConfiguration, TeamNodeDetails, TeamRunTools } from './TeamControls';

const PlanDraftEditor = lazy(() => import('./PlanDraftEditor').then(m => ({ default: m.PlanDraftEditor })));
const WorkflowGraph = lazy(() => import('./WorkflowGraph').then(m => ({ default: m.WorkflowGraph })));
const statusText: Record<LeaderRun['status'], string> = { draft: 'Leader 生成计划中', awaiting_plan_approval: '等待首次计划确认', running: '执行中', paused: '已暂停后续派单', waiting_approval: '等待原生审批', stopping: '等待 Provider 停止确认', completed: '审查通过', blocked: '已阻断，需人工处理', failed: '执行失败', cancelled: '已停止', interrupted: '已中断，不自动重放' };
export function LeaderPage() {
  const proposal = useStore(s => s.workflowProposal); const [editing, setEditing] = useState(false);
  const snapshot = useStore(s => s.snapshot); const projectId = snapshot?.settings.projectId;
  const [runs, setRuns] = useState<LeaderRun[]>([]); const [selected, setSelected] = useState(''); const [view, setView] = useState<LeaderView | null>(null);
  const [goal, setGoal] = useState(''); const [leader, setLeader] = useState<Provider>('codex'); const [workers, setWorkers] = useState<Provider[]>(['dsh']); const [control, setControl] = useState<LeaderRun['control']>('supervised'); const [allowWrites, setAllowWrites] = useState(false); const [busy, setBusy] = useState(false);
  const [reasoning,setReasoning]=useState<ReasoningValue>();
  const [teamEnabled,setTeamEnabled]=useState(true);const [team,setTeam]=useState<TeamSettings>({concurrency:2,reviewer:'dsh',maxReworks:2,maxDispatches:20});
  useEffect(() => { setSelected(''); setRuns([]); setView(null); setGoal(''); }, [projectId]);
  useEffect(() => {
    let live = true; if (!projectId) return;
    const load = async () => {
      const list = await request('leader.list', { projectId, offset: 0, limit: 20 });
      if (!live) return; setRuns(list); const id = selected || list[0]?.id;
      if (id) { const v = await request('leader.get', { runId: id }); if (live) setView(v); } else setView(null);
    };
    void load().catch(e => { if (live) useStore.getState().setError(e.message); });
    const timer = setInterval(() => void load().catch(e => { if (live) useStore.getState().setError(e.message); }), 1500);
    return () => { live = false; clearInterval(timer); };
  }, [projectId, selected]);
  useEffect(() => { if (proposal) { setGoal(proposal.goal); setWorkers([...new Set(proposal.tasks.map(t => t.assignedAgentId))]); setAllowWrites(false); } }, [proposal]);
  const probe = (p: Provider) => snapshot?.installations.find(i => i.id === p);
  const eligible = (p: Provider, role: 'leader' | 'worker') => !!probe(p)?.capabilities.sendPrompt.supported && !!probe(p)?.capabilities.cancel.supported && (role === 'worker' || !!probe(p)?.capabilities.leaderEligible.supported);
  const change = (fn: () => Promise<unknown>) => act(async () => { setBusy(true); try { await fn(); if (view) setView(await request('leader.get', { runId: view.run.id })); await useStore.getState().refreshTasks(); } finally { setBusy(false); } });
  const run = view?.run; const active = !!run && activeRunStatuses.includes(run.status);
  const refresh=async()=>{if(run)setView(await request('leader.get',{runId:run.id}));await useStore.getState().refreshTasks();};
  const dispatch = (taskId?: string) => change(async () => { if (!run) return; const node = view?.tasks.find(n => n.taskId === taskId); const r = await request('leader.action', { actionId: crypto.randomUUID(), runId: run.id, expectedRevision: run.planRevision, type: taskId ? 'assign_task' : 'request_review', ...(taskId ? { taskId, agentId: node!.assignedAgentId } : {}), reason: taskId ? '用户手动派发批准的任务' : '用户请求 Leader 审查' }); if (!r.ok) throw Error(r.reason); });
  return <div className="leader-page">
    <section className="leader-form" aria-label="Leader Run 配置"><div className="section-label">{teamEnabled?'M3.5 / 团队协作':'M3 / 串行 Leader MVP'} <span>最多 10 节点</span></div>
      <p>Leader 提出计划，工作台校验并派单。首次计划需要确认；目标和所需上下文由原生 Provider 发往其模型服务，费用未知。</p>
      {reasoning&&<p>Leader 的规划、节点审查和总结使用已选 Model Provider；下方 Agent 角色保留用于原生会议和历史兼容。</p>}<div className="leader-selectors"><label>Leader Agent<select aria-label="Leader Agent" value={leader} onChange={e => setLeader(e.target.value as Provider)}>{providers.map(p => <option key={p} value={p} disabled={!eligible(p, 'leader')}>{providerMeta[p].name}{eligible(p, 'leader') ? ' · 可规划' : ' · 当前不可用'}</option>)}</select></label>
        <label>控制模式<select aria-label="Leader 控制模式" value={control} onChange={e => setControl(e.target.value as LeaderRun['control'])}><option value="supervised">Supervised · 确认计划后串行派单</option><option value="manual">Manual · 每项任务手动派发</option>{teamEnabled && <option value="bounded-auto">Bounded Auto · 授权内有限返工</option>}</select></label>
      </div>
      <TeamConfiguration modelReview={!!reasoning} enabled={teamEnabled} settings={team} onSettings={setTeam} onEnabled={v=>{setTeamEnabled(v);if(!v)setReasoning(undefined);if(!v&&control==='bounded-auto')setControl('supervised');}} />{teamEnabled&&<ModelReasoning value={reasoning} onChange={setReasoning} disabled={busy} />}<fieldset><legend>Worker Agents</legend>{providers.map(p => <label key={p} className="leader-check"><input type="checkbox" aria-label={`${providerMeta[p].name} Worker`} checked={workers.includes(p)} disabled={!eligible(p, 'worker')} onChange={e => { setWorkers(old => e.target.checked ? [...old, p] : old.filter(x => x !== p)); if (p === 'codex' && !e.target.checked) setAllowWrites(false); }} /><span>{providerMeta[p].name} · {eligible(p, 'worker') ? p === 'dsh' ? '只读' : '可控任务' : probe(p)?.detail ?? '未验证'}</span></label>)}</fieldset>
      <label className="leader-check"><input type="checkbox" aria-label="允许计划内 Codex 项目写入" checked={allowWrites} disabled={!workers.includes('codex')} onChange={e => setAllowWrites(e.target.checked)} /><span>允许计划内 Codex 项目写入（要求 Git 根目录；保留原生单次审批）。默认只读。</span></label>
      {proposal && <p>工作流草案 · {proposal.tasks.length} 节点。创建后仍需单独批准。<Button size="sm" variant="outline" onClick={() => useStore.getState().loadWorkflow(null)}>改用模型生成计划</Button></p>}
      <label>总体目标<textarea aria-label="Leader 总体目标" maxLength={8000} rows={4} value={goal} onChange={e => setGoal(e.target.value)} placeholder="说明范围、目标和验收要求…" /></label>
      <Button disabled={busy || !projectId || !goal.trim() || (!reasoning&&!eligible(leader, 'leader')) || !!reasoning&&(!reasoning.primary.providerId||!reasoning.primary.model.trim()||!!reasoning.fallback&&(!reasoning.fallback.providerId||!reasoning.fallback.model.trim())) || !workers.length || (teamEnabled && (!reasoning&&!eligible(team.reviewer, 'worker') || team.maxDispatches < 1 || team.maxDispatches > 20 || team.maxReworks < 0 || team.maxReworks > 2)) || workers.some(p => !eligible(p, 'worker')) || runs.some(r => activeRunStatuses.includes(r.status))} onClick={() => change(async () => { if (!projectId) return; const r = await request('leader.start', { projectId, leader, workers, goal, ...(proposal ? { initialTasks: proposal.tasks } : {}), mode: 'real', control, allowWrites, stepTimeoutMs: 180000, ...(teamEnabled?{team,reasoning}:{}) }); setSelected(r.id); setView(await request('leader.get', { runId: r.id })); setRuns(await request('leader.list', { projectId, offset: 0, limit: 20 })); })}>{proposal ? '创建工作流待批准计划' : '生成 Leader 计划'}</Button>
      {!projectId && <p role="status">请先导入并选择项目。</p>}
    </section>
    <section className="leader-run" aria-label="Leader Run 状态"><div className="section-label">Run 历史 <span>{runs.length}</span></div>
      <select aria-label="Leader Run 历史" value={selected || runs[0]?.id || ''} onChange={e => { setSelected(e.target.value); setEditing(false); }}><option value="" disabled>暂无 Run</option>{runs.map(r => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString('zh-CN')} · {statusText[r.status]} · {r.goal.slice(0, 60)}</option>)}</select>
      {run && <><div className="leader-state"><strong role="status" aria-label="Leader Run 当前状态">{statusText[run.status]}</strong><span>{run.leader} → {run.workers.join(' / ')} · {run.mode} · {run.control} · revision {run.planRevision}</span></div><code>Run ID：{run.id}</code><p className="leader-goal">{run.goal}</p>
        {run.reason && <p role="alert">{run.reason}</p>}
        <TeamRunTools view={view} refresh={refresh} /><div className="leader-buttons">{run.status === 'awaiting_plan_approval' && <><Button variant="outline" disabled={busy} onClick={() => setEditing(v => !v)}>{editing ? '关闭计划编辑' : '编辑待批准计划'}</Button><Button disabled={busy || editing} onClick={() => change(() => request('leader.approve', { runId: run.id, expectedRevision: run.planRevision, decision: 'approve' }))}>确认并批准此计划</Button><Button variant="outline" disabled={busy} onClick={() => change(() => request('leader.approve', { runId: run.id, expectedRevision: run.planRevision, decision: 'reject' }))}>拒绝计划</Button></>}
          {active && run.status !== 'stopping' && (run.status === 'paused' ? <Button disabled={busy} onClick={() => change(() => request('leader.resume', { runId: run.id }))}>继续派单</Button> : <Button variant="outline" disabled={busy} onClick={() => change(() => request('leader.pause', { runId: run.id }))}>暂停后续派单</Button>)}
          {active && <Button variant="destructive" disabled={busy || run.status === 'stopping'} onClick={() => change(() => request('leader.stop', { runId: run.id }))}>{run.status === 'stopping' ? '等待停止确认' : '停止 Leader Run'}</Button>}
          {run.control === 'manual' && run.status === 'running' && view.tasks.length > 0 && view.tasks.every(n => n.status === 'completed') && <Button disabled={busy} onClick={() => dispatch()}>请求 Leader 审查</Button>}
        </div>
        {run.status === 'paused' && <p>仅暂停后续派发；已发出的任务仍可运行并回传结果。</p>}
        {[...new Set([...(run.activeTaskIds??[]),...(run.currentTaskId?[run.currentTaskId]:[])])].map(id=><div key={id}><p>在途原生任务：<code>{id}</code>（{run.phase}）</p><Approvals taskId={id} /></div>)}
        {view.plan && (editing && run.status === 'awaiting_plan_approval' ? <Suspense fallback={<p>正在载入计划编辑器…</p>}><PlanDraftEditor key={run.id} view={view} onSaved={v => { setView(v); setEditing(false); }} /></Suspense> : <Suspense fallback={<p>正在载入任务图…</p>}><WorkflowGraph key={run.id} tasks={view.plan.tasks} statuses={Object.fromEntries(view.tasks.map(t => [t.taskId, t.status]))} /></Suspense>)}
        {view.plan && <div className="leader-task-tree" aria-label="Leader 任务计划">{view.tasks.map(n => <article key={n.taskId}><header><strong>{n.taskId} · {n.title}</strong><span>{n.status} · {n.assignedAgentId} · attempt {n.attempt}</span></header><p>{n.instruction}</p><p>依赖：{n.dependsOn.join(' / ') || '无'} · 权限：{n.needsWriteAccess ? '项目写入' : '只读'}</p><ul>{n.acceptance.map(a => <li key={a}>{a}</li>)}</ul>{n.providerTaskId && <code>Task ID：{n.providerTaskId}</code>}{n.result && <details><summary>Worker 结果 · {n.result.source}</summary><pre>{n.result.summary}</pre><p>事件引用：{n.result.rawEventRefs.join(' / ')}</p></details>}<TeamNodeDetails node={n} view={view} busy={busy} refresh={refresh} />{run.control === 'manual' && run.status === 'running' && n.status === 'pending' && n.dependsOn.every(id => view.tasks.find(t => t.taskId === id)?.status === 'completed') && <Button size="sm" disabled={busy || !!run.currentTaskId} onClick={() => dispatch(n.taskId)}>派发 {n.taskId}</Button>}</article>)}</div>}
        <details className="leader-events" open><summary>Run 审计日志 · 最近 {view.events.length} 条</summary>{view.events.map(e => <div key={e.id}><span>{e.sequence} · {new Date(e.timestamp).toLocaleTimeString('zh-CN')}</span><b>{e.type}</b><p>{e.text}</p>{e.taskId && <code>{e.taskId}</code>}</div>)}</details>
        {run.report && <section aria-label="Leader 验收报告"><h2>验收报告</h2><pre className="leader-report">{run.report}</pre></section>}
      </>}
    {run?.reasoning&&<ModelCalls runId={run.id} />}</section>
  </div>;
}
