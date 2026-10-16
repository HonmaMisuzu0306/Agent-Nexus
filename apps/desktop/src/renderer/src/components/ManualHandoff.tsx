import { useEffect, useRef, useState } from 'react';
import type { Handoff } from '../../../../../../packages/shared';
import { act, request, useStore } from '../store';
import { Button } from './ui/button';
import { providerMeta } from './AgentPanel';

export function ManualHandoff({ provider, installed }: { provider: Handoff['provider']; installed: boolean }) {
  const projectId = useStore(s => s.snapshot?.settings.projectId); const [prompt, setPrompt] = useState(''); const [items, setItems] = useState<Handoff[]>([]);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState(''); const [importing, setImporting] = useState<Handoff | null>(null);
  const name = providerMeta[provider].name;
  useEffect(() => { let live = true; if (projectId) request('handoffs.list', { projectId, provider }).then(h => { if (live) setItems(h); }).catch(e => { if (live) useStore.getState().setError(e.message); }); return () => { live = false; }; }, [projectId, provider]);
  const latest = items[0];
  const prepare = () => act(async () => {
    if (!projectId) return; setBusy(true);
    try { const h = await request('handoff.prepare', { projectId, provider, prompt }); await request('handoff.copy', { handoffId: h.id }); setItems(await request('handoffs.list', { projectId, provider })); setNote('交接目标已复制；请在原生应用中确认目录与权限后手动提交。'); }
    finally { setBusy(false); }
  });
  return <><div className="agent-output manual-output"><strong>人工交接 · 原生状态未知</strong><p>复制目标后，在 {name} 中手动提交。导入结果保存在本机，并标记为人工来源。</p>{note && <p role="status">{note}</p>}{items.map(h => <article key={h.id}><b>{h.prompt}</b><small>{h.status === 'imported' ? '已导入人工结果；原生完成状态未验证' : '已准备；尚未导入结果'}</small>{h.result && <pre>{h.result}</pre>}<div><Button size="sm" variant="outline" onClick={() => setImporting(h)}>导入人工结果</Button><Button size="sm" variant="ghost" onClick={() => act(async () => { await request('handoff.copy', { handoffId: h.id }); setNote('交接目标已复制'); })}>再次复制</Button></div></article>)}</div><div className="agent-composer"><textarea aria-label={`${name} 人工交接目标`} placeholder="输入人工交接目标…" value={prompt} disabled={busy} maxLength={16000} onChange={e => setPrompt(e.target.value)} /><div className="composer-actions"><Button size="sm" variant="outline" disabled={!installed} onClick={() => act(async () => { await request('provider.open', { provider }); setNote('已请求打开原生应用；未自动提交任务。'); })}>打开原生应用</Button><Button size="sm" disabled={!projectId || !prompt.trim() || busy} onClick={prepare}>准备并复制目标</Button></div>{latest && <span className="micro">MANUAL / {items.length} 条近期交接</span>}</div>{importing && <ImportDialog handoff={importing} close={() => setImporting(null)} saved={h => setItems(old => old.map(x => x.id === h.id ? h : x))} />}</>;
}
function ImportDialog({ handoff, close, saved }: { handoff: Handoff; close: () => void; saved: (h: Handoff) => void }) {
  const ref = useRef<HTMLDialogElement>(null); const [result, setResult] = useState(handoff.result ?? ''); const [busy, setBusy] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog className="handoff-dialog" ref={ref} aria-labelledby="handoff-title" onCancel={close}><h2 id="handoff-title">导入人工结果</h2><p>原生成功、文件变更和费用由你核实；此记录只代表人工提交的结果。</p><label>结果<textarea autoFocus aria-label="人工结果文本" value={result} maxLength={100000} onChange={e => setResult(e.target.value)} /></label><div><Button variant="outline" disabled={busy} onClick={close}>关闭</Button><Button disabled={!result.trim() || busy} onClick={() => act(async () => { setBusy(true); try { saved(await request('handoff.import', { handoffId: handoff.id, result })); close(); } finally { setBusy(false); } })}>保存人工结果</Button></div></dialog>;
}
