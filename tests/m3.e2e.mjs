import { _electron as electron, expect } from 'playwright/test';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url); mkdirSync('test-results', { recursive: true }); mkdirSync('.runtime', { recursive: true });
await build({ entryPoints: ['tests/fixtures/m3-desktop.ts'], outfile: '.runtime/m3-desktop.cjs', platform: 'node', format: 'cjs', bundle: true, external: ['electron', 'sql.js'], define: { 'import.meta.url': '__m3FileUrl' }, banner: { js: "const __m3FileUrl = require('node:url').pathToFileURL(__filename).href;" } });
const root = mkdtempSync(join(resolve('.runtime'), 'm3 product ')); const env = { ...process.env, NEXUS_DATA_DIR: join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
let app; const errors = []; const checks = [];
const api = (page, channel, args) => page.evaluate(async ({ channel, args }) => { const r = await window.nexus.call(channel, args); if (!r.ok) throw Error(r.error); return r.data; }, { channel, args });
async function launch() { app = await electron.launch({ args: [resolve('.runtime/m3-desktop.cjs')], env, executablePath: require('electron') }); const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible(); await page.setViewportSize({ width: 1440, height: 960 }); return page; }
try {
  let page = await launch(); const p = await api(page, 'project.add', { name: 'M3 synthetic fixture', rootPath: root }); await api(page, 'settings.set', { projectId: p.id }); await page.reload();
  await page.getByRole('button', { name: 'Leader Mode', exact: true }).click();
  await page.getByLabel('开启 M3.5 团队协作').uncheck();
  async function plan(goal) { await page.getByLabel('Leader 总体目标').fill(goal); await page.getByRole('button', { name: '生成 Leader 计划', exact: true }).click(); await expect(page.getByRole('status', { name: 'Leader Run 当前状态' })).toHaveText('等待首次计划确认', { timeout: 15000 }); const runs = await api(page, 'leader.list', { projectId: p.id, offset: 0, limit: 20 }); return runs[0].id; }
  const first = await plan('Synthetic two-step fixture'); expect((await api(page, 'leader.get', { runId: first })).tasks.every(n => n.attempt === 0)).toBe(true);
  await page.screenshot({ path: 'test-results/m3-plan-approval.png' });
  await page.getByRole('button', { name: '确认并批准此计划', exact: true }).click();
  await expect.poll(async () => (await api(page, 'leader.get', { runId: first })).tasks[0].status).toBe('running');
  await page.getByRole('button', { name: '暂停后续派单', exact: true }).click(); await expect(page.getByRole('status', { name: 'Leader Run 当前状态' })).toHaveText('已暂停后续派单');
  await expect.poll(async () => (await api(page, 'leader.get', { runId: first })).tasks[0].status).toBe('completed'); expect((await api(page, 'leader.get', { runId: first })).tasks[1].status).toBe('pending');
  await page.getByRole('button', { name: '继续派单', exact: true }).click(); await expect(page.getByRole('status', { name: 'Leader Run 当前状态' })).toHaveText('审查通过', { timeout: 15000 });
  await expect(page.getByRole('region', { name: 'Leader 验收报告' })).toContainText('mock');
  checks.push('actual desktop controls: first-plan approval, serial dependency, pause preserves in-flight completion, resume, report with mock provenance');
  await page.screenshot({ path: 'test-results/m3-completed.png' });
  await page.getByRole('button', { name: '切换深色主题', exact: true }).click(); await page.screenshot({ path: 'test-results/m3-dark.png' }); await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/m3-narrow.png' }); await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByLabel('Leader Agent', { exact: true }).selectOption('dsh'); await page.getByLabel('DeepSeek Harness Worker').uncheck(); await page.getByLabel('Codex Worker').check(); await page.getByLabel('Leader 控制模式').selectOption('manual');
  const manual = await plan('Manual role-swapped fixture'); await page.getByRole('button', { name: '确认并批准此计划', exact: true }).click(); await page.getByRole('button', { name: '派发 a', exact: true }).click(); await expect.poll(async () => (await api(page, 'leader.get', { runId: manual })).tasks[0].status).toBe('completed'); expect((await api(page, 'leader.get', { runId: manual })).tasks[1].status).toBe('pending'); await page.getByRole('button', { name: '派发 b', exact: true }).click(); await expect.poll(async () => (await api(page, 'leader.get', { runId: manual })).tasks[1].status).toBe('completed'); await page.getByRole('button', { name: '请求 Leader 审查', exact: true }).click(); await expect(page.getByRole('status', { name: 'Leader Run 当前状态' })).toHaveText('审查通过', { timeout: 15000 });
  checks.push('Manual dispatch/review works with DSH selected as Leader; roles are not fixed to Codex (offline fixture only)');
  await page.getByLabel('Leader 控制模式').selectOption('supervised'); const stopped = await plan('Stop-all fixture'); await page.getByRole('button', { name: '确认并批准此计划', exact: true }).click(); await expect.poll(async () => (await api(page, 'leader.get', { runId: stopped })).tasks[0].status).toBe('running'); await page.getByRole('button', { name: '停止全部任务', exact: true }).click(); await expect(page.getByRole('status', { name: 'Leader Run 当前状态' })).toHaveText('已停止'); expect((await api(page, 'leader.get', { runId: stopped })).tasks[1].status).toBe('cancelled');
  checks.push('global Stop-all stops dispatch before provider cancellation and never dispatches dependent work');
  const interrupted = await plan('Shutdown fixture'); await page.getByRole('button', { name: '确认并批准此计划', exact: true }).click(); await expect.poll(async () => (await api(page, 'leader.get', { runId: interrupted })).tasks[0].status).toBe('running'); await app.close(); app = null; page = await launch(); const recovered = await api(page, 'leader.get', { runId: interrupted }); expect(recovered.run.status).toBe('interrupted'); expect(recovered.tasks[0].status).toBe('interrupted'); expect(recovered.tasks[1].attempt).toBe(0); expect((await api(page, 'snapshot.get', {})).activeTaskCount).toBe(0);
  checks.push('shutdown/restart retains run/task histories and never replays uncertain tasks');
  expect(errors).toEqual([]); writeFileSync('test-results/m3-product-report.json', JSON.stringify({ passed: true, nativeProviders: false, fixture: 'actual renderer/preload/IPC/service, test-only mock adapters', checks, rendererErrors: errors }, null, 2)); console.log(JSON.stringify({ passed: true, checks, nativeProviders: false }));
} finally { if (app) await app.close(); }
