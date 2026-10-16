import { useEffect, useState } from 'react';
import type { ModelConfig } from '../../../../../../packages/model-core/types';
import type { ModelCall, ModelConfigView, ModelHealth } from '../../../../../../packages/shared/models';
import { act, request } from '../store';
import { Button } from './ui/button';
import './model-hub.css';

const freshConfig = (): ModelConfig => ({ id: crypto.randomUUID(), name: '', kind: 'ollama', scope: 'local', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 60000, maxOutputTokens: 4096, structuredOutput: 'json-schema' });
const callStatus: Record<ModelCall['status'], string> = { running: '调用中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断，未自动重放' };
const describeError = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

export function ModelHubPage() {
  const [configs, setConfigs] = useState<ModelConfigView[]>([]);
  const [form, setForm] = useState<ModelConfig>(freshConfig);
  const [apiKey, setApiKey] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [testProvider, setTestProvider] = useState('');
  const [model, setModel] = useState('');
  const [health, setHealth] = useState<{ providerId: string; result: ModelHealth } | null>(null);
  const [prompt, setPrompt] = useState('请只回复 MODEL_HUB_OK。');
  const [acknowledged, setAcknowledged] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState<ModelCall | null>(null);
  const saved = configs.find(config => config.id === form.id);
  const tested = configs.find(config => config.id === testProvider);
  const testedHealth = health?.providerId === testProvider ? health.result : undefined;
  const locked = busy || !!activeId;

  useEffect(() => {
    let live = true;
    void request('models.list', {}).then(list => { if (live) setConfigs(list); }).catch(e => { if (live) setError(describeError(e)); });
    return () => { live = false; };
  }, []);

  const resetTest = (providerId: string) => { setTestProvider(providerId); setModel(''); setHealth(null); setAcknowledged(false); setResult(null); setNotice(''); setError(''); };
  const edit = (config?: ModelConfigView) => {
    setForm(config ? { id: config.id, name: config.name, kind: config.kind, scope: config.scope, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens, structuredOutput: config.structuredOutput } : freshConfig());
    setApiKey(''); setClearSecret(false); setRemoveConfirm(false); setNotice(''); setError('');
    if (config) resetTest(config.id);
  };
  const action = (fn: () => Promise<void>) => act(async () => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); }
    catch (e) { const message = describeError(e); setError(message); throw new Error(message); }
    finally { setBusy(false); }
  });
  const save = () => action(async () => {
    let updated: ModelConfigView;
    try { updated = await request('models.save', { config: form, ...(apiKey.trim() ? { apiKey } : {}), clearSecret }); }
    catch { throw new Error('模型配置保存失败；请检查配置、系统加密与本地存储后重试'); }
    setApiKey(''); setClearSecret(false); setForm({ ...form, baseUrl: updated.baseUrl });
    setConfigs(await request('models.list', {})); resetTest(updated.id); setNotice('配置已保存'); setRemoveConfirm(false);
  });
  const check = () => action(async () => {
    if (!tested) return;
    setHealth(null);
    const value = await request('models.health', { providerId: tested.id });
    setHealth({ providerId: tested.id, result: value });
    setNotice(value.available ? '连接检查完成；请选择或填写模型名称' : '连接检查未通过，请核对已保存的服务配置');
  });
  const generate = () => act(async () => {
    if (!tested || !model.trim() || !prompt.trim() || (tested.scope === 'external' && !acknowledged)) return;
    const id = crypto.randomUUID(); setActiveId(id); setResult(null); setError(''); setNotice(''); setCancelling(false);
    try {
      const call = await request('models.generate', { id, selection: { providerId: tested.id, model: model.trim() }, prompt: prompt.trim(), externalAcknowledged: acknowledged });
      setResult(call); setNotice('合成测试已完成');
    } catch (e) { const message = describeError(e); setError(message); throw new Error(message); }
    finally { setActiveId(null); setCancelling(false); }
  });
  const cancel = () => act(async () => {
    if (!activeId) return;
    setCancelling(true);
    try {
      const reply = await request('models.cancel', { id: activeId });
      if (!reply.ok) throw new Error(reply.reason ?? '请求尚未进入可取消状态或已结束，请稍后重试或查看调用记录');
      setNotice('已请求停止，等待调用结束');
    } catch (e) { setCancelling(false); setError(describeError(e)); throw e; }
  });
  const valid = !!form.name.trim() && !!form.baseUrl.trim() && form.timeoutMs >= 1000 && form.timeoutMs <= 180000 && Number.isInteger(form.timeoutMs) && form.maxOutputTokens >= 128 && form.maxOutputTokens <= 8192 && Number.isInteger(form.maxOutputTokens) && (!apiKey || (!!apiKey.trim() && apiKey.trim().length <= 4096 && !/[\r\n]/.test(apiKey)));

  return <div className="model-hub-page">
    <section className="model-panel model-intro" aria-label="模型服务说明">
      <div className="section-label">M4 / MODEL HUB <span>{configs.length} 个已配置服务</span></div>
      <p>模型生成文本与结构化计划，不具有文件或命令权限。执行仍由原生 Agent 完成，会议继续使用原生 Agent。</p>
      <p className="model-muted">OurFreeModel 仅支持用户显式配置、并验证兼容的网关。保存配置不会检查连接，也不会自动发起模型调用。</p>
    </section>

    {error && <p className="model-error" role="alert">{error}</p>}
    {notice && <p className="model-notice" role="status">{notice}</p>}

    <div className="model-config-layout">
      <aside className="model-panel" aria-label="已配置模型服务">
        <div className="section-label">模型服务 <span>{configs.length}</span></div>
        <div className="model-provider-list">{configs.map(config => <button type="button" key={config.id} disabled={locked} className={`model-provider-card${config.id === form.id ? ' is-selected' : ''}`} aria-pressed={config.id === form.id} onClick={() => edit(config)}>
          <strong>{config.name}</strong><span>{config.kind === 'ollama' ? 'Ollama' : 'OpenAI 兼容'} · {config.scope === 'local' ? '本地端点' : '外部服务'}</span><small>{config.hasSecret ? '凭证已加密保存' : '无凭证'}</small>
        </button>)}</div>
        {!configs.length && <p className="model-muted">尚未配置模型服务。先保存服务，再主动检查连接。</p>}
        <Button variant="outline" disabled={locked} onClick={() => edit()}>新增模型服务</Button>
      </aside>

      <form className="model-panel" aria-label="模型服务配置" onSubmit={e => { e.preventDefault(); if (valid && !locked) void save(); }}>
        <div className="section-label">{saved ? '编辑模型服务' : '新增模型服务'} <span>配置与凭证分开保存</span></div>
        <fieldset className="model-fields" disabled={locked}>
          <label>服务名称<input aria-label="模型服务名称" maxLength={100} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例如：本机 Ollama" required /></label>
          <div className="model-form-row">
            <label>服务协议<select aria-label="模型服务协议" value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as ModelConfig['kind'] })}><option value="ollama">Ollama</option><option value="openai">OpenAI 兼容</option></select></label>
            <label>数据流向<select aria-label="模型服务数据流向" value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value as ModelConfig['scope'] })}><option value="local">本地回环端点</option><option value="external">外部服务</option></select></label>
          </div>
          <label>服务端点<input aria-label="模型服务端点" value={form.baseUrl} maxLength={1024} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder={form.kind === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:8000/v1'} required spellCheck={false} /></label>
          {form.scope === 'external' && <p className="model-boundary">测试内容与所选团队推理资料会发送至此外部服务。开始测试或团队 Run 前，需明确确认外发。</p>}
          {form.kind === 'ollama' && <p className="model-muted">回环地址只说明端点位于本机，不代表上游绝对本地；请确认 Ollama 模型及网关的实际数据流向。</p>}
          <div className="model-form-row">
            <label>超时（毫秒）<input aria-label="模型请求超时" type="number" min={1000} max={180000} step={1} value={form.timeoutMs} onChange={e => setForm({ ...form, timeoutMs: Number(e.target.value) })} /></label>
            <label>最大输出 Token<input aria-label="模型最大输出 Token" type="number" min={128} max={8192} value={form.maxOutputTokens} onChange={e => setForm({ ...form, maxOutputTokens: Number(e.target.value) })} /></label>
          </div>
          <label>结构化输出策略<select aria-label="模型结构化输出策略" value={form.structuredOutput} onChange={e => setForm({ ...form, structuredOutput: e.target.value as ModelConfig['structuredOutput'] })}><option value="json-schema">JSON Schema · 严格结构</option><option value="json-object">JSON Object · 兼容模式</option></select></label>
          <label>API Key<input aria-label="模型服务 API Key" type="password" autoComplete="new-password" maxLength={4096} value={apiKey} onChange={e => { setApiKey(e.target.value); if (e.target.value) setClearSecret(false); }} placeholder={saved?.hasSecret ? '已加密保存；留空保留现有凭证' : '可选：仅填写此模型服务的凭证'} /></label>
          <p className="model-muted" aria-label="模型凭证状态">{saved?.hasSecret ? '凭证已加密保存' : '无凭证'}；保存成功后输入框会清空。</p>
          {saved?.hasSecret && <label className="model-check"><input aria-label="清除模型服务凭证" type="checkbox" checked={clearSecret} onChange={e => { setClearSecret(e.target.checked); if (e.target.checked) setApiKey(''); }} /><span>保存时清除此服务的凭证</span></label>}
        </fieldset>
        <div className="model-actions"><Button type="submit" disabled={locked || !valid}>保存配置</Button>{saved && <Button type="button" variant="destructive" disabled={locked} onClick={() => setRemoveConfirm(true)}>移除服务</Button>}</div>
        {removeConfirm && saved && <div className="model-boundary"><p>确认移除“{saved.name}”及其凭证？已有调用记录会保留。</p><div className="model-actions"><Button type="button" variant="destructive" disabled={locked} onClick={() => action(async () => { const reply = await request('models.remove', { providerId: saved.id }); if (!reply.ok) throw new Error(reply.reason ?? '移除服务失败'); setConfigs(await request('models.list', {})); edit(); resetTest(''); setNotice('服务及凭证已移除'); })}>确认移除服务</Button><Button type="button" variant="outline" disabled={locked} onClick={() => setRemoveConfirm(false)}>保留服务</Button></div></div>}
      </form>
    </div>

    <section className="model-panel" aria-label="模型合成测试">
      <div className="section-label">连接检查与合成测试 <span>仅在点击后请求服务</span></div>
      <div className="model-form-row model-test-selectors"><label>测试已保存的服务<select aria-label="合成测试模型服务" value={testProvider} disabled={locked} onChange={e => resetTest(e.target.value)}><option value="">请选择已保存的服务</option>{configs.map(config => <option key={config.id} value={config.id}>{config.name} · {config.scope === 'local' ? '本地' : '外部'}</option>)}</select></label><Button variant="outline" disabled={locked || !tested} onClick={check}>检查连接并读取模型</Button></div>
      {testedHealth && <div className={`model-health${testedHealth.available ? '' : ' is-failed'}`} role="status"><strong>{testedHealth.available ? '连接可用' : '连接不可用'}</strong><p>{testedHealth.detail}</p><span>模型列表：{testedHealth.models.length} 项</span></div>}
      {tested && <p className="model-muted">本次请求发送至 {tested.name} · {tested.baseUrl}。检查连接会读取服务状态与模型列表；合成测试只发送下方测试内容。</p>}
      <label>模型名称<input aria-label="合成测试模型名称" list="model-hub-test-models" maxLength={200} value={model} disabled={locked || !tested} onChange={e => setModel(e.target.value)} placeholder="从已检查的模型列表选择，或手动填写完整模型名称" /></label>
      <datalist id="model-hub-test-models">{testedHealth?.models.map(name => <option key={name} value={name} />)}</datalist>
      {!!testedHealth?.models.length && <label>已检查的模型列表<select aria-label="合成测试模型列表" value={testedHealth.models.includes(model) ? model : ''} disabled={locked} onChange={e => setModel(e.target.value)}><option value="">选择模型，或在上方手动填写</option>{testedHealth.models.map(name => <option key={name} value={name}>{name}</option>)}</select></label>}
      <label>合成测试内容<textarea aria-label="模型合成测试内容" rows={3} maxLength={4000} value={prompt} disabled={locked} onChange={e => setPrompt(e.target.value)} /></label>
      {tested?.scope === 'external' && <label className="model-check model-boundary"><input aria-label="确认合成测试内容发送至外部服务" type="checkbox" checked={acknowledged} disabled={locked} onChange={e => setAcknowledged(e.target.checked)} /><span>我确认将本次测试内容发送至 {tested.name}（{tested.baseUrl}），费用未知。</span></label>}
      {tested?.kind === 'ollama' && <p className="model-muted">Ollama 端点可能连接远端模型；请自行确认上游流向。</p>}
      <div className="model-actions"><Button disabled={locked || !tested || !model.trim() || !prompt.trim() || (tested.scope === 'external' && !acknowledged)} onClick={generate}>开始合成测试</Button>{activeId && <Button variant="destructive" disabled={cancelling} onClick={cancel}>{cancelling ? '等待停止确认' : '停止合成测试'}</Button>}</div>
      {activeId && <p role="status">模型调用中；结果会写入调用记录。</p>}
      {result && <div className="model-test-result" aria-label="合成测试结果"><strong>{callStatus[result.status]} · {result.providerId} / {result.model}</strong><pre>{result.text || '无文本输出'}</pre></div>}
    </section>
    <ModelCalls />
  </div>;
}

