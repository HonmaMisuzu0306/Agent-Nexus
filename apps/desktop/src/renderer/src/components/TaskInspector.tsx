import { appVersion } from '../../../../../../packages/shared/constants';
import { useEffect, useRef, useState } from 'react';
import { PanelRightClose, ChevronDown, Activity } from 'lucide-react';
import type { AgentEvent, Task } from '../../../../../../packages/shared';
import { act, request, useStore } from '../store';
import { providerMeta, taskStatus } from './AgentPanel';
import { Approvals } from './Approvals';
import { EventTimeline } from './EventTimeline';
import { Button } from './ui/button';

export function TaskInspector() {
  const tasks = useStore(s => s.tasks); const selectedId = useStore(s => s.selectedTaskId);
  const inspected = useStore(s => s.inspectedTask);
  const task = tasks.find(t => t.id === selectedId) ?? (inspected?.id === selectedId ? inspected : null) ?? tasks[0];
  const generation = useRef(0); const [searchRevision, setSearchRevision] = useState(0); const [pageBusy, setPageBusy] = useState(false);
  const [query, setQuery] = useState(''), [applied, setApplied] = useState('');
  const [events, setEvents] = useState<AgentEvent[]>([]); const [hasMore, setHasMore] = useState(false);
  const [loadedThrough, setLoadedThrough] = useState(0);
  useEffect(() => {
    const revision = ++generation.current; let live = true; setPageBusy(false); setEvents([]); setHasMore(false); setLoadedThrough(0);
    if (!task) return;
    request('events.list', { taskId: task.id, query: applied, after: 0, limit: 50 }).then(e => { if (live) { setEvents(old => [...new Map([...e, ...old].map(x => [x.eventId, x])).values()].sort((a, b) => a.sequence - b.sequence)); setLoadedThrough(e.at(-1)?.sequence ?? 0); setHasMore(e.length === 50); } }).catch(e => { if (live) useStore.getState().setError(e.message); });
    const unsubscribe = window.nexus.onEvent(e => { if (e.taskId === task.id && !applied) setEvents(old => old.some(x => x.eventId === e.eventId) ? old : [...old, e].sort((a, b) => a.sequence - b.sequence)); });
    return () => { live = false; if (generation.current === revision) generation.current++; unsubscribe(); };
  }, [task?.id, applied, searchRevision]);
  return <aside className="inspector">
    <header><div><span className="micro">TASK / TELEMETRY</span><h2>任务监视器</h2></div><button aria-label="收起任务详情" title="收起任务详情" onClick={() => useStore.getState().toggleInspector()}><PanelRightClose size={17} /></button></header>
    <div className="inspector-summary"><span className="state-dot green" />本地事件持久化<span className="micro">SQLITE</span></div>
    <div className="task-list"><div className="section-label">近期任务 <span>{String(tasks.length).padStart(2, '0')}</span></div>{!tasks.length ? <div className="inspector-empty"><Activity size={28} strokeWidth={1} /><p>暂无任务</p><span>启动任务后，事件将在此显示。</span></div> : tasks.slice(0, 8).map((t, i) => <button key={t.id} className={`task-item ${task?.id === t.id ? 'selected' : ''}`} onClick={() => useStore.getState().selectTask(t.id)}><span className="task-index">{String(i + 1).padStart(2, '0')}</span><span><b>{t.prompt}</b><small>{providerMeta[t.provider].name} · {t.mode === 'mock' ? '模拟任务' : t.mode === 'bridge' ? '桥接 / 客户端报告' : '真实任务'}</small></span><i className={`task-state state-${t.status}`} title={taskStatus(t)} /></button>)}</div>
    {task && <><TaskInfo task={task} /><Approvals taskId={task.id} /><div className="event-section"><div className="section-label">事件日志 <span>{events.length}</span></div><form className="event-search" onSubmit={e => { e.preventDefault(); setApplied(query.trim()); setSearchRevision(r => r + 1); }}><input aria-label="任务日志搜索" maxLength={200} placeholder="搜索此任务全部事件…" value={query} onChange={e => setQuery(e.target.value)} /><Button size="sm">查找</Button></form><p>{applied ? '搜索结果为当前快照；再次查找可刷新新增日志。' : '显示已载入事件和实时输出。'}</p><EventTimeline key={`${task.id}:${applied}:${searchRevision}`} events={events} /><div className="event-log">{hasMore && <Button size="sm" variant="outline" disabled={pageBusy} onClick={() => act(async () => { const revision = generation.current; setPageBusy(true); try { const e = await request('events.list', { taskId: task.id, query: applied, after: loadedThrough, limit: 50 }); if (revision !== generation.current) return; setEvents(old => [...new Map([...old, ...e].map(x => [x.eventId, x])).values()].sort((a, b) => a.sequence - b.sequence)); setLoadedThrough(e.at(-1)?.sequence ?? loadedThrough); setHasMore(e.length === 50); } finally { if (revision === generation.current) setPageBusy(false); } })}>加载后续日志 <ChevronDown size={12} /></Button>}</div></div></>}
    <footer><span className="yellow-rule" />本地工作台<span>LOCAL / {appVersion}</span></footer>
  </aside>;
}
function TaskInfo({ task }: { task: Task }) {
  return <div className="task-info"><div><span>任务状态</span><strong className={task.status === 'failed' ? 'error' : ''}>{taskStatus(task)}</strong></div><div><span>任务 ID</span><code>{task.id}</code></div><div><span>任务目标</span><span className="full-prompt">{task.prompt}</span></div><div><span>模型 / 权限</span><span>{task.mode === 'bridge' ? '模型未知 · 权限由 WorkBuddy 管理' : `${task.model ?? '模拟 / 未知'} · ${task.sandbox ?? '无文件执行'}`}</span></div><div><span>费用</span><span>{task.mode === 'bridge' ? '未知；桥接不报告用量' : '未知；原生 Token 见事件日志'}</span></div></div>;
}
