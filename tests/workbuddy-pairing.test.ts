import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedPairingStore, type EncryptionProvider } from '../packages/agent-core/workbuddy-pairing';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';

let root: string, repo: Repository, service: NexusService, store: EncryptedPairingStore, encryption: EncryptionProvider, projectId: string;
let blocker: Server | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'Nexus protected pairing ')); repo = await Repository.open(join(root, 'nexus.sqlite')); projectId = repo.addProject('pairing', root).id;
  // Only the OS key provider is substituted in Node tests. Real Windows DPAPI is covered in Electron E2E.
  const key = randomBytes(32);
  encryption = {
    isEncryptionAvailable: () => true,
    encryptString: value => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    decryptString: value => { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12), { authTagLength: 16 }); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); }
  };
  store = new EncryptedPairingStore(join(root, 'workbuddy-pairing.bin'), encryption); service = new NexusService(repo, undefined, store); await service.restoreWorkBuddy();
});
afterEach(async () => { vi.restoreAllMocks(); await service.dispose(); if (blocker) await new Promise<void>(r => blocker!.close(() => r())); blocker = undefined; repo.close(); rmSync(root, { recursive: true, force: true }); });
async function enable() { await service.call('workbuddy.enable', { projectId }); return JSON.parse(await service.call('workbuddy.config.copy', { projectId })).mcpServers['agent-nexus-workbuddy']; }
async function restart() { await service.dispose(); service = new NexusService(repo, undefined, store); await service.restoreWorkBuddy(); }

it('restores the same protected URL/key, persists revocation, and prunes removed projects', async () => {
  const config = await enable(); expect(readFileSync(join(root, 'workbuddy-pairing.bin')).includes(config.headers.Authorization.slice(7))).toBe(false);
  await restart(); expect(await service.call('workbuddy.status', { projectId })).toMatchObject({ enabled: true, saved: true, persistence: 'encrypted', url: config.url });
  expect(JSON.parse(await service.call('workbuddy.config.copy', { projectId })).mcpServers['agent-nexus-workbuddy']).toEqual(config);
  await service.call('workbuddy.revoke', { projectId }); await restart(); expect((await service.call('workbuddy.status', { projectId })).enabled).toBe(false);
  await enable(); await service.dispose(); repo.removeProject(projectId); service = new NexusService(repo, undefined, store); await service.restoreWorkBuddy(); expect(store.load()?.grants).toHaveLength(0);
});
it('fails closed on port collision and retries the same saved endpoint when the port is released', async () => {
  const config = await enable(); await service.dispose();
  blocker = createServer(); await new Promise<void>(r => blocker!.listen(Number(new URL(config.url).port), '127.0.0.1', r));
  service = new NexusService(repo, undefined, store); await service.restoreWorkBuddy();
  expect(await service.call('workbuddy.status', { projectId })).toMatchObject({ enabled: false, saved: true });
  expect((await service.call('workbuddy.status', { projectId })).error).toContain('端口');
  await expect(service.call('workbuddy.enable', { projectId })).rejects.toThrow('端口');
  expect((await service.call('snapshot.get', {})).projects).toHaveLength(1);
  await new Promise<void>(r => blocker!.close(() => r())); blocker = undefined;
  await service.call('workbuddy.enable', { projectId }); expect((await service.call('workbuddy.status', { projectId })).url).toBe(config.url);
});
it('keeps corrupted ciphertext intact and never silently replaces it with a new pairing', async () => {
  await enable(); await service.dispose(); const broken = Buffer.from('corrupted ciphertext'); writeFileSync(join(root, 'workbuddy-pairing.bin'), broken);
  service = new NexusService(repo, undefined, store); await service.restoreWorkBuddy();
  expect((await service.call('workbuddy.status', { projectId })).error).toContain('解密');
  await expect(service.call('workbuddy.enable', { projectId })).rejects.toThrow('解密');
  expect(readFileSync(join(root, 'workbuddy-pairing.bin'))).toEqual(broken);
});
it('does not enable plaintext fallback when OS encryption is unavailable', async () => {
  await service.dispose(); vi.spyOn(encryption, 'isEncryptionAvailable').mockReturnValue(false);
  service = new NexusService(repo, undefined, store); await service.restoreWorkBuddy();
  await expect(service.call('workbuddy.enable', { projectId })).rejects.toThrow('加密不可用');
  expect(existsSync(join(root, 'workbuddy-pairing.bin'))).toBe(false);
});
it('does not acknowledge enable/revoke if encrypted saving fails', async () => {
  const encrypt = vi.spyOn(encryption, 'encryptString').mockImplementationOnce(() => { throw Error('encryption failure'); });
  await expect(service.call('workbuddy.enable', { projectId })).rejects.toThrow('保存'); expect((await service.call('workbuddy.status', { projectId })).enabled).toBe(false);
  const config = await enable(); encrypt.mockImplementationOnce(() => { throw Error('encryption failure'); });
  await expect(service.call('workbuddy.revoke', { projectId })).rejects.toThrow('保存'); expect((await service.call('workbuddy.status', { projectId })).enabled).toBe(true);
  await restart(); expect((await service.call('workbuddy.status', { projectId })).url).toBe(config.url);
});
it('rejects invalid decrypted pairing data before opening endpoints', async () => {
  const invalid = { version: 1, port: 0, grants: [{ projectId: randomUUID(), path: '/mcp/invalid', token: 'short' }] };
  writeFileSync(join(root, 'workbuddy-pairing.bin'), encryption.encryptString(JSON.stringify(invalid)));
  await restart(); expect((await service.call('workbuddy.status', { projectId })).error).toContain('格式无效');
  await expect(service.call('workbuddy.enable', { projectId })).rejects.toThrow();
});
it('preserves the previous vault and authorization when the atomic disk write fails', async () => {
  const config = await enable(); const file = join(root, 'workbuddy-pairing.bin'); const previous = readFileSync(file);
  mkdirSync(`${file}.tmp`);
  await expect(service.call('workbuddy.revoke', { projectId })).rejects.toThrow('保存');
  expect(readFileSync(file)).toEqual(previous); expect((await service.call('workbuddy.status', { projectId })).enabled).toBe(true);
  await restart(); expect((await service.call('workbuddy.status', { projectId })).url).toBe(config.url);
});
