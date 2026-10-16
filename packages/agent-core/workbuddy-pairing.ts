import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  version: z.literal(1), port: z.number().int().min(1).max(65535),
  grants: z.array(z.object({ projectId: z.string().uuid(), path: z.string().regex(/^\/mcp\/[a-f0-9-]{36}$/), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(64)
}).strict().refine(s => new Set(s.grants.map(g => g.projectId)).size === s.grants.length && new Set(s.grants.map(g => g.path)).size === s.grants.length, 'Duplicate grants');
export type WorkBuddyPairing = z.infer<typeof schema>;
export interface PairingStore { load(): WorkBuddyPairing | undefined; save(state: WorkBuddyPairing): void }
export interface EncryptionProvider { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }

// Main injects Windows safeStorage after app.ready. No provider login data is stored.
export class EncryptedPairingStore implements PairingStore {
  constructor(private filename: string, private encryption: EncryptionProvider) {}
  private available() { if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows 本地加密不可用，无法启用或恢复桥接配对；未使用明文后备'); }
  load(): WorkBuddyPairing | undefined {
    if (!existsSync(this.filename)) return undefined; this.available();
    try {
      if (statSync(this.filename).size > 256 * 1024) throw new Error('Too large');
      return schema.parse(JSON.parse(this.encryption.decryptString(readFileSync(this.filename))));
    } catch { throw new Error('保存的 WorkBuddy 配对无法解密或格式无效；原文件已保留，未自动覆盖'); }
  }
  save(state: WorkBuddyPairing) {
    this.available(); const value = schema.parse(state);
    try {
      const encrypted = this.encryption.encryptString(JSON.stringify(value));
      if (!encrypted.length) throw new Error('Empty ciphertext');
      mkdirSync(dirname(this.filename), { recursive: true });
      writeFileSync(`${this.filename}.tmp`, encrypted); renameSync(`${this.filename}.tmp`, this.filename);
    } catch { throw new Error('无法保存加密配对，授权变更未生效；请检查本地存储后重试'); }
  }
}
