import { useState } from 'react';
import type { LeaderView } from '../../../../../../packages/shared/leader';
import { planSchema } from '../../../../../../packages/shared/leader';
import { validateDependencies } from '../../../../../../packages/shared/workflows';
import { request, act } from '../store';
import { WorkflowEditor } from './WorkflowEditor';
import { Button } from './ui/button';

export function PlanDraftEditor({ view, onSaved }: { view: LeaderView; onSaved: (v: LeaderView) => void }) {
  const [tasks, setTasks] = useState(view.plan!.tasks), [busy, setBusy] = useState(false);
  const [revision] = useState(view.run.planRevision); let invalid = false;
  try { planSchema.shape.tasks.parse(tasks); validateDependencies(tasks); } catch { invalid = true; }
  return <section className="workflow-page"><p>正在编辑 revision {revision}。保存将使旧审批失效；已有审批或执行状态改变时会拒绝保存。</p><WorkflowEditor tasks={tasks} onChange={setTasks} workers={view.run.workers} /><Button disabled={busy || invalid} onClick={() => act(async () => { setBusy(true); try { onSaved(await request('leader.plan.update', { runId: view.run.id, expectedRevision: revision, tasks })); } finally { setBusy(false); } })}>保存计划新版本</Button>{invalid && <p role="alert">请检查节点字段及依赖。</p>}</section>;
}
