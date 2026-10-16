export interface WorkspaceRecord {
  id: string;
  runId: string;
  taskId: string;
  projectRoot: string;
  path: string;
  branch: string;
  baseCommit: string;
  createdAt: string;
}

export interface WorkspaceSnapshot {
  diff: string;
  changedPaths: string[];
  head: string;
  hash: string;
  bounded: boolean;
  truncated: boolean;
}

export interface MergePreview {
  hash: string;
  patch: string;
  paths: string[];
  allowed: boolean;
  reasons: string[];
}

export class GitWorkspace {
  readonly ownedWorktreesRoot: string;
  private applyTail: Promise<unknown> = Promise.resolve();

  constructor(ownedWorktreesRoot: string) {
    this.ownedWorktreesRoot = resolve(ownedWorktreesRoot);
  }

  async create(input: { projectRoot: string; runId: string; taskId: string }): Promise<WorkspaceRecord> {
    const projectRoot = await realpath(resolve(input.projectRoot));
    if (!input.runId || !input.taskId) throw new Error('Workspace run and task IDs are required');
    const top = (await git(projectRoot, ['rev-parse', '--show-toplevel'])).text.trim();
    if (!samePath(await realpath(top), projectRoot)) throw new Error('Project must be a Git repository root');
    const baseCommit = (await git(projectRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).text.trim();
    await mkdir(this.ownedWorktreesRoot, { recursive: true });
    if (!samePath(await realpath(this.ownedWorktreesRoot), this.ownedWorktreesRoot)) throw new Error('escaped-path');
    const id = randomUUID();
    const path = join(this.ownedWorktreesRoot, id);
    const branch = `nexus/${id}`;
    await git(projectRoot, ['worktree', 'add', '-b', branch, '--', path, baseCommit]);
    const record: WorkspaceRecord = { id, runId: input.runId, taskId: input.taskId, projectRoot, path, branch, baseCommit, createdAt: new Date().toISOString() };
    await this.validate(record);
    return record;
  }

  async validate(record: WorkspaceRecord): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(record.id) || !samePath(record.path, join(this.ownedWorktreesRoot, record.id))) throw new Error('escaped-path');
    if (!samePath(await realpath(this.ownedWorktreesRoot), this.ownedWorktreesRoot)
      || !samePath(await realpath(record.path), record.path)) throw new Error('escaped-path');
    if (record.branch !== `nexus/${record.id}` || !/^[a-f0-9]{40,64}$/i.test(record.baseCommit)) throw new Error('invalid-workspace');
    const root = (await git(record.projectRoot, ['rev-parse', '--show-toplevel'])).text.trim();
    if (!samePath(await realpath(root), record.projectRoot)) throw new Error('invalid-workspace');
    const top = (await git(record.path, ['rev-parse', '--show-toplevel'])).text.trim();
    if (!samePath(await realpath(top), record.path)) throw new Error('escaped-path');
    const common = (await git(record.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).text.trim();
    const originalCommon = (await git(record.projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).text.trim();
    if (!samePath(await realpath(common), await realpath(originalCommon))) throw new Error('invalid-workspace');
    if ((await git(record.path, ['symbolic-ref', '--short', 'HEAD'])).text.trim() !== record.branch) throw new Error('invalid-workspace');
    const registered = (await git(record.projectRoot, ['worktree', 'list', '--porcelain', '-z'])).text.split('\0\0');
    if (!registered.some(entry => entry.split('\0').some(line => line === `worktree ${record.path.replaceAll('\\', '/')}`)
      && entry.split('\0').includes(`branch refs/heads/${record.branch}`))) throw new Error('invalid-workspace');
    await git(record.path, ['merge-base', '--is-ancestor', record.baseCommit, 'HEAD']);
  }

  async snapshot(record: WorkspaceRecord): Promise<WorkspaceSnapshot> {
    return (await this.capture(record)).snapshot;
  }

  private async capture(record: WorkspaceRecord): Promise<{ snapshot: WorkspaceSnapshot; reasons: string[] }> {
    await this.validate(record);
    const indexPath = join(this.ownedWorktreesRoot, `.index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      // An isolated index includes new files without touching either real staging area.
      await git(record.path, ['read-tree', 'HEAD'], { env });
      await git(record.path, ['add', '--intent-to-add', '--all', '--', '.'], { env });
      const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', record.baseCommit];
      const head = (await git(record.path, ['rev-parse', 'HEAD'])).text.trim();
      const changedPaths = (await git(record.path, [...args, '--name-only', '-z', '--'], { env })).text.split('\0').filter(Boolean).sort();
      const raw = (await git(record.path, [...args, '--raw', '-z', '--'], { env })).text;
      const patch = await git(record.path, [...args, '--binary', '--full-index', '--'], { env, bounded: true });
      const reasons: string[] = [];
      if (raw.split('\0').some(part => /^:(?:120000|160000) |^:\d+ (?:120000|160000) /.test(part))) reasons.push('symlink');
      for (const path of changedPaths) {
        const problem = await safeChangedPath(record.path, path);
        if (problem) reasons.push(problem);
      }
      const snapshot: WorkspaceSnapshot = {
        diff: patch.text, changedPaths, head,
        hash: digest(JSON.stringify({ head, base: record.baseCommit, paths: changedPaths, patch: patch.hash })),
        bounded: true, truncated: patch.truncated,
      };
      return { snapshot, reasons };
    } finally {
      await unlink(indexPath).catch(() => undefined);
      await unlink(`${indexPath}.lock`).catch(() => undefined);
    }
  }

  async preview(records: WorkspaceRecord[]): Promise<MergePreview> {
    const reasons: string[] = [];
    const parts: string[] = [];
    const paths = new Set<string>();
    const seen = new Set<string>();
    const fingerprints: unknown[] = [];
    let targetHead = '';
    let targetStatus = '';
    if (!records.length) reasons.push('empty-workspaces');
    const target = records[0]?.projectRoot;
    const base = records[0]?.baseCommit;
    for (const record of records) {
      if (!samePath(record.projectRoot, target ?? '') || record.baseCommit !== base) reasons.push('different-base');
      try {
        const captured = await this.capture(record);
        const snapshot = captured.snapshot;
        reasons.push(...captured.reasons);
        if (snapshot.truncated) reasons.push('truncated');
        fingerprints.push({ record, hash: snapshot.hash });
        parts.push(snapshot.diff);
        for (const path of snapshot.changedPaths) {
          const key = process.platform === 'win32' ? path.toLowerCase() : path;
          if (seen.has(key)) reasons.push('overlap');
          seen.add(key);
          paths.add(path);
          if (target) {
            const problem = await safeChangedPath(target, path);
            if (problem) reasons.push(problem);
          }
        }
      } catch (error) {
        reasons.push(error instanceof Error && error.message.includes('escaped-path') ? 'escaped-path' : 'invalid-workspace');
        fingerprints.push({ record, error: String(error) });
      }
    }
    if (target) {
      try {
        targetHead = (await git(target, ['rev-parse', 'HEAD'])).text.trim();
        targetStatus = (await git(target, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).text;
        if (targetHead !== base) reasons.push('stale-target');
        if (targetStatus) reasons.push('dirty-target');
      } catch {
        reasons.push('invalid-target');
      }
    }
    let patch = parts.join('');
    if (Buffer.byteLength(patch) > PATCH_LIMIT) {
      patch = Buffer.from(patch).subarray(0, PATCH_LIMIT).toString('utf8');
      reasons.push('truncated');
    }
    if (target && !reasons.length && patch) {
      try { await git(target, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], { input: patch }); }
      catch { reasons.push('conflict'); }
    }
    const uniqueReasons = [...new Set(reasons)];
    return {
      hash: digest(JSON.stringify({ fingerprints, targetHead, targetStatus, reasons: uniqueReasons })),
      patch, paths: [...paths].sort(), allowed: !uniqueReasons.length, reasons: uniqueReasons,
    };
  }

  async apply(records: WorkspaceRecord[], expectedHash: string): Promise<MergePreview> {
    const operation = this.applyTail.then(async () => {
      const fresh = await this.preview(records);
      if (fresh.hash !== expectedHash) throw new Error('stale-preview');
      if (!fresh.allowed) throw new Error(`Merge refused: ${fresh.reasons.join(', ')}`);
      if (fresh.patch) {
        await git(records[0].projectRoot, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], { input: fresh.patch });
        // Recheck after Git's dry run; never index, commit, merge, or push the user's files.
        const checked = await this.preview(records);
        if (checked.hash !== expectedHash || !checked.allowed) throw new Error('stale-preview');
        await git(records[0].projectRoot, ['apply', '--binary', '--whitespace=nowarn', '-'], { input: fresh.patch });
      }
      return fresh;
    });
    this.applyTail = operation.catch(() => undefined);
    return operation;
  }
}
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';


const PATCH_LIMIT = 1_048_576;

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function safeChangedPath(root: string, path: string): Promise<string | undefined> {
  if (isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some(part => !part || part === '..' || part === '.git')) return 'escaped-path';
  const location = resolve(root, path);
  const inside = relative(resolve(root), location);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) return 'escaped-path';
  let current = resolve(root);
  for (const part of path.split('/')) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return 'symlink';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

function git(cwd: string, args: string[], options: { env?: Record<string, string>; input?: string; bounded?: boolean } = {}): Promise<{ text: string; hash: string; truncated: boolean }> {
  return new Promise((fulfill, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, options.env);
    const child = spawn('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], { cwd, env, shell: false, windowsHide: true, stdio: 'pipe' });
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let retained = 0;
    let total = 0;
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      hash.update(chunk);
      if (retained < PATCH_LIMIT) {
        const portion = chunk.subarray(0, PATCH_LIMIT - retained);
        chunks.push(portion);
        retained += portion.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString('utf8'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut || code !== 0) reject(new Error(`Git command failed${timedOut ? ' (timeout)' : ''}: ${stderr.trim()}`));
      else if (total > PATCH_LIMIT && !options.bounded) reject(new Error('Git metadata exceeded limit'));
      else fulfill({ text: Buffer.concat(chunks).toString('utf8'), hash: hash.digest('hex'), truncated: total > PATCH_LIMIT });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
  });
}
