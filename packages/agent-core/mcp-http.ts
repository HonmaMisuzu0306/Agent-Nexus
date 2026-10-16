import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(100), z.number().int()]).optional(), method: z.string().max(100), params: z.record(z.string(), z.unknown()).optional() }).strict();
type Client = { id: string; projectId: string; version: string; initialized: boolean; seen: number };
export interface McpGrant { path: string; token: string; projectId: string }
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }

// Deliberate subset: JSON responses, no SSE/push or server-initiated sampling.
export class McpHttpServer {
  private server?: Server;
  private starting?: Promise<void>;
  private clients = new Map<string, Client>();
  private grants = new Map<string, McpGrant>();
  private sessionIssues = new Set<string>();
  private port = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private tools: McpTool[], private execute: (projectId: string, clientId: string, name: string, args: unknown) => unknown, private disconnected: (clientId: string) => void) {}
  async start(port = 0) {
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
      this.server = server; server.maxConnections = 64; server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 2000;
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return reject(new Error('桥接监听失败')); this.port = address.port; resolve(); });
    });
    try { await this.starting; }
    catch { this.starting = undefined; this.server = undefined; throw new Error(`桥接端口 ${port || '自动分配'} 无法监听，可能被占用；请释放端口后重试，或撤销已保存的配对后重新启用`); }
    this.timer = setInterval(() => { for (const c of this.clients.values()) if (Date.now() - c.seen > 30 * 60_000) this.drop(c.id); }, 30_000); this.timer.unref();
  }
  add(grant: McpGrant) { this.grants.set(grant.path, grant); }
  get listeningPort() { return this.port; }
  remove(projectId: string) {
    this.sessionIssues.delete(projectId);
    for (const [path, grant] of this.grants) if (grant.projectId === projectId) this.grants.delete(path);
    for (const c of this.clients.values()) if (c.projectId === projectId) this.drop(c.id);
  }
  url(path: string) { return `http://127.0.0.1:${this.port}${path}`; }
  status(projectId: string) {
    const clients = [...this.clients.values()].filter(c => c.projectId === projectId && c.initialized && Date.now() - c.seen < 60_000);
    const last = Math.max(0, ...[...this.clients.values()].filter(c => c.projectId === projectId).map(c => c.seen));
    return { connectedClients: clients.length, ...(last ? { lastSeenAt: new Date(last).toISOString() } : {}), ...(this.sessionIssues.has(projectId) ? { connectionIssue: 'session_expired' as const } : {}) };
  }
  private drop(id: string) { this.clients.delete(id); this.disconnected(id); }
  private json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const host = `127.0.0.1:${this.port}`;
    if (req.headers.host !== host || req.headers.origin && req.headers.origin !== `http://${host}`) { res.writeHead(403).end(); return; }
    const grant = this.grants.get(req.url ?? '');
    const received = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${grant?.token ?? ''}`);
    if (!grant || received.length !== expected.length || !timingSafeEqual(received, expected)) { res.writeHead(401).end(); return; }
    const sessionId = req.headers['mcp-session-id'];
    const client = typeof sessionId === 'string' ? this.clients.get(sessionId) : undefined;
    if (sessionId && (!client || client.projectId !== grant.projectId)) { this.sessionIssues.add(grant.projectId); res.writeHead(404).end(); return; }
    const version = req.headers['mcp-protocol-version'] ?? '2025-03-26';
    if (typeof version !== 'string' || !versions.includes(version)) { res.writeHead(400).end(); return; }
    if (req.method === 'DELETE') { if (!client) { res.writeHead(400).end(); return; } this.drop(client.id); res.writeHead(200).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, DELETE' }).end(); return; }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { res.writeHead(415).end(); return; }
    if (!req.headers.accept?.includes('application/json') || !req.headers.accept.includes('text/event-stream')) { res.writeHead(406).end(); return; }
    if (Number(req.headers['content-length']) > 128 * 1024) { res.writeHead(413).end(); return; }
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    // Pair/session can have been revoked while a slow body was being uploaded.
    if (this.grants.get(req.url ?? '') !== grant || client && this.clients.get(client.id) !== client) { res.writeHead(401).end(); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { this.json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    const valid = envelope.safeParse(parsed);
    if (!valid.success) { this.json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return; }
    const m = valid.data;
    const reply = (result: unknown) => this.json(res, 200, { jsonrpc: '2.0', id: m.id, result });
    const error = (code: number, message: string) => this.json(res, 200, { jsonrpc: '2.0', id: m.id, error: { code, message } });
    if (m.method === 'initialize' && m.id !== undefined) {
      const params = z.object({ protocolVersion: z.string(), capabilities: z.record(z.string(), z.unknown()), clientInfo: z.object({ name: z.string().max(200), version: z.string().max(100) }) }).safeParse(m.params);
      if (!params.success || client) { error(-32602, 'Invalid initialization'); return; }
      if (this.clients.size >= 32) { res.writeHead(429).end(); return; }
      const c: Client = { id: randomUUID(), projectId: grant.projectId, version: versions.includes(params.data.protocolVersion) ? params.data.protocolVersion : versions[0], initialized: false, seen: Date.now() };
      this.clients.set(c.id, c); res.setHeader('Mcp-Session-Id', c.id);
      reply({ protocolVersion: c.version, capabilities: { tools: {} }, serverInfo: { name: 'Agent Nexus WorkBuddy Bridge', version: '0.3.0' }, instructions: 'User-authorized single-task bridge. Confirm project and native permissions. Claim once; if no task, stop. Report progress/status every 3 minutes (5-minute lease); stop work on cancellation, expired lease or tool error. Report result honestly. No native sandbox is enforced by this bridge.' }); return;
    }
    if (!client) { res.writeHead(400).end(); return; }
    client.seen = Date.now();
    if (m.id === undefined) { if (m.method === 'notifications/initialized') { client.initialized = true; this.sessionIssues.delete(grant.projectId); } res.writeHead(202).end(); return; }
    if (m.method === 'ping') { reply({}); return; }
    if (!client.initialized) { error(-32600, 'Client not initialized'); return; }
    if (m.method === 'tools/list') { reply({ tools: this.tools }); return; }
    if (m.method !== 'tools/call') { error(-32601, 'Unknown method'); return; }
    if (typeof m.params?.name !== 'string' || !this.tools.some(t => t.name === m.params!.name)) { error(-32602, 'Unknown tool'); return; }
    try { const result = this.execute(grant.projectId, client.id, m.params.name, m.params.arguments ?? {}); reply({ content: [{ type: 'text', text: JSON.stringify(result) }] }); }
    catch (e) { reply({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : 'Bridge tool failed' }] }); }
  }
  async dispose() {
    await this.starting?.catch(() => {});
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients.values()) this.drop(c.id);
    this.grants.clear();
    this.sessionIssues.clear();
    const server = this.server; this.server = undefined;
    if (server?.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
