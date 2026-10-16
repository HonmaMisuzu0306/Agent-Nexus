import { useEffect, useState } from 'react';
import { ArrowUpRight, Play, Square, Terminal, Focus } from 'lucide-react';
import { activeStatuses } from '../../../../../../packages/shared/constants';
import type { AgentEvent, AgentInstallation, Mode, Provider, Task } from '../../../../../../packages/shared';
import { Button } from './ui/button';
import { act, request, useStore } from '../store';
import { ManualHandoff } from './ManualHandoff';
import { WorkBuddyBridge } from './WorkBuddyBridge';

export const providerMeta = {
  codex: { name: 'Codex', vendor: 'OPENAI', mark: 'CX', number: '01' },
  antigravity: { name: 'Antigravity', vendor: 'GOOGLE', mark: 'AG', number: '02' },
  dsh: { name: 'DeepSeek Harness', vendor: 'DEEPSEEK', mark: 'DS', number: '03' },
  workbuddy: { name: 'WorkBuddy', vendor: 'TENCENT', mark: 'WB', number: '04' }
};
export const statusText: Record<Task['status'], string> = { queued: '排队中', running: '模拟运行中', waiting_approval: '等待审批', completed: '模拟完成', failed: '模拟失败', cancelled: '已取消', interrupted: '已中断' };
export const taskStatus = (task: Task) => task.mode === 'mock' ? statusText[task.status] : task.mode === 'bridge' ? ({ ...statusText, queued: '等待客户端领取', running: '桥接执行中', completed: '客户端报告完成', failed: '桥接失败', cancelled: '桥接已取消', interrupted: '桥接已中断' })[task.status] : ({ ...statusText, running: '真实运行中', completed: '真实完成', failed: '真实失败' })[task.status];
export function AgentPanel({ provider, installation, task }: { provider: Provider; installation?: AgentInstallation; task?: Task }) {
  const [mode, setMode] = useState<Mode>('real');
  const [prompt, setPrompt] = useState('');
  const [scenario, setScenario] = useState<'success' | 'failure'>('success');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [sandbox, setSandbox] = useState<'read-only' | 'workspace-write'>('read-only');
  const [resume, setResume] = useState(false);
  const projectId = useStore(s => s.snapshot?.settings.projectId);
  const running = task && activeStatuses.some(status => status === task.status);
  const meta = providerMeta[provider];
  useEffect(() => {
    let live = true;
    if (!task) { setEvents([]); return; }
    setEvents([]);
    request('events.tail', { taskId: task.id, limit: 50 }).then(e => { if (live) setEvents(old => [...new Map([...e, ...old].map(x => [x.eventId, x])).values()].sort((a, b) => a.sequence - b.sequence).slice(-50)); }).catch(e => { if (live) useStore.getState().setError(e.message); });
    const unsubscribe = window.nexus.onEvent(e => { if (e.taskId === task.id) setEvents(old => old.some(x => x.eventId === e.eventId) ? old : [...old, e].slice(-50)); });
    return () => { live = false; unsubscribe(); };
  }, [task?.id]);
  useEffect(() => { setPrompt(''); setMode('real'); setSandbox('read-only'); setResume(false); }, [projectId]);
  useEffect(() => { if (task && activeStatuses.some(s => s === task.status)) setMode(task.mode); }, [task?.id, task?.status]);
  const connected = !!installation?.capabilities.sendPrompt.supported;
  const matching = task?.mode === mode;
  const label = running ? taskStatus(task) : mode === 'bridge' ? 'MCP 项目桥接' : mode === 'mock' ? '模拟就绪' : connected ? '原生已连接' : installation?.state === 'detected' ? '已安装 · 受限接入' : installation?.state === 'unverified' ? '安装待验证' : '未安装 / 未连接';
  const start = () => act(async () => {
    if (!projectId) return; setBusy(true);
    try {
      const t = await request('task.start', { projectId, provider, prompt, scenario, mode, ...(mode === 'real' ? { sandbox: resume && task ? task.sandbox : sandbox, ...(resume && task ? { sessionId: task.sessionId } : {}) } : {}) });
      useStore.getState().selectTask(t.id); await useStore.getState().refreshTasks();
    } finally { setBusy(false); }
  });
  return <section className={`agent-panel ${running ? 'agent-running' : ''}`} data-agent={provider}>
    <header className="agent-header">
      <span className="agent-mark">{meta.mark}</span>
      <div className="agent-name"><span className="micro">{meta.vendor} / {meta.number}</span><h3>{meta.name}</h3></div>
      <Button variant="ghost" size="icon" title={`聚焦 ${meta.name}`} aria-label={`聚焦 ${meta.name}`} onClick={() => act(() => useStore.getState().updateSettings({ layout: 'focus', focusedAgent: provider }))}><Focus size={15} /></Button>
    </header>
    <div className="agent-mode"><span className={`state-dot ${mode === 'mock' || connected ? 'yellow' : ''}`} /><span>{label}</span><span className="micro">{mode === 'bridge' ? 'MCP BRIDGE' : mode === 'mock' ? 'SIMULATION' : connected ? 'NATIVE' : 'RESTRICTED'}</span></div>
    <div className="mode-tabs" role="group" aria-label={`${meta.name} 运行方式`}>
      <button disabled={!!running || busy} className={mode === 'real' ? 'selected' : ''} onClick={() => { setMode('real'); setResume(false); }}>真实 Provider</button>
      <button disabled={!!running || busy} className={mode === 'mock' ? 'selected' : ''} onClick={() => { setMode('mock'); setResume(false); }}>模拟演示</button>
      {provider === 'workbuddy' && <button disabled={!!running || busy} className={mode === 'bridge' ? 'selected' : ''} onClick={() => { setMode('bridge'); setResume(false); }}>本地桥接</button>}
    </div>
    {mode === 'bridge' ? <WorkBuddyBridge key={projectId} task={task} events={events} /> : mode === 'real' && (provider === 'antigravity' || provider === 'workbuddy') ? <ManualHandoff provider={provider} installed={installation?.state === 'detected'} /> : <><div className="agent-output">
      {mode === 'real' && !connected ? <div className="unconnected"><Terminal size={25} strokeWidth={1} /><strong>已安装 / 能力受限</strong><p>{installation?.detail ?? '正在检测本机启动入口…'}</p><span className="micro">不会替换为模拟器或其他 CLI</span></div> : !matching || !events.length ? <div className="unconnected"><Terminal size={25} strokeWidth={1} /><strong>{mode === 'mock' ? '模拟工作区已就绪' : '原生工作区已就绪'}</strong><p>{mode === 'mock' ? '模拟器不会执行命令或修改项目文件。' : '目标将发送给已登录的原生 Provider。默认只读；原生审批会在任务详情显示。'}</p></div> : <div className="console-lines">{events.map(e => <div key={e.eventId} className={`console-line ${e.type === 'task.failed' ? 'error' : ''}`}><span className="line-number">{String(e.sequence).padStart(2, '0')}</span><span>{e.payload.text}</span></div>)}</div>}
    </div>
    <div className="agent-composer">
      {mode === 'real' && connected && <div className="native-options"><label>权限<select aria-label={`${meta.name} 权限`} value={resume && task ? task.sandbox : sandbox} disabled={!!running || resume} onChange={e => setSandbox(e.target.value as typeof sandbox)}><option value="read-only">只读</option>{provider === 'codex' && <option value="workspace-write">项目写入（需 Git）</option>}</select></label>{task?.mode === 'real' && installation?.capabilities.resumeSession.supported && <label><input type="checkbox" checked={resume} disabled={!!running} onChange={e => setResume(e.target.checked)} />继续上次会话</label>}</div>}
      <textarea aria-label={`${meta.name} 任务输入`} placeholder={mode === 'mock' ? '输入模拟任务目标…' : connected ? '输入真实任务目标…' : '真实 Provider 尚未连接'} disabled={mode === 'real' && !connected || !!running || busy} value={prompt} maxLength={16000} onChange={e => setPrompt(e.target.value)} />
      <div className="composer-actions">
        {mode === 'mock' ? <select aria-label={`${meta.name} 模拟场景`} value={scenario} disabled={!!running} onChange={e => setScenario(e.target.value as 'success' | 'failure')}><option value="success">成功场景</option><option value="failure">失败场景</option></select> : <span className="micro">{task?.mode === 'real' ? task.model : '原生默认模型'}</span>}
        {running ? <Button size="sm" variant="destructive" onClick={() => act(async () => { await request('task.cancel', { taskId: task.id }); await useStore.getState().refreshTasks(); })}><Square size={12} />{task.mode === 'mock' ? '停止模拟' : '停止任务'}</Button> : <Button size="sm" disabled={mode === 'real' && !connected || !projectId || !prompt.trim() || busy} onClick={start}><Play size={12} />{mode === 'mock' ? '开始模拟' : resume ? '继续会话' : '发送任务'}</Button>}
      </div>
    </div></>}
    <footer className="agent-footer"><span>TOKENS <b>{events.filter(e => e.type === 'usage').at(-1)?.payload.usage?.totalTokens ?? '未知'}</b> / 费用未知</span>{task ? <button onClick={() => useStore.getState().selectTask(task.id)}>任务详情 <ArrowUpRight size={12} /></button> : <span className="micro">NO ACTIVE TASK</span>}</footer>
  </section>;
}
