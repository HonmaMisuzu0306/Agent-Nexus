import { ScriptAdapter } from './leader-adapter';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SendPromptRequest, StartSessionRequest } from '../../packages/shared';
import type { LeaderPlan } from '../../packages/shared/leader';
export class TeamAdapter extends ScriptAdapter {
  requests: { taskId: string; role: string; prompt: Record<string, any>; rootPath?: string }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  planTasks?: LeaderPlan['tasks']; reviewDelay = 40; needsChanges = 0; reviewCalls = 0;
  writes = false;
  async startSession(a: StartSessionRequest) { const s = await super.startSession(a); s.rootPath = a.rootPath; s.sandbox = a.sandbox; return s; }
  async sendPrompt(a: SendPromptRequest) {
    const p = JSON.parse(a.prompt); const session = this.sessions.get(a.sessionId)!; const id = a.taskId!;
    this.requests.push({ taskId: id, role: p.role, prompt: p, rootPath: session.rootPath });
    const timer = setTimeout(() => {
      let response: unknown;
      if (p.role === 'NEXUS_LEADER_PLAN') {
        const writable=String(p.scope.goal).includes('M35_WRITE'); if(writable)this.writes=true;
        response = {runId:p.scope.runId,revision:p.scope.revision,goal:p.scope.goal,tasks:this.planTasks ?? ['a','b'].map(taskId=>({taskId,title:taskId,instruction:'Analyze '+taskId,assignedAgentId:writable?'codex':(p.scope.workers[taskId==='a'?0:1]??p.scope.workers[0]),dependsOn:[],acceptance:['Evidence'],needsWriteAccess:writable,paths:writable?[taskId+'.txt']:[]}))};
      }
      else if (p.role === 'NEXUS_TASK_REVIEW') { this.reviewCalls++; response={runId:p.runId,revision:p.revision,taskId:p.task.taskId,attempt:p.attempt,verdict:this.needsChanges-->0?'needs_changes':'passed',summary:'Review actual fixture evidence',unmet:this.needsChanges>=0?['Correct the specified defect']:[]}; }
      else if (p.role === 'NEXUS_LEADER_REVIEW') response={runId:p.runId,revision:p.revision,verdict:'passed',summary:'Final fixture evidence',unmet:[]};
      else if (p.phase === 'agenda') response={runId:p.runId,topic:p.topic,participants:p.participants,rounds:p.roundLimit,questions:['Protect local files?']};
      else if (p.phase === 'discussion') response='Keep original changes; use isolated worktrees and explicit patch approval.';
      else if (p.phase === 'summary') response={runId:p.runId,summary:'Use isolated worktrees',consensus:['Preserve user changes'],disagreements:['Review cadence'],taskDrafts:[{title:'Validate safety',instruction:'Inspect safeguards',acceptance:['Evidence']}]};
      else { this.workerCalls++; if(this.writes&&p.permission?.startsWith('workspace-write'))writeFileSync(join(session.rootPath!,p.task.paths[0]),`fixture ${p.task.taskId} attempt ${p.attempt}\n`); response='Worker fixture evidence: tests NOT RUN'; }
      this.emit(id,'message.delta',typeof response==='string'?response:JSON.stringify(response)); this.emit(id,this.failure&&p.role==='NEXUS_WORKER'?'task.failed':'task.completed','fixture terminal'); this.jobs.delete(id);
    }, p.role==='NEXUS_WORKER'?this.delay:p.role==='NEXUS_TASK_REVIEW'?this.reviewDelay:this.planningDelay);
    this.jobs.set(id,{timer,session,sequence:0}); this.emit(id,'task.started','fixture started'); return {taskId:id};
  }
}
