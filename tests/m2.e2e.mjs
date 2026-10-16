import { _electron as electron, expect } from 'playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const packaged = process.argv[2]; const require = createRequire(import.meta.url);
mkdirSync('.runtime', { recursive: true }); mkdirSync('test-results', { recursive: true });
const root = mkdtempSync(join(resolve('.runtime'), 'm2 product ')); const env = { ...process.env, NEXUS_DATA_DIR: join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const report = { status: 'RUNNING', root, packaged: !!packaged, checks: [], errors: [] }; let app; let page;
async function launch() {
  app = await electron.launch({ executablePath: packaged ? resolve(packaged) : require('electron'), args: packaged ? [] : ['.'], env, timeout: 30000 });
  page = await app.firstWindow(); page.on('pageerror', e => report.errors.push(e.message));
  await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible();
}
async function api(channel, args) { return page.evaluate(async ({ channel, args }) => { const r = await window.nexus.call(channel, args); if (!r.ok) throw new Error(r.error); return r.data; }, { channel, args }); }
async function newTask(projectId, count, prompt) {
  await expect.poll(async () => (await api('tasks.list', { projectId, offset: 0, limit: 30 })).tasks.length, { timeout: 15000 }).toBe(count);
  await expect(page.locator('.full-prompt')).toHaveText(prompt);
  return (await api('tasks.list', { projectId, offset: 0, limit: 30 })).tasks[0];
}
try {
  await launch();
  await page.getByRole('button', { name: '项目管理', exact: true }).click(); await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称').fill('Empty native acceptance'); await page.getByLabel('目录路径').fill(root); await page.getByRole('button', { name: '创建项目', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '独立工作台', exact: true }).click();
  const snapshot = await api('snapshot.get', {}); const projectId = snapshot.settings.projectId; report.installations = snapshot.installations;
  const codex = page.locator('[data-agent="codex"]');
  await codex.getByLabel('Codex 权限').selectOption('workspace-write'); await codex.getByLabel('Codex 任务输入').fill('No tools. Reply NEXUS_PRODUCT_OK.'); await codex.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Git'); expect((await api('tasks.list', { projectId, offset: 0, limit: 30 })).tasks).toHaveLength(0);
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await codex.getByLabel('Codex 权限').selectOption('read-only');
  let count = 0;
  for (const [provider, name] of [['codex', 'Codex'], ['dsh', 'DeepSeek Harness']]) {
    const panel = page.locator(`[data-agent="${provider}"]`);
    const prompt = 'Do not use any tools, inspect files, call agents or access the web. Reply with exactly NEXUS_PRODUCT_OK.';
    await panel.getByLabel(`${name} 任务输入`).fill(prompt);
    await panel.getByRole('button', { name: '发送任务', exact: true }).click();
    await newTask(projectId, ++count, prompt);
    await expect(page.locator('.task-info strong')).toHaveText('真实完成', { timeout: 90000 });
    await expect(panel.locator('.console-lines')).toContainText('NEXUS_PRODUCT_OK'); report.checks.push(`${provider}: UI -> sandbox IPC -> native inference -> persisted real completion`);
  }
  const workbuddy = page.locator('[data-agent="workbuddy"]'); await workbuddy.getByLabel('WorkBuddy 人工交接目标').fill('Synthetic manual office report'); await workbuddy.getByRole('button', { name: '准备并复制目标', exact: true }).click();
  await expect(workbuddy.getByRole('status')).toContainText('已复制');
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText()); expect(copied).toContain('Synthetic manual office report');
  await workbuddy.getByRole('button', { name: '导入人工结果', exact: true }).click(); await page.getByLabel('人工结果文本').fill('Synthetic user-reported result'); await page.getByRole('button', { name: '保存人工结果', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(workbuddy).toContainText('原生完成状态未验证'); expect((await api('tasks.list', { projectId, offset: 0, limit: 30 })).tasks).toHaveLength(2);
  report.checks.push('WorkBuddy: clipboard handoff / manual import kept separate from native task success');
  await app.close(); app = null; await launch();
  await expect(page.locator('[data-agent="workbuddy"]')).toContainText('Synthetic user-reported result');
  const resumed = page.locator('[data-agent="codex"]'); await resumed.getByLabel('继续上次会话').check(); await resumed.getByLabel('Codex 任务输入').fill('Do not use tools or inspect files. Repeat the exact text from your preceding response.'); await resumed.getByRole('button', { name: '继续会话', exact: true }).click();
  await newTask(projectId, ++count, 'Do not use tools or inspect files. Repeat the exact text from your preceding response.');
  await expect(page.locator('.task-info strong')).toHaveText('真实完成', { timeout: 90000 }); await expect(resumed.locator('.console-lines')).toContainText('NEXUS_PRODUCT_OK');
  await resumed.getByLabel('Codex 任务输入').fill('Do not use tools. Write integers from 1 to 3000 on separate lines.'); await resumed.getByRole('button', { name: '继续会话', exact: true }).click(); await newTask(projectId, ++count, 'Do not use tools. Write integers from 1 to 3000 on separate lines.'); await resumed.getByRole('button', { name: '停止任务', exact: true }).click(); await expect(page.locator('.task-info strong')).toHaveText('已取消', { timeout: 15000 });
  await resumed.getByLabel('继续上次会话').uncheck();
  const project = snapshot.projects.find(p => p.id === projectId); expect(spawnSync('git', ['init', '--quiet', project.rootPath], { windowsHide: true }).status).toBe(0);
  await resumed.getByLabel('Codex 权限').selectOption('workspace-write');
  const writePrompt = 'Use only a file editing tool to create acceptance.txt in the current project with the exact contents NEXUS_WRITE_OK. Do not run commands, access the web, inspect other files, or call other agents. Then reply DONE.';
  await resumed.getByLabel('Codex 任务输入').fill(writePrompt); await resumed.getByRole('button', { name: '发送任务', exact: true }).click(); await newTask(projectId, ++count, writePrompt);
  await expect(page.locator('.task-info strong')).toHaveText('真实完成', { timeout: 90000 }); expect(readFileSync(join(project.rootPath, 'acceptance.txt'), 'utf8').trim()).toBe('NEXUS_WRITE_OK');
  report.checks.push('native workspace-write in independent Git project: acceptance.txt readback matches requested content');
  const tasks = (await api('tasks.list', { projectId, offset: 0, limit: 30 })).tasks; expect(tasks.every(t => t.mode === 'real')).toBe(true); expect((await api('snapshot.get', {})).activeTaskCount).toBe(0);
  report.tasks = tasks; report.checks.push('full application restart: native thread resume, remembered response, cancellation; manual record retained');
  await page.screenshot({ path: 'test-results/m2-workspace.png' });
  expect(report.errors).toEqual([]); report.status = 'PASSED';
} catch (error) { report.status = 'FAILED'; report.error = error.message; if (page) await page.screenshot({ path: 'test-results/m2-failure.png' }); throw error; }
finally { if (app) await app.close(); writeFileSync(`test-results/${packaged ? 'm2-packaged' : 'm2-product'}-report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: report.status, checks: report.checks, root }, null, 2)); }
