import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import type { LeaderView } from '../packages/shared/leader';

it.skipIf(process.env.NEXUS_TEST_M4_NATIVE!=='1')('real local Ollama planning, native Codex Worker and local model reviews',async()=>{
  mkdirSync('.runtime',{recursive:true});mkdirSync('test-results',{recursive:true});const root=mkdtempSync(join(resolve('.runtime'),'m4 native '));const projectRoot=join(root,'project');mkdirSync(projectRoot);
  writeFileSync(join(projectRoot,'calc.mjs'),'export function add(a,b) { return a + b; }\n');
  const repo=await Repository.open(join(root,'data','nexus.sqlite'));const service=new NexusService(repo);let id:string|undefined;
  const report:Record<string,unknown>={native:true,localModel:true,sourceRepositorySent:false,status:'RUNNING',fixtureRoot:projectRoot,date:new Date().toISOString()};
  const nativeFetch=globalThis.fetch;const responseDiagnostics:unknown[]=[];
  globalThis.fetch=async(...args:Parameters<typeof fetch>)=>{const response=await nativeFetch(...args);if(String(args[0]).endsWith('/api/chat')){const value=await response.clone().json();responseDiagnostics.push({done:value.done,reason:value.done_reason,contentCharacters:value.message?.content?.length,thinkingCharacters:value.message?.thinking?.length,thinkingEnd:value.message?.thinking?.slice(-600),outputTokens:value.eval_count});}return response;};
  const wait=async(runId:string,predicate:(view:LeaderView)=>boolean)=>{const deadline=Date.now()+540000;while(Date.now()<deadline){const v=repo.leaderView(runId);if(predicate(v))return v;if(['blocked','failed','cancelled','interrupted'].includes(v.run.status))throw Error(v.run.reason??v.run.status);await new Promise(done=>setTimeout(done,250));}throw Error('Native M4 timeout');};
  try{
    const project=repo.addProject('M4 local model acceptance',projectRoot);report.installations=await service.detect();
    await service.call('models.save',{config:{id:'local-ollama',name:'Existing local Ollama',kind:'ollama',baseUrl:'http://127.0.0.1:11434',scope:'local',timeoutMs:180000,maxOutputTokens:8192,structuredOutput:'json-schema'}});
    const health=await service.call('models.health',{providerId:'local-ollama'});expect(health.available).toBe(true);expect(health.models).toContain('qwen3-vl:4b');report.health=health;
    const run=await service.call('leader.start',{projectId:project.id,leader:'codex',workers:['codex'],mode:'real',control:'supervised',allowWrites:false,stepTimeoutMs:180000,team:{concurrency:1,reviewer:'codex',maxReworks:0,maxDispatches:2},reasoning:{primary:{providerId:'local-ollama',model:'qwen3-vl:4b'}},goal:'合成验收：仅规划一个 Codex 只读节点，paths 必须为 ["calc.mjs"]，无依赖、无写入。Worker 只读取 calc.mjs，报告文件行号、return a + b、静态 add(2,3)=5 和 tests NOT RUN。允许文件读取工具；若只有终端工具，允许且仅允许读取 calc.mjs 的只读命令（例如 Get-Content）。此许可必须写入节点 instruction。禁止其他命令、测试、写文件、其他代理或网络。审查只依据当前提供的静态证据，不要求额外测试或未来总结。'});id=run.id;
    const pending=await wait(id,v=>v.run.status==='awaiting_plan_approval');expect(pending.tasks).toHaveLength(1);expect(pending.tasks[0]).toMatchObject({assignedAgentId:'codex',needsWriteAccess:false,attempt:0,dependsOn:[],paths:['calc.mjs']});report.pending=pending;
    expect(repo.tasks(project.id)).toHaveLength(0);
    await service.call('leader.approve',{runId:id,expectedRevision:1,decision:'approve'});const done=await wait(id,v=>v.run.status==='completed');
    expect(done.tasks[0].result?.source).toBe('real');expect(done.tasks[0].result?.summary).toContain('5');expect(done.tasks[0].review?.verdict).toBe('passed');expect(done.tasks[0].reviewTaskId).toMatch(/^model:/);
    const calls=repo.modelCalls(id,100);expect(calls.filter(c=>c.status==='completed')).toHaveLength(3);expect(calls.every(c=>c.scope==='local')).toBe(true);
    report.view=done;report.modelCalls=calls;report.providerTasks=repo.tasks(project.id).map(t=>({task:t,session:repo.session(t.sessionId),events:repo.events(t.id,0,100)}));report.status='PASSED';
    console.log(JSON.stringify({status:'PASSED',native:true,runId:id,modelCalls:calls.length,nativeWorkers:1}));
  }catch(e){report.status='FAILED';report.error=e instanceof Error?e.message:String(e);if(id){report.view=repo.leaderView(id);report.modelCalls=repo.modelCalls(id,100);}throw e;}
  finally{globalThis.fetch=nativeFetch;report.responseDiagnostics=responseDiagnostics;await service.dispose();repo.close();writeFileSync('test-results/m4-native-report.json',JSON.stringify(report,null,2));}
},600000);



