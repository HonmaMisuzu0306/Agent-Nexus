import { useEffect, useState } from 'react';
import type { Approval } from '../../../../../../packages/shared';
import { act, request, useStore } from '../store';
import { Button } from './ui/button';

export function Approvals({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<Approval[]>([]); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => request('approvals.list', { taskId }).then(a => { if (live) setItems(a); }).catch(e => { if (live) useStore.getState().setError(e.message); });
    void load(); const unsubscribe = window.nexus.onEvent(e => { if (e.taskId === taskId && (e.type.startsWith('approval.') || e.type.startsWith('task.'))) void load(); });
    return () => { live = false; unsubscribe(); };
  }, [taskId]);
  const respond = (id: string, decision: 'accept' | 'decline') => act(async () => {
    setBusy(true); try { await request('approval.respond', { approvalId: id, decision }); setItems(await request('approvals.list', { taskId })); await useStore.getState().refreshTasks(); } finally { setBusy(false); }
  });
  return <>{items.filter(a => a.status === 'pending').map(a => <div className="approval-card" key={a.id}><strong>原生请求 · {a.kind === 'command' ? '命令执行' : '文件写入'}</strong><p>{a.reason}</p>{a.command && <pre>{a.command}</pre>}<code>{a.cwd}</code><p>批准可能让此条命令在原生沙箱外执行。工作目录不限制命令的影响范围，请核对完整内容。</p><div><Button size="sm" disabled={busy} onClick={() => respond(a.id, 'accept')}>单次批准</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => respond(a.id, 'decline')}>拒绝</Button></div></div>)}</>;
}
