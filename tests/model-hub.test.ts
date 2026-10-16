import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../packages/persistence';
import { ModelHub } from '../packages/model-core/hub';
import type { ModelSecrets } from '../packages/model-core/secrets';

let repo:Repository;let root:string;let hub:ModelHub;let server:Server;let url:string;let requests=0;let fail=false;let hang=false;
beforeEach(async()=>{
  root=mkdtempSync(join(tmpdir(),'nexus-model-hub-'));repo=await Repository.open(join(root,'db.sqlite'));
  server=createServer((req,res)=>{if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'toy'}]}));return;}requests++;if(hang)return;if(fail){res.writeHead(503);res.end('server-error-secret');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'toy',choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:4}}));});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
  const values=new Map<string,string>();const secrets:ModelSecrets={get:id=>values.get(id),has:id=>values.has(id),set:(id,v)=>{if(v===undefined)values.delete(id);else values.set(id,v);}};
  hub=new ModelHub(repo,secrets);requests=0;fail=false;hang=false;
  hub.save({id:'local',name:'Local',kind:'openai',baseUrl:url,scope:'local',timeoutMs:1000,maxOutputTokens:2048,structuredOutput:'json-schema'});
});
afterEach(async()=>{hub.dispose();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));repo.close();rmSync(root,{recursive:true,force:true});});
it('stores calls separately from native Tasks with trusted usage and no raw prompt or key in database',async()=>{
  const reply=await hub.generate('probe-one',{primary:{providerId:'local',model:'toy'},externalAcknowledged:false},'private synthetic prompt',{purpose:'probe'});
  expect(reply.status).toBe('completed');expect(reply.id).toBe('model:probe-one');expect(reply.usage).toMatchObject({inputTokens:5,outputTokens:4,cost:'unknown'});expect(repo.modelCalls()).toHaveLength(1);expect(JSON.stringify(repo.modelCalls())).not.toContain('private synthetic prompt');expect(reply.requestHash).toHaveLength(64);
});
it('fails an unavailable endpoint honestly and only uses the explicitly selected fallback once',async()=>{
  hub.save({id:'offline',name:'Offline',kind:'openai',baseUrl:'http://127.0.0.1:1/v1',scope:'local',timeoutMs:1000,maxOutputTokens:2048,structuredOutput:'json-schema'});
  let attempts=0;const reply=await hub.generate('fallback',{primary:{providerId:'offline',model:'toy'},fallback:{providerId:'local',model:'toy'},externalAcknowledged:false},'synthetic',{purpose:'probe',beforeAttempt:()=>{attempts++;}});
  expect(reply.status).toBe('completed');expect(attempts).toBe(2);expect(requests).toBe(1);expect(repo.modelCalls().map(c=>c.status).sort()).toEqual(['completed','failed']);expect(reply.fallbackOf).toBe('model:fallback');
});
it('aborts an in-flight call without fallback or successful completion',async()=>{
  hang=true;const pending=hub.generate('abort',{primary:{providerId:'local',model:'toy'},fallback:{providerId:'local',model:'toy'},externalAcknowledged:false},'synthetic',{purpose:'probe'});
  while(!requests)await new Promise(done=>setTimeout(done,5));hub.cancel('model:abort');await expect(pending).rejects.toThrow();expect(requests).toBe(1);expect(repo.modelCall('model:abort')?.status).toBe('cancelled');
});
it('refuses to mutate configuration used by an active probe',async()=>{
  hang=true;const pending=hub.generate('locked',{primary:{providerId:'local',model:'toy'},externalAcknowledged:false},'synthetic',{purpose:'probe'});
  while(!requests)await new Promise(done=>setTimeout(done,5));
  expect(()=>hub.remove('local')).toThrow('结束');hub.cancel('model:locked');await expect(pending).rejects.toThrow();
});
it('requires explicit external data acknowledgment before any HTTP request and never accepts URL credentials',async()=>{
  expect(()=>hub.save({id:'bad',name:'Bad',kind:'openai',baseUrl:'http://user:secret@127.0.0.1:1/v1',scope:'local',timeoutMs:1000,maxOutputTokens:2048,structuredOutput:'json-schema'})).toThrow();
  hub.save({id:'external',name:'External',kind:'openai',baseUrl:'https://example.invalid/v1',scope:'external',timeoutMs:1000,maxOutputTokens:2048,structuredOutput:'json-schema'});
  await expect(hub.generate('external',{primary:{providerId:'external',model:'toy'},externalAcknowledged:false},'synthetic',{purpose:'probe'})).rejects.toThrow('确认');expect(repo.modelCalls()).toHaveLength(0);
});
it('shutdown waits for all independent probe calls to settle before their repository can close',async()=>{
  hang=true;const pending=hub.generate('shutdown',{primary:{providerId:'local',model:'toy'},externalAcknowledged:false},'synthetic',{purpose:'probe'}).catch(e=>e);
  while(!requests)await new Promise(done=>setTimeout(done,5));hub.dispose();await hub.settled();await pending;expect(repo.modelCall('model:shutdown')?.status).toBe('cancelled');
});
