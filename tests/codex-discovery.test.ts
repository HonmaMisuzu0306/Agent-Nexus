import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findCodex } from '../packages/agent-core/codex';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'Nexus discovery ')); vi.stubEnv('PATH', ''); vi.stubEnv('LOCALAPPDATA', root); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function executable(folder: string, timestamp = 10000) { mkdirSync(folder, { recursive: true }); const file = join(folder, 'codex.exe'); writeFileSync(file, 'fixture, never executed'); utimesSync(file, timestamp, timestamp); return file; }

it.skipIf(process.platform !== 'win32')('finds a desktop-bundled native CLI absent from the Windows PATH', () => {
  const expected = executable(join(root, 'OpenAI', 'Codex', 'bin', 'version-a'));
  expect(findCodex()).toBe(expected);
});
it.skipIf(process.platform !== 'win32')('keeps an explicit PATH executable ahead of bundled versions', () => {
  const expected = executable(join(root, 'path-bin')); executable(join(root, 'OpenAI', 'Codex', 'bin', 'version-b'), 20000);
  vi.stubEnv('PATH', `"${join(root, 'path-bin')}"`); expect(findCodex()).toBe(expected);
});
it.skipIf(process.platform !== 'win32')('selects the newest existing native CLI and ignores directories without the executable', () => {
  executable(join(root, 'OpenAI', 'Codex', 'bin', 'older'), 10000); const expected = executable(join(root, 'OpenAI', 'Codex', 'bin', 'newer'), 20000);
  mkdirSync(join(root, 'OpenAI', 'Codex', 'bin', 'incomplete')); expect(findCodex()).toBe(expected);
});
it.skipIf(process.platform !== 'win32')('never treats shell wrappers or missing executables as a native CLI', () => {
  const folder = join(root, 'OpenAI', 'Codex', 'bin', 'wrapper'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'codex.cmd'), '@echo off');
  expect(findCodex()).toBeNull();
});
