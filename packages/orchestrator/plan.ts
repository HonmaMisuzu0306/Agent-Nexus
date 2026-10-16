import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, win32 } from 'node:path';
import { planSchema, type LeaderPlan } from '../shared/leader';
import type { Provider } from '../shared';
export interface PlanScope { runId: string; revision: number; goal: string; workers: readonly Provider[]; allowWrites: boolean; rootPath: string }
export function projectPath(root: string, path: string) {
  if (isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\') || path.split('/').includes('..')) throw new Error('计划路径必须是项目内的相对路径');
  const canonical = realpathSync(root); const target = resolve(canonical, path);
  let ancestor = target; while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) throw new Error('路径不存在'); ancestor = parent; }
  const rel = relative(canonical, realpathSync(ancestor));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('计划路径或符号链接越出项目');
  return target;
}
export function validatePlan(input: unknown, scope: PlanScope): LeaderPlan {
  const plan = planSchema.parse(input);
  if (plan.runId !== scope.runId || plan.revision !== scope.revision || plan.goal !== scope.goal) throw new Error('计划身份、目标或版本不匹配');
  const nodes = new Map(plan.tasks.map(t => [t.taskId, t]));
  if (nodes.size !== plan.tasks.length) throw new Error('重复任务 ID');
  for (const node of plan.tasks) {
    if (!scope.workers.includes(node.assignedAgentId)) throw new Error('计划包含未选择的 Worker');
    if (node.needsWriteAccess && (!scope.allowWrites || node.assignedAgentId !== 'codex')) throw new Error('写入未授权，或 Worker 不支持可审核写入');
    if (new Set(node.dependsOn).size !== node.dependsOn.length || node.dependsOn.some(id => !nodes.has(id))) throw new Error('依赖重复或不存在');
    node.paths.forEach(path => projectPath(scope.rootPath, path));
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) throw new Error('任务依赖存在环'); if (visited.has(id)) return; visiting.add(id); nodes.get(id)!.dependsOn.forEach(visit); visiting.delete(id); visited.add(id); };
  nodes.forEach(n => visit(n.taskId)); return plan;
}
