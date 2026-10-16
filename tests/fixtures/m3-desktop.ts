// Test-only desktop harness: actual renderer/preload/IPC/service, all providers explicitly mock.
import { app, BrowserWindow, ipcMain, dialog, net, protocol } from 'electron';
import { resolve, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Repository } from '../../packages/persistence';
import { NexusService } from '../../apps/desktop/src/main/service';
import { registerNexusIpc } from '../../apps/desktop/src/main/ipc';
import { ScriptAdapter } from './leader-adapter';
import { TeamAdapter } from './team-adapter';

protocol.registerSchemesAsPrivileged([{ scheme: 'nexus', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let service: NexusService; let win: BrowserWindow; let closed = false;
app.setPath('userData', resolve(process.env.NEXUS_DATA_DIR!));
void app.whenReady().then(async () => {
  const rendererRoot = resolve('out/renderer');
  protocol.handle('nexus', request => { const url = new URL(request.url); const file = resolve(rendererRoot, '.' + decodeURIComponent(url.pathname)); if (url.hostname !== 'app' || !file.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 }); return net.fetch(pathToFileURL(file).href); });
  const repo = await Repository.open(join(app.getPath('userData'), 'nexus.sqlite')); repo.recoverInterrupted();
  const codex = process.env.NEXUS_FIXTURE_TEAM==='1'?new TeamAdapter('codex'):new ScriptAdapter('codex'); const dsh = process.env.NEXUS_FIXTURE_TEAM==='1'?new TeamAdapter('dsh'):new ScriptAdapter('dsh'); codex.delay = dsh.delay = 3000;
  service = new NexusService(repo, { get: p => p === 'codex' ? codex : dsh, dispose: async () => { await codex.dispose(); await dsh.dispose(); } });
  win = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: { preload: resolve('out/preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const fixture = new Proxy(service, { get(target, key) { if (key === 'call') return (channel: string, args: unknown) => channel === 'leader.start' ? target.call('leader.start', { ...(args as object), mode: 'mock' }) : target.call(channel as Parameters<NexusService['call']>[0], args); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  registerNexusIpc(ipcMain, dialog, () => win, fixture, 'nexus://app/index.html');
  service.onEvent = e => { if (!win.isDestroyed()) win.webContents.send('nexus:event', e); }; service.onIssue = e => { if (!win.isDestroyed()) win.webContents.send('nexus:issue', e); };
  await service.detect(); await win.loadURL('nexus://app/index.html'); win.show();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => { if (closed || !service) return; event.preventDefault(); closed = true; void service.dispose().finally(() => { service.repository.close(); app.quit(); }); });
