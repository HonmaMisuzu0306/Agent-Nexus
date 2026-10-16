import { useEffect, useState } from 'react';
import type { Task } from '../../../../../../packages/shared';
import { request, act, useStore } from '../store';
import { providerMeta, taskStatus } from './AgentPanel';
import { Button } from './ui/button';
import './history.css';
export function HistorySearchPage() {
  const projectId = useStore(s => s.snapshot?.settings.projectId);
  return projectId ? <ProjectHistory key={projectId} projectId={projectId} /> : <p>请先选择项目。</p>;
}
function ProjectHistory({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState(''), [applied, setApplied] = useState(''), [tasks, setTasks] = useState<Task[]>([]), [hasMore, setHasMore] = useState(false), [revision, setRevision] = useState(0), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { let live = true; setBusy(true); void request('history.search', { projectId, query: applied, offset: 0, limit: 30 }).then(p => { if (live) { setTasks(p.tasks); setHasMore(p.hasMore); } }).catch(e => { if (live) useStore.getState().setError(e.message); }).finally(() => { if (live) setBusy(false); }); return () => { live = false; }; }, [projectId, applied, revision]);
  return <><form className="history-search" onSubmit={e => { e.preventDefault(); setApplied(query.trim()); setRevision(r => r + 1); }}><label>搜索全部历史目标与日志<input aria-label="历史全文搜索" maxLength={200} value={query} onChange={e => setQuery(e.target.value)} placeholder="按当前项目搜索全部持久化目标和日志…" /></label><Button disabled={busy}>搜索历史</Button><Button type="button" variant="outline" onClick={() => setRevision(r => r + 1)}>刷新历史</Button></form>
    <div className="history-diagnostic"><p>点击任务在监视器查看事件时间线。诊断仅含汇总计数，不含目标、日志、路径或凭证。</p><Button variant="outline" size="sm" onClick={() => act(async () => { const r = await request('diagnostics.export', {}); setMessage(r.cancelled ? '已取消导出。' : '脱敏诊断已保存。'); })}>导出脱敏诊断</Button></div><p role="status" aria-label="历史消息">{message}</p>
    {!tasks.length ? <p>暂无匹配的任务历史。</p> : <div className="history-list">{tasks.map((t, i) => <button key={t.id} className="history-item" onClick={() => useStore.getState().inspectTask(t)}><span className="micro">{String(i + 1).padStart(2, '0')}</span><span><b>{t.prompt}</b><small>{providerMeta[t.provider].name} · {t.mode === 'mock' ? '模拟任务' : t.mode === 'bridge' ? '桥接 / 客户端报告' : '真实任务'} · {new Date(t.createdAt).toLocaleString('zh-CN')}</small></span><span className={`history-status state-${t.status}`}>{taskStatus(t)}</span></button>)}</div>}
    {hasMore && <Button variant="outline" disabled={busy} onClick={() => act(async () => { setBusy(true); try { const p = await request('history.search', { projectId, query: applied, offset: tasks.length, limit: 30 }); setTasks(t => [...t, ...p.tasks.filter(n => !t.some(old => old.id === n.id))]); setHasMore(p.hasMore); } finally { setBusy(false); } })}>加载更早任务</Button>}
  </>;
}
