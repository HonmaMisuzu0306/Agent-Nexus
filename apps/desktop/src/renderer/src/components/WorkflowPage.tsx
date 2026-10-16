import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { create } from 'zustand';
import { templateTasks, workflowSchema, workflowTemplates, validateDependencies, type WorkflowDraft } from '../../../../../../packages/shared/workflows';
import { act, request, useStore } from '../store';
import { Button } from './ui/button';
import { WorkflowEditor } from './WorkflowEditor';

export function WorkflowPage() {
  const projectId = useStore(s => s.snapshot?.settings.projectId);
  return projectId ? <ProjectWorkflow key={projectId} projectId={projectId} /> : <p>请先导入并选择项目。</p>;
}
type DraftEdit = { draft: { id: string; name: string; goal: string; tasks: WorkflowDraft['tasks'] }; version: number; busy: boolean };
// Navigation keeps unsaved edits; only an explicit save persists them across app restarts.
const useEdits = create<{ projects: Record<string, DraftEdit> }>(() => ({ projects: {} }));
function ProjectWorkflow({ projectId }: { projectId: string }) {
  const [initial] = useState<DraftEdit>(() => ({ draft: { id: crypto.randomUUID(), name: '新工作流', goal: '', tasks: templateTasks('development', 'codex') }, version: 0, busy: false }));
  const { draft, version, busy } = useEdits(s => s.projects[projectId]) ?? initial;
  const update = (change: (edit: DraftEdit) => DraftEdit) => useEdits.setState(s => ({ projects: { ...s.projects, [projectId]: change(s.projects[projectId] ?? initial) } }));
  const setDraft: Dispatch<SetStateAction<DraftEdit['draft']>> = next => update(edit => ({ ...edit, draft: typeof next === 'function' ? next(edit.draft) : next }));
  const setVersion = (version: number) => update(edit => ({ ...edit, version }));
  const setBusy = (busy: boolean) => update(edit => ({ ...edit, busy }));
  const [saved, setSaved] = useState<WorkflowDraft[]>([]), [selected, setSelected] = useState(''), [template, setTemplate] = useState('development'), [message, setMessage] = useState('');
  useEffect(() => { let live = true; void request('workflow.list', { projectId }).then(v => { if (live) setSaved(v); }).catch(e => useStore.getState().setError(e.message)); return () => { live = false; }; }, [projectId]);
  let validation = ''; try { workflowSchema.parse(draft); validateDependencies(draft.tasks); } catch { validation = '请填写名称、总体目标、节点指令与验收；最多 10 节点、8 条验收，路径使用项目相对路径。'; }
  const operation = (fn: () => Promise<void>) => act(async () => { setBusy(true); try { await fn(); } finally { setBusy(false); } });
  return <section className="workflow-page" aria-label="工作流草案"><div className="section-label">WORKFLOW / M5 <span>{draft.tasks.length} / 10 节点 · {version ? `保存版本 ${version}` : '未保存'}</span></div><p>草案保存在当前项目。保存不调用模型，创建 Run 后仍需批准执行。内置模板默认只读；编码/修复需要写入时，请显式设置节点权限并在 Leader 配置中授权。</p>
    <div className="workflow-actions"><label>工作流模板<select aria-label="工作流模板" value={template} onChange={e => setTemplate(e.target.value)}>{workflowTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><Button variant="outline" disabled={busy} onClick={() => { setDraft(d => ({ ...d, tasks: templateTasks(template, 'codex') })); setMessage('模板已载入当前编辑；保存后生效。'); }}>使用模板</Button><Button variant="outline" disabled={busy} onClick={() => { setDraft({ id: crypto.randomUUID(), name: '新工作流', goal: '', tasks: [templateTasks('bugfix', 'codex')[0]] }); setVersion(0); setMessage('新草案已建立。'); }}>新建草案</Button></div>
    <div className="workflow-actions"><label>已保存工作流<select aria-label="已保存工作流" value={selected} onChange={e => setSelected(e.target.value)}><option value="">选择草案</option>{saved.map(d => <option key={d.id} value={d.id}>{d.name} · v{d.version}</option>)}</select></label><Button variant="outline" disabled={!selected || busy} onClick={() => operation(async () => { const list = await request('workflow.list', { projectId }); setSaved(list); const d = list.find(d => d.id === selected); if (!d) throw Error('草案已移除'); setDraft({ id: d.id, name: d.name, goal: d.goal, tasks: d.tasks }); setVersion(d.version); setMessage('草案已载入，替换当前编辑。'); })}>载入草案</Button><Button variant="outline" disabled={!version || busy} onClick={() => operation(async () => { await request('workflow.remove', { projectId, id: draft.id, expectedVersion: version }); setSaved(await request('workflow.list', { projectId })); setVersion(0); setMessage('已删除保存记录；当前编辑仍保留。'); })}>删除保存记录</Button></div>
    <label>工作流名称<input aria-label="工作流名称" maxLength={100} value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} /></label><label>总体目标<textarea aria-label="工作流总体目标" rows={3} maxLength={8000} value={draft.goal} onChange={e => setDraft(d => ({ ...d, goal: e.target.value }))} /></label>
    <WorkflowEditor tasks={draft.tasks} onChange={tasks => setDraft(d => ({ ...d, tasks }))} />
    {validation && <p>{validation}</p>}<div className="workflow-actions"><Button disabled={!!validation || busy} onClick={() => operation(async () => { const d = await request('workflow.save', { projectId, expectedVersion: version, draft }); setVersion(d.version); setSaved(await request('workflow.list', { projectId })); setSelected(d.id); setMessage(`已保存工作流 · v${d.version}`); })}>保存工作流</Button><Button variant="outline" disabled={!!validation || busy} onClick={() => useStore.getState().loadWorkflow({ goal: draft.goal, tasks: draft.tasks })}>载入 Leader 配置</Button></div><p role="status" aria-label="工作流消息">{message}</p>
  </section>;
}
