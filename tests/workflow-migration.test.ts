import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { Repository } from '../packages/persistence';
it('keeps an exact pre-upgrade v6 database copy and preserves existing configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-v6-upgrade-')), file = join(root, 'db.sqlite');
  try {
    let repo = await Repository.open(file); const p = repo.addProject('Existing M4', root); repo.setSettings({ theme: 'dark', projectId: p.id }); repo.close();
    const require = createRequire(import.meta.url), SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const db = new SQL.Database(readFileSync(file)); db.run('DROP TABLE workflow_drafts; PRAGMA user_version=6'); writeFileSync(file, db.export()); db.close(); const previous = readFileSync(file);
    repo = await Repository.open(file); try { expect(repo.settings()).toMatchObject({ theme: 'dark', projectId: p.id }); expect(repo.workflowDrafts(p.id)).toEqual([]); } finally { repo.close(); }
    expect(existsSync(file + '.before-v7.bak')).toBe(true); expect(readFileSync(file + '.before-v7.bak')).toEqual(previous);
    repo = await Repository.open(file); repo.close(); expect(readFileSync(file + '.before-v7.bak')).toEqual(previous);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
