import { z } from 'zod';
import { planSchema, type LeaderPlan } from './leader';
import type { Provider } from './index';

export const workflowSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), name: z.string().trim().min(1).max(100), goal: z.string().trim().min(1).max(8000), tasks: planSchema.shape.tasks }).strict();
export type WorkflowDraft = z.infer<typeof workflowSchema> & { projectId: string; version: number; updatedAt: string };
const identity = { projectId: z.string().min(1).max(100) };
export const workflowRequests = {
  'workflow.list': z.object(identity).strict(),
  'workflow.save': z.object({ ...identity, expectedVersion: z.number().int().min(0), draft: workflowSchema }).strict(),
  'workflow.remove': z.object({ ...identity, id: workflowSchema.shape.id, expectedVersion: z.number().int().min(1) }).strict()
};
export function validateDependencies(tasks: LeaderPlan['tasks']) {
  const nodes = new Map(tasks.map(t => [t.taskId, t]));
  if (nodes.size !== tasks.length) throw Error('重复任务 ID');
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw Error('任务依赖存在环');
    if (visited.has(id)) return;
    const node = nodes.get(id); if (!node) throw Error('依赖节点不存在');
    if (new Set(node.dependsOn).size !== node.dependsOn.length) throw Error('依赖重复');
    visiting.add(id); node.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  };
  nodes.forEach(n => visit(n.taskId));
}
export const workflowTemplates = [
  { id: 'development', name: '需求 → 编码 → 测试 → 审查', steps: ['需求分析', '编码实现', '测试验证', '交付审查'] },
  { id: 'review', name: '多 Agent 评审', steps: ['实现评审', '安全评审', '汇总分歧与建议'] },
  { id: 'bugfix', name: 'Bug 修复', steps: ['复现与定位', '最小修复', '回归验证'] }
] as const;
export function templateTasks(template: string, worker: Provider): LeaderPlan['tasks'] {
  const preset = workflowTemplates.find(t => t.id === template); if (!preset) throw Error('模板不存在');
  return preset.steps.map((title, i) => ({ taskId: `step_${i + 1}`, title, instruction: `${title}：根据本次总体目标完成此步骤，报告真实证据及未验证项。仅在批准的权限内操作。`, assignedAgentId: worker, dependsOn: template === 'review' ? i === 2 ? ['step_1', 'step_2'] : [] : i ? [`step_${i}`] : [], acceptance: ['提供可追踪的结果和证据；明确测试已运行或未运行。'], needsWriteAccess: false, paths: [] }));
}
