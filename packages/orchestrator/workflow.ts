import { randomUUID } from 'node:crypto';
import type { LeaderPlan, LeaderRun } from '../shared/leader';
import { validatePlan } from './plan';

// A supplied workflow is a user-authored proposal, never implicit execution permission.
export function initialWorkflow(run: LeaderRun, tasks: LeaderPlan['tasks']) {
  const plan = validatePlan({ runId: run.id, revision: 1, goal: run.goal, tasks }, { runId: run.id, revision: 1, goal: run.goal, workers: run.workers, allowWrites: run.allowWrites, rootPath: run.rootPath });
  return {
    run: { ...run, status: 'awaiting_plan_approval' as const, phase: 'workers' as const, planRevision: 1 },
    extra: { plan, nodes: plan.tasks.map(t => ({ ...t, runId: run.id, status: 'pending' as const, attempt: 0 })), approval: { id: randomUUID(), runId: run.id, revision: 1, status: 'pending' as const, createdAt: new Date().toISOString() }, source: 'user' as const }
  };
}
