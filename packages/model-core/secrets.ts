import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ModelSecrets {
  get(id: string): string | undefined;
  set(id: string, value: string | undefined): void;
  has(id: string): boolean;
}

export interface SecretEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
}

const maxCiphertextBytes = 128 * 1024;
const loadError = '保存的模型凭证无法解密或格式无效；原文件已保留，请检查系统加密及凭证文件后重试';
const saveError = '无法保存加密模型凭证，变更未生效；请检查本地存储后重试';

function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('提供方 ID 无效；请使用 1–100 个字母、数字、下划线或连字符');
}

function normalizeKey(value: string): string {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('API Key 无效；请输入 1–4096 字符且不含换行的密钥');
  const key = value.trim();
  if (!key.length || key.length > 4096) throw new Error('API Key 无效；请输入 1–4096 字符且不含换行的密钥');
  return key;
}

// Main injects Electron safeStorage after app.ready. Never fall back to plaintext.
export class EncryptedModelSecrets implements ModelSecrets {
  constructor(private filename: string, private encryption: SecretEncryption) {}

  private available(): void {
    try {
      if (this.encryption.isEncryptionAvailable()) return;
    } catch { /* Provider errors must not expose credentials or filesystem contents. */ }
    throw new Error('系统本地加密不可用，无法读取或保存模型凭证；请恢复系统加密后重试，未使用明文后备');
  }

  private load(): Record<string, string> {
    let size: number;
    try { size = statSync(this.filename).size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Record<string, string>;
      throw new Error(loadError);
    }
    this.available();
    try {
      if (!size || size > maxCiphertextBytes) throw new Error('Invalid ciphertext size');
      const bytes = readFileSync(this.filename);
      if (!bytes.length || bytes.length > maxCiphertextBytes) throw new Error('Invalid ciphertext size');
      const parsed: unknown = JSON.parse(this.encryption.decryptString(bytes));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid record');
      const secrets = Object.create(null) as Record<string, string>;
      for (const [id, value] of Object.entries(parsed)) {
        validateId(id);
        if (typeof value !== 'string') throw new Error('Invalid key');
        secrets[id] = normalizeKey(value);
      }
      return secrets;
    } catch { throw new Error(loadError); }
  }

  get(id: string): string | undefined {
    validateId(id);
    return this.load()[id];
  }

  has(id: string): boolean { return this.get(id) !== undefined; }

  set(id: string, value: string | undefined): void {
    validateId(id);
    const key = value === undefined ? undefined : normalizeKey(value);
    const secrets = this.load();
    this.available();
    if (key === undefined) delete secrets[id];
    else secrets[id] = key;
    let createdTemp = false;
    const temp = `${this.filename}.tmp`;
    try {
      const encrypted = this.encryption.encryptString(JSON.stringify(secrets));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > maxCiphertextBytes) throw new Error('Invalid ciphertext size');
      mkdirSync(dirname(this.filename), { recursive: true });
      // Exclusive creation avoids overwriting a stale or externally created temporary file.
      const descriptor = openSync(temp, 'wx', 0o600);
      createdTemp = true;
      try { writeFileSync(descriptor, encrypted); }
      finally { closeSync(descriptor); }
      renameSync(temp, this.filename);
    } catch {
      if (createdTemp) { try { unlinkSync(temp); } catch { /* Preserve the original failure. */ } }
      throw new Error(saveError);
    }
  }
}
