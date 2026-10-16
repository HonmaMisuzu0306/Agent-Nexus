import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Launch } from './rpc';
import type { Provider } from '../shared';
import { spawn } from 'node:child_process';
import { ProcessManager } from './process-manager';

export function desktopExecutable(provider: Provider) {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  const entries = { antigravity: ['antigravity', 'Antigravity.exe'], dsh: ['DeepSeek Harness', 'DeepSeek Harness.exe'], workbuddy: ['WorkBuddy', 'WorkBuddy.exe'], codex: [] }[provider];
  if (!entries.length) return null;
  const path = join(process.env.LOCALAPPDATA, 'Programs', ...entries);
  return existsSync(path) ? path : null;
}
export function dshLaunch(): Launch | null {
  const executable = desktopExecutable('dsh'); if (!executable) return null;
  const root = join(executable, '..');
  const wrapper = join(root, 'resources/runtime/cli/bin/dsh.cmd');
  if (!existsSync(wrapper)) return null;
  const text = readFileSync(wrapper, 'utf8');
  // Expand the verified vendor wrapper to native argv; never execute a shell wrapper.
  if (!text.includes('set "ELECTRON_RUN_AS_NODE=1"') || !text.includes('DeepSeek Harness.exe" --expose-internals') || !text.includes(String.raw`@deepseek-ai\dsh-desktop-host\lib\cli.js`)) return null;
  return { executable, args: ['--expose-internals', join(root, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: 'read-only' } };
}
export async function openDesktop(provider: 'antigravity' | 'workbuddy') {
  const executable = desktopExecutable(provider); if (!executable) throw new Error('未找到原生桌面程序');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [], { cwd: join(executable, '..'), env, shell: false, detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); }); child.unref();
  return { ok: true };
}
export async function requireGitProject(root: string) {
  const git = (process.env.PATH ?? '').split(delimiter).map(p => join(p.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'git.exe' : 'git')).find(p => existsSync(p));
  if (!git) throw new Error('项目写入要求可用的原生 Git');
  const manager = new ProcessManager();
  try {
    const result = await manager.run(git, ['rev-parse', '--show-toplevel'], root);
    if (result.exitCode !== 0 || realpathSync(result.stdout.trim()).toLowerCase() !== realpathSync(root).toLowerCase()) throw new Error('请选择 Git 仓库根目录后使用项目写入');
  } finally { await manager.dispose(); }
}
