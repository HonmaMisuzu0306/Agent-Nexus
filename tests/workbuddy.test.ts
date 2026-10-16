import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import type { Channel } from '../packages/shared';

let root: string, repo: Repository, service: NexusService, projectId: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'Nexus bridge 中文 ')); repo = await Repository.open(join(root, 'nexus.sqlite')); service = new NexusService(repo);
  projectId = repo.addProject('bridge test', root).id;
});
afterEach(async () => { vi.restoreAllMocks(); await service.dispose(); repo.close(); rmSync(root, { recursive: true, force: true }); });
// Dynamic boundary intentionally exercises unknown IPC before the feature exists.
async function call(channel: string, args: unknown): Promise<any> { return service.call(channel as Channel, args); } // eslint-disable-line @typescript-eslint/no-explicit-any
async function pairing(id = projectId) {
  await call('workbuddy.enable', { projectId: id });
  const config = JSON.parse(await call('workbuddy.config.copy', { projectId: id }));
  return config.mcpServers['agent-nexus-workbuddy'] as { url: string; headers: { Authorization: string } };
}
async function client(config: Awaited<ReturnType<typeof pairing>>) {
  let session = ''; let id = 0;
  const raw = (message: unknown, headers = {}) => fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...config.headers, ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-11-25' } : {}), ...headers }, body: JSON.stringify(message) });
  const init = await raw({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Nexus offline test client', version: '1' } } });
  expect(init.status).toBe(200); session = init.headers.get('mcp-session-id')!; expect(session).toBeTruthy();
  await raw({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { raw, session, async tool(name: string, args = {}) {
    const response = await raw({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    const body = await response.json();
    if (body.error || body.result?.isError) throw new Error(body.error?.message ?? body.result.content[0].text);
    return JSON.parse(body.result.content[0].text);
  } };
}
const start = () => call('task.start', { projectId, provider: 'workbuddy', mode: 'bridge', prompt: 'Synthetic bridge task', scenario: 'success' });

it('requires explicit project pairing before queuing a bridge task', async () => {
  await expect(start()).rejects.toThrow();
  await expect(call('workbuddy.enable', { projectId })).resolves.toMatchObject({ enabled: true });
  expect((await start()).status).toBe('queued');
  await expect(start()).rejects.toThrow('运行中');
});
it('claims once, deduplicates progress/result and retains reported results across reopen', async () => {
  const config = await pairing(); const c = await client(config); const other = await client(config); const task = await start();
  const claimed = await c.tool('nexus_claim_task'); expect(claimed.task).toMatchObject({ taskId: task.id, prompt: 'Synthetic bridge task', rootPath: root });
  expect((await c.tool('nexus_claim_task')).task.lease).toBe(claimed.task.lease);
  expect((await other.tool('nexus_claim_task')).task).toBeNull();
  const owned = { taskId: task.id, lease: claimed.task.lease };
  await expect(other.tool('nexus_task_status', owned)).rejects.toThrow();
  await c.tool('nexus_report_progress', { ...owned, sequence: 1, text: 'Synthetic progress' });
  await c.tool('nexus_report_progress', { ...owned, sequence: 1, text: 'Synthetic progress' });
  await expect(c.tool('nexus_report_progress', { ...owned, sequence: 1, text: 'Changed duplicate' })).rejects.toThrow();
  await expect(c.tool('nexus_report_progress', { ...owned, sequence: 3, text: 'Gap' })).rejects.toThrow();
  await c.tool('nexus_report_result', { ...owned, status: 'completed', text: 'Synthetic output' });
  await c.tool('nexus_report_result', { ...owned, status: 'completed', text: 'Synthetic output' });
  await expect(c.tool('nexus_report_result', { ...owned, status: 'failed', text: 'Rewrite' })).rejects.toThrow();
  expect(repo.events(task.id).filter(e => e.payload.text === 'Synthetic progress')).toHaveLength(1);
  expect(repo.task(task.id)).toMatchObject({ status: 'completed', mode: 'bridge' });
  expect(repo.events(task.id).at(-1)?.payload).toMatchObject({ source: 'mcp-client', text: 'Synthetic output' });
  expect(JSON.stringify(await call('snapshot.get', {}))).not.toContain(config.headers.Authorization);
  await service.dispose(); repo.close(); repo = await Repository.open(join(root, 'nexus.sqlite')); service = new NexusService(repo); repo.recoverInterrupted();
  expect(repo.task(task.id).status).toBe('completed'); expect((await call('workbuddy.status', { projectId })).enabled).toBe(false);
});
it('distinguishes withdrawal from cooperative cancellation and propagates pending stop-all', async () => {
  const c = await client(await pairing()); const queued = await start();
  await call('task.cancel', { taskId: queued.id }); expect(repo.task(queued.id).status).toBe('cancelled');
  const task = await start(); const { task: claim } = await c.tool('nexus_claim_task'); const owned = { taskId: task.id, lease: claim.lease };
  expect(await call('tasks.stopAll', {})).toMatchObject({ ok: true, pending: true }); expect(repo.task(task.id).status).toBe('running');
  expect(await c.tool('nexus_task_status', owned)).toMatchObject({ cancelRequested: true });
  await expect(c.tool('nexus_report_result', { ...owned, status: 'completed', text: 'Too late' })).rejects.toThrow();
  await c.tool('nexus_report_result', { ...owned, status: 'cancelled', text: 'Client confirms stopped' }); expect(repo.task(task.id).status).toBe('cancelled');
});
it('rejects unauthorized requests and revokes access without claiming the native task stopped', async () => {
  const config = await pairing(); const c = await client(config); const task = await start(); await c.tool('nexus_claim_task');
  for (const headers of [{ Authorization: 'Bearer wrong' }, { Origin: 'https://untrusted.example' }]) expect((await c.raw({ jsonrpc: '2.0', id: 7, method: 'ping' }, headers)).status).toBeGreaterThanOrEqual(400);
  const badHost = await new Promise<number | undefined>((resolve, reject) => { const req = httpRequest(config.url, { headers: { Host: 'untrusted.example', ...config.headers } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }); expect(badHost).toBe(403);
  expect((await c.raw({ jsonrpc: '2.0', id: 7, method: 'ping' }, { 'MCP-Protocol-Version': 'invalid' })).status).toBe(400);
  await call('workbuddy.revoke', { projectId }); expect(repo.task(task.id).status).toBe('interrupted');
  expect((await c.raw({ jsonrpc: '2.0', id: 8, method: 'ping' })).status).toBe(401);
});
it('rejects cross-project leases and marks bridge work interrupted on app shutdown', async () => {
  const config = await pairing(); const c = await client(config); const task = await start(); const { task: claim } = await c.tool('nexus_claim_task');
  const p2 = await call('project.create', { name: 'second', parentPath: root }); const other = await client(await pairing(p2.id));
  expect((await call('workbuddy.status', { projectId: p2.id })).activeTask).toBeUndefined();
  await expect(other.tool('nexus_report_result', { taskId: task.id, lease: claim.lease, status: 'completed', text: 'Wrong project' })).rejects.toThrow();
  await service.dispose(); expect(repo.task(task.id).status).toBe('interrupted');
});
it('does not acknowledge a result or its retry when durable event recording failed', async () => {
  const c = await client(await pairing()); const task = await start(); const { task: claim } = await c.tool('nexus_claim_task');
  vi.spyOn(repo, 'recordEvent').mockImplementationOnce(() => { throw new Error('disk failed'); });
  const result = { taskId: task.id, lease: claim.lease, status: 'completed', text: 'Not durable' };
  await expect(c.tool('nexus_report_result', result)).rejects.toThrow();
  await expect(c.tool('nexus_report_result', result)).rejects.toThrow();
  expect(repo.task(task.id).status).toBe('failed');
});
it('expires unattended queues and leases without replay or claiming native cancellation', async () => {
  const c = await client(await pairing()); const queued = await start(); const now = Date.now(); const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(now + 601_000); expect((await c.tool('nexus_claim_task')).task).toBeNull(); expect(repo.task(queued.id).status).toBe('interrupted');
  clock.mockReturnValue(now); const task = await start(); const { task: claim } = await c.tool('nexus_claim_task');
  clock.mockReturnValue(now + 301_000);
  expect(await c.tool('nexus_task_status', { taskId: task.id, lease: claim.lease })).toMatchObject({ status: 'interrupted', leaseSeconds: 0 });
  await expect(c.tool('nexus_report_result', { taskId: task.id, lease: claim.lease, status: 'completed', text: 'late' })).rejects.toThrow();
  expect(repo.task(task.id).status).toBe('interrupted');
});
it('limits cancellation confirmation wait even when a client keeps renewing the lease', async () => {
  const c = await client(await pairing()); const task = await start(); const { task: claim } = await c.tool('nexus_claim_task');
  await call('task.cancel', { taskId: task.id });
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000);
  expect(await c.tool('nexus_task_status', { taskId: task.id, lease: claim.lease })).toMatchObject({ status: 'interrupted', cancelRequested: true });
  expect(repo.task(task.id).status).toBe('interrupted');
});
it('renews a long task on an exact progress retry without duplicating durable progress', async () => {
  const c = await client(await pairing()); const task = await start(); const { task: claim } = await c.tool('nexus_claim_task');
  const owned = { taskId: task.id, lease: claim.lease };
  const progress = { ...owned, sequence: 1, text: 'Long task checkpoint' };
  await c.tool('nexus_report_progress', progress);
  const now = Date.now(); const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(now + 240_000); await c.tool('nexus_report_progress', progress);
  clock.mockReturnValue(now + 480_000);
  expect(await c.tool('nexus_task_status', owned)).toMatchObject({ status: 'running', leaseSeconds: 300 });
  await c.tool('nexus_report_result', { ...owned, status: 'completed', text: 'Long task completed' });
  expect(repo.task(task.id).status).toBe('completed');
  expect(repo.events(task.id).filter(e => e.payload.text === progress.text)).toHaveLength(1);
});
it('keeps an hour-long task alive through authenticated status heartbeats', async () => {
  const c = await client(await pairing()); const task = await start(); const { task: claim } = await c.tool('nexus_claim_task');
  const owned = { taskId: task.id, lease: claim.lease }; const now = Date.now(); const clock = vi.spyOn(Date, 'now');
  for (let elapsed = 240_000; elapsed <= 3_600_000; elapsed += 240_000) {
    clock.mockReturnValue(now + elapsed);
    expect(await c.tool('nexus_task_status', owned)).toMatchObject({ status: 'running', cancelRequested: false });
  }
  await c.tool('nexus_report_result', { ...owned, status: 'completed', text: 'Hour-long task fixture completed' });
  expect(repo.task(task.id).status).toBe('completed');
  expect(repo.events(task.id).map(e => e.type)).toEqual(['bridge.queued', 'task.started', 'task.completed']);
});
it('exposes project-scoped deadlines without renewing from UI polling or leaking a lease', async () => {
  const config = await pairing(); const c = await client(config); const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const task = await start();
  expect(await call('workbuddy.status', { projectId })).toMatchObject({ activeTask: { taskId: task.id, status: 'queued', expiresAt: new Date(now + 600_000).toISOString() } });
  const { task: claim } = await c.tool('nexus_claim_task'); const owned = { taskId: task.id, lease: claim.lease };
  clock.mockReturnValue(now + 180_000);
  const status = await call('workbuddy.status', { projectId });
  expect(status.activeTask).toEqual({ taskId: task.id, status: 'running', expiresAt: new Date(now + 300_000).toISOString(), lastContactAt: new Date(now).toISOString() });
  expect(JSON.stringify(status)).not.toContain(claim.lease);
  await c.tool('nexus_task_status', owned);
  expect((await call('workbuddy.status', { projectId })).activeTask.expiresAt).toBe(new Date(now + 480_000).toISOString());
  await call('task.cancel', { taskId: task.id });
  expect((await call('workbuddy.status', { projectId })).activeTask.cancelDeadline).toBe(new Date(now + 300_000).toISOString());
  clock.mockReturnValue(now + 301_000); expect((await call('workbuddy.status', { projectId })).activeTask).toBeUndefined();
  expect(repo.task(task.id).status).toBe('interrupted');
});
it('does not let malformed progress retries renew a lease or valid retries extend cancellation', async () => {
  const c = await client(await pairing()); const task = await start(); const { task: claim } = await c.tool('nexus_claim_task');
  const owned = { taskId: task.id, lease: claim.lease }; const progress = { ...owned, sequence: 1, text: 'Checkpoint' };
  await c.tool('nexus_report_progress', progress);
  const now = Date.now(); const clock = vi.spyOn(Date, 'now'); clock.mockReturnValue(now + 240_000);
  await expect(c.tool('nexus_report_progress', { ...progress, text: 'Changed retry' })).rejects.toThrow();
  clock.mockReturnValue(now + 301_000);
  expect(await c.tool('nexus_task_status', owned)).toMatchObject({ status: 'interrupted' });
  const next = await start(); const nextClaim = (await c.tool('nexus_claim_task')).task;
  const nextProgress = { taskId: next.id, lease: nextClaim.lease, sequence: 1, text: 'Next checkpoint' };
  await c.tool('nexus_report_progress', nextProgress); await call('task.cancel', { taskId: next.id });
  clock.mockReturnValue(now + 361_000); expect(await c.tool('nexus_report_progress', nextProgress)).toMatchObject({ cancelRequested: true });
  clock.mockReturnValue(now + 422_000);
  expect(await c.tool('nexus_task_status', { taskId: next.id, lease: nextClaim.lease })).toMatchObject({ status: 'interrupted', cancelRequested: true });
});
it('DELETE ends ownership, malformed requests cannot mutate tasks, and credentials stay out of events', async () => {
  const config = await pairing(); const c = await client(config); const task = await start(); const { task: claim } = await c.tool('nexus_claim_task');
  expect((await c.raw([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status).toBe(400);
  expect((await c.raw({ jsonrpc: '2.0', id: 1, method: 'ping', params: { huge: 'x'.repeat(140_000) } })).status).toBe(413);
  await expect(c.tool('nexus_report_progress', { taskId: task.id, lease: claim.lease, sequence: 1, text: 'wrong', command: 'arbitrary' })).rejects.toThrow();
  await c.tool('nexus_report_progress', { taskId: task.id, lease: claim.lease, sequence: 1, text: `Token ${config.headers.Authorization.slice(7)} lease ${claim.lease}` });
  const events = JSON.stringify(repo.events(task.id)); expect(events).not.toContain(config.headers.Authorization.slice(7)); expect(events).not.toContain(claim.lease);
  await expect(call('project.remove', { projectId })).rejects.toThrow('WorkBuddy');
  const response = await fetch(config.url, { method: 'DELETE', headers: { ...config.headers, 'Mcp-Session-Id': c.session, 'MCP-Protocol-Version': '2025-11-25' } }); expect(response.status).toBe(200);
  expect(repo.task(task.id).status).toBe('interrupted'); expect((await c.raw({ jsonrpc: '2.0', id: 7, method: 'ping' })).status).toBe(404);
  expect(await call('workbuddy.status', { projectId })).toMatchObject({ connectionIssue: 'session_expired' });
  await client(config); expect((await call('workbuddy.status', { projectId })).connectionIssue).toBeUndefined();
});
