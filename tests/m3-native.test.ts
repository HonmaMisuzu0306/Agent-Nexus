import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import type { LeaderView } from '../packages/shared/leader';

it.skipIf(process.env.NEXUS_TEST_M3_NATIVE !== '1')('real Codex Leader → real DSH Workers → real Codex review in an isolated fixture repository', async () => {
  mkdirSync('.runtime', { recursive: true }); mkdirSync('test-results', { recursive: true });
  const root = mkdtempSync(join(resolve('.runtime'), 'm3 native ')); const projectRoot = join(root, 'project'); mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));\n');
  writeFileSync(join(projectRoot, 'calc.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add,clamp} from './calc.mjs'; test('addition',()=>assert.equal(add(2,3),5)); test('clamp edges',()=>{assert.equal(clamp(-1,0,10),0);assert.equal(clamp(11,0,10),10);});\n");
  const git = spawnSync('git', ['init', '--quiet', projectRoot], { windowsHide: true }); expect(git.status).toBe(0);
  const fixtureTests = spawnSync(process.execPath, ['--test', 'calc.test.mjs'], { cwd: projectRoot, windowsHide: true, encoding: 'utf8' }); expect(fixtureTests.status).toBe(0);
  const repo = await Repository.open(join(root, 'data', 'nexus.sqlite')); const service = new NexusService(repo); let view: LeaderView | undefined;
  const report: Record<string, unknown> = { date: new Date().toISOString(), native: true, fixtureRoot: projectRoot, status: 'RUNNING', fixtureTests: { exitCode: fixtureTests.status, stdout: fixtureTests.stdout }, sourceRepositorySent: false };
  try {
    const project = repo.addProject('M3 native acceptance', projectRoot); report.installations = await service.detect();
    const run = await service.call('leader.start', { projectId: project.id, leader: 'codex', workers: ['dsh'], control: 'supervised', mode: 'real', allowWrites: false, stepTimeoutMs: 180000, goal: 'Read-only acceptance. Produce exactly two small serial tasks for dsh; second depends on first. First statically explain calc.mjs add and clamp using only calc.mjs; second statically inspect calc.test.mjs and evaluate its assertions using the first result. Require concise file/line evidence. Do not run commands, modify files, search the web or launch other agents. Tests are independently run by the acceptance harness, so workers must not claim they executed tests. No repair is required: both functions are correct.' });
    const wait = async (predicate: (v: LeaderView) => boolean) => { const until = Date.now() + 600000; while (Date.now() < until) { view = repo.leaderView(run.id); if (predicate(view)) return view; if (['blocked','failed','cancelled','interrupted'].includes(view.run.status)) throw Error(view.run.reason ?? view.run.status); await new Promise(r => setTimeout(r, 500)); } throw Error('M3 native timeout'); };
    const pending = await wait(v => v.run.status === 'awaiting_plan_approval'); expect(pending.tasks.length).toBeGreaterThanOrEqual(2); expect(pending.tasks.length).toBeLessThanOrEqual(3); expect(pending.tasks.every(t => t.attempt === 0)).toBe(true);
    report.beforeApproval = { status: pending.run.status, dispatchedWorkers: pending.tasks.filter(n => n.providerTaskId).length };
    // User explicitly requested this read-only synthetic native acceptance; approve only its bounded plan.
    await service.call('leader.approve', { runId: run.id, expectedRevision: pending.run.planRevision, decision: 'approve' });
    view = await wait(v => v.run.status === 'completed');
    expect(view.tasks.every(n => n.result?.source === 'real' && n.status === 'completed' && n.result.rawEventRefs.length > 0)).toBe(true);
    expect(view.run.review?.verdict).toBe('passed'); report.view = view;
    report.providerTasks = [run.id].flatMap(() => repo.tasks(project.id, 0, 30).filter(t => t.leaderRunId === run.id).map(t => ({ task: t, session: repo.session(t.sessionId), events: repo.events(t.id, 0, 100) })));
    report.status = 'PASSED'; console.log(JSON.stringify({ native: true, runId: run.id, workers: view.tasks.length, verdict: view.run.review?.verdict }));
  } catch (e) { report.status = 'FAILED'; report.error = e instanceof Error ? e.message : String(e); if (view) report.view = view; throw e; }
  finally { await service.dispose(); repo.close(); writeFileSync('test-results/m3-native-report.json', JSON.stringify(report, null, 2)); }
}, 900000);
