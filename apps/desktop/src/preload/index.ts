import { contextBridge, ipcRenderer } from 'electron';
import { channels } from '../../../../packages/shared/channels';
import type { AgentEvent, NexusBridge, ServiceIssue } from '../../../../packages/shared';

const bridge: NexusBridge = {
  call: (channel, args) => {
    if (!channels.includes(channel)) return Promise.resolve({ ok: false, error: 'unsupported IPC channel' });
    return ipcRenderer.invoke(`nexus:${channel}`, args);
  },
  onEvent: handler => {
    const listener = (_event: Electron.IpcRendererEvent, event: AgentEvent) => handler(event);
    ipcRenderer.on('nexus:event', listener);
    return () => { ipcRenderer.removeListener('nexus:event', listener); };
  },
  onIssue: handler => {
    const listener = (_event: Electron.IpcRendererEvent, issue: ServiceIssue) => handler(issue);
    ipcRenderer.on('nexus:issue', listener);
    return () => { ipcRenderer.removeListener('nexus:issue', listener); };
  }
};
contextBridge.exposeInMainWorld('nexus', bridge);
