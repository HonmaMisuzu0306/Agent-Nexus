// Production executable reads a copy of synthetic M5 evidence; no new Provider calls.
import { _electron as electron, expect } from 'playwright/test';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const source = JSON.parse(readFileSync('test-results/m5-product-report.json', 'utf8'));
if (!source.passed || source.nativeProviders !== false) throw Error('M5 fixture evidence missing');
const root = mkdtempSync(join(resolve('.runtime'), 'm5 packaged ')); mkdirSync(join(root, 'data'));
copyFileSync(join(source.root, 'data', 'nexus.sqlite'), join(root, 'data', 'nexus.sqlite'));
const env = { ...process.env, NEXUS_DATA_DIR: join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const executable = resolve('release/win-unpacked/Agent Nexus.exe');
const app = await electron.launch({ executablePath: executable, args: [], env, timeout: 30000 }); const errors = [];
try {
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible();
  const call = (channel, args) => page.evaluate(async ({ channel, args }) => { const r = await window.nexus.call(channel, args); if (!r.ok) throw Error(r.error); return r.data; }, { channel, args });
  const before = await call('diagnostics.get', {}), snapshot = await call('snapshot.get', {}), projectId = snapshot.settings.projectId;
  await page.getByRole('button', { name: '工作流', exact: true }).click(); const drafts = await call('workflow.list', { projectId });
  expect(drafts).toHaveLength(1); await page.getByLabel('已保存工作流').selectOption(drafts[0].id); await page.getByRole('button', { name: '载入草案', exact: true }).click();
  await expect(page.getByLabel('工作流名称')).toHaveValue('M5 saved fixture'); await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await page.locator('.workflow-graph').scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/m5-packaged-workflow.png' });
  await page.getByRole('button', { name: 'Leader Mode', exact: true }).click(); await expect(page.getByRole('status', { name: 'Leader Run 当前状态' })).toHaveText('审查通过');
  const runs = await call('leader.list', { projectId, offset: 0, limit: 20 }); expect(runs[0].planRevision).toBe(2);
  await page.getByRole('button', { name: '任务历史', exact: true }).click(); await page.getByLabel('历史全文搜索').fill('M5_LONG_LOG_NEEDLE'); await page.getByRole('button', { name: '搜索历史', exact: true }).click(); await expect(page.locator('.history-item')).toHaveCount(1);
  const after = await call('diagnostics.get', {}); expect(after.taskCount).toBe(before.taskCount); expect(after.eventCount).toBe(before.eventCount); expect(snapshot.activeTaskCount).toBe(0); expect(errors).toEqual([]);
  writeFileSync('test-results/m5-packaged-report.json', JSON.stringify({ passed: true, executable, root, nativeProviders: false, checks: ['Production executable restores saved DAG, completed revision 2 and full persisted logs', 'No replay or Provider task created while browsing copied M5 history'], errors }, null, 2)); console.log('M5 packaged history/workflow passed');
} finally { await app.close(); }
