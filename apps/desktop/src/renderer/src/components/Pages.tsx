import { useState } from 'react';
import { FolderPlus, FolderOpen, ArrowUpRight, Trash2, ShieldCheck, GitBranch, Network, MessageSquare, Workflow, RefreshCw, Monitor } from 'lucide-react';
import { providers } from '../../../../../../packages/shared/constants';
import { act, request, useStore } from '../store';
import { Button } from './ui/button';
import { providerMeta, taskStatus } from './AgentPanel';
import { ProjectDialog } from './ProjectDialog';

export function ProjectsPage() {
  const snapshot = useStore(s => s.snapshot); const [dialog, setDialog] = useState<'create' | 'import' | null>(null);
  return <><div className="section-toolbar"><p>一个项目，一组独立的会话与任务历史。</p><div><Button variant="outline" onClick={() => setDialog('import')}><FolderOpen size={15} />导入目录</Button><Button onClick={() => setDialog('create')}><FolderPlus size={15} />新建项目</Button></div></div>
    {!snapshot?.projects.length ? <div className="large-empty"><FolderOpen size={44} strokeWidth={1} /><h2>从一个本地项目开始</h2><p>创建新目录，或导入现有项目。所有历史保存在本机。</p><Button onClick={() => setDialog('import')}>导入第一个项目 <ArrowUpRight size={15} /></Button></div> : <div className="project-grid">{snapshot.projects.map((p, i) => <article className="project-card" key={p.id}><header><span className="micro">PROJECT / {String(i + 1).padStart(2, '0')}</span><span className="label-tag">{snapshot.settings.projectId === p.id ? '当前项目' : '本地目录'}</span></header><FolderOpen size={30} strokeWidth={1.2} /><h2>{p.name}</h2><dl><dt>目录</dt><dd>{p.rootPath}</dd><dt>最近打开</dt><dd>{new Date(p.lastOpenedAt).toLocaleString('zh-CN')}</dd></dl><footer><Button size="sm" onClick={() => act(async () => { await useStore.getState().updateSettings({ projectId: p.id }); useStore.getState().setPage('workspace'); })}>打开工作台<ArrowUpRight size={13} /></Button><Button variant="ghost" size="sm" aria-label="从列表移除" title="从列表移除，保留磁盘文件" onClick={() => act(async () => { await request('project.remove', { projectId: p.id }); await useStore.getState().initialize(); })}><Trash2 size={13} /><span>从列表移除</span></Button></footer></article>)}</div>}
    <div className="inline-note"><ShieldCheck size={16} /><span>从列表移除只清除本地记录与历史，原始项目文件保留。</span></div>
    {dialog && <ProjectDialog mode={dialog} close={() => setDialog(null)} />}</>;
}

export function OverviewPage() {
  const snapshot = useStore(s => s.snapshot);
  return <><div className="overview-intro"><div><span className="micro">LOCAL AGENT WORKBENCH</span><h2>一个工作台，<br />掌握四个工作区。</h2><p>选择项目，向原生 Codex / DSH 发送目标，或为受限工作区准备人工交接。</p><Button onClick={() => useStore.getState().setPage('workspace')}>进入独立工作台 <ArrowUpRight size={16} /></Button></div><div className="system-diagram" aria-label="四个 Provider 通过工作台连接本地项目"><span className="diagram-center">NEXUS<br /><small>本地工作台</small></span><div>{providers.map(p => <span key={p}>{providerMeta[p].mark}<small>{providerMeta[p].name}</small></span>)}</div><p>项目 · 会话 · 任务 · 事件</p></div></div>
    <div className="chapter-bar"><span>01</span><h2>接入状态</h2><span className="micro">PROVIDER STATUS</span></div><div className="overview-providers">{providers.map(p => { const installation = snapshot?.installations.find(i => i.id === p); return <article key={p}><span className="micro">{providerMeta[p].vendor}</span><h3>{providerMeta[p].name}</h3><b>{installation?.capabilities.sendPrompt.supported ? '原生接口已连接' : installation?.state === 'detected' ? '已安装 · 人工交接' : installation?.state === 'unverified' ? '安装待验证' : '未安装 / 未连接'}</b><p>{installation?.detail ?? '待检测'}</p></article>; })}</div>
    <div className="chapter-bar"><span>02</span><h2>本地边界</h2><span className="micro">WORKSPACE POLICY</span></div><div className="explain-grid"><article><ShieldCheck size={23} /><h3>记录保存在本机</h3><p>项目、设置和事件保存在本机。真实任务会由原生 Provider 向其模型服务发送目标与所需上下文。</p></article><article><Monitor size={23} /><h3>模拟明确标识</h3><p>演示任务需要手动选择。模拟器不会执行命令或更改项目文件。</p></article><article><GitBranch size={23} /><h3>有界串行协作</h3><p>Leader 已支持计划确认、串行派单和审查；并行执行与 Git Worktree 属于 M3.5。</p></article></div></>;
}

