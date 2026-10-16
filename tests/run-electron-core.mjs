import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { clearTimeout } from 'node:timers';

const entry = resolve('.runtime/core/main/index.js');
if (!existsSync(entry)) throw new Error(`缺少核心测试入口，先运行 npm run build:core: ${entry}`);
const require = createRequire(import.meta.url);
const executable = require('electron');
if (!existsSync(executable)) throw new Error('Electron 运行时不存在');
mkdirSync('.runtime', { recursive: true });
const testRoot = mkdtempSync(join(resolve('.runtime'), 'electron core 中文 & '));
async function run(phase) {
  const env = { ...process.env, NEXUS_CORE_TEST_ROOT: testRoot, NEXUS_CORE_TEST_PHASE: phase };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [entry], { env, shell: false, windowsHide: true, stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron 核心验收超时')); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Electron 核心验收 ${phase} 失败: exit ${code}`)); });
  });
}
await run('run');
await run('restart');
