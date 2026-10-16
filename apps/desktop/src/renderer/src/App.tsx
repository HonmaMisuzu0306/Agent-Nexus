import { lazy, Suspense, useEffect, useRef } from 'react';
import { Activity, FolderOpen, LayoutDashboard, PanelsTopLeft, Network, MessageSquare, Workflow, History, Settings, Moon, Sun, Grid2X2, Columns2, Scan, PanelRightOpen, Square, X, ArrowUpRight, ShieldCheck } from 'lucide-react';
import { appVersion, providers } from '../../../../../packages/shared/constants';
import { act, request, useStore, type Page } from './store';
import { AgentPanel, providerMeta } from './components/AgentPanel';
import { TaskInspector } from './components/TaskInspector';
import { OverviewPage, ProjectsPage, SettingsPage } from './components/Pages';
import { Button } from './components/ui/button';
import { LeaderPage } from './components/LeaderPage';
import { ModelHubPage } from './components/ModelHubPage';
import { MeetingPage } from './components/MeetingPage';

const HistorySearchPage = lazy(() => import('./components/HistorySearchPage').then(m => ({ default: m.HistorySearchPage })));
const WorkflowPage = lazy(() => import('./components/WorkflowPage').then(m => ({ default: m.WorkflowPage })));
const nav = [
  { id: 'overview', name: '总览', title: '工作台总览', english: 'OVERVIEW', Icon: LayoutDashboard },
  { id: 'projects', name: '项目管理', title: '本地项目', english: 'PROJECTS', Icon: FolderOpen },
  { id: 'workspace', name: '独立工作台', title: 'Agent 工作台', english: 'WORKSPACE', Icon: PanelsTopLeft },
  { id: 'leader', name: 'Leader Mode', title: 'Leader Mode', english: 'ORCHESTRATION', Icon: Network },
  { id: 'meetings', name: 'Agent 会议', title: 'Agent 会议', english: 'MEETINGS', Icon: MessageSquare },
  { id: 'workflows', name: '工作流', title: '任务工作流', english: 'WORKFLOWS', Icon: Workflow },
  { id: 'history', name: '任务历史', title: '任务历史', english: 'TASK HISTORY', Icon: History },
  { id: 'models', name: 'Model Hub', title: '模型服务', english: 'MODEL HUB', Icon: Network },
  { id: 'settings', name: '设置', title: '工作台设置', english: 'SETTINGS', Icon: Settings }
] satisfies { id: Page; name: string; title: string; english: string; Icon: typeof Activity }[];

