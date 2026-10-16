import type { LeaderPlan } from '../../../../../packages/shared/leader';
import { create } from 'zustand';
import type { Channel, RequestMap, ResponseMap, Settings, Snapshot, Task } from '../../../../../packages/shared';

export async function request<K extends Channel>(channel: K, args: RequestMap[K]): Promise<ResponseMap[K]> {
  if (!window.nexus) throw new Error('请在 Electron 桌面应用中打开工作台');
  const reply = await window.nexus.call(channel, args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
export type Page = 'overview' | 'projects' | 'workspace' | 'leader' | 'meetings' | 'workflows' | 'history' | 'settings' | 'models';
interface State {
  inspectedTask: Task | null; inspectTask(task: Task): void;
  workflowProposal: Pick<LeaderPlan, 'goal' | 'tasks'> | null;
  loadWorkflow(proposal: Pick<LeaderPlan, 'goal' | 'tasks'> | null): void;
  snapshot: Snapshot | null; tasks: Task[]; hasMore: boolean; page: Page; error: string | null; selectedTaskId: string | null; inspector: boolean;
  setPage(page: Page): void; setError(error: string | null): void; selectTask(id: string | null): void; toggleInspector(): void;
  initialize(): Promise<void>; refreshTasks(append?: boolean): Promise<void>; updateSettings(settings: Partial<Settings>): Promise<void>;
}
let taskLoadRevision = 0;
export const useStore = create<State>((set, get) => ({
  inspectedTask: null, inspectTask: task => set({ inspectedTask: task, selectedTaskId: task.id, inspector: true }),
  workflowProposal: null, loadWorkflow: workflowProposal => set({ workflowProposal, ...(workflowProposal ? { page: 'leader' as const } : {}) }),
  snapshot: null, tasks: [], hasMore: false, page: 'workspace', error: null, selectedTaskId: null, inspector: true,
  setPage: page => set({ page }), setError: error => set({ error }),
  selectTask: selectedTaskId => set({ selectedTaskId, inspector: true }), toggleInspector: () => set(s => ({ inspector: !s.inspector })),
  initialize: async () => {
    try { const snapshot = await request('snapshot.get', {}); set({ snapshot }); await get().refreshTasks(); }
    catch (error) { set({ error: error instanceof Error ? error.message : '加载失败' }); }
  },
  refreshTasks: async (append = false) => {
    const projectId = get().snapshot?.settings.projectId;
    const revision = ++taskLoadRevision;
    const snapshot = await request('snapshot.get', {});
    if (revision !== taskLoadRevision) return;
    set(s => ({ snapshot: s.snapshot ? { ...s.snapshot, activeTaskCount: snapshot.activeTaskCount } : snapshot }));
    if (!projectId) { set({ tasks: [], hasMore: false, selectedTaskId: null }); return; }
    const result = await request('tasks.list', { projectId, offset: append ? get().tasks.length : 0, limit: 30 });
    if (revision !== taskLoadRevision || get().snapshot?.settings.projectId !== projectId) return;
    set(s => ({ tasks: append ? [...s.tasks, ...result.tasks.filter(t => !s.tasks.some(old => old.id === t.id))] : result.tasks, hasMore: result.hasMore }));
  },
  updateSettings: async partial => {
    const settings = await request('settings.set', partial);
    set(s => ({ snapshot: s.snapshot ? { ...s.snapshot, settings } : null, ...(partial.projectId !== undefined ? { selectedTaskId: null, tasks: [], workflowProposal: null, inspectedTask: null } : {}) }));
    if (partial.projectId !== undefined) await get().refreshTasks();
  }
}));
export async function act(action: () => Promise<unknown>) {
  try { await action(); } catch (error) { useStore.getState().setError(error instanceof Error ? error.message : '操作失败'); }
}
