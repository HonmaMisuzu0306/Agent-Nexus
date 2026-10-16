// Test-only Electron harness: real renderer, IPC, HTTP Model Hub and Windows encryption;
// Worker adapters are synthetic protocol fixtures, never native-provider evidence.
import { app, BrowserWindow, ipcMain, dialog, net, protocol, safeStorage } from 'electron';
import { resolve, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Repository } from '../../packages/persistence';
import { NexusService } from '../../apps/desktop/src/main/service';
import { registerNexusIpc } from '../../apps/desktop/src/main/ipc';
import { TeamAdapter } from './team-adapter';
import { EncryptedModelSecrets } from '../../packages/model-core/secrets';
import type { StartSessionRequest } from '../../packages/shared';

class ProtocolSlotFixture extends TeamAdapter {async startSession(a:StartSessionRequest){const s=await super.startSession(a);s.mode='real';return s;}}
protocol.registerSchemesAsPrivileged([{scheme:'nexus',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.setPath('userData',resolve(process.env.NEXUS_DATA_DIR!));let service:NexusService;let win:BrowserWindow;let closing=false;
void app.whenReady().then(async()=>{
  const rendererRoot=resolve('out/renderer');protocol.handle('nexus',request=>{const u=new URL(request.url);const file=resolve(rendererRoot,'.'+decodeURIComponent(u.pathname));if(u.hostname!=='app'||!file.startsWith(rendererRoot+sep))return new Response('Forbidden',{status:403});return net.fetch(pathToFileURL(file).href);});
  const repo=await Repository.open(join(app.getPath('userData'),'nexus.sqlite'));repo.recoverInterrupted();
  const codex=new ProtocolSlotFixture('codex'),dsh=new ProtocolSlotFixture('dsh');
  const secrets=new EncryptedModelSecrets(join(app.getPath('userData'),'model-credentials.bin'),{isEncryptionAvailable:()=>process.platform==='win32'&&safeStorage.isEncryptionAvailable(),encryptString:s=>safeStorage.encryptString(s),decryptString:b=>safeStorage.decryptString(b)});
  service=new NexusService(repo,{get:p=>p==='codex'?codex:dsh,dispose:async()=>{await codex.dispose();await dsh.dispose();}},undefined,secrets);
  win=new BrowserWindow({width:1440,height:960,show:false,webPreferences:{preload:resolve('out/preload/index.js'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  registerNexusIpc(ipcMain,dialog,()=>win,service,'nexus://app/index.html');service.onEvent=e=>{if(!win.isDestroyed())win.webContents.send('nexus:event',e);};service.onIssue=e=>{if(!win.isDestroyed())win.webContents.send('nexus:issue',e);};
  await service.detect();await win.loadURL('nexus://app/index.html');win.show();
});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',e=>{if(closing||!service)return;e.preventDefault();closing=true;void service.dispose().finally(()=>{service.repository.close();app.quit();});});
