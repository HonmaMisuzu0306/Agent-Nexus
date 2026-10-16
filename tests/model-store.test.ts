import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../packages/persistence';
import { parseRequest } from '../packages/shared';

it('stores non-secret model config and interrupts unfinished model calls on restart without replay', async () => {
  const root=mkdtempSync(join(tmpdir(),'nexus-model-store-')); let repo:Repository|undefined;
  try {
    repo=await Repository.open(join(root,'db.sqlite'));
    expect(repo.migrationVersion()).toBe(7);
    const config={id:'local-test',name:'Local',kind:'openai' as const,scope:'local' as const,baseUrl:'http://127.0.0.1:5000/v1',timeoutMs:10000,maxOutputTokens:2048,structuredOutput:'json-schema' as const,createdAt:'now',updatedAt:'now'};
    repo.modelConfigSave(config); expect(repo.modelConfigs()).toEqual([config]);
    repo.modelCallSave({id:'model:one',providerId:config.id,model:'toy',status:'running',purpose:'probe',scope:'local',endpoint:config.baseUrl,createdAt:'now',requestHash:'sha256',text:''});
    repo.close(); repo=await Repository.open(join(root,'db.sqlite')); repo.recoverInterrupted();
    expect(repo.modelCalls()[0].status).toBe('interrupted'); expect(repo.modelCalls()).toHaveLength(1);
    expect(readFileSync(join(root,'db.sqlite')).includes(Buffer.from('apiKey'))).toBe(false);
  } finally {repo?.close();rmSync(root,{recursive:true,force:true});}
});

it('rejects inline credentials and non-team model reasoning at the public IPC boundary',()=>{
  const base={id:'local-test',name:'Local',kind:'openai',scope:'local',baseUrl:'http://127.0.0.1:5000/v1',timeoutMs:10000,maxOutputTokens:2048,structuredOutput:'json-schema'};
  expect(parseRequest('models.save',{config:base}).config.id).toBe('local-test');
  expect(()=>parseRequest('models.save',{config:{...base,apiKey:'forbidden'}})).toThrow();
  expect(()=>parseRequest('leader.start',{projectId:'p',goal:'g',leader:'codex',workers:['codex'],reasoning:{primary:{providerId:'local-test',model:'toy'}}})).toThrow();
});
it('upgrades an actual v5 database without replacing existing projects',async()=>{
  const root=mkdtempSync(join(tmpdir(),'nexus-model-v5-'));const file=join(root,'db.sqlite');
  try{let repo=await Repository.open(file);const project=repo.addProject('Existing v5',root);repo.close();
    const require=createRequire(import.meta.url);const SQL=await initSqlJs({locateFile:()=>require.resolve('sql.js/dist/sql-wasm.wasm')});const old=new SQL.Database(readFileSync(file));old.run('DROP TABLE workflow_drafts; DROP TABLE model_calls; DROP TABLE model_configs; PRAGMA user_version=5');writeFileSync(file,old.export());old.close();
    repo=await Repository.open(file);try{expect(repo.migrationVersion()).toBe(7);expect(repo.project(project.id).name).toBe('Existing v5');expect(repo.modelConfigs()).toEqual([]);}finally{repo.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
