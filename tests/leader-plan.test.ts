import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePlan } from '../packages/orchestrator/plan';
import { planSchema, reviewSchema, actionSchema } from '../packages/shared/leader';

const plan = { runId: 'r', revision: 1, goal: 'Analyse', tasks: [{ taskId: 'a', title: 'Inspect', instruction: 'Inspect', assignedAgentId: 'dsh', dependsOn: [], acceptance: ['Evidence'], needsWriteAccess: false, paths: [] }] };
it('accepts a bounded DAG and refuses cycles, missing dependencies, duplicate nodes and unselected agents', () => {
  const root = mkdtempSync(join(tmpdir(), 'Nexus plan '));
  try {
    const scope = { runId: 'r', revision: 1, goal: 'Analyse', workers: ['dsh'] as const, allowWrites: false, rootPath: root };
    expect(validatePlan(plan, scope).tasks).toHaveLength(1);
    for (const tasks of [[plan.tasks[0], plan.tasks[0]], [{ ...plan.tasks[0], dependsOn: ['a'] }], [{ ...plan.tasks[0], dependsOn: ['missing'] }], [{ ...plan.tasks[0], assignedAgentId: 'codex' }], Array.from({ length: 11 }, (_, i) => ({ ...plan.tasks[0], taskId: String(i) }))]) expect(() => validatePlan({ ...plan, tasks }, scope)).toThrow();
    expect(() => validatePlan({ ...plan, revision: 2 }, scope)).toThrow();
    expect(() => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], needsWriteAccess: true }] }, scope)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('rejects outside paths, absolute paths and symbolic links escaping the project', () => {
  const base = mkdtempSync(join(tmpdir(), 'Nexus scope ')); const root = join(base, 'project'); mkdirSync(root); mkdirSync(join(base, 'outside'));
  try {
    symlinkSync(join(base, 'outside'), join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const scope = { runId: 'r', revision: 1, goal: 'Analyse', workers: ['dsh'] as const, allowWrites: false, rootPath: root };
    for (const p of ['../outside', 'escape/file.txt', '/outside', 'C:\\secrets\\private.txt']) expect(() => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], paths: [p] }] }, scope)).toThrow();
  } finally { rmSync(base, { recursive: true, force: true }); }
});
it('strictly rejects executable text, unknown action keys and non-whitelisted actions', () => {
  expect(() => planSchema.parse('run a command')).toThrow();
  expect(() => planSchema.parse({ ...plan, command: 'whoami' })).toThrow();
  expect(() => actionSchema.parse({ actionId: 'x', runId: 'r', expectedRevision: 1, type: 'shell', reason: 'x' })).toThrow();
  expect(() => actionSchema.parse({ actionId: 'x', runId: 'r', expectedRevision: 1, type: 'assign_task', taskId: 'a', reason: 'x', cwd: '../' })).toThrow();
  expect(() => reviewSchema.parse({ runId: 'r', revision: 1, verdict: 'passed', summary: 'x', unmet: [], budget: 100 })).toThrow();
});
