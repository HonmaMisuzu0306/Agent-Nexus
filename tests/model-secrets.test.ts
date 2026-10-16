import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedModelSecrets, type SecretEncryption } from '../packages/model-core/secrets';

let root: string, filename: string, encryption: SecretEncryption, store: EncryptedModelSecrets;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nexus-model-secrets-'));
  filename = join(root, 'model-secrets.bin');
  const key = randomBytes(32);
  // Substitute only the OS key provider; exercise actual encrypted bytes and filesystem writes.
  encryption = {
    isEncryptionAvailable: () => true,
    encryptString: text => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString: bytes => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
  store = new EncryptedModelSecrets(filename, encryption);
});
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); });

it('keeps two provider keys isolated across restart and stores only ciphertext', () => {
  store.set('provider-a', ' first-private-key ');
  store.set('2fd07ef4-a144-4fee-8dc4-69d785839902', 'second-private-key');
  const bytes = readFileSync(filename);
  expect(bytes.includes(Buffer.from('first-private-key'))).toBe(false);
  expect(bytes.includes(Buffer.from('second-private-key'))).toBe(false);
  const restarted = new EncryptedModelSecrets(filename, encryption);
  expect(restarted.get('provider-a')).toBe('first-private-key');
  expect(restarted.get('2fd07ef4-a144-4fee-8dc4-69d785839902')).toBe('second-private-key');
  expect(restarted.has('provider-a')).toBe(true);
  expect(restarted.get('absent')).toBeUndefined();
  expect(restarted.has('absent')).toBe(false);
});

it('deletes only the selected provider and handles object prototype names as ordinary ids', () => {
  store.set('__proto__', 'prototype-key'); store.set('constructor', 'constructor-key');
  store.set('__proto__', undefined);
  const restarted = new EncryptedModelSecrets(filename, encryption);
  expect(restarted.has('__proto__')).toBe(false);
  expect(restarted.get('constructor')).toBe('constructor-key');
  restarted.set('constructor', undefined);
  expect(new EncryptedModelSecrets(filename, encryption).has('constructor')).toBe(false);
});

it('reads absent storage without OS encryption but refuses every save without it', () => {
  vi.spyOn(encryption, 'isEncryptionAvailable').mockReturnValue(false);
  expect(store.get('provider-a')).toBeUndefined(); expect(store.has('provider-a')).toBe(false);
  expect(() => store.set('provider-a', 'private-key')).toThrow('加密不可用');
  expect(() => store.set('provider-a', undefined)).toThrow('加密不可用');
  expect(existsSync(filename)).toBe(false);
});

it('preserves existing ciphertext and refuses reads or changes when OS encryption is unavailable', () => {
  store.set('provider-a', 'private-key'); const previous = readFileSync(filename);
  vi.spyOn(encryption, 'isEncryptionAvailable').mockReturnValue(false);
  for (const action of [() => store.get('provider-a'), () => store.has('provider-a'), () => store.set('provider-a', undefined)]) {
    expect(action).toThrow('加密不可用');
  }
  expect(readFileSync(filename)).toEqual(previous);
});

it('preserves corrupted ciphertext and reports a fixed actionable error without leaking underlying details', () => {
  const broken = Buffer.from('broken-data'); writeFileSync(filename, broken);
  vi.spyOn(encryption, 'decryptString').mockImplementation(() => { throw new Error('sensitive-underlying-detail'); });
  const messages: string[] = [];
  for (const action of [() => store.get('provider-a'), () => store.set('provider-b', 'private-key')]) {
    try { action(); } catch (error) { messages.push((error as Error).message); }
  }
  expect(messages).toHaveLength(2); expect(new Set(messages).size).toBe(1);
  expect(messages[0]).toMatch(/无法解密或格式无效/); expect(messages[0]).toMatch(/原文件已保留/);
  expect(messages[0]).not.toContain('sensitive-underlying-detail');
  expect(readFileSync(filename)).toEqual(broken);
});

