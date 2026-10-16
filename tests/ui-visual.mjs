import { _electron as electron, expect } from 'playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

mkdirSync('.runtime', { recursive: true }); mkdirSync('test-results', { recursive: true });
const testRoot = mkdtempSync(join(resolve('.runtime'), 'ui visual '));
const env = { ...process.env, NEXUS_DATA_DIR: join(testRoot, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const require = createRequire(import.meta.url);
const app = await electron.launch({ executablePath: require('electron'), args: ['.'], env });
const page = await app.firstWindow(); const errors = [];
await page.emulateMedia({ reducedMotion: 'reduce' });
page.on('pageerror', e => errors.push(e.message));
const checks = [];
async function api(channel, args) {
  return page.evaluate(async ({ channel, args }) => { const r = await window.nexus.call(channel, args); if (!r.ok) throw new Error(r.error); return r.data; }, { channel, args });
}
async function size(width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  checks.push(`CSS viewport ${width}x${height}: no horizontal overflow`);
}
async function shot(name) { await page.screenshot({ path: `test-results/${name}.png`, scale: 'css', fullPage: false, animations: 'disabled' }); }
try {
  await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible();
  await size(1440, 960);
  await page.getByRole('button', { name: '项目管理', exact: true }).click();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称').fill('Agent Nexus'); await page.getByLabel('目录路径').fill(testRoot);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await shot('projects-light');
  await page.getByRole('button', { name: '独立工作台', exact: true }).click();
  const panel = page.locator('[data-agent="codex"]');
  await panel.getByRole('button', { name: '模拟演示', exact: true }).click();
  await panel.getByLabel('Codex 任务输入').fill('检查 Adapter 能力与本地会话边界。');
  await panel.getByRole('button', { name: '开始模拟' }).click();
  await expect(page.locator('.task-info strong')).toHaveText('模拟完成', { timeout: 10000 });
  await expect(page.locator('.agent-panel').last().locator('.agent-footer')).toBeInViewport({ ratio: 1 });
  await shot('workspace-light');
  await page.getByRole('button', { name: '切换深色主题', exact: true }).click(); await shot('workspace-dark');
  await page.getByRole('button', { name: '切换浅色主题', exact: true }).click();
  for (const [name, file] of [['总览', 'overview'], ['设置', 'settings'], ['Leader Mode', 'leader']]) {
    await page.getByRole('button', { name, exact: true }).click(); await shot(file);
  }
  await page.getByRole('button', { name: '独立工作台', exact: true }).click();
  await size(390, 844); await shot('workspace-mobile');
  expect(await page.locator('.agent-panel').count()).toBe(4);
  for (const name of ['总览', '项目管理', '任务历史', 'Leader Mode', 'Agent 会议', '工作流', '设置']) {
    await page.getByRole('button', { name, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  checks.push('390px: all eight pages usable as a single-column content flow');
  await size(1440, 960);
  const longName = '用于检验长名称自然换行的本地项目'.repeat(4);
  const longProject = await api('project.create', { name: longName, parentPath: testRoot });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(page.getByLabel('当前项目').locator('option')).toHaveCount(3);
  await page.getByLabel('当前项目').selectOption(longProject.id);
  await page.getByRole('button', { name: '项目管理', exact: true }).click();
  await expect(page.locator('.project-card h2').filter({ hasText: longName })).toHaveText(longName);
  await shot('projects-long-name');
  await page.getByRole('button', { name: '独立工作台', exact: true }).click();
  const longPrompt = '这是必须完整保留的验收目标；'.repeat(500);
  await panel.getByRole('button', { name: '模拟演示', exact: true }).click();
  await panel.getByLabel('Codex 任务输入').fill(longPrompt);
  await panel.getByRole('button', { name: '开始模拟' }).click();
  await panel.getByRole('button', { name: '停止模拟' }).click();
  await expect(page.locator('.full-prompt')).toHaveText(longPrompt);
  expect(await page.locator('.full-prompt').evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  checks.push('long project name and 7,000-character prompt retained; full prompt scrolls without omission');
  await page.getByRole('button', { name: '项目管理', exact: true }).click();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await expect(page.getByLabel('项目名称')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称').fill('CON'); await page.getByLabel('目录路径').fill(testRoot);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.locator('.form-error')).toBeVisible(); await shot('project-validation');
  await page.keyboard.press('Escape');
  checks.push('native dialog focus/Escape; invalid Windows folder name remains rejected');
  await page.getByRole('button', { name: '独立工作台', exact: true }).click();
  const samples = [];
  for (const theme of ['light', 'dark']) {
    const current = await api('snapshot.get', {});
    if (current.settings.theme !== theme) await page.getByRole('button', { name: theme === 'light' ? '切换浅色主题' : '切换深色主题', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const contrasts = await page.evaluate(() => {
      const luminance = rgb => rgb.map(x => x / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4).reduce((v, x, i) => v + x * [0.2126, 0.7152, 0.0722][i], 0);
      return ['.page-header h1', '.workspace-toolbar p', '.agent-mode', '.unconnected p', '.sidebar nav button.active', '.inspector-summary', '.task-info', '.button-primary:not(:disabled)', '.topbar .button-ghost', '.agent-header .button-ghost', '.layout-controls .button-outline'].map(selector => {
        const el = document.querySelector(selector); if (!el) return null;
        const color = getComputedStyle(el).color.match(/[\d.]+/g).map(Number).slice(0, 3);
        let parent = el; let bg;
        while (parent) { const c = getComputedStyle(parent).backgroundColor.match(/[\d.]+/g).map(Number); if (c.length < 4 || c[3] === 1) { bg = c.slice(0, 3); break; } parent = parent.parentElement; }
        if (!bg) bg = [255, 255, 255];
        const a = luminance(color), b = luminance(bg); return { selector, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      }).filter(Boolean);
    });
    for (const c of contrasts) expect(c.ratio, `${theme} ${c.selector}`).toBeGreaterThanOrEqual(4.5);
    samples.push({ theme, contrasts });
  }
  checks.push('sampled essential text contrast >=4.5:1 in both themes');
  expect(errors).toEqual([]);
  writeFileSync('test-results/ui-visual-report.json', JSON.stringify({ passed: true, checks, samples, errors, testRoot }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, samples }, null, 2));
} catch (error) { await shot('visual-failure'); throw error; }
finally { await app.close(); }
