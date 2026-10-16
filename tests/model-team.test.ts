import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import { TeamAdapter } from './fixtures/team-adapter';
import type { LeaderView } from '../packages/shared/leader';
import type { StartSessionRequest } from '../packages/shared';
// Synthetic adapter in real-mode protocol slot; this is not native Provider evidence.
class ProtocolSlotFixture extends TeamAdapter {async startSession(a:StartSessionRequest){const s=await super.startSession(a);s.mode='real';return s;}}
let repo:Repository,root:string,service:NexusService,server:Server,projectId:string,adapter:TeamAdapter;let hang=false;let requests=0;
beforeEach(async()=>{
  root=mkdtempSync(join(tmpdir(),'nexus-model-team-'));repo=await Repository.open(join(root,'data','db.sqlite'));projectId=repo.addProject('Synthetic protocol fixtures',root).id;
  adapter=new ProtocolSlotFixture('codex');service=new NexusService(repo,{get:()=>adapter,dispose:()=>adapter.dispose()});requests=0;hang=false;
  server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests++;if(hang)return;const request=JSON.parse(body);const p=JSON.parse(request.messages.at(-1).content);let value;
    if(p.role==='NEXUS_LEADER_PLAN')value={runId:p.scope.runId,revision:p.scope.revision,goal:p.scope.goal,tasks:[{taskId:'a',title:'Synthetic',instruction:'Report fixture evidence',assignedAgentId:'codex',dependsOn:[],acceptance:['Evidence'],needsWriteAccess:false,paths:[]}]};
    else value={runId:p.runId,revision:p.revision,...(p.role==='NEXUS_TASK_REVIEW'?{taskId:p.task.taskId,attempt:p.attempt}:{}),verdict:'passed',summary:'Synthetic model protocol fixture',unmet:[]};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'toy',choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20}}));});});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  await service.call('models.save',{config:{id:'local',name:'Synthetic',kind:'openai',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,scope:'local',timeoutMs:1000,maxOutputTokens:2048,structuredOutput:'json-schema'}});
});
afterEach(async()=>{await service.dispose();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));repo.close();rmSync(root,{recursive:true,force:true});});
async function wait(id:string,predicate:(v:LeaderView)=>boolean){for(let i=0;i<200;i++){const v=repo.leaderView(id);if(predicate(v))return v;await new Promise(done=>setTimeout(done,15));}throw Error('Run timeout '+JSON.stringify(repo.leaderRun(id)));}
const start=()=>service.call('leader.start',{projectId,goal:'Synthetic fixtures only, no actual models',leader:'codex',workers:['codex'],mode:'real',control:'supervised',team:{concurrency:2,reviewer:'codex',maxReworks:2,maxDispatches:10},reasoning:{primary:{providerId:'local',model:'toy'}}});
it('routes planning and both reviews to HTTP decisions, keeps Worker separate and still requires plan approval',async()=>{
  const run=await start();await wait(run.id,v=>v.run.status==='awaiting_plan_approval');expect(adapter.workerCalls).toBe(0);expect(requests).toBe(1);
  await service.call('leader.approve',{runId:run.id,expectedRevision:1,decision:'approve'});const done=await wait(run.id,v=>v.run.status==='completed');
  expect(adapter.requests.map(p=>p.role)).toEqual(['NEXUS_WORKER']);expect(done.tasks[0].reviewTaskId).toMatch(/^model:/);expect(done.run.nativeCalls).toBe(4);expect(repo.modelCalls(run.id)).toHaveLength(3);expect(repo.tasks(projectId)).toHaveLength(1);
});
it('Stop during HTTP planning aborts the model and does not send any Worker or retry',async()=>{
  hang=true;const run=await start();while(!requests)await new Promise(done=>setTimeout(done,5));await service.call('leader.stop',{runId:run.id});await wait(run.id,v=>v.run.status==='cancelled');expect(repo.modelCalls(run.id)[0].status).toBe('cancelled');expect(adapter.workerCalls).toBe(0);expect(requests).toBe(1);
});
it('Stop-all aborts an independent model probe as well as Run tasks',async()=>{
  hang=true;const id='d7aa52f0-c966-4a3a-bc2e-3de8a51736fc';const pending=service.call('models.generate',{id,selection:{providerId:'local',model:'toy'},prompt:'synthetic'});
  while(!requests)await new Promise(done=>setTimeout(done,5));await service.call('tasks.stopAll',{});
  await expect(pending).rejects.toThrow('取消');expect(repo.modelCall(`model:${id}`)?.status).toBe('cancelled');
});