export function App() {
  const snapshot = useStore(s => s.snapshot); const tasks = useStore(s => s.tasks); const page = useStore(s => s.page); const error = useStore(s => s.error); const inspector = useStore(s => s.inspector);
  const mainScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void useStore.getState().initialize();
    if (!window.nexus) return;
    const unsubscribe = window.nexus.onEvent(() => void act(() => useStore.getState().refreshTasks()));
    const issueUnsubscribe = window.nexus.onIssue(issue => { useStore.getState().setError(`${issue.agentId ?? '工作台'} / ${issue.taskId ?? '系统'}：${issue.message}${issue.fatal ? '；请检查本地存储并重启' : ''}`); void act(() => useStore.getState().refreshTasks()); });
    return () => { unsubscribe(); issueUnsubscribe(); };
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = snapshot?.settings.theme ?? 'light'; }, [snapshot?.settings.theme]);
  useEffect(() => { if (mainScroll.current) mainScroll.current.scrollTop = 0; }, [page]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (event.altKey && !event.ctrlKey && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) { event.preventDefault(); useStore.getState().setPage(nav[Number(event.code.slice(-1)) - 1].id); }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyM') { event.preventDefault(); useStore.getState().toggleInspector(); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, []);
  const active = snapshot?.activeTaskCount ?? 0;
  const currentProject = snapshot?.projects.find(p => p.id === snapshot.settings.projectId);
  const currentNav = nav.find(n => n.id === page)!;
  const showInspector = inspector && ['workspace', 'history'].includes(page);
  const settings = snapshot?.settings;
  return <div className={`app-shell ${showInspector ? 'with-inspector' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">N</span><div><b>AGENT NEXUS</b><span>本地 Agent 工作台</span></div></div>
      <div className="nav-caption"><span>工作台导航</span><span className="micro">INDEX / 09</span></div>
      <nav aria-label="工作台导航">{nav.map((n, i) => <button key={n.id} className={page === n.id ? 'active' : ''} aria-label={n.name} aria-current={page === n.id ? 'page' : undefined} onClick={() => useStore.getState().setPage(n.id)}><span className="nav-number">{String(i + 1).padStart(2, '0')}</span><n.Icon size={17} /><span className="nav-name">{n.name}</span>{['leader', 'meetings', 'workflows'].includes(n.id) && <small>{n.id === 'leader' ? 'M3.5' : n.id === 'meetings' ? 'M3.5' : 'M5'}</small>}</button>)}</nav>
      <div className="sidebar-project"><span className="micro">CURRENT PROJECT</span><strong>{currentProject?.name ?? '未选择项目'}</strong><p>{currentProject ? '本地项目 · 历史独立保存' : '导入目录，开始工作'}</p><button onClick={() => useStore.getState().setPage('projects')}>管理项目 <ArrowUpRight size={13} /></button></div>
      <div className="sidebar-footer"><ShieldCheck size={18} /><span>记录保存在本机<small>LOCAL / {appVersion}</small></span></div>
    </aside>
    <div className="app-main">
      <header className="topbar"><div className="project-selector"><FolderOpen size={16} /><select aria-label="当前项目" value={settings?.projectId ?? ''} onChange={e => act(() => useStore.getState().updateSettings({ projectId: e.target.value || null }))}><option value="">选择本地项目</option>{snapshot?.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div><div className="topbar-actions"><span className="global-state"><span className={`state-dot ${active ? 'yellow' : 'green'}`} />{active ? `${active} 项任务运行中` : '无运行任务'}</span><Button variant="outline" size="sm" onClick={()=>act(()=>request('leader.pauseAll',{}))}>暂停 Leader 派单</Button><Button variant="outline" size="sm" disabled={!active} onClick={() => act(async () => { const result = await request('tasks.stopAll', {}); if (result.pending || !result.ok) useStore.getState().setError(result.reason ?? '部分任务仍等待取消确认'); await useStore.getState().refreshTasks(); })}><Square size={11} />停止全部任务</Button><Button variant="ghost" size="icon" title={settings?.theme === 'dark' ? '切换浅色主题' : '切换深色主题'} aria-label={settings?.theme === 'dark' ? '切换浅色主题' : '切换深色主题'} onClick={() => act(() => useStore.getState().updateSettings({ theme: settings?.theme === 'dark' ? 'light' : 'dark' }))}>{settings?.theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</Button></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭错误提示" onClick={() => useStore.getState().setError(null)}><X size={16} /></button></div>}
      <div className="main-scroll" ref={mainScroll}><main className="page-content">
        <header className="page-header"><div><span className="micro">AGENT NEXUS / {currentNav.english}</span><h1>{currentNav.title}<span className="heading-period" aria-hidden="true">.</span></h1></div><span className="page-index">{String(nav.indexOf(currentNav) + 1).padStart(2, '0')}<small>/ 09</small></span></header>
        {page === 'workspace' && <><div className="workspace-toolbar"><div><span className="label-tag">独立模式</span><p>{currentProject ? 'Codex / DSH 原生接入；WorkBuddy 可选本地桥接。' : '先选择或导入一个本地项目。'}</p>{!currentProject && <button className="text-link" onClick={() => useStore.getState().setPage('projects')}>导入项目 <ArrowUpRight size={13} /></button>}</div><div className="layout-controls"><div className="segmented">{[{ layout: 'grid', label: '四宫格布局', Icon: Grid2X2 }, { layout: 'columns', label: '双栏布局', Icon: Columns2 }, { layout: 'focus', label: '聚焦布局', Icon: Scan }].map(({ layout, label, Icon }) => <button key={layout} aria-label={label} title={label} className={settings?.layout === layout ? 'selected' : ''} onClick={() => act(() => useStore.getState().updateSettings({ layout: layout as 'grid' | 'columns' | 'focus' }))}><Icon size={16} /></button>)}</div><Button variant="outline" size="icon" aria-label={showInspector ? '收起任务监视器' : '展开任务监视器'} title="任务监视器" onClick={() => useStore.getState().toggleInspector()}><PanelRightOpen size={16} /></Button></div></div><div className={`agent-grid layout-${settings?.layout ?? 'grid'}`}>{providers.filter(p => settings?.layout !== 'focus' || p === settings.focusedAgent).map(p => <AgentPanel key={`${settings?.projectId ?? 'none'}:${p}`} provider={p} installation={snapshot?.installations.find(i => i.id === p)} task={tasks.find(t => t.provider === p)} />)}</div></>}
        {page === 'models' && <ModelHubPage />}{page === 'overview' && <OverviewPage />}{page === 'projects' && <ProjectsPage />}{page === 'history' && <Suspense fallback={<p>正在载入历史…</p>}><HistorySearchPage /></Suspense>}{page === 'settings' && <SettingsPage />}{page === 'leader' && <LeaderPage />}{page === 'meetings' && <MeetingPage />}{page === 'workflows' && <Suspense fallback={<p>正在载入工作流…</p>}><WorkflowPage /></Suspense>}
      </main></div>
      <footer className="statusbar"><span><span className="state-dot green" />本地工作台 · {snapshot ? `${snapshot.projects.length} 个项目` : '正在加载'}</span><span>原生接口：{snapshot?.installations.filter(i => i.capabilities.sendPrompt.supported).map(i => providerMeta[i.id].name).join(' / ') || '未连接'}<span className="status-divider" />费用：未知</span></footer>
    </div>
    {showInspector && <TaskInspector />}
  </div>;
}
