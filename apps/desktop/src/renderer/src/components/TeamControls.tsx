import { useEffect, useState } from 'react';
import type { Provider } from '../../../../../../packages/shared';
import type { LeaderNode, LeaderView, RunEvent, TeamSettings } from '../../../../../../packages/shared/leader';
import type { MergePreview } from '../../../../../../packages/git-workspace';
import { providers } from '../../../../../../packages/shared/constants';
import { act, request, useStore } from '../store';
import { providerMeta } from './AgentPanel';
import { Button } from './ui/button';

export function TeamConfiguration({enabled,onEnabled,settings,onSettings,modelReview=false}: {modelReview?:boolean;enabled:boolean;onEnabled(v:boolean):void;settings:TeamSettings;onSettings(v:TeamSettings):void}) {
  const installations=useStore(s=>s.snapshot?.installations);
  return <div className="team-config"><label className="leader-check"><input type="checkbox" aria-label="开启 M3.5 团队协作" checked={enabled} onChange={e=>onEnabled(e.target.checked)} /><span>M3.5 团队协作 · 并行、独立审查、隔离与有限返工</span></label>
    {enabled&&<><div className="leader-selectors"><label>并发上限<select aria-label="团队并发上限" value={settings.concurrency} onChange={e=>onSettings({...settings,concurrency:Number(e.target.value)})}><option value="1">1 · 顺序执行</option><option value="2">2 · 独立任务并行</option></select></label><label>{modelReview?'独立审查使用所选 Model Provider':'独立 Reviewer'}<select disabled={modelReview} aria-label="团队 Reviewer" value={settings.reviewer} onChange={e=>onSettings({...settings,reviewer:e.target.value as Provider})}>{providers.map(p=><option key={p} value={p} disabled={!installations?.find(i=>i.id===p)?.capabilities.sendPrompt.supported}>{providerMeta[p].name}</option>)}</select></label></div>
      <div className="leader-selectors"><label>每节点最多返工<input aria-label="团队返工上限" type="number" min="0" max="2" value={settings.maxReworks} onChange={e=>onSettings({...settings,maxReworks:Number(e.target.value)})} /></label><label>Run 最多 Worker 派发<input aria-label="团队派发上限" type="number" min="1" max="20" value={settings.maxDispatches} onChange={e=>onSettings({...settings,maxDispatches:Number(e.target.value)})} /></label></div><p>写入任务进入独立 Worktree，原目录改动保留。审查使用独立会话或模型请求。Supervised 返工须确认；Bounded Auto 在批准范围内最多返工两次。合并补丁需另行批准。</p></>}
  </div>;
}

export function TeamNodeDetails({node,view,busy,refresh}: {node:LeaderNode;view:LeaderView;busy:boolean;refresh():Promise<void>}) {
  if(!view.run.team)return null;
  const allowed=['running','waiting_approval'].includes(view.run.status);
  const action=(type:'request_retry'|'request_review')=>act(async()=>{const reply=await request('leader.action',{actionId:crypto.randomUUID(),runId:view.run.id,expectedRevision:view.run.planRevision,type,taskId:node.taskId,reason:type==='request_retry'?'用户允许本节点有界返工':'用户请求独立只读审查'});if(!reply.ok)throw Error(reply.reason);await refresh();});
  return <div className="team-node-details">
    {node.workspace&&<p>隔离目录：<code>{node.workspace.path}</code><br />分支：<code>{node.workspace.branch}</code></p>}
    {node.review&&<p>独立审查：<strong>{node.review.verdict}</strong> · {node.review.summary}{node.review.unmet.length>0&&<span> · 未处理：{node.review.unmet.join('；')}</span>}</p>}
    {node.reviewTaskId&&<code>Reviewer Task：{node.reviewTaskId}</code>}
    {node.history&&node.history.length>0&&<details><summary>尝试与审查证据 · {node.history.length} 次</summary>{node.history.map(h=><section key={h.attempt}><h4>attempt {h.attempt} · {h.review?.verdict??h.result?.outcome}</h4><p>实现：<code>{h.result?.providerTaskId}</code> · 审查：<code>{h.reviewTaskId}</code></p><pre>{h.result?.summary}</pre><p>{h.review?.summary}</p><p>审查事件：{h.reviewEventRefs?.join(' / ')}</p></section>)}</details>}
    {node.diff&&<details><summary>改动与 Diff · {node.diff.changedPaths.length} 个路径{node.diff.truncated?' · 已截断，不能自动通过':''}</summary><p>{node.diff.changedPaths.join(' / ')||'无文件修改'}</p><pre>{node.diff.diff||'无 diff'}</pre></details>}
    {allowed&&node.status==='rework_pending'&&view.run.control!=='bounded-auto'&&<Button disabled={busy} onClick={()=>action('request_retry')}>批准返工 {node.taskId}</Button>}
    {allowed&&node.status==='awaiting_review'&&view.run.control==='manual'&&<Button disabled={busy} onClick={()=>action('request_review')}>审查 {node.taskId}</Button>}
  </div>;
}

