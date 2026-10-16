import { useEffect, useId, useState } from 'react';
import type { ModelConfigView, ModelHealth, ModelReasoning as ModelReasoningValue, ModelSelection } from '../../../../../../packages/shared/models';
import { act, request, useStore } from '../store';
import { Button } from './ui/button';
import './model-hub.css';

export function ModelReasoning({ value, onChange, disabled }: { value?: ModelReasoningValue; onChange: (value: ModelReasoningValue | undefined) => void; disabled?: boolean }) {
  const [configs, setConfigs] = useState<ModelConfigView[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void request('models.list', {}).then(list => { if (live) setConfigs(list); }).catch(e => { if (live) setError(e instanceof Error ? e.message : '读取模型服务失败'); });
    return () => { live = false; };
  }, []);
  const primary = configs.find(config => config.id === value?.primary.providerId);
  const fallback = configs.find(config => config.id === value?.fallback?.providerId);
  const external = [primary, fallback].filter(config => config?.scope === 'external');
  return <fieldset className="model-reasoning" disabled={disabled} aria-label="团队推理来源">
    <legend>团队推理来源</legend>
    <label>规划与审查使用<select aria-label="团队推理方式" value={value ? 'model' : 'native'} onChange={e => onChange(e.target.value === 'native' ? undefined : { primary: { providerId: configs[0]?.id ?? '', model: '' }, externalAcknowledged: false })}><option value="native">原生 Agent</option><option value="model">显式选择 Model Provider</option></select></label>
    <p className="model-muted">模型只负责推理，没有文件或命令权限；Worker 继续使用原生 Agent。会议仍由原生 Agent 处理。</p>
    {error && <p className="model-error" role="alert">{error}</p>}
    {value && <>
      {!configs.length && <p className="model-boundary">请先在模型服务页保存服务配置，再选择模型。</p>}
      <ReasoningModel label="主模型" selection={value.primary} configs={configs} disabled={disabled} onChange={selection => onChange({ ...value, primary: selection, externalAcknowledged: false })} />
      <label className="model-check"><input aria-label="启用备用推理模型" type="checkbox" checked={!!value.fallback} onChange={e => onChange({ ...value, fallback: e.target.checked ? { providerId: configs.find(config => config.id !== value.primary.providerId)?.id ?? configs[0]?.id ?? '', model: '' } : undefined, externalAcknowledged: false })} /><span>启用一个备用模型：仅在传输失败或超时时尝试一次</span></label>
      {value.fallback && <ReasoningModel label="备用模型" selection={value.fallback} configs={configs} disabled={disabled} onChange={selection => onChange({ ...value, fallback: selection, externalAcknowledged: false })} />}
      <p className="model-muted">鉴权、协议、无效结构化输出或取消不会触发备用模型；首次计划仍需要人工确认。</p>
      {external.length > 0 && <label className="model-check model-boundary"><input aria-label="确认团队推理资料发送至外部服务" type="checkbox" checked={value.externalAcknowledged} onChange={e => onChange({ ...value, externalAcknowledged: e.target.checked })} /><span>我确认将本次 Run 的目标、计划和必要 Worker 证据发送至外部服务：{external.map(config => `${config!.name}（${config!.baseUrl}）`).join('；')}。费用未知。</span></label>}
      {[primary, fallback].some(config => config?.kind === 'ollama') && <p className="model-muted">Ollama 的回环端点不保证上游绝对本地，请确认模型与网关的实际数据流向。</p>}
    </>}
  </fieldset>;
}

function ReasoningModel({ label, selection, configs, onChange, disabled }: { label: string; selection: ModelSelection; configs: ModelConfigView[]; onChange: (selection: ModelSelection) => void; disabled?: boolean }) {
  const listId = useId();
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<{ providerId: string; result: ModelHealth } | null>(null);
  const [error, setError] = useState('');
  const config = configs.find(item => item.id === selection.providerId);
  const result = health?.providerId === selection.providerId ? health.result : undefined;
  const check = () => act(async () => {
    if (!config) return;
    setChecking(true); setError(''); setHealth(null);
    try { setHealth({ providerId: config.id, result: await request('models.health', { providerId: config.id }) }); }
    catch (e) { const message = e instanceof Error ? e.message : '连接检查失败'; setError(message); useStore.getState().setError(message); }
    finally { setChecking(false); }
  });
  return <div className="model-reasoning-selection">
    <div className="model-form-row"><label>{label}服务<select aria-label={`${label}服务`} value={selection.providerId} disabled={disabled || checking} onChange={e => { onChange({ providerId: e.target.value, model: '' }); setError(''); setHealth(null); }}><option value="">请选择模型服务</option>{selection.providerId && !config && <option value={selection.providerId} disabled>原服务已移除，请重新选择</option>}{configs.map(item => <option key={item.id} value={item.id}>{item.name} · {item.scope === 'external' ? '外部' : '本地'}</option>)}</select></label><Button type="button" variant="outline" size="sm" disabled={disabled || checking || !config} onClick={check}>{checking ? '检查中…' : `检查${label}服务`}</Button></div>
    <label>{label}名称<input aria-label={`${label}名称`} list={listId} maxLength={200} value={selection.model} disabled={disabled || !config} onChange={e => onChange({ ...selection, model: e.target.value })} placeholder="手动填写，或点击检查后选择模型" /></label>
    <datalist id={listId}>{result?.models.map(name => <option key={name} value={name} />)}</datalist>
    {result && <p className={result.available ? 'model-muted' : 'model-error'} role="status">{result.available ? '连接可用' : '连接不可用'} · {result.detail} · {result.models.length} 个模型</p>}
    {error && <p className="model-error" role="alert">{error}</p>}
  </div>;
}
