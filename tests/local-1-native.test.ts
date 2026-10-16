import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import type { LeaderPlan, LeaderView } from '../packages/shared/leader';

it.skipIf(process.env.NEXUS_TEST_LOCAL_1_NATIVE !== '1')('local self-use: approved workflow, real Codex/DSH, isolated write, review, patch and durable restart', async () => {
  mkdirSync('.runtime', { recursive: true }); mkdirSync('test-results', { recursive: true });
  const root = mkdtempSync(join(resolve('.runtime'), 'local-1 native ')), projectRoot = join(root, 'project'), dataFile = join(root, 'data', 'nexus.sqlite'); mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, 'input.txt'), 'NEXUS_LOCAL_INPUT=5\n');
  const git = (args: string[]) => { const r = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true }); if (r.status) throw Error(r.stderr); return r.stdout.trim(); };
  git(['init', '--quiet']); git(['config', 'core.autocrlf', 'false']); git(['add', 'input.txt']); git(['-c', 'user.name=Local Acceptance', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'synthetic input']);
  const tasks: LeaderPlan['tasks'] = [
    { taskId: 'write', title: 'Create isolated marker', assignedAgentId: 'codex', needsWriteAccess: true, paths: ['result.txt'], dependsOn: [], instruction: 'In this isolated workspace, create ONLY result.txt containing exactly NEXUS_LOCAL_WRITE_OK followed by one newline. Use a file editing tool; no tests, commands, git, network or other agents. Report the exact created content and tests NOT RUN, under 500 characters.', acceptance: ['result.txt contains NEXUS_LOCAL_WRITE_OK and a newline.', 'Only result.txt is changed; report tests NOT RUN.'] },
    { taskId: 'read', title: 'Read synthetic input', assignedAgentId: 'dsh', needsWriteAccess: false, paths: ['input.txt'], dependsOn: [], instruction: 'Read ONLY input.txt. Report its literal first line and file/line evidence. Do not modify files or run tests, commands, network, or other agents. Report tests NOT RUN; keep under 500 characters.', acceptance: ['Report input.txt:1 containing NEXUS_LOCAL_INPUT=5.', 'Report tests NOT RUN without claiming independent test execution.'] }
  ];
  let repo = await Repository.open(dataFile); let service = new NexusService(repo); let id: string | undefined;
  const report: Record<string, unknown> = { native: true, status: 'RUNNING', root, systemPathOnly: true, sourceRepositorySent: false };
  const wait = async (predicate: (v: LeaderView) => boolean) => { const deadline = Date.now() + 480000; while (Date.now() < deadline) { const v = repo.leaderView(id!); if (predicate(v)) return v; if (['blocked', 'failed', 'cancelled', 'interrupted'].includes(v.run.status)) throw Error(v.run.reason ?? v.run.status); if (v.run.status === 'waiting_approval') throw Error('Unexpected native approval; no unreviewed command is auto-approved'); await new Promise(done => setTimeout(done, 200)); } throw Error('Local workflow timeout'); };
  try {
    const project = repo.addProject('Local self-use synthetic acceptance', projectRoot); report.installations = await service.detect();
    const draft = await service.call('workflow.save', { projectId: project.id, expectedVersion: 0, draft: { id: 'local-native', name: 'Local native workflow', goal: 'Bounded synthetic local workflow: create a marker only in an isolated worktree and inspect the provided input. Review file content and diff statically. Tests are NOT RUN by Workers; do not require post-Run harness checks as passing criteria. No private files, commands, network, other agents, commits or publishing.', tasks } });
    const run = await service.call('leader.start', { projectId: project.id, leader: 'codex', workers: ['codex', 'dsh'], mode: 'real', control: 'supervised', allowWrites: true, stepTimeoutMs: 180000, team: { concurrency: 2, reviewer: 'codex', maxReworks: 0, maxDispatches: 2 }, goal: draft.goal, initialTasks: draft.tasks }); id = run.id;
    expect(repo.tasks(project.id)).toEqual([]); expect(repo.leaderRun(id).status).toBe('awaiting_plan_approval');
    await service.call('leader.pause', { runId: id }); await service.call('leader.resume', { runId: id }); expect(repo.leaderRun(id).status).toBe('awaiting_plan_approval'); expect(repo.tasks(project.id)).toEqual([]);
    await service.call('leader.approve', { runId: id, expectedRevision: 1, decision: 'approve' });
    await wait(v => v.tasks.some(n => n.status === 'running')); await service.call('leader.pause', { runId: id }); await new Promise(done => setTimeout(done, 250)); expect(repo.leaderRun(id).status).toBe('paused'); await service.call('leader.resume', { runId: id });
    const done = await wait(v => v.run.status === 'completed'); report.view = done;
    expect(done.tasks.every(n => n.result?.source === 'real' && n.review?.verdict === 'passed' && n.reviewTaskId !== n.providerTaskId)).toBe(true);
    const written = done.tasks.find(n => n.taskId === 'write')!; expect(written.workspace).toBeDefined(); expect(readFileSync(join(written.workspace!.path, 'result.txt'), 'utf8')).toBe('NEXUS_LOCAL_WRITE_OK\n'); expect(existsSync(join(projectRoot, 'result.txt'))).toBe(false); expect(git(['status', '--porcelain'])).toBe('');
    const preview = await service.call('leader.merge.preview', { runId: id }); expect(preview.allowed).toBe(true); expect(preview.paths).toEqual(['result.txt']);
    await service.call('leader.merge.apply', { runId: id, expectedHash: preview.hash, acknowledged: true }); expect(readFileSync(join(projectRoot, 'result.txt'), 'utf8')).toBe('NEXUS_LOCAL_WRITE_OK\n'); expect(git(['status', '--porcelain'])).toContain('result.txt');
    const taskCount = repo.tasks(project.id, 0, 100).length; report.providerTasks = repo.tasks(project.id, 0, 100).map(t => ({ task: t, events: repo.events(t.id, 0, 100) }));
    expect((await service.call('history.search', { projectId: project.id, query: 'NEXUS_LOCAL_WRITE_OK', offset: 0, limit: 100 })).tasks.length).toBeGreaterThan(0);
    await service.dispose(); repo.close(); repo = await Repository.open(dataFile); repo.recoverInterrupted(); service = new NexusService(repo);
    expect(repo.leaderRun(id).status).toBe('completed'); expect(repo.tasks(project.id, 0, 100)).toHaveLength(taskCount); expect(repo.workflowDrafts(project.id)[0].tasks).toHaveLength(2);
    report.status = 'PASSED'; report.checks = ['Zero tasks before first approval including pause/resume', 'Real Codex isolated file write and real DSH read-only task, independent reviews and final summary', 'In-flight pause/resume and only two Worker dispatches', 'Original unchanged until explicit owned-fixture patch approval; exact output verified', 'Full-text evidence search and durable restart without replay'];
    console.log(JSON.stringify({ status: report.status, runId: id, taskCount }));
  } catch (error) { report.status = 'FAILED'; report.error = error instanceof Error ? error.message : String(error); if (id) report.view = repo.leaderView(id); throw error; }
  finally { await service.dispose(); repo.close(); writeFileSync('test-results/local-1-workflow-native-report.json', JSON.stringify(report, null, 2)); }
}, 600000);
