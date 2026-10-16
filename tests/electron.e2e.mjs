import { _electron as electron, expect } from 'playwright/test';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packagedExecutable = process.env.NEXUS_E2E_PACKAGED || process.argv[2];
const root = resolve('.runtime'); mkdirSync(root, { recursive: true });
const testRoot = mkdtempSync(join(root, 'm1 acceptance 中文 & '));
const data = join(testRoot, 'user data');
const projects = join(testRoot, 'projects'); mkdirSync(projects);
mkdirSync('test-results', { recursive: true });
const env = { ...process.env, NEXUS_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const errors = []; const checks = [];
let app;
async function launch() {
  app = await electron.launch({ executablePath: packagedExecutable ? resolve(packagedExecutable) : require('electron'), args: packagedExecutable ? [] : ['.'], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1520, 980));
  await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible();
  return page;
}
async function api(page, channel, args) {
  return page.evaluate(async ({ channel, args }) => { const reply = await window.nexus.call(channel, args); if (!reply.ok) throw new Error(reply.error); return reply.data; }, { channel, args });
}
async function noOverflow(page, size) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), size);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  checks.push(`layout ${size.join('x')}: no document overflow`);
}
try {
  let page = await launch();
  const security = await app.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox };
  });
  expect(security).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  const rejected = await page.evaluate(() => window.nexus.call('execute', { command: 'whoami' })); expect(rejected.ok).toBe(false);
  const invalid = await page.evaluate(() => window.nexus.call('task.start', { shell: true })); expect(invalid.ok).toBe(false);
  checks.push('sandbox, IPC allowlist, malformed input rejection');
  await page.getByRole('button', { name: '项目管理', exact: true }).click();
  for (const name of ['Project One', '项目 Two']) {
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByLabel('项目名称').fill(name);
    await page.getByLabel('目录路径').fill(projects);
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const snapshot = await api(page, 'snapshot.get', {}); expect(snapshot.projects).toHaveLength(2);
  await page.getByLabel('当前项目').selectOption(snapshot.projects.find(p => p.name === 'Project One').id);
  await page.getByRole('button', { name: '独立工作台', exact: true }).click();
  const codex = page.locator('[data-agent="codex"]');
  await expect(codex.getByRole('button', { name: '发送任务' })).toBeDisabled();
  await codex.getByRole('button', { name: '模拟演示', exact: true }).click();
  await codex.getByLabel('Codex 任务输入').fill('验证模拟成功');
  await codex.getByRole('button', { name: '开始模拟' }).click();
  await expect(page.locator('.task-info strong')).toHaveText('模拟完成', { timeout: 10000 });
  await expect(codex.locator('.console-lines')).toContainText('未向任何真实 Provider');
  await codex.getByLabel('Codex 模拟场景').selectOption('failure');
  await codex.getByLabel('Codex 任务输入').fill('验证模拟失败');
  await codex.getByRole('button', { name: '开始模拟' }).click();
  await expect(page.locator('.task-info strong')).toHaveText('模拟失败', { timeout: 10000 });
  const dsh = page.locator('[data-agent="dsh"]');
  await dsh.getByRole('button', { name: '模拟演示', exact: true }).click();
  await dsh.getByLabel('DeepSeek Harness 任务输入').fill('验证模拟取消');
  await dsh.getByRole('button', { name: '开始模拟' }).click();
  await dsh.getByRole('button', { name: '停止模拟' }).click();
  await expect(page.locator('.task-info strong')).toHaveText('已取消');
  expect((await api(page, 'tasks.list', { projectId: snapshot.projects.find(p => p.name === 'Project One').id, offset: 0, limit: 30 })).tasks.map(t => t.status)).toEqual(['cancelled', 'failed', 'completed']);
  checks.push('UI: create two projects, success/failure/cancel event streams');
  await page.getByLabel('当前项目').selectOption(snapshot.projects.find(p => p.name === '项目 Two').id);
  await expect(page.locator('.task-item')).toHaveCount(0);
  await page.getByLabel('当前项目').selectOption(snapshot.projects.find(p => p.name === 'Project One').id);
  await expect(page.locator('.task-item')).toHaveCount(3);
  await codex.getByRole('button', { name: '模拟演示', exact: true }).click();
  await codex.getByLabel('Codex 任务输入').fill('跨项目全局停止验证');
  await codex.getByRole('button', { name: '开始模拟' }).click();
  await page.getByLabel('当前项目').selectOption(snapshot.projects.find(p => p.name === '项目 Two').id);
  await expect(page.getByRole('button', { name: '停止全部任务', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '停止全部任务', exact: true }).click();
  await page.getByLabel('当前项目').selectOption(snapshot.projects.find(p => p.name === 'Project One').id);
  await expect(page.locator('.task-item')).toHaveCount(4);
  await page.getByRole('button', { name: '双栏布局', exact: true }).click();
  await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
  await app.close(); page = await launch();
  await expect(page.locator('.agent-grid')).toHaveClass(/layout-columns/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.task-item')).toHaveCount(4);
  checks.push('restart: projects, layout, theme, task history persist; no replay');
  await page.getByRole('button', { name: '切换浅色主题', exact: true }).click();
  await page.getByRole('button', { name: '四宫格布局', exact: true }).click();
  await page.locator('[data-agent="codex"]').getByRole('button', { name: '模拟演示', exact: true }).click();
  await page.screenshot({ path: 'test-results/workspace-light.png' });
  await page.getByRole('button', { name: '聚焦 Codex', exact: true }).click();
  await expect(page.locator('.agent-panel')).toHaveCount(1);
  await page.getByRole('button', { name: '四宫格布局', exact: true }).click();
  await page.getByRole('button', { name: 'Leader Mode', exact: true }).click();
  await expect(page.getByLabel('Leader 总体目标')).toBeVisible();
  await page.locator('.main-scroll').evaluate(e => { e.scrollTop = e.scrollHeight; });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '工作台设置', exact: true })).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: '独立工作台', exact: true }).click();
  for (const size of [[2560, 1600], [1366, 768], [960, 680]]) await noOverflow(page, size);
  await page.screenshot({ path: 'test-results/workspace-laptop.png' });
  await page.getByRole('button', { name: '项目管理', exact: true }).click();
  const projectCard = page.locator('.project-card').filter({ hasText: '项目 Two' });
  await projectCard.getByRole('button', { name: '从列表移除', exact: true }).click();
  expect(existsSync(snapshot.projects.find(p => p.name === '项目 Two').rootPath)).toBe(true);
  expect((await api(page, 'snapshot.get', {})).projects).toHaveLength(1);
  checks.push('project removal retains disk files; Leader navigation opens the M3 control page');
  expect(errors).toEqual([]);
  await app.close(); app = null;
  writeFileSync(`test-results/${packagedExecutable ? 'packaged-e2e-report' : 'e2e-report'}.json`, JSON.stringify({ passed: true, packaged: !!packagedExecutable, checks, security, errors, testRoot }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, testRoot }, null, 2));
} catch (error) {
  if (app) { const page = await app.firstWindow(); await page.screenshot({ path: 'test-results/e2e-failure.png' }); }
  throw error;
} finally { if (app) await app.close(); }
