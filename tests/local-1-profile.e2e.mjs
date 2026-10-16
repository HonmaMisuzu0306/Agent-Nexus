// Upgrade a COPY of the existing local profile, without sending model prompts
// or changing the installed app/user database. Do not print private contents.
import { _electron as electron, expect } from 'playwright/test';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const source = join(process.env.APPDATA, 'agent-nexus', 'nexus.sqlite');
if (!existsSync(source)) throw Error('Existing local profile is absent');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const before = digest(readFileSync(source)), root = mkdtempSync(join(resolve('.runtime'), 'local-1 profile ')), data = join(root, 'data'); mkdirSync(data); const target = join(data, 'nexus.sqlite'); copyFileSync(source, target);
const env = { ...process.env, NEXUS_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({ executablePath: resolve('release/win-unpacked/Agent Nexus.exe'), args: [], env, timeout: 45000 });
try {
  const page = await app.firstWindow(); await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible({ timeout: 45000 });
  const report = await page.evaluate(async () => { const result = await window.nexus.call('diagnostics.get', {}); if (!result.ok) throw Error(result.error); return result.data; });
  expect(report.schemaVersion).toBe(7); expect(existsSync(target + '.before-v7.bak')).toBe(true); expect(digest(readFileSync(target + '.before-v7.bak'))).toBe(before); expect(digest(readFileSync(source))).toBe(before);
  writeFileSync('test-results/local-1-profile-report.json', JSON.stringify({ passed: true, root, schemaVersion: report.schemaVersion, sourceUnchanged: true, exactUpgradeBackup: true, modelPromptsSent: 0 }, null, 2)); console.log('Existing local profile copy upgrades successfully; original unchanged; no model prompts');
} finally { await app.close(); }