export function TeamRunTools({view,refresh}: {view:LeaderView;refresh():Promise<void>}) {
  const r=view.run;const installations=useStore(s=>s.snapshot?.installations);
  const [target,setTarget]=useState<Provider>('dsh');const [ack,setAck]=useState(false);const [mergeAck,setMergeAck]=useState(false);const [preview,setPreview]=useState<MergePreview|null>(null);const [busy,setBusy]=useState(false);const [query,setQuery]=useState('');const [events,setEvents]=useState<RunEvent[]|null>(null);
  useEffect(()=>{setTarget(r.leader==='codex'?'dsh':'codex');setAck(false);setMergeAck(false);setPreview(null);setEvents(null);setQuery('');},[r.id,r.leader]);
  if(!r.team)return null;
  const change=(fn:()=>Promise<unknown>)=>act(async()=>{setBusy(true);try{await fn();await refresh();}finally{setBusy(false);}});
  const occupied=(r.activeTaskIds?.length??0)>0||view.tasks.some(n=>['assigned','running','waiting_approval','reviewing'].includes(n.status));
  return <section className="team-run-tools" aria-label="团队控制与审计"><p>并发 ≤ {r.team.concurrency} · Worker 派发 {r.dispatches??0}/{r.team.maxDispatches} · 原生请求登记 {r.nativeCalls??0}/60 · 费用未知</p>
    {r.status==='paused'&&<div className="team-handoff"><label>交接给<select aria-label="Leader 交接目标" value={target} onChange={e=>setTarget(e.target.value as Provider)}>{providers.map(p=><option key={p} value={p} disabled={!installations?.find(i=>i.id===p)?.capabilities.leaderEligible.supported}>{providerMeta[p].name}</option>)}</select></label><Button variant="outline" disabled={busy||occupied||!r.planRevision||target===r.leader} onClick={()=>change(()=>request('leader.handoff',{runId:r.id,expectedRevision:r.planRevision,leader:target,reason:'用户在暂停检查点明确选择新 Leader'}))}>确认 Leader 交接</Button><p>仅在无在途工作时交接，计划与权限不变；旧版本动作过期，之后仍需点击继续。</p></div>}
    {r.status==='interrupted'&&<><label className="leader-check"><input type="checkbox" aria-label="已核查原生任务以恢复" checked={ack} onChange={e=>setAck(e.target.checked)} /><span>已核查原生任务；仅允许安全的只读重排，不重复未知写入。</span></label><Button disabled={busy||!ack} onClick={()=>change(()=>request('leader.recover',{runId:r.id,expectedRevision:r.planRevision,acknowledged:true}))}>从安全检查点恢复</Button><p>恢复后先暂停；未知写入会被拒绝，请查看 Worktree 并人工核查。</p></>}
    {r.status==='completed'&&view.tasks.some(n=>n.workspace)&&<div className="team-merge"><Button variant="outline" disabled={busy} onClick={()=>change(async()=>{setPreview(await request('leader.merge.preview',{runId:r.id}));setMergeAck(false);})}>预览合并补丁</Button>{preview&&<><p>路径：{preview.paths.join(' / ')||'无改动'} · {preview.allowed?'可以申请应用':`阻断：${preview.reasons.join(' / ')}`}</p><details open><summary>原目录补丁预览</summary><pre>{preview.patch||'无补丁'}</pre></details><label className="leader-check"><input type="checkbox" aria-label="批准应用预览补丁" checked={mergeAck} disabled={!preview.allowed} onChange={e=>setMergeAck(e.target.checked)} /><span>已检查补丁，批准应用到原目录；保持未提交，不 push。</span></label><Button disabled={busy||!preview.allowed||!mergeAck} onClick={()=>change(async()=>{await request('leader.merge.apply',{runId:r.id,expectedHash:preview.hash,acknowledged:true});setPreview(null);setMergeAck(false);})}>应用已批准补丁</Button></>}{view.merges?.map(m=><p key={m.id}>补丁记录：{m.status} · {m.hash.slice(0,16)} {m.reason}</p>)}</div>}
    {view.handoffs?.map(h=><details key={h.id}><summary>Leader 交接 · {h.from} → {h.to} · revision {h.revision}</summary><pre>{h.summary}</pre><p>{h.reason}</p></details>)}
    <div className="team-event-search"><label>审计查询<input aria-label="Run 事件查询" maxLength={200} value={query} onChange={e=>setQuery(e.target.value)} placeholder="事件类型、任务 ID 或原因" /></label><Button variant="outline" disabled={busy} onClick={()=>change(async()=>setEvents(await request('leader.events',{runId:r.id,after:0,limit:100,query})))}>查询 Run 事件</Button>{events&&<><p>{events.length} 条查询结果</p>{events.map(e=><p key={e.id}>{e.sequence} · {e.type} · {e.text}</p>)}{events.length>0&&events.length%100===0&&<Button variant="outline" onClick={()=>change(async()=>setEvents([...events,...await request('leader.events',{runId:r.id,after:events.at(-1)!.sequence,limit:100,query})]))}>加载更多事件</Button>}</>}</div>
  </section>;
}
