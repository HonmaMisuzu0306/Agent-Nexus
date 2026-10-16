import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { Repository } from '../packages/persistence';
it('upgrades actual v4 data to v5 without replacing M3 projects or histories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'Nexus v5 ')); const file = join(root,'nexus.sqlite');
  try {
    const repo = await Repository.open(file); const p = repo.addProject('Preserved M3',root); repo.close();
    const require = createRequire(import.meta.url); const SQL = await initSqlJs({locateFile:()=>require.resolve('sql.js/dist/sql-wasm.wasm')}); const db = new SQL.Database(readFileSync(file));
    db.run('DROP TABLE IF EXISTS workflow_drafts; DROP TABLE IF EXISTS model_calls; DROP TABLE IF EXISTS model_configs; DROP TABLE IF EXISTS meetings; DROP TABLE IF EXISTS leader_handoffs; DROP TABLE IF EXISTS workspace_merges; PRAGMA user_version=4;'); writeFileSync(file,db.export()); db.close();
    const restored = await Repository.open(file); try { expect(restored.migrationVersion()).toBe(7); expect(restored.project(p.id).name).toBe('Preserved M3'); expect(restored.leaderRuns(p.id)).toEqual([]); } finally { restored.close(); }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
