import { lazy, Suspense, useState } from 'react';
import type { LeaderPlan } from '../../../../../../packages/shared/leader';
import type { Provider } from '../../../../../../packages/shared';
import { providers } from '../../../../../../packages/shared/constants';
import { validateDependencies } from '../../../../../../packages/shared/workflows';
import { providerMeta } from './AgentPanel';
import { Button } from './ui/button';
import './workflow.css';
const Graph = lazy(() => import('./WorkflowGraph').then(m => ({ default: m.WorkflowGraph })));
export function WorkflowEditor({ tasks, onChange, workers = providers }: { tasks: LeaderPlan['tasks']; onChange: (tasks: LeaderPlan['tasks']) => void; workers?: readonly Provider[] }) {
  const [selected, setSelected] = useState(tasks[0]?.taskId ?? ''); const [error, setError] = useState('');
  const task = tasks.find(t => t.taskId === selected) ?? tasks[0];
  const update = (patch: Partial<LeaderPlan['tasks'][number]>) => onChange(tasks.map(t => t.taskId === task?.taskId ? { ...t, ...patch } : t));
  const dependencies = (dependsOn: string[]) => { try { const next = tasks.map(t => t.taskId === task?.taskId ? { ...t, dependsOn } : t); validateDependencies(next); onChange(next); setError(''); } catch (e) { setError((e as Error).message); } };
  return <div className="workflow-editor">
    <Suspense fallback={<p>正在载入工作流图…</p>}><Graph tasks={tasks} selected={task?.taskId} onSelect={setSelected} onChange={onChange} onError={setError} /></Suspense>
    <p className="workflow-hint">拖动节点调整位置，连接右侧到左侧端口添加依赖；选中连线后按 Delete 删除。也可用下方表单编辑全部内容。节点位置仅在当前编辑期间保留。</p>
    {error && <p role="alert">{error}</p>}
    <div className="workflow-actions"><label>当前节点<select aria-label="当前工作流节点" value={task?.taskId ?? ''} onChange={e => setSelected(e.target.value)}>{tasks.map(t => <option key={t.taskId} value={t.taskId}>{t.taskId} · {t.title}</option>)}</select></label><Button variant="outline" disabled={tasks.length >= 10} onClick={() => { const taskId = `task_${crypto.randomUUID().slice(0, 8)}`; onChange([...tasks, { taskId, title: '新任务', instruction: '说明此任务的范围与产物', assignedAgentId: workers[0] ?? 'codex', dependsOn: [], acceptance: ['提供结果和实际证据'], paths: [], needsWriteAccess: false }]); setSelected(taskId); }}>添加节点</Button><Button variant="outline" disabled={tasks.length <= 1} onClick={() => { onChange(tasks.filter(t => t.taskId !== task.taskId).map(t => ({ ...t, dependsOn: t.dependsOn.filter(id => id !== task.taskId) }))); setError(''); }}>删除当前节点</Button></div>
    {task && <div className="workflow-fields"><label>节点标题<input aria-label="节点标题" maxLength={200} value={task.title} onChange={e => update({ title: e.target.value })} /></label><label>执行 Worker<select aria-label="节点 Worker" value={task.assignedAgentId} onChange={e => update({ assignedAgentId: e.target.value as Provider, needsWriteAccess: e.target.value === 'codex' && task.needsWriteAccess })}>{workers.map(p => <option key={p} value={p}>{providerMeta[p].name}</option>)}</select></label><label className="wide">节点指令<textarea aria-label="节点指令" rows={3} maxLength={6000} value={task.instruction} onChange={e => update({ instruction: e.target.value })} /></label><label>验收标准（每行一条）<textarea aria-label="节点验收标准" rows={3} value={task.acceptance.join('\n')} onChange={e => update({ acceptance: e.target.value.split('\n') })} /></label><label>项目相对路径（每行一条，可空）<textarea aria-label="节点项目路径" rows={3} value={task.paths.join('\n')} onChange={e => update({ paths: e.target.value ? e.target.value.split('\n') : [] })} /></label><label className="workflow-check wide"><input type="checkbox" aria-label="节点需要项目写入" disabled={task.assignedAgentId !== 'codex'} checked={task.needsWriteAccess} onChange={e => update({ needsWriteAccess: e.target.checked })} />节点需要项目写入（还须在 Leader 配置中单独授权）</label><fieldset className="wide"><legend>前置依赖</legend>{tasks.filter(t => t.taskId !== task.taskId).map(t => <label className="workflow-check" key={t.taskId}><input type="checkbox" aria-label={`依赖 ${t.taskId}`} checked={task.dependsOn.includes(t.taskId)} onChange={e => dependencies(e.target.checked ? [...task.dependsOn, t.taskId] : task.dependsOn.filter(id => id !== t.taskId))} />{t.taskId} · {t.title}</label>)}{tasks.length === 1 && <p>暂无其他节点。</p>}</fieldset></div>}
  </div>;
}
