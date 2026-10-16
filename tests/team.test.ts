import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
import { TeamAdapter } from './fixtures/team-adapter';
import type { Channel } from '../packages/shared';
import type { LeaderNode } from '../packages/shared/leader';
let root:string,repo:Repository,service:NexusService,projectId:string,codex:TeamAdapter,dsh:TeamAdapter;
beforeEach(async()=>{root=mkdtempSync(join(tmpdir(),'Nexus team '));repo=await Repository.open(join(root,'data','nexus.sqlite'));projectId=repo.addProject('Team fixture',root).id;codex=new TeamAdapter('codex');dsh=new TeamAdapter('dsh');service=new NexusService(repo,{get:p=>p==='codex'?codex:dsh,dispose:async()=>{await codex.dispose();await dsh.dispose();}});});
afterEach(async()=>{vi.restoreAllMocks();await service.dispose();repo.close();rmSync(root,{recursive:true,force:true});});
const call=(c:string,a:unknown):Promise<any>=>service.call(c as Channel,a); // eslint-disable-line @typescript-eslint/no-explicit-any
const start=(extra={})=>call('leader.start',{projectId,goal:'Two independent tasks',leader:'codex',workers:['codex','dsh'],mode:'mock',control:'supervised',team:{concurrency:2,reviewer:'dsh',maxReworks:2,maxDispatches:20},...extra});
async function wait(id:string,predicate:(v:any)=>boolean) { // eslint-disable-line @typescript-eslint/no-explicit-any
  for(let i=0;i<300;i++){const v=repo.leaderView(id);if(predicate(v))return v;await new Promise(r=>setTimeout(r,15));}throw Error('Team state timeout: '+JSON.stringify(repo.leaderView(id).run));
}
async function approved(extra={}){const r=await start(extra);await wait(r.id,v=>v.run.status==='awaiting_plan_approval');await call('leader.approve',{runId:r.id,expectedRevision:1,decision:'approve'});return r;}
it('runs two independent Workers concurrently, then separately reviews both before final completion',async()=>{
  codex.delay=300;dsh.delay=300;const r=await approved();const inFlight=await wait(r.id,v=>v.tasks.filter((n:any)=>n.status==='running').length===2); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(inFlight.run.activeTaskIds).toHaveLength(2);const done=await wait(r.id,v=>v.run.status==='completed');
  expect(done.tasks.every((n:any)=>n.review?.verdict==='passed'&&n.reviewTaskId!==n.providerTaskId)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(done.run.dispatches).toBe(2);expect(done.run.activeTaskIds).toEqual([]);
});
it('does not release a dependent node until the independent Reviewer passes its predecessor',async()=>{
  codex.planTasks=['a','b'].map((taskId,i)=>({taskId,title:taskId,instruction:'Read',assignedAgentId:'codex',dependsOn:i?['a']:[],acceptance:['Evidence'],needsWriteAccess:false,paths:[]}));dsh.reviewDelay=250;
  const r=await approved();const v=await wait(r.id,v=>v.tasks[0].status==='reviewing');expect(v.tasks[1].attempt).toBe(0);await wait(r.id,v=>v.run.status==='completed');
});
it('Stop cancels both native tasks and sends no review or dependent work',async()=>{
  codex.delay=5000;dsh.delay=5000;const r=await approved();await wait(r.id,v=>v.tasks.filter((n:any)=>n.status==='running').length===2); // eslint-disable-line @typescript-eslint/no-explicit-any
  await call('leader.stop',{runId:r.id});const v=await wait(r.id,v=>v.run.status==='cancelled');expect(repo.activeTasks()).toHaveLength(0);expect(v.tasks.every((n:any)=>n.status==='cancelled')).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(dsh.reviewCalls).toBe(0);
});
it('Bounded Auto records review failure, repairs once, and preserves both attempt evidences',async()=>{
  dsh.needsChanges=1;const r=await approved({control:'bounded-auto'});const v=await wait(r.id,v=>v.run.status==='completed');const repaired=v.tasks.find((n:any)=>n.attempt===2); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(repaired).toBeDefined();expect(repaired!.history).toHaveLength(2);expect(repaired!.history![0].review!.verdict).toBe('needs_changes');expect(repaired!.history![1].review!.verdict).toBe('passed');expect(v.run.dispatches).toBe(3);
});
it('Supervised requires explicit retry and rejects stale or changed idempotent retry actions',async()=>{
  dsh.needsChanges=1;const r=await approved();const v=await wait(r.id,v=>v.tasks.some((n:any)=>n.status==='rework_pending')); // eslint-disable-line @typescript-eslint/no-explicit-any
  const n=v.tasks.find((n:any)=>n.status==='rework_pending'); // eslint-disable-line @typescript-eslint/no-explicit-any
  const a={actionId:'repair-a',runId:r.id,expectedRevision:1,type:'request_retry',taskId:n!.taskId,reason:'User approves rework'};
  expect(await call('leader.action',{...a,actionId:'stale',expectedRevision:2})).toMatchObject({ok:false});expect(await call('leader.action',a)).toMatchObject({ok:true});expect(await call('leader.action',a)).toMatchObject({ok:true});expect(await call('leader.action',{...a,reason:'different'})).toMatchObject({ok:false});await wait(r.id,v=>v.run.status==='completed');
});
it('enforces Worker dispatch budget without silently running the remaining node',async()=>{
  const r=await approved({team:{concurrency:1,reviewer:'dsh',maxReworks:2,maxDispatches:1}});const v=await wait(r.id,v=>v.run.status==='blocked');expect(v.run.dispatches).toBe(1);expect(v.tasks[1].attempt).toBe(0);expect(v.run.reason).toContain('派发');
});
it('allows paused idle Leader handoff, increments revision and preserves plan/history',async()=>{
  const r=await start({control:'manual'});await wait(r.id,v=>v.run.status==='awaiting_plan_approval');await call('leader.approve',{runId:r.id,expectedRevision:1,decision:'approve'});await call('leader.pause',{runId:r.id});
  expect(await call('leader.handoff',{runId:r.id,expectedRevision:1,leader:'dsh',reason:'User selection'})).toMatchObject({ok:true});const v=repo.leaderView(r.id);expect(v.run.leader).toBe('dsh');expect(v.run.planRevision).toBe(2);expect(v.run.status).toBe('paused');expect(v.handoffs).toHaveLength(1);expect(v.plan?.revision).toBe(2);
  expect(await call('leader.action',{actionId:'old',runId:r.id,expectedRevision:1,type:'assign_task',taskId:'a',reason:'old'})).toMatchObject({ok:false});
});
it('recovery requires acknowledgement, leaves safe completed work and never auto-dispatches',async()=>{
  const r=await start({control:'manual'});await wait(r.id,v=>v.run.status==='awaiting_plan_approval');await call('leader.approve',{runId:r.id,expectedRevision:1,decision:'approve'});repo.leaderSave({...repo.leaderRun(r.id),status:'interrupted'},'fixture.interrupt','Fixture');
  await expect(call('leader.recover',{runId:r.id,expectedRevision:1,acknowledged:false})).rejects.toThrow();expect(await call('leader.recover',{runId:r.id,expectedRevision:1,acknowledged:true})).toMatchObject({ok:true});expect(repo.leaderRun(r.id).status).toBe('paused');expect(codex.workerCalls+dsh.workerCalls).toBe(0);
});
it('Pause during two asynchronous session startups sends no Worker prompts until Resume',async()=>{
  codex.startupDelay=dsh.startupDelay=200;const r=await approved();await wait(r.id,v=>v.tasks.every((n:any)=>n.status==='assigned')); // eslint-disable-line @typescript-eslint/no-explicit-any
  await call('leader.pauseAll',{});await new Promise(r=>setTimeout(r,300));expect(codex.requests.concat(dsh.requests).filter(p=>p.role==='NEXUS_WORKER')).toHaveLength(0);
  expect(repo.leaderRun(r.id).status).toBe('paused');await call('leader.resume',{runId:r.id});await wait(r.id,v=>v.run.status==='completed');
});
it('blocks after at most two automatic reworks and keeps all three reviewed attempt histories',async()=>{
  dsh.needsChanges=20;codex.planTasks=[{taskId:'a',title:'A',instruction:'Read',assignedAgentId:'codex',dependsOn:[],acceptance:['Evidence'],needsWriteAccess:false,paths:[]}];
  const r=await approved({control:'bounded-auto'});const v=await wait(r.id,v=>v.run.status==='blocked');expect(v.tasks[0].attempt).toBe(3);expect(v.tasks[0].history).toHaveLength(3);expect(v.run.dispatches).toBe(3);
});
it('persists actual failed Worker output and event evidence without dispatching review',async()=>{
  codex.failure=true;const r=await approved();const v=await wait(r.id,v=>v.run.status==='blocked');const node=v.tasks[0];expect(node.status).toBe('failed');expect(node.result?.outcome).toBe('failed');expect(node.result?.rawEventRefs.length).toBeGreaterThan(0);expect(node.history?.[0].result?.outcome).toBe('failed');
});
it('creates separate writable worktrees, preserves dirty original files and rejects merging into them',async()=>{
  const git=(args:string[])=>execFileSync('git',args,{cwd:root,windowsHide:true,encoding:'utf8'});git(['init','--quiet']);writeFileSync(join(root,'base.txt'),'baseline\n');git(['add','base.txt']);git(['-c','user.name=Synthetic','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture']);writeFileSync(join(root,'base.txt'),'user edit\n');
  codex.writes=true;codex.planTasks=['a','b'].map(taskId=>({taskId,title:taskId,instruction:'Write fixture',assignedAgentId:'codex',dependsOn:[],acceptance:['Evidence'],needsWriteAccess:true,paths:[taskId+'.txt']}));const r=await approved({allowWrites:true});const v=await wait(r.id,v=>v.run.status==='completed');
  expect(v.tasks[0].workspace?.path).not.toBe(v.tasks[1].workspace?.path);expect(readFileSync(join(root,'base.txt'),'utf8')).toBe('user edit\n');expect(existsSync(join(root,'a.txt'))).toBe(false);
  expect(v.tasks[0].diff?.changedPaths).toContain('a.txt');const preview=await call('leader.merge.preview',{runId:r.id});expect(preview.allowed).toBe(false);expect(preview.reasons).toContain('dirty-target');
  await expect(call('leader.merge.apply',{runId:r.id,expectedHash:preview.hash,acknowledged:true})).rejects.toThrow();
},20000);
it('runs a bounded checkpointed meeting before plan approval and sends no Workers from its drafts',async()=>{
  const r=await start({meeting:{topic:'Protect local changes',participants:['codex','dsh'],rounds:1}});const v=await wait(r.id,v=>v.run.status==='awaiting_plan_approval');expect(v.meeting?.status).toBe('completed');expect(v.meeting?.messages).toHaveLength(2);expect(v.tasks.every((n:any)=>n.attempt===0)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(codex.workerCalls+dsh.workerCalls).toBe(0);expect(v.meeting?.messages.every(m=>m.source==='mock')).toBe(true);
});
it('shutdown reconciles a still-running sibling even after a different Worker blocks the Run',async()=>{
  codex.failure=true;dsh.delay=5000;const r=await approved();await wait(r.id,v=>v.run.status==='blocked');await service.dispose();
  const v=repo.leaderView(r.id);expect(v.tasks.every(n=>!['assigned','running','reviewing','waiting_approval'].includes(n.status))).toBe(true);expect(repo.activeTasks()).toHaveLength(0);
});
it('does not claim cancellation success when both Providers fail to confirm cancellation',async()=>{
  const r=await start();await wait(r.id,v=>v.run.status==='awaiting_plan_approval');repo.leaderSave({...repo.leaderRun(r.id),deadline:Date.now()+300},'fixture.deadline','Bounded cancellation test');codex.delay=dsh.delay=5000;
  vi.spyOn(codex,'cancelTask').mockResolvedValue({ok:false});vi.spyOn(dsh,'cancelTask').mockResolvedValue({ok:false});
  await call('leader.approve',{runId:r.id,expectedRevision:1,decision:'approve'});await wait(r.id,v=>v.tasks.every((n:LeaderNode)=>n.status==='running'));await call('leader.stop',{runId:r.id});
  const v=await wait(r.id,v=>['cancelled','interrupted'].includes(v.run.status));expect(v.run.status).toBe('interrupted');expect(v.tasks.every(n=>n.status==='interrupted')).toBe(true);expect(v.run.activeTaskIds).toHaveLength(2);
});
it('preserves Pause when final review returns, then Resume applies the saved conclusion without another model call',async()=>{
  const r=await approved();codex.planningDelay=250;await wait(r.id,v=>v.run.phase==='reviewing'&&!!v.run.activeTaskIds?.length);await call('leader.pause',{runId:r.id});
  const v=await wait(r.id,v=>v.run.review?.verdict==='passed');expect(v.run.status).toBe('paused');const calls=codex.requests.filter(p=>p.role==='NEXUS_LEADER_REVIEW').length;
  await call('leader.resume',{runId:r.id});await wait(r.id,v=>v.run.status==='completed');expect(codex.requests.filter(p=>p.role==='NEXUS_LEADER_REVIEW')).toHaveLength(calls);
});
it('clears current-attempt result while preserving the previous reviewed attempt in history before rework dispatch',async()=>{
  codex.planTasks=[{taskId:'a',title:'A',instruction:'Read',assignedAgentId:'codex',dependsOn:[],acceptance:['Evidence'],needsWriteAccess:false,paths:[]}];dsh.needsChanges=1;
  const original=dsh.sendPrompt.bind(dsh);vi.spyOn(dsh,'sendPrompt').mockImplementation(async a=>{if(JSON.parse(a.prompt).role==='NEXUS_TASK_REVIEW')codex.delay=5000;return original(a);});
  const r=await approved({control:'bounded-auto'});const v=await wait(r.id,v=>v.tasks[0].attempt===2&&v.tasks[0].status==='running');expect(v.tasks[0].result).toBeUndefined();expect(v.tasks[0].history?.[0].review?.verdict).toBe('needs_changes');expect(v.tasks[0].providerTaskId).not.toBe(v.tasks[0].history?.[0].result?.providerTaskId);
});
it('recovery discards stale result identity and requeues only the uncertain readonly attempt',async()=>{
  const r=await start({control:'manual'});await wait(r.id,v=>v.run.status==='awaiting_plan_approval');await call('leader.approve',{runId:r.id,expectedRevision:1,decision:'approve'});
  const n=repo.leaderNodes(r.id)[0];const stale={runId:r.id,taskId:n.taskId,agentId:n.assignedAgentId,source:'mock' as const,outcome:'success' as const,summary:'old evidence',artifacts:[],tests:[],rawEventRefs:[],providerTaskId:'old-worker'};
  repo.leaderSave({...repo.leaderRun(r.id),status:'interrupted'},'fixture.interrupt','Stale checkpoint',{nodes:[{...n,attempt:2,status:'interrupted',providerTaskId:'new-worker',result:stale,history:[{attempt:1,result:stale}]}]});
  await call('leader.recover',{runId:r.id,expectedRevision:1,acknowledged:true});const recovered=repo.leaderNodes(r.id)[0];expect(recovered.status).toBe('pending');expect(recovered.result).toBeUndefined();expect(recovered.history?.[0].result?.providerTaskId).toBe('old-worker');
});
it('final summary receives approved dependencies, verified execution receipts and earlier rejected attempt evidence',async()=>{
  dsh.needsChanges=1;const r=await approved({control:'bounded-auto'});await wait(r.id,v=>v.run.status==='completed');const prompt=codex.requests.find(p=>p.role==='NEXUS_LEADER_REVIEW')!.prompt;
  expect(prompt.results.every((n:any)=>Array.isArray(n.dependsOn)&&n.executionEvidence.worker.sessionId&&n.executionEvidence.worker.finishedAt)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(prompt.results.some((n:any)=>n.previousAttempts?.some((h:any)=>h.review?.verdict==='needs_changes'&&h.result?.providerTaskId))).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
});
it('rework Reviewer receives prior rejection and verified native operation audit, rather than asking the Worker to recreate history',async()=>{
  dsh.needsChanges=1;const r=await approved({control:'bounded-auto'});await wait(r.id,v=>v.run.status==='completed');const review=dsh.requests.find(p=>p.role==='NEXUS_TASK_REVIEW'&&p.prompt.attempt===2)!.prompt;
  expect(review.previousAttempts[0].review.verdict).toBe('needs_changes');expect(review.executionEvidence.worker.status).toBe('completed');expect(review.operationAudit.commandExecutions).toBe(0);
});
