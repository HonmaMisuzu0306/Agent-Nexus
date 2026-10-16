// Explicitly authorized existing-profile verification AFTER user approves
// installing the candidate. Never run this as a default/offline test.
import { _electron as electron, expect } from 'playwright/test';
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
if (process.env.NEXUS_TEST_EXISTING_INSTALL !== '1') throw Error('Existing installation/profile verification requires explicit user authorization');
const require = createRequire(import.meta.url), expected = JSON.parse(readFileSync('package.json', 'utf8')).version;
const executable = join(process.env.LOCALAPPDATA, 'Programs', 'agent-nexus', 'Agent Nexus.exe'), file = join(process.env.APPDATA, 'agent-nexus', 'nexus.sqlite');
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
function counts() { const db = new SQL.Database(readFileSync(file)); try { return { schema: Number(db.exec('PRAGMA user_version')[0].values[0][0]), projects: Number(db.exec('SELECT COUNT(*) FROM projects')[0].values[0][0]), tasks: Number(db.exec('SELECT COUNT(*) FROM tasks')[0].values[0][0]), identities: createHash('sha256').update(JSON.stringify(['projects', 'tasks'].map(table => db.exec(`SELECT id FROM ${table} ORDER BY id`)))).digest('hex') }; } finally { db.close(); } }
const before = counts(), env = { ...process.env }; delete env.NEXUS_DATA_DIR; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const originalDatabaseHash = createHash('sha256').update(readFileSync(file)).digest('hex');
const launches = [], errors = [];
let app;
try {
  for (let launch = 1; launch <= 2; launch++) {
  app = await electron.launch({ executablePath: executable, args: [], env, timeout: 45000 });
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await expect(page.getByRole('heading', { name: 'Agent 工作台', exact: true })).toBeVisible({ timeout: 45000 });
  expect(await app.evaluate(({ app }) => app.getVersion())).toBe(expected);
  const snapshot = await page.evaluate(async () => { const r = await window.nexus.call('snapshot.get', {}); if (!r.ok) throw Error(r.error); return r.data; });
  const codex = snapshot.installations.find(i => i.id === 'codex'); expect(codex.auth).toBe('authenticated'); expect(codex.capabilities.sendPrompt.supported).toBe(true);
  expect(snapshot.projects).toHaveLength(before.projects); const after = counts(); expect(after.schema).toBe(7); expect(after.tasks).toBe(before.tasks); expect(after.identities).toBe(before.identities);
  if (before.schema < 7) {
    expect(existsSync(file + '.before-v7.bak')).toBe(true);
    expect(createHash('sha256').update(readFileSync(file + '.before-v7.bak')).digest('hex')).toBe(originalDatabaseHash);
  }
  expect(errors).toEqual([]);
  await app.close(); app = undefined;
  expect(counts()).toEqual(after);
  launches.push({ launch, after, codex: { authenticated: true, canSendPrompt: true, version: codex.version } });
  }
  writeFileSync('test-results/local-1-installed-report.json', JSON.stringify({ passed: true, version: expected, installedExecutable: resolve(executable), actualUserProfile: true, before, launches, restartVerified: true, modelPromptsSent: 0, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, version: expected, installed: true, codexConnected: true, projectsPreserved: true, tasksNotReplayed: true }));
} finally { if (app) await app.close(); }