export function HistoryPage() {
  const tasks = useStore(s => s.tasks); const hasMore = useStore(s => s.hasMore);
  return <><div className="section-toolbar"><p>当前项目的持久化任务历史。选择任务查看完整事件。</p><Button size="sm" variant="outline" onClick={() => act(() => useStore.getState().refreshTasks())}><RefreshCw size={14} />刷新历史</Button></div>
    {!tasks.length ? <div className="large-empty"><MessageSquare size={38} strokeWidth={1} /><h2>暂无任务历史</h2><p>在独立工作台启动任务后，记录会出现在这里。人工交接记录保存在对应工作区。</p></div> : <div className="history-list">{tasks.map((t, i) => <button key={t.id} className="history-item" onClick={() => useStore.getState().selectTask(t.id)}><span className="micro">{String(i + 1).padStart(2, '0')}</span><span><b>{t.prompt}</b><small>{providerMeta[t.provider].name} · {t.mode === 'mock' ? '模拟任务' : t.mode === 'bridge' ? '桥接 / 客户端报告' : '真实任务'} · {new Date(t.createdAt).toLocaleString('zh-CN')}</small></span><span className={`history-status state-${t.status}`}>{taskStatus(t)}</span><ArrowUpRight size={16} /></button>)}</div>}
    {hasMore && <Button variant="outline" className="load-more" onClick={() => act(() => useStore.getState().refreshTasks(true))}>加载更早任务</Button>}</>;
}

export function SettingsPage() {
  const snapshot = useStore(s => s.snapshot); const [detecting, setDetecting] = useState(false);
  return <><div className="chapter-bar"><span>01</span><h2>界面偏好</h2><span className="micro">APPEARANCE</span></div><div className="settings-block"><div><strong>工作台主题</strong><p>主题和布局在应用重启后继续保留。Alt + 1–9 切换导航；Ctrl + Shift + M 切换任务监视器。输入框内不触发这些快捷键。</p></div><div className="segmented">{(['light', 'dark'] as const).map(theme => <button key={theme} className={snapshot?.settings.theme === theme ? 'selected' : ''} onClick={() => act(() => useStore.getState().updateSettings({ theme }))}>{theme === 'light' ? '浅色终端' : '深色终端'}</button>)}</div></div>
    <div className="chapter-bar"><span>02</span><h2>本机能力</h2><Button variant="ghost" size="sm" disabled={detecting} onClick={() => act(async () => { setDetecting(true); try { await request('agents.detect', {}); await useStore.getState().initialize(); } finally { setDetecting(false); } })}><RefreshCw size={14} />{detecting ? '检测中…' : '重新检测'}</Button></div>
    <div className="capability-list">{snapshot?.installations.map(i => <article key={i.id}><header><span className="agent-mark">{providerMeta[i.id].mark}</span><div><h3>{providerMeta[i.id].name}</h3><p>{i.detail}</p></div><span className="label-tag">{i.capabilities.sendPrompt.supported ? '原生接入' : '受限接入'}</span></header><dl><dt>启动入口</dt><dd>{i.executablePath ?? 'PATH 未发现 / 未验证'}</dd><dt>版本</dt><dd>{i.version ?? '未知'}</dd><dt>认证状态</dt><dd>{i.auth === 'authenticated' ? '原生登录可用' : i.auth === 'needs_auth' ? '需先在原生应用登录' : '未知；接口握手不代表模型授权'}</dd><dt>真实任务能力</dt><dd>{i.capabilities.sendPrompt.supported ? '可发送真实任务' : i.id === 'workbuddy' ? '可选本地 MCP 桥接；需原生配置和对话领取，或人工交接' : '不可自动提交；请人工交接'}</dd><dt>能力</dt><dd>{Object.entries(i.capabilities).filter(([, c]) => c.supported).map(([name]) => name).join(' / ')}</dd><dt>最近检测</dt><dd>{new Date(i.probeAt).toLocaleString('zh-CN')}</dd></dl></article>)}</div>
    <div className="inline-note"><ShieldCheck size={16} /><span>不会自动安装 CLI 或复制原生 Provider 的凭证；费用与额度未知；只有原生返回的 Token 才显示数值。</span></div></>;
}

