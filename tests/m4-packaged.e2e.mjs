import { _electron as electron, expect } from 'playwright/test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const native=JSON.parse(readFileSync('test-results/m4-native-report.json','utf8'));expect(native.status).toBe('PASSED');expect(native.native).toBe(true);
const root=mkdtempSync(join(resolve('.runtime'),'m4 packaged '));const data=join(root,'data');mkdirSync(data);copyFileSync(join(dirname(native.fixtureRoot),'data','nexus.sqlite'),join(data,'nexus.sqlite'));
const env={...process.env,NEXUS_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;let app;const errors=[];const checks=[];
const api=(page,channel,args)=>page.evaluate(async({channel,args})=>{const r=await window.nexus.call(channel,args);if(!r.ok)throw Error(r.error);return r.data;},{channel,args});
async function launch(){app=await electron.launch({executablePath:resolve('release/win-unpacked/Agent Nexus.exe'),env,timeout:30000});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await expect(page.getByRole('heading',{name:'Agent 工作台',exact:true})).toBeVisible();return page;}
try{
  let page=await launch();const version=await app.evaluate(({app})=>app.getVersion());expect(version).toBe(JSON.parse(readFileSync('package.json','utf8')).version);
  const run=native.view.run;await api(page,'settings.set',{projectId:run.projectId});await page.reload();await page.getByRole('button',{name:'Leader Mode',exact:true}).click();
  await page.getByLabel('Leader Run 历史').selectOption(run.id);await expect(page.getByRole('status',{name:'Leader Run 当前状态'})).toHaveText('审查通过');
  const calls=await api(page,'models.calls',{runId:run.id,limit:30});expect(calls).toEqual(native.modelCalls);expect((await api(page,'leader.get',{runId:run.id})).tasks[0].reviewTaskId).toMatch(/^model:/);
  await expect(page.getByRole('region',{name:'Run 模型调用记录',exact:true})).toContainText('qwen3-vl:4b');await page.screenshot({path:'test-results/m4-packaged-real-run.png',fullPage:true});
  await page.getByRole('button',{name:'Model Hub',exact:true}).click();await expect(page.getByRole('region',{name:'模型调用记录',exact:true})).toContainText('qwen3-vl:4b');await page.screenshot({path:'test-results/m4-packaged-real-models.png',fullPage:true});
  const before=await api(page,'tasks.list',{projectId:run.projectId,offset:0,limit:100});expect(before.tasks).toHaveLength(native.providerTasks.length);expect((await api(page,'snapshot.get',{})).activeTaskCount).toBe(0);checks.push('production reads real Ollama model decisions, trusted usage, native Worker evidence and completed Run from copied database');
  await app.close();app=null;page=await launch();expect(await api(page,'models.calls',{runId:run.id,limit:30})).toEqual(calls);expect((await api(page,'tasks.list',{projectId:run.projectId,offset:0,limit:100})).tasks.map(t=>t.id)).toEqual(before.tasks.map(t=>t.id));expect((await api(page,'snapshot.get',{})).activeTaskCount).toBe(0);expect(errors).toEqual([]);checks.push('restart preserves separate model/native history without replay or extra model requests');
  writeFileSync('test-results/m4-packaged-report.json',JSON.stringify({passed:true,version,runId:run.id,additionalModelRequests:false,copiedDatabase:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,version,checks}));
}finally{if(app)await app.close();}