function tokens(call: ModelCall, field: 'inputTokens' | 'outputTokens'): string {
  const count = call.usage?.[field];
  return call.usage?.source === 'provider' && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count.toLocaleString('zh-CN') : '未知';
}

export function ModelCalls({ runId }: { runId?: string }) {
  const [calls, setCalls] = useState<ModelCall[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true, pending = false;
    setCalls([]); setLoading(true); setError('');
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const records = await request('models.calls', { ...(runId ? { runId } : {}), limit: 30 });
        if (live) { setCalls(records); setError(''); }
      } catch (e) { if (live) setError(describeError(e)); }
      finally { pending = false; if (live) setLoading(false); }
    };
    void load(); const timer = setInterval(() => void load(), 1500);
    return () => { live = false; clearInterval(timer); };
  }, [runId, revision]);
  return <section className="model-panel model-calls" aria-label={runId ? 'Run 模型调用记录' : '模型调用记录'}>
    <div className="model-calls-heading"><div><div className="section-label">持久化模型调用记录 <span>最近 30 条</span></div><p className="model-muted">来源：Model Provider · 每 1.5 秒读取本地记录；仅显示服务可信返回的 Token，费用未知。</p></div><Button size="sm" variant="outline" onClick={() => setRevision(value => value + 1)}>刷新调用记录</Button></div>
    {error && <p className="model-error" role="alert">{error}</p>}
    {!calls.length && <p className="model-muted" role="status">{loading ? '正在读取调用记录…' : '暂无模型调用记录'}</p>}
    {calls.map(call => <article className="model-call" key={call.id}>
      <header><strong>{call.providerId} / {call.model}</strong><span className={`model-call-status status-${call.status}`}>{callStatus[call.status]}</span></header>
      <dl className="model-call-meta"><div><dt>来源</dt><dd>Model Provider · {call.scope === 'external' ? '外部服务' : '本地端点'}</dd></div><div><dt>用途</dt><dd>{call.purpose}</dd></div><div><dt>输入 / 输出 Token</dt><dd>{tokens(call, 'inputTokens')} / {tokens(call, 'outputTokens')}</dd></div><div><dt>费用</dt><dd>未知</dd></div></dl>
      <p className="model-muted"><time dateTime={call.createdAt}>{new Date(call.createdAt).toLocaleString('zh-CN')}</time> · {call.endpoint}</p>
      {call.runId && <p className="model-muted">Run：<code>{call.runId}</code></p>}
      {call.fallbackOf && <p className="model-muted">备用调用，关联：<code>{call.fallbackOf}</code></p>}
      {call.error && <p className="model-error" role="alert">{call.error}</p>}
      <details><summary>返回文本与调用标识</summary><code>{call.id}</code><pre>{call.text || (call.status === 'running' ? '等待模型返回' : '无文本输出')}</pre></details>
    </article>)}
  </section>;
}
