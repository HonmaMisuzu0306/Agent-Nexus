import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';

export class ProcessManager {
  private children = new Set<ChildProcess>();
  get activeCount() { return this.children.size; }
  start(executable: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
    if (!isAbsolute(executable) || !isAbsolute(cwd) || /\.(cmd|bat)$/i.test(executable)) throw new Error('Only absolute native executable paths are supported');
    const child = spawn(executable, args, { cwd, env: env ?? process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.add(child);
    child.once('error', () => this.children.delete(child)); child.once('close', () => this.children.delete(child));
    return child;
  }
  async run(executable: string, args: string[], cwd: string, timeoutMs = 5000, env?: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    if (!isAbsolute(executable) || !isAbsolute(cwd) || /\.(cmd|bat)$/i.test(executable)) throw new Error('Only absolute native executable paths are supported; wrappers require M2 review');
    const child = spawn(executable, args, { cwd, env: env ?? process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
    return new Promise((resolve, reject) => {
      let stdout = ''; let stderr = ''; let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void this.stop(child); }, timeoutMs);
      child.stdout?.on('data', b => { stdout = (stdout + b.toString('utf8')).slice(-65536); });
      child.stderr?.on('data', b => { stderr = (stderr + b.toString('utf8')).slice(-65536); });
      child.once('error', error => { clearTimeout(timer); this.children.delete(child); reject(error); });
      child.once('close', code => { clearTimeout(timer); this.children.delete(child); if (timedOut) reject(new Error('Process timed out')); else resolve({ exitCode: code, stdout, stderr }); });
    });
  }
  async stop(child: ChildProcess) {
    if (child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') {
      await new Promise<void>(resolve => {
        const killer = spawn(joinSystemTaskkill(), ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
        killer.once('error', () => { child.kill(); resolve(); }); killer.once('close', () => resolve());
      });
    } else child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
  async dispose() { await Promise.all([...this.children].map(c => this.stop(c))); }
}
function joinSystemTaskkill() { return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\taskkill.exe`; }
