import { chromium, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { clearTimeout } from 'node:timers';

const portProbe = createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
mkdirSync('.runtime', { recursive: true }); mkdirSync('test-results', { recursive: true });
const data = mkdtempSync(join(resolve('.runtime'), 'dev smoke '));
const env = { ...process.env, NEXUS_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, [resolve('node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--remoteDebuggingPort', String(port)], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
let browser;
try {
  const deadline = Date.now() + 30000; let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev process exit ${child.exitCode}: ${output}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) { ready = true; break; } } catch { /* local debug port not ready yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw new Error(`dev startup timed out: ${output}`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible();
  const reply = await page.evaluate(() => window.nexus.call('snapshot.get', {}));
  expect(reply.ok).toBe(true); expect(reply.data.installations).toHaveLength(4);
  await page.screenshot({ path: 'test-results/dev-workspace.png', scale: 'css', animations: 'disabled' });
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev process did not close with the window')), 10000);
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`dev exit ${code}`)); });
  });
  await page.evaluate(() => window.close()); await exited;
  writeFileSync('test-results/dev-report.json', JSON.stringify({ passed: true, rendererUrl: page.url(), ipc: true, cleanExit: true }, null, 2));
  console.log('PASS: electron-vite dev starts the product window, serves React, accepts trusted IPC and exits cleanly.');
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    if (process.platform === 'win32') await new Promise(r => {
      const cleanup = spawn(`${process.env.SystemRoot}\\System32\\taskkill.exe`, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' }); cleanup.on('close', r); cleanup.on('error', r);
    });
    else child.kill();
  }
}
