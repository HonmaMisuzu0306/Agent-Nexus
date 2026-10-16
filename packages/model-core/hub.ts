import { createHash, randomUUID } from 'node:crypto';
import { Repository } from '../persistence';
import { sanitize } from '../agent-core/sanitize';
import { modelConfigSchema, reasoningSchema, type ModelCall, type ModelReasoning, type ModelConfigView } from '../shared/models';
import type { ModelConfig } from './types';
import type { ModelSecrets } from './secrets';
import { HttpModelProvider, ModelTransportError, validateEndpoint } from './http';

export interface GenerateOptions {runId?:string;purpose:string;schema?:Record<string,unknown>;beforeAttempt?():number|void;timeoutMs?:number}
export class ModelHub {
  private active=new Map<string,{controller:AbortController;runId?:string}>();
  private operations=new Set<Promise<ModelCall>>();
  private closed=false;
  constructor(private repo:Repository,private secrets?:ModelSecrets){}
  list():ModelConfigView[]{return this.repo.modelConfigs().map(c=>({...c,hasSecret:this.secrets?.has(c.id)??false}));}
  private mutable(id:string){if(this.closed||this.active.size||this.repo.leaderActive().some(r=>[r.reasoning?.primary.providerId,r.reasoning?.fallback?.providerId].includes(id)))throw Error('请先结束使用 Model Provider 的活动请求和 Run，再修改配置');}
  save(input:ModelConfig,apiKey?:string,clearSecret=false):ModelConfigView{
    const config=modelConfigSchema.parse(input);this.mutable(config.id);config.baseUrl=validateEndpoint(config.baseUrl,config.scope);
    const old=this.repo.modelConfigs().find(c=>c.id===config.id);const now=new Date().toISOString();
    const changesSecret=apiKey!==undefined||clearSecret;let previous:string|undefined;
    if(changesSecret){if(!this.secrets)throw Error('操作系统加密存储不可用，未使用明文后备');previous=this.secrets.get(config.id);this.secrets.set(config.id,clearSecret?undefined:apiKey);}
    try{this.repo.modelConfigSave({...config,createdAt:old?.createdAt??now,updatedAt:now});}
    catch(e){if(changesSecret)this.secrets!.set(config.id,previous);throw e;}
    return {...this.repo.modelConfig(config.id),hasSecret:this.secrets?.has(config.id)??false};
  }
  remove(id:string){this.mutable(id);this.repo.modelConfig(id);const previous=this.secrets?.get(id);this.secrets?.set(id,undefined);try{this.repo.modelConfigRemove(id);}catch(e){if(previous)this.secrets?.set(id,previous);throw e;}return {ok:true};}
  async health(id:string){const c=this.repo.modelConfig(id);const provider=new HttpModelProvider({...c,timeoutMs:Math.min(c.timeoutMs,5000)},this.secrets?.get(id));try{return {available:true,detail:'Model endpoint available',models:await provider.listModels()};}catch{return {available:false,detail:'模型列表读取失败，请核对端点、鉴权和协议',models:[]};}}
  validate(reasoning:ModelReasoning){reasoningSchema.parse(reasoning);for(const s of [reasoning.primary,reasoning.fallback].filter(s=>s!==undefined)){const c=this.repo.modelConfig(s.providerId);validateEndpoint(c.baseUrl,c.scope);if(c.scope==='external'&&!reasoning.externalAcknowledged)throw Error('请确认向外部 Model Provider 发送目标、计划和必要 Worker 证据');if(this.secrets?.has(c.id))this.secrets.get(c.id);}}
  private scrub(text:string){let clean=String(sanitize(text));for(const c of this.repo.modelConfigs()){const key=this.secrets?.get(c.id);if(key)clean=clean.split(key).join('[REDACTED]');}return clean;}
  generate(id:string,reasoning:ModelReasoning,prompt:string,options:GenerateOptions):Promise<ModelCall>{
    const operation=this.perform(id,reasoning,prompt,options);this.operations.add(operation);
    void operation.then(()=>this.operations.delete(operation),()=>this.operations.delete(operation));return operation;
  }
  private async perform(id:string,reasoning:ModelReasoning,prompt:string,options:GenerateOptions):Promise<ModelCall>{
    if(this.closed)throw Error('Model Hub 已关闭');this.validate(reasoning);
    const content=this.scrub(prompt);if(content.length>16000)throw Error('模型上下文超过 16000 字符，未静默裁剪证据');
    const selections=[reasoning.primary,...(reasoning.fallback?[reasoning.fallback]:[])];let primaryId:string|undefined;
    for(let i=0;i<selections.length;i++){
      const remaining=options.beforeAttempt?.();if(this.closed)throw Error('Model Hub 已关闭');
      const selection=selections[i];const config=this.repo.modelConfig(selection.providerId);const callId=`model:${i===0?id:randomUUID()}`;
      if(this.repo.modelCall(callId))throw Error('模型调用 ID 已存在，不能重放');
      const call:ModelCall={id:callId,runId:options.runId,providerId:config.id,model:selection.model,status:'running',purpose:options.purpose,scope:config.scope,endpoint:config.baseUrl,createdAt:new Date().toISOString(),requestHash:createHash('sha256').update(content).digest('hex'),text:'',...(i?{fallbackOf:primaryId}:{})};
      this.repo.modelCallSave(call);primaryId??=callId;
      const controller=new AbortController();this.active.set(callId,{controller,runId:options.runId});
      let persisted=call;
      try{
        const provider=new HttpModelProvider({...config,timeoutMs:Math.min(config.timeoutMs,options.timeoutMs??config.timeoutMs,remaining??config.timeoutMs)},this.secrets?.get(config.id));
        const response=await provider.generate({id:callId,model:selection.model,prompt:content,schema:options.schema,signal:controller.signal});
        if(controller.signal.aborted)throw Error('模型请求已取消');
        persisted={...call,status:'completed',finishedAt:new Date().toISOString(),text:this.scrub(response.text),usage:response.usage,model:selection.model};this.repo.modelCallSave(persisted);return persisted;
      }catch(e){
        // A storage failure must never trigger another network call.
        if(persisted.status==='completed')throw e;
        const cancelled=controller.signal.aborted;
        const detail=e instanceof Error?this.scrub(e.message).slice(0,160):'unknown';
        const error=cancelled?'模型请求已取消':e instanceof ModelTransportError?`Model Provider 传输失败或超时，请检查服务和端点 [${detail}]`:`Model Provider 响应无效、鉴权失败或协议不兼容 [${detail}]`;
        this.repo.modelCallSave({...call,status:cancelled?'cancelled':'failed',finishedAt:new Date().toISOString(),error});
        if(!cancelled&&e instanceof ModelTransportError&&i===0&&selections.length>1)continue;
        throw Error(error);
      }finally{this.active.delete(callId);}
    }throw Error('Model Provider 不可用');
  }
  cancel(id:string){const active=this.active.get(id);active?.controller.abort();return {ok:!!active};}
  cancelRun(id:string){for(const item of this.active.values())if(item.runId===id)item.controller.abort();}
  cancelAll(){for(const item of this.active.values())item.controller.abort();}
  dispose(){this.closed=true;for(const item of this.active.values())item.controller.abort();}
  async settled(){await Promise.allSettled([...this.operations]);}
}
