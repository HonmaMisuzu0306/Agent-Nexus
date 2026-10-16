// M5 harness reuses the M4 protocol-fixture desktop. Only the save-dialog result
// is controlled, so the real IPC export writes a file in isolated test userData.
import { app, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
type SaveDialog = typeof dialog.showSaveDialog;
dialog.showSaveDialog = (async () => ({ canceled: false, filePath: join(app.getPath('userData'), 'synthetic-diagnostics.json') })) as SaveDialog;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (event, input) => {
  const result = await listener(event, input);
  if (channel === 'nexus:events.list' && input.query === 'M5_LONG_LOG_NEEDLE' && input.after > 0) await new Promise(done => setTimeout(done, 700));
  if (channel === 'nexus:workflow.save') await new Promise(done => setTimeout(done, 700));
  return result;
});
void import('./m4-desktop');
