import type { AgentInstallation, OperationResult, Provider, RequestMap, Task } from '../shared';
import { activeStatuses } from '../shared';
import { activeRunStatuses, type LeaderRun } from '../shared/leader';
import { Repository } from '../persistence';
import { sanitize } from '../agent-core/sanitize';
import type { ModelCall, ModelReasoning } from '../shared/models';

export interface TaskLink { runId: string; nodeId?: string; rootPath?: string; slotId?: string; beforeSend(t: Task): void }
export interface OrchestratorPorts {
  detect(provider: Provider, mode: 'real' | 'mock'): Promise<AgentInstallation>;
  launch(a: RequestMap['task.start'] & { outputSchema?: Record<string, unknown> }, link: TaskLink): Promise<Task>;
  cancel(id: string): Promise<OperationResult>;
  issue?(message: string): void;
  validateReasoning?(selection:ModelReasoning):void;
  decide?(runId:string,prompt:string,options:{schema?:Record<string,unknown>;purpose:string;beforeAttempt():number}):Promise<ModelCall>;
  cancelModels?(runId:string):void;
}
export class TeamPaused extends Error {}
export class NativeTaskFailure extends Error { constructor(message: string, readonly task?: Task) { super(message); } }
export interface NativeResult { task: Task; text: string; refs: string[]; source: 'real' | 'mock' }
export interface DecisionResult {id:string;text:string;refs:string[];source:'real'|'mock'}
const sleep = () => new Promise<void>(done => setTimeout(done, 25));
export class TeamTaskRunner {
  closed = false; suspended = false;
  private launches = new Set<Promise<void>>();
  constructor(private repo: Repository, private ports: OrchestratorPorts) {}
  save(id: string, patch: Partial<LeaderRun>, type: string, text: string, extra: Parameters<Repository['leaderSave']>[3] = {}) {
    if (this.closed || this.suspended) throw new Error('团队服务已关闭或存储不可用');
    try { this.repo.leaderSave({ ...this.repo.leaderRun(id), ...patch }, type, String(sanitize(text)).slice(0,6000), extra); }
    catch(e) { this.suspended = true; this.ports.issue?.('团队存储失败，已停止派单并请求取消；请检查存储后重启'); void Promise.allSettled((this.repo.leaderRun(id).activeTaskIds ?? []).map(taskId=>this.ports.cancel(taskId))); throw e; }
  }
  private allowed(id: string) {
    const r = this.repo.leaderRun(id);
    if (this.closed || this.suspended || !activeRunStatuses.includes(r.status) || r.status === 'stopping') throw new NativeTaskFailure('Run 已停止，拒绝新请求');
    if (r.status === 'paused') throw new TeamPaused('已暂停后续请求');
    if (Date.now() >= r.deadline) throw new NativeTaskFailure('Run 总时限已到');
    return r;
  }
  async decision(id:string,provider:Provider,prompt:object,options:Parameters<TeamTaskRunner['request']>[3]):Promise<DecisionResult>{
    const r=this.allowed(id);
    if(!r.reasoning){const result=await this.request(id,provider,prompt,options);return {...result,id:result.task.id};}
    if(!this.ports.decide)throw Error('Model Provider 决策端口不可用');
    const serialized=JSON.stringify(sanitize(prompt));if(serialized.length>16000)throw Error('团队上下文超过限制，未静默裁剪证据');
    const deadline=Math.min(r.deadline,Date.now()+r.stepTimeoutMs);
    const call=await this.ports.decide(id,serialized,{schema:options.schema,purpose:options.slotId,beforeAttempt:()=>{
      const current=this.allowed(id);if(Date.now()>=deadline)throw Error('模型步骤总时限已到');if((current.nativeCalls??0)>=60)throw Error('Run 调用上限 60 已到');
      this.save(id,{nativeCalls:(current.nativeCalls??0)+1},'model.requested',`${options.slotId}：显式模型决策请求已登记`);return deadline-Date.now();
    }});
    return {id:call.id,text:call.text,refs:[`sqlite:${call.id}`],source:'real'};
  }
  async request(id: string, provider: Provider, prompt: object, options: { nodeId?: string; rootPath: string; write?: boolean; schema?: Record<string, unknown>; slotId: string; bound?(t: Task): void } ): Promise<NativeResult> {
    const r = this.allowed(id); const serialized = JSON.stringify(sanitize(prompt));
    if (serialized.length > 16000) throw new Error('团队上下文超过限制，未静默裁剪证据');
    if ((r.nativeCalls ?? 0) >= 60) throw new Error('Run 原生调用上限 60 已到');
    this.save(id,{nativeCalls:(r.nativeCalls??0)+1},'native.requested',`${provider} ${options.slotId} 请求已登记`);
    let task: Task | undefined; let settled = false; let error: unknown; let aborted = false;
    const deadline = Math.min(r.deadline,Date.now()+r.stepTimeoutMs);
    const operation = this.ports.launch({projectId:r.projectId,provider,mode:r.mode,prompt:serialized,scenario:'success',sandbox:options.write?'workspace-write':'read-only',outputSchema:options.schema},{runId:id,nodeId:options.nodeId,rootPath:options.rootPath,slotId:options.slotId,beforeSend:t=>{
      if(aborted)throw new NativeTaskFailure('迟到派单已失效'); this.allowed(id); task=t;
      const current=this.repo.leaderRun(id); this.save(id,{activeTaskIds:[...new Set([...(current.activeTaskIds??[]),t.id])],...(options.nodeId?{}:{currentTaskId:t.id})},'task.bound',`${provider} 原生任务 ${t.id}`,{taskId:t.id});
      options.bound?.(t);
    }}).then(t=>{task=t;settled=true;},e=>{error=e;settled=true;});
    this.launches.add(operation); void operation.finally(()=>this.launches.delete(operation));
    try {
      while(!settled || task && activeStatuses.includes(this.repo.task(task.id).status)) {
        if(this.closed||this.suspended||Date.now()>=deadline){aborted=true;if(task&&activeStatuses.includes(this.repo.task(task.id).status))await this.ports.cancel(task.id);throw new NativeTaskFailure(this.closed?'应用关闭':'步骤超时或存储中断；不自动重放',task?this.repo.task(task.id):undefined);}
        if(this.repo.leaderRun(id).status==='stopping' && !task){aborted=true;throw new NativeTaskFailure('用户停止未发送任务');}
        await sleep();
      }
      if(error)throw error;
      if(!task)throw new NativeTaskFailure('原生任务未创建');
      const actual=this.repo.task(task.id);
      if(actual.status!=='completed')throw new NativeTaskFailure(`原生任务 ${actual.status}`,actual);
      const result = this.read(actual); if(!result.text.trim())throw new Error('原生任务没有最终输出'); return result;
    } finally {
      if(task&&!this.closed&&!this.suspended){const current=this.repo.leaderRun(id);const terminal=!activeStatuses.includes(this.repo.task(task.id).status);this.save(id,{activeTaskIds:terminal?(current.activeTaskIds??[]).filter(t=>t!==task!.id):current.activeTaskIds,...(terminal&&current.currentTaskId===task.id?{currentTaskId:undefined}:{})},terminal?'task.finished':'task.unconfirmed',terminal?`${provider} 原生任务终态已回收`:`${provider} 原生取消未确认，保留任务引用`,{taskId:task.id});}
    }
  }
  read(task: Task): NativeResult {
    let after=0;let text='';const refs:string[]=[];
    for(;;){const events=this.repo.events(task.id,after,100);for(const e of events){if(e.type==='message.delta')text+=e.payload.text??'';if(refs.length<40)refs.push(e.rawRef??`sqlite:event:${e.eventId}`);}if(text.length>100000)throw new Error('原生响应超过有界长度');if(events.length<100)break;after=events.at(-1)!.sequence;}
    return {task,text,refs,source:task.mode==='real'?'real':'mock'};
  }
  async settled(){await Promise.allSettled([...this.launches]);}
}
