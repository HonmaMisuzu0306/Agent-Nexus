import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, safeStorage, session } from 'electron';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Repository } from '../../../../packages/persistence';
import { NexusService } from './service';
import { registerNexusIpc } from './ipc';
import { EncryptedPairingStore } from '../../../../packages/agent-core/workbuddy-pairing';
import { EncryptedModelSecrets } from '../../../../packages/model-core/secrets';

protocol.registerSchemesAsPrivileged([{ scheme: 'nexus', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.NEXUS_DATA_DIR) app.setPath('userData', resolve(process.env.NEXUS_DATA_DIR));
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
let window: BrowserWindow | null = null;
let service: NexusService | null = null;
let quitting = false;
let closed = false;
const devUrl = process.env.ELECTRON_RENDERER_URL;

function createWindow() {
  window = new BrowserWindow({
    width: 1520, height: 980, minWidth: 960, minHeight: 680, show: false, backgroundColor: '#101214', title: 'Agent Nexus',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  if (devUrl && !app.isPackaged) void window.loadURL(devUrl);
  else void window.loadURL('nexus://app/index.html');
}

if (singleInstance) void app.whenReady().then(async () => {
  const rendererRoot = resolve(__dirname, '../renderer');
  protocol.handle('nexus', request => {
    const url = new URL(request.url);
    const filepath = resolve(rendererRoot, '.' + decodeURIComponent(url.pathname));
    if (url.hostname !== 'app' || !filepath.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filepath).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const repository = await Repository.open(join(app.getPath('userData'), 'nexus.sqlite'));
  repository.recoverInterrupted();
  const pairingStore = new EncryptedPairingStore(join(app.getPath('userData'), 'workbuddy-pairing.bin'), { isEncryptionAvailable: () => process.platform === 'win32' && safeStorage.isEncryptionAvailable(), encryptString: text => safeStorage.encryptString(text), decryptString: bytes => safeStorage.decryptString(bytes) });
  const modelSecrets=new EncryptedModelSecrets(join(app.getPath('userData'),'model-credentials.bin'),{isEncryptionAvailable:()=>process.platform==='win32'&&safeStorage.isEncryptionAvailable(),encryptString:text=>safeStorage.encryptString(text),decryptString:bytes=>safeStorage.decryptString(bytes)});
  service = new NexusService(repository, undefined, pairingStore,modelSecrets);
  await service.restoreWorkBuddy();
  service.onEvent = event => { if (window && !window.isDestroyed()) window.webContents.send('nexus:event', event); };
  service.onIssue = issue => { if (window && !window.isDestroyed()) window.webContents.send('nexus:issue', issue); };
  const trustedUrl = devUrl && !app.isPackaged ? devUrl : 'nexus://app/index.html';
  registerNexusIpc(ipcMain, dialog, () => window, service, trustedUrl, clipboard);
  await service.detect();
  createWindow();
}).catch(error => { dialog.showErrorBox('Agent Nexus 无法启动', error.message); app.quit(); });

app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (closed || !service) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void service.dispose().then(() => service!.repository.close()).finally(() => { closed = true; app.quit(); });
});
