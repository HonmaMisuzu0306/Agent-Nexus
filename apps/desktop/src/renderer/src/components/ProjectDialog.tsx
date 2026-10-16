import { useEffect, useRef, useState } from 'react';
import { FolderOpen, X, ArrowUpRight } from 'lucide-react';
import { request, useStore } from '../store';
import { Button } from './ui/button';

export function ProjectDialog({ mode, close }: { mode: 'create' | 'import'; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(''); const [path, setPath] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    const modal = dialog.current; const previous = document.activeElement as HTMLElement | null;
    modal?.showModal(); nameInput.current?.focus();
    return () => { modal?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const pick = async () => {
    try { const picked = await request('project.pick', {}); if (picked) { setPath(picked); if (!name && mode === 'import') setName(picked.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Project'); } }
    catch (e) { setError(e instanceof Error ? e.message : '目录选择失败'); }
  };
  return <dialog ref={dialog} className="project-dialog" aria-labelledby="project-dialog-title" onCancel={close}>
    <div className="dialog-header"><span className="micro">PROJECT / {mode === 'create' ? 'CREATE' : 'IMPORT'}</span><button aria-label="关闭项目窗口" onClick={close}><X size={18} /></button></div>
    <h2 id="project-dialog-title">{mode === 'create' ? '新建本地项目' : '导入本地目录'}</h2>
    <p>{mode === 'create' ? '在父目录中创建一个新文件夹，并加入项目列表。' : '将已有目录加入工作台，原文件保持原位。'}</p>
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        const project = mode === 'create' ? await request('project.create', { name, parentPath: path }) : await request('project.add', { name, rootPath: path });
        await useStore.getState().initialize(); await useStore.getState().updateSettings({ projectId: project.id }); close();
      } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
      finally { setBusy(false); }
    }}>
      <label>项目名称<input ref={nameInput} aria-label="项目名称" required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="例如 Agent Nexus" /></label>
      <label>{mode === 'create' ? '父目录' : '本地目录'}<div className="path-input"><input aria-label="目录路径" required value={path} onChange={e => setPath(e.target.value)} placeholder="选择或输入完整目录路径" /><Button type="button" variant="outline" size="icon" aria-label="浏览本地目录" onClick={() => void pick()}><FolderOpen size={16} /></Button></div></label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="dialog-footer"><Button type="button" variant="outline" onClick={close} disabled={busy}>取消</Button><Button type="submit" disabled={busy || !name.trim() || !path.trim()}>{mode === 'create' ? '创建项目' : '导入项目'}<ArrowUpRight size={15} /></Button></div>
    </form>
  </dialog>;
}
