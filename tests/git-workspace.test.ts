import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWorkspace } from '../packages/git-workspace';

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', shell: false, windowsHide: true });
}

describe('GitWorkspace using real isolated synthetic repositories', () => {
  let fixture: string;
  let project: string;
  let workspaces: GitWorkspace;

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'nexus-m35-git-'));
    project = join(fixture, 'project');
    await mkdir(project);
    git(project, ['init', '--quiet']);
    git(project, ['config', 'user.name', 'Synthetic Test']);
    git(project, ['config', 'user.email', 'synthetic@example.invalid']);
    git(project, ['config', 'core.autocrlf', 'false']);
    await writeFile(join(project, 'base.txt'), 'baseline\n');
    git(project, ['add', '--', 'base.txt']);
    git(project, ['commit', '--quiet', '-m', 'synthetic baseline']);
    workspaces = new GitWorkspace(join(fixture, 'owned'));
  });

  afterEach(async () => {
    const location = resolve(fixture);
    const within = relative(resolve(tmpdir()), location);
    if (!within || isAbsolute(within) || within.startsWith('..') || !within.startsWith('nexus-m35-git-')) {
      throw new Error('Unsafe fixture cleanup');
    }
    await rm(location, { recursive: true, force: true });
  });

  const create = () => workspaces.create({ projectRoot: project, runId: 'run-1', taskId: 'task-1' });

  it('creates two distinct worktrees from HEAD while preserving dirty original content and index', async () => {
    await writeFile(join(project, 'base.txt'), 'private original edit\n');
    await writeFile(join(project, 'private.txt'), 'private untracked\n');
    const status = git(project, ['status', '--porcelain=v1']);
    const first = await create();
    const second = await create();
    expect(first.path).not.toBe(second.path);
    expect(first.branch).not.toBe(second.branch);
    expect(await readFile(join(first.path, 'base.txt'), 'utf8')).toBe('baseline\n');
    await writeFile(join(first.path, 'base.txt'), 'worker one\n');
    expect(await readFile(join(second.path, 'base.txt'), 'utf8')).toBe('baseline\n');
    expect(await readFile(join(project, 'base.txt'), 'utf8')).toBe('private original edit\n');
    expect(git(project, ['status', '--porcelain=v1'])).toBe(status);
    expect((await workspaces.preview([first])).reasons).toContain('dirty-target');
  });

  it('rejects non-repositories, nested directories and unborn HEAD without initializing them', async () => {
    const plain = join(fixture, 'plain');
    const nested = join(project, 'nested');
    const unborn = join(fixture, 'unborn');
    await Promise.all([mkdir(plain), mkdir(nested), mkdir(unborn)]);
    git(unborn, ['init', '--quiet']);
    for (const root of [plain, nested, unborn]) {
      await expect(workspaces.create({ projectRoot: root, runId: 'r', taskId: 't' })).rejects.toThrow();
    }
    await expect(readFile(join(plain, '.git', 'HEAD'))).rejects.toThrow();
  });

  it('validates durable ownership, branch and registered repository across module restarts', async () => {
    const record = await create();
    const restarted = new GitWorkspace(join(fixture, 'owned'));
    await expect(restarted.validate(record)).resolves.toBeUndefined();
    await expect(restarted.validate({ ...record, path: project })).rejects.toThrow();
    await expect(restarted.validate({ ...record, branch: 'wrong-branch' })).rejects.toThrow();
    await expect(restarted.validate({ ...record, baseCommit: '0'.repeat(40) })).rejects.toThrow();
  });

  it('snapshots committed and uncommitted edits and untracked files without staging them', async () => {
    const record = await create();
    await writeFile(join(record.path, 'committed.txt'), 'committed worker\n');
    git(record.path, ['add', '--', 'committed.txt']);
    git(record.path, ['commit', '--quiet', '-m', 'synthetic worker commit']);
    await writeFile(join(record.path, 'base.txt'), 'working change\n');
    await writeFile(join(record.path, 'new file.txt'), 'new worker\n');
    const status = git(record.path, ['status', '--porcelain=v1']);
    const snapshot = await workspaces.snapshot(record);
    expect(snapshot.changedPaths).toEqual(['base.txt', 'committed.txt', 'new file.txt']);
    expect(snapshot.diff).toContain('+working change');
    expect(snapshot.diff).toContain('+committed worker');
    expect(snapshot.diff).toContain('+new worker');
    expect(snapshot.truncated).toBe(false);
    expect(git(record.path, ['status', '--porcelain=v1'])).toBe(status);
    expect(git(project, ['status', '--porcelain=v1'])).toBe('');
  });

  it('previews read-only and applies disjoint new text and binary files as uncommitted changes', async () => {
    const first = await create();
    const second = await create();
    await writeFile(join(first.path, 'first.txt'), 'first result\n');
    const binary = Buffer.from([0, 255, 1, 2, 0, 19]);
    await writeFile(join(second.path, 'binary.bin'), binary);
    const head = git(project, ['rev-parse', 'HEAD']);
    const preview = await workspaces.preview([first, second]);
    expect(preview.allowed).toBe(true);
    expect(preview.paths).toEqual(['binary.bin', 'first.txt']);
    expect(git(project, ['status', '--porcelain=v1'])).toBe('');
    await workspaces.apply([first, second], preview.hash);
    expect(await readFile(join(project, 'first.txt'), 'utf8')).toBe('first result\n');
    expect(await readFile(join(project, 'binary.bin'))).toEqual(binary);
    expect(git(project, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(project, ['diff', '--cached'])).toBe('');
    expect(git(project, ['status', '--porcelain=v1'])).toContain('?? first.txt');
  });

  it('refuses stale worker content without writing the target', async () => {
    const record = await create();
    await writeFile(join(record.path, 'base.txt'), 'first revision\n');
    const preview = await workspaces.preview([record]);
    await writeFile(join(record.path, 'base.txt'), 'later revision\n');
    await expect(workspaces.apply([record], preview.hash)).rejects.toThrow(/stale/i);
    expect(await readFile(join(project, 'base.txt'), 'utf8')).toBe('baseline\n');
  });

  it('refuses a target changed after preview and preserves its exact contents', async () => {
    const record = await create();
    await writeFile(join(record.path, 'base.txt'), 'worker\n');
    const preview = await workspaces.preview([record]);
    await writeFile(join(project, 'base.txt'), 'user changed target\n');
    await expect(workspaces.apply([record], preview.hash)).rejects.toThrow();
    expect(await readFile(join(project, 'base.txt'), 'utf8')).toBe('user changed target\n');
  });

  it('refuses overlapping worker paths even when changes look compatible', async () => {
    const first = await create();
    const second = await create();
    await writeFile(join(first.path, 'base.txt'), 'same worker change\n');
    await writeFile(join(second.path, 'base.txt'), 'same worker change\n');
    const preview = await workspaces.preview([first, second]);
    expect(preview.allowed).toBe(false);
    expect(preview.reasons).toContain('overlap');
    await expect(workspaces.apply([first, second], preview.hash)).rejects.toThrow();
    expect(await readFile(join(project, 'base.txt'), 'utf8')).toBe('baseline\n');
  });

  it('refuses different bases and a target HEAD advanced after creation', async () => {
    const first = await create();
    await writeFile(join(project, 'later.txt'), 'later base\n');
    git(project, ['add', '--', 'later.txt']);
    git(project, ['commit', '--quiet', '-m', 'later synthetic base']);
    const second = await create();
    const preview = await workspaces.preview([first, second]);
    expect(preview.allowed).toBe(false);
    expect(preview.reasons).toContain('different-base');
    expect((await workspaces.preview([first])).reasons).toContain('stale-target');
  });

  it('refuses a changed Git symlink even on Windows with symlink checkout disabled', async () => {
    const record = await create();
    const blob = git(record.path, ['hash-object', '-w', '--stdin'], '../outside').trim();
    git(record.path, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
    git(record.path, ['commit', '--quiet', '-m', 'synthetic symlink']);
    await writeFile(join(record.path, 'link'), '../outside');
    const preview = await workspaces.preview([record]);
    expect(preview.allowed).toBe(false);
    expect(preview.reasons).toContain('symlink');
  });

  it('refuses an escaped persisted worktree path', async () => {
    const record = await create();
    const preview = await workspaces.preview([{ ...record, path: project }]);
    expect(preview.allowed).toBe(false);
    expect(preview.reasons).toContain('escaped-path');
  });

  it('bounds a large snapshot and refuses application of a truncated patch', async () => {
    const record = await create();
    await writeFile(join(record.path, 'large.txt'), 'x'.repeat(1_100_000));
    const snapshot = await workspaces.snapshot(record);
    expect(snapshot.bounded).toBe(true);
    expect(snapshot.truncated).toBe(true);
    expect(Buffer.byteLength(snapshot.diff)).toBeLessThanOrEqual(1_048_576);
    const preview = await workspaces.preview([record]);
    expect(preview.allowed).toBe(false);
    expect(preview.reasons).toContain('truncated');
  });
});
