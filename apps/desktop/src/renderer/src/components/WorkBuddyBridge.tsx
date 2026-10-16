import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, Task, WorkBuddyStatus } from '../../../../../../packages/shared';
import { activeStatuses } from '../../../../../../packages/shared/constants';
import { act, request, useStore } from '../store';
import { Button } from './ui/button';

export function WorkBuddyBridge({ task, events }: { task?: Task; events: AgentEvent[] }) {
  const projectId = useStore(s => s.snapshot?.settings.projectId);
  const [status, setStatus] = useState<WorkBuddyStatus | null>(null); const [setup, setSetup] = useState(false); const [prompt, setPrompt] = useState(''); const [busy, setBusy] = useState(false);
  const running = task?.mode === 'bridge' && activeStatuses.some(s => s === task.status);
  useEffect(() => {
    let live = true; setStatus(null); setPrompt('');
    if (!projectId) return;
    const update = () => request('workbuddy.status', { projectId }).then(s => { if (live) setStatus(s); }).catch(e => { if (live) useStore.getState().setError(e.message); });
    void update(); const timer = setInterval(update, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [projectId]);
  const cancelRequested = !!running && (!!status?.cancelRequested || events.some(e => e.type === 'bridge.cancel_requested'));
  const active = status?.activeTask;
  const deadline = active?.cancelDeadline ?? active?.expiresAt;
  const remaining = deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - Date.now()) / 1000)) : 0;
  return <><div className="agent-output manual-output bridge-output">
    <strong>{!status?.enabled ? '项目桥接尚未启用' : active?.status === 'running' ? '桥接任务已领取；等待客户端续租' : status.connectedClients ? 'MCP 客户端最近有通信' : '等待 MCP 客户端连接'}</strong>
    {status?.error && <p role="alert">{status.error}</p>}
    {status?.connectionIssue === 'session_expired' && <p role="alert">MCP 会话已失效。请在 WorkBuddy 的自定义连接器列表，点击 agent-nexus-workbuddy 右侧的刷新按钮，再发送启动提示。</p>}
    <p>在 WorkBuddy 中配置桥接后，发送启动提示领取任务。权限由原生应用管理，结果标记为客户端报告。</p>
    {active && deadline && <div role="status" aria-label="桥接任务期限">
      <p>{active.cancelDeadline ? '取消确认期限' : active.status === 'queued' ? '任务领取期限' : '客户端续租期限'}：<time dateTime={deadline}>{new Date(deadline).toLocaleTimeString('zh-CN', { hour12: false })}</time>（剩余 {Math.floor(remaining / 60)} 分 {remaining % 60} 秒）</p>
      {active.lastContactAt && <p>最近任务通信：<time dateTime={active.lastContactAt}>{new Date(active.lastContactAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></p>}
      {!active.cancelDeadline && active.status === 'running' && <p>长任务每 3 分钟查询状态或回传进度。连续 5 分钟没有续租会中断；Nexus 无法确认原生工作已停止。</p>}
    </div>}
    {cancelRequested && <p role="status">已请求取消，等待客户端确认；必要时请在 WorkBuddy 中停止。</p>}
    {task?.mode === 'bridge' && events.map(e => <div className="console-line" key={e.eventId}><span className="line-number">{e.sequence}</span><span>{e.payload.text}</span></div>)}
  </div><div className="agent-composer">
    <textarea aria-label="WorkBuddy 桥接任务输入" placeholder="输入交给 WorkBuddy 领取的任务…" maxLength={16000} value={prompt} disabled={!status?.enabled || !!running || busy} onChange={e => setPrompt(e.target.value)} />
    <div className="composer-actions"><Button size="sm" variant="outline" disabled={!projectId} onClick={() => setSetup(true)}>配置桥接</Button>
      {running ? <Button size="sm" variant="destructive" disabled={cancelRequested || busy} onClick={() => act(async () => { if (!task) return; setBusy(true); try { const result = await request('task.cancel', { taskId: task.id }); if (!result.ok) throw new Error(result.reason); if (projectId) setStatus(await request('workbuddy.status', { projectId })); await useStore.getState().refreshTasks(); } finally { setBusy(false); } })}>{cancelRequested ? '等待取消确认' : task?.status === 'queued' ? '撤回排队' : '请求取消'}</Button>
      : <Button size="sm" disabled={!projectId || !status?.enabled || !prompt.trim() || busy} onClick={() => act(async () => { if (!projectId) return; setBusy(true); try { const t = await request('task.start', { projectId, provider: 'workbuddy', mode: 'bridge', prompt, scenario: 'success' }); useStore.getState().selectTask(t.id); await useStore.getState().refreshTasks(); } finally { setBusy(false); } })}>提交到桥接</Button>}
    </div>
  </div>{setup && projectId && <BridgeSetup projectId={projectId} status={status} changed={setStatus} close={() => setSetup(false)} />}</>;
}
function BridgeSetup({ projectId, status, changed, close }: { projectId: string; status: WorkBuddyStatus | null; changed: (s: WorkBuddyStatus) => void; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null); const [busy, setBusy] = useState(false); const [note, setNote] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  const action = (fn: () => Promise<void>) => act(async () => { setBusy(true); try { await fn(); } finally { setBusy(false); } });
  return <dialog ref={ref} className="handoff-dialog bridge-dialog" aria-labelledby="bridge-title" onCancel={close}>
    <h2 id="bridge-title">WorkBuddy 本地桥接</h2>
    <ol><li>启用当前项目的桥接。</li><li>在 WorkBuddy 5.5.6 的“专家·技能·连接器 → 连接器 → 自定义连接器 → 配置 MCP”中粘贴复制的 JSON。若已有其他 MCP，只合并 agent-nexus-workbuddy 条目。保存后返回列表，完成首次信任确认；应显示 4/4 个工具已启用。</li><li>回到 Nexus 提交桥接任务，在 WorkBuddy 选择相同项目目录，再把“启动提示”粘贴到对话中发送。</li></ol>
    <p>{status?.persistence === 'encrypted' ? '配对使用 Windows 本地加密保存，Nexus 重启后恢复相同地址；WorkBuddy 5.5.6 需在 MCP 列表点击刷新后再发送启动提示。旧任务不会自动重跑。' : '当前会话配对仅在本次运行期间有效，重启后需重新配置。'} MCP 配置已在 WorkBuddy 5.5.6 验证；其他版本需核实入口。</p>
    {status?.error && <p role="alert">{status.error}</p>}
    {status?.url && <p><b>MCP URL</b><code className="bridge-url">{status.url}</code></p>}
    <p>取消需客户端确认。撤销配对只切断桥接，仍需在 WorkBuddy 中检查已领取的任务。</p>
    {note && <p role="status">{note}</p>}
    <div className="bridge-buttons"><Button disabled={busy || !!status?.enabled} onClick={() => action(async () => { changed(await request('workbuddy.enable', { projectId })); setNote('当前项目桥接已启用'); })}>{status?.saved && !status.enabled ? '重试恢复桥接' : '启用项目桥接'}</Button>
      <Button variant="outline" disabled={busy || !status?.enabled} onClick={() => action(async () => { await request('workbuddy.config.copy', { projectId }); setNote('配置已复制，包含当前项目的配对密钥；仅粘贴到 WorkBuddy 的 MCP 设置'); })}>复制 MCP 配置</Button>
      <Button variant="outline" disabled={busy || !status?.enabled} onClick={() => action(async () => { await request('workbuddy.bootstrap.copy', { projectId }); setNote('启动提示已复制；在 WorkBuddy 中确认目录与权限后发送'); })}>复制启动提示</Button>
      <Button variant="outline" disabled={busy} onClick={() => action(async () => { const result = await request('provider.open', { provider: 'workbuddy' }); if (!result.ok) throw new Error(result.reason); setNote('已请求打开 WorkBuddy'); })}>打开 WorkBuddy</Button>
      <Button variant="destructive" disabled={busy || !status?.enabled && !status?.saved} onClick={() => action(async () => { const result = await request('workbuddy.revoke', { projectId }); changed(await request('workbuddy.status', { projectId })); setNote(result.reason ?? '配对已撤销'); await useStore.getState().refreshTasks(); })}>撤销配对</Button>
      <Button variant="outline" disabled={busy} onClick={close}>关闭</Button></div>
  </dialog>;
}