export function FuturePage({ kind }: { kind: 'leader' | 'meetings' | 'workflows' }) {
  const data = {
    leader: { eyebrow: 'LEADER MODE / M3', title: 'Leader 决策，工作台执行。', desc: '将总体目标转化为结构化计划，再由工作台验证权限、依赖和能力，委托 Worker 执行。', Icon: Network, steps: ['用户提出目标', 'Leader 生成计划', '验证与人工审批', 'Worker 执行与审查'], fields: [['Leader 资格', '需支持结构化决策与 leaderEligible 能力'], ['默认策略', 'Supervised：计划内常规派单，敏感动作人工授权'], ['边界', '模型不能提高自身授权、修改预算或绕过原生审批']] },
    meetings: { eyebrow: 'AGENT MEETING / M3.5', title: '有边界的讨论，形成可检验的结论。', desc: '围绕同一主题独立提出意见，再总结共识与分歧。当前页面为功能规划说明。', Icon: MessageSquare, steps: ['确定主题与范围', 'Worker 独立意见', '限定轮次讨论', '确认决策产物'], fields: [['默认轮数', '最多 3 轮，避免无限争辩'], ['上下文', '只共享经确认、与任务相关的资料'], ['边界', '不自动向其他 Provider 发送全仓库、密钥或私密记录']] },
    workflows: { eyebrow: 'WORKFLOW / M5', title: '任务依赖清晰，执行过程可追踪。', desc: '后续以 DAG 描述任务、依赖和交付结果。当前阶段没有可用的工作流编辑器。', Icon: Workflow, steps: ['定义可验收任务', '检查依赖无环', '有限并发执行', '审查并申请合并'], fields: [['默认并发', '2 个 Agent'], ['返工限制', '单任务最多 2 次；单 Run 最多 20 个子任务'], ['版本隔离', '并行写代码使用 Git Worktree，合并由用户批准']] }
  }[kind];
  return <><div className="future-hero"><span className="label-tag">后续阶段 · 未开放</span><data.Icon size={76} strokeWidth={0.8} /><span className="micro">{data.eyebrow}</span><h2>{data.title}</h2><p>{data.desc}</p></div><div className="plan-steps">{data.steps.map((s, i) => <div key={s}><span>{String(i + 1).padStart(2, '0')}</span><strong>{s}</strong></div>)}</div><dl className="future-fields">{data.fields.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl><div className="inline-note"><ShieldCheck size={17} /><span>M3 已开放串行 Leader 闭环；会议属于 M3.5，工作流属于 M5，等待下一阶段指令。</span></div></>;
}
