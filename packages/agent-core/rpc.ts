import { StringDecoder } from 'node:string_decoder';
import { ProcessManager } from './process-manager';

export interface Launch { executable: string; args: string[]; env?: NodeJS.ProcessEnv }
export interface RpcMessage { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }
export async function waitWithin(promise: Promise<void>, timeout: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('原生终态等待超时')), timeout); })]); }
  finally { if (timer) clearTimeout(timer); }
}
// App Server uses one JSON object per line, not LSP Content-Length framing.
export class JsonRpcProcess {
  private manager = new ProcessManager();
  private child;
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private id = 0;
  private closed = false;
  private disposing?: Promise<void>;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onMessage: (message: RpcMessage) => void = () => {};
  onClose: (error: Error) => void = () => {};
  constructor(launch: Launch, cwd: string) {
    this.child = this.manager.start(launch.executable, launch.args, cwd, launch.env);
    this.child.stdout.on('data', (bytes: Buffer) => {
      this.buffer += this.decoder.write(bytes);
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) { this.fail(new Error('原生协议消息超过 4 MiB 限制')); void this.manager.dispose(); return; }
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message: RpcMessage = JSON.parse(line);
          if (!message || typeof message !== 'object') throw new Error('Invalid JSON-RPC envelope');
          const pending = typeof message.id === 'number' && !message.method ? this.pending.get(message.id) : undefined;
          if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id as number); if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result); }
          else this.onMessage(message);
        } catch (error) { this.fail(error instanceof Error ? error : new Error('协议解码失败')); void this.manager.dispose(); return; }
      }
    });
    // Drain diagnostics without copying account data, stderr or credentials into the UI/database.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.fail(error));
    this.child.once('error', error => this.fail(error));
    this.child.once('close', code => this.fail(new Error(`原生进程退出 (${code ?? 'signal'})；未收到终态的任务不能判定成功`)));
  }
  private fail(error: Error) {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.onClose(error);
  }
  send(message: RpcMessage) {
    if (this.closed) throw new Error('原生进程已关闭');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  async request<T>(method: string, params: Record<string, unknown>, timeout = 20000): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 请求超时`)); }, timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async dispose() {
    if (this.disposing) return this.disposing;
    this.disposing = this.close(); return this.disposing;
  }
  private async close() {
    this.child.stdin.end();
    await new Promise<void>(resolve => { if (this.closed) { resolve(); return; } const timer = setTimeout(resolve, 500); this.child.once('close', () => { clearTimeout(timer); resolve(); }); });
    await this.manager.dispose(); this.fail(new Error('App Server 已关闭'));
  }
}
