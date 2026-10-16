import { writeFileSync } from 'node:fs';
import type { BrowserWindow, Dialog, IpcMain } from 'electron';
import { ZodError } from 'zod';
import { channels, parseRequest } from '../../../../packages/shared';
import type { NexusService } from './service';

export function isTrustedDocument(frameUrl: string, trustedUrl: string) {
  try {
    const actual = new URL(frameUrl); const trusted = new URL(trustedUrl);
    return actual.protocol === trusted.protocol && actual.host === trusted.host && actual.pathname === trusted.pathname && actual.search === trusted.search;
  } catch { return false; }
}

export function registerNexusIpc(ipc: IpcMain, dialog: Dialog, getWindow: () => BrowserWindow | null, service: NexusService, trustedUrl: string, clipboard?: { writeText: (text: string) => void }) {
  for (const channel of channels) {
    ipc.handle(`nexus:${channel}`, async (event, input) => {
      try {
        const window = getWindow(); const frame = event.senderFrame;
        if (!window || event.sender !== window.webContents || frame !== window.webContents.mainFrame || !frame || !isTrustedDocument(frame.url, trustedUrl)) throw new Error('拒绝非可信 IPC 来源');
        parseRequest(channel, input);
        if (channel === 'project.pick') {
          const picked = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: '选择项目目录' });
          return { ok: true, data: picked.canceled ? null : picked.filePaths[0] };
        }
        if (channel === 'diagnostics.export') {
          const report = await service.call('diagnostics.get', {});
          const picked = await dialog.showSaveDialog(window, { title: '保存脱敏诊断（仅汇总计数）', defaultPath: 'nexus-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
          if (!picked.canceled && picked.filePath) writeFileSync(picked.filePath, JSON.stringify(report, null, 2), 'utf8');
          return { ok: true, data: { cancelled: picked.canceled || !picked.filePath } };
        }
        const data = await service.call(channel, input);
        if (channel === 'handoff.copy' || channel === 'workbuddy.config.copy' || channel === 'workbuddy.bootstrap.copy') { if (!clipboard || typeof data !== 'string') throw new Error('剪贴板不可用'); clipboard.writeText(data); }
        return { ok: true, data };
      } catch (error) { return { ok: false, error: error instanceof ZodError ? error.issues.map(issue => issue.message).join('；') : error instanceof Error ? error.message : '未知错误' }; }
    });
  }
  return () => channels.forEach(channel => ipc.removeHandler(`nexus:${channel}`));
}