it.each(['not-json', 'null', '[]', '{"provider-a":7}', '{"bad/id":"key"}', '{"provider-a":""}', '{"provider-a":"line\\nkey"}'])('rejects malformed decrypted records without overwriting the file (%#)', plaintext => {
  const previous = encryption.encryptString(plaintext); writeFileSync(filename, previous);
  expect(() => store.get('provider-a')).toThrow('格式无效');
  expect(() => store.set('provider-a', 'replacement')).toThrow('格式无效');
  expect(readFileSync(filename)).toEqual(previous);
});

it('keeps memory and disk at the previous value after an atomic write failure', () => {
  store.set('provider-a', 'previous-key'); const previous = readFileSync(filename);
  mkdirSync(`${filename}.tmp`);
  expect(() => store.set('provider-a', 'replacement-key')).toThrow('保存');
  expect(readFileSync(filename)).toEqual(previous);
  expect(store.get('provider-a')).toBe('previous-key');
  expect(new EncryptedModelSecrets(filename, encryption).get('provider-a')).toBe('previous-key');
});

it('removes its temporary ciphertext after a failed write so retry can succeed', () => {
  store.set('provider-a', 'previous-key'); const previous = readFileSync(filename);
  const write = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((file, data, options) => {
    write(file, data, options); throw new Error('sensitive-write-detail');
  });
  syncBuiltinESMExports();
  let message = '';
  try { store.set('provider-a', 'replacement-key'); } catch (error) { message = (error as Error).message; }
  expect(message).toMatch(/无法保存/); expect(message).not.toContain('sensitive-write-detail');
  expect(readFileSync(filename)).toEqual(previous);
  expect(existsSync(`${filename}.tmp`)).toBe(false);
  store.set('provider-a', 'replacement-key'); expect(store.get('provider-a')).toBe('replacement-key');
});

it('rejects empty or oversized encryption results and preserves previous keys', () => {
  store.set('provider-a', 'previous-key'); const previous = readFileSync(filename);
  const encrypt = vi.spyOn(encryption, 'encryptString');
  for (const result of [Buffer.alloc(0), Buffer.alloc(128 * 1024 + 1)]) {
    encrypt.mockReturnValueOnce(result);
    expect(() => store.set('provider-a', 'replacement-key')).toThrow('保存');
    expect(readFileSync(filename)).toEqual(previous); expect(store.get('provider-a')).toBe('previous-key');
  }
});

it('refuses oversized ciphertext before decrypting it and preserves it', () => {
  const bytes = Buffer.alloc(128 * 1024 + 1); writeFileSync(filename, bytes);
  const decrypt = vi.spyOn(encryption, 'decryptString');
  expect(() => store.get('provider-a')).toThrow('格式无效');
  expect(decrypt).not.toHaveBeenCalled(); expect(readFileSync(filename)).toEqual(bytes);
});

it.each(['', 'a'.repeat(101), '../provider', 'has space', 'provider\n', '中文'])('validates provider ids for reads and writes without exposing their contents (%#)', id => {
  for (const action of [() => store.get(id), () => store.has(id), () => store.set(id, 'private-key'), () => store.set(id, undefined)]) {
    expect(action).toThrow('提供方 ID 无效');
  }
  expect(existsSync(filename)).toBe(false);
});

it.each(['', '   ', 'a'.repeat(4097), 'key\rvalue', 'key\nvalue', '\nkey'])('rejects invalid keys without writing or including key material in errors (%#)', value => {
  let message = '';
  try { store.set('provider-a', value); } catch (error) { message = (error as Error).message; }
  expect(message).toBe('API Key 无效；请输入 1–4096 字符且不含换行的密钥');
  expect(existsSync(filename)).toBe(false);
});

it('accepts safe maximum-length ids and trimmed maximum-length keys', () => {
  const id = 'a'.repeat(100), value = 'k'.repeat(4096);
  store.set(id, ` ${value} `);
  expect(new EncryptedModelSecrets(filename, encryption).get(id)).toBe(value);
});
