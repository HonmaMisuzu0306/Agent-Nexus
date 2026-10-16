import type { ModelConfig, ModelProvider, ModelReply, ModelRequest, ModelUsage } from './types';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 100000;
const MAX_LINE_CHARS = 256 * 1024;

export class ModelTransportError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelTransportError'; }
}
class ResponseError extends Error {}
function invalid(): never { throw new ResponseError('Invalid model response'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function parse(value: string): Record<string, unknown> {
  try { return record(JSON.parse(value)); } catch { return invalid(); }
}
function usage(input: unknown, output: unknown): ModelUsage | undefined {
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!count(input) && !count(output)) return undefined;
  return { ...(count(input) ? { inputTokens: input } : {}), ...(count(output) ? { outputTokens: output } : {}), source: 'provider', cost: 'unknown' };
}

export function validateEndpoint(baseUrl: string, scope: 'local' | 'external'): string {
  const reject = (): never => { throw new Error('Invalid model endpoint'); };
  if (!['local', 'external'].includes(scope) || /[\s\\?#]/.test(baseUrl)) return reject();
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(baseUrl);
  if (!match || /@/.test(match[2])) return reject();
  let path = match[3] ?? '';
  for (let round = 0; ; round++) {
    if (/(?:^|\/)\.{1,2}(?:\/|$)|\\|%2f|%5c/i.test(path)) return reject();
    try { const decoded = decodeURIComponent(path); if (decoded === path) break; if (round >= 7) return reject(); path = decoded; } catch { return reject(); }
  }
  let url: URL;
  try { url = new URL(baseUrl); } catch { return reject(); }
  const authority = match[2].toLowerCase();
  const localLiteral = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(authority);
  if (scope === 'local') {
    if (!localLiteral) return reject();
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  } else if (url.protocol !== 'https:' || /^(?:localhost\.?|0\.0\.0\.0|127(?:\.\d+){3}|\[::1\])$/i.test(url.hostname)) return reject();
  return url.toString().replace(/\/+$/, '');
}

export class HttpModelProvider implements ModelProvider {
  private readonly config: ModelConfig;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly active = new Map<string, AbortController>();
  private readonly usages = new Map<string, ModelUsage>();

  constructor(config: ModelConfig, apiKey?: string) {
    this.config = { ...config };
    this.baseUrl = validateEndpoint(config.baseUrl, config.scope);
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || !Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) throw new Error('Invalid model limits');
    this.apiKey = apiKey || undefined;
  }

  private redact(text: string): string { return this.apiKey ? text.split(this.apiKey).join('[REDACTED]') : text; }
  cancel(id: string): void { this.active.get(id)?.abort(); }
  getUsage(id: string): ModelUsage | undefined {
    const value = this.usages.get(id); return value ? { ...value } : undefined;
  }
  async detect(): Promise<{ available: boolean; detail: string }> {
    try { await this.listModels(); return { available: true, detail: 'Model endpoint available' }; }
    catch (error) { return { available: false, detail: this.redact(error instanceof Error ? error.message : 'Model request failed') }; }
  }
  health(): Promise<{ available: boolean; detail: string }> { return this.detect(); }

  private async exchange<T>(path: string, payload: unknown | undefined, req: ModelRequest | undefined, consume: (response: Response) => Promise<T>): Promise<T> {
    if (req && this.active.has(req.id)) throw new Error('Model request already active');
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    if (req?.signal?.aborted) controller.abort();
    req?.signal?.addEventListener('abort', cancel, { once: true });
    if (req) { this.active.set(req.id, controller); this.usages.delete(req.id); }
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeoutMs);
    try {
      if (controller.signal.aborted) throw new ResponseError('Model request cancelled');
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: payload === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const message = `Model endpoint HTTP ${response.status}`;
        if ([408, 429].includes(response.status) || response.status >= 500) throw new ModelTransportError(message);
        throw new ResponseError(message);
      }
      const result = await consume(response);
      if (controller.signal.aborted) throw new ResponseError('Model request cancelled');
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        if (timedOut) throw new ModelTransportError('Model request timed out');
        throw new Error('Model request cancelled');
      }
      if (error instanceof ResponseError || error instanceof ModelTransportError) throw error;
      throw new ModelTransportError('Model network request failed');
    } finally {
      clearTimeout(timer); req?.signal?.removeEventListener('abort', cancel);
      if (req) this.active.delete(req.id);
      controller.abort();
    }
  }

  private async read(response: Response, onChunk: (text: string) => void): Promise<void> {
    if (!response.body) return invalid();
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    try {
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try { result = await reader.read(); } catch { throw new ResponseError('Model response body interrupted'); }
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > MAX_BODY_BYTES) throw new ResponseError('Model response too large');
        let decoded: string;
        try { decoded = decoder.decode(result.value, { stream: true }); } catch { return invalid(); }
        onChunk(decoded);
      }
      let final: string;
      try { final = decoder.decode(); } catch { return invalid(); }
      onChunk(final);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private async json(response: Response): Promise<Record<string, unknown>> {
    let text = ''; await this.read(response, chunk => { text += chunk; }); return parse(text);
  }
  async listModels(): Promise<string[]> {
    return this.exchange(this.config.kind === 'openai' ? '/models' : '/api/tags', undefined, undefined, async response => {
      const value = await this.json(response);
      if (value.error !== undefined) return invalid();
      const entries = this.config.kind === 'openai' ? value.data : value.models;
      if (!Array.isArray(entries)) return invalid();
      return entries.map(item => { const entry = record(item); const name = this.config.kind === 'openai' ? entry.id : entry.name; return typeof name === 'string' && name ? this.redact(name) : invalid(); });
    });
  }
  private payload(req: ModelRequest, stream: boolean): Record<string, unknown> {
    const base = { model: req.model, messages: [{ role: 'user', content: req.prompt }], stream };
    if (this.config.kind === 'ollama') return {
      ...base, think: false, options: { num_predict: this.config.maxOutputTokens, ...(req.schema ? { temperature: 0 } : {}) },
      ...(req.schema ? {
        messages: [
          { role: 'system', content: 'Return only the requested final JSON object. Do not output reasoning or analysis. You have no tools or file access. /no_think' },
          { role: 'user', content: `${req.prompt}\n/no_think` },
        ],
        format: this.config.structuredOutput === 'json-schema' ? req.schema : 'json',
      } : {}),
    };
    return {
      ...base, max_tokens: this.config.maxOutputTokens, ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(req.schema ? { response_format: this.config.structuredOutput === 'json-schema' ? { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: req.schema } } : { type: 'json_object' } } : {}),
    };
  }
  private checkMessage(message: Record<string, unknown>): void {
    if (message.tool_calls !== undefined || message.function_call !== undefined || message.refusal || (message.role !== undefined && message.role !== 'assistant')) throw new ResponseError('Model tool call or refusal rejected');
  }
  private checkFinish(reason: unknown): void {
    if (reason !== 'stop') throw new ResponseError('Model response did not finish normally');
  }
  private save(req: ModelRequest, text: string, model: string, value?: ModelUsage): ModelReply {
    if (!text.trim()) throw new ResponseError('Model response has no content');
    if (text.length > MAX_TEXT_CHARS) throw new ResponseError('Model response text too large');
    if (value) this.usages.set(req.id, value);
    return { text: this.redact(text), model: this.redact(model), ...(value ? { usage: value } : {}) };
  }
  async generate(req: ModelRequest): Promise<ModelReply> {
    return this.exchange(this.config.kind === 'openai' ? '/chat/completions' : '/api/chat', this.payload(req, false), req, async response => {
      const value = await this.json(response);
      if (value.error !== undefined) return invalid();
      let message: Record<string, unknown>; let counts: ModelUsage | undefined;
      if (this.config.kind === 'openai') {
        if (!Array.isArray(value.choices) || value.choices.length !== 1) return invalid();
        const choice = record(value.choices[0]); this.checkFinish(choice.finish_reason); message = record(choice.message);
        const raw = value.usage === undefined ? {} : record(value.usage); counts = usage(raw.prompt_tokens, raw.completion_tokens);
      } else {
        if (value.done !== true) return invalid(); this.checkFinish(value.done_reason); message = record(value.message);
        counts = usage(value.prompt_eval_count, value.eval_count);
      }
      this.checkMessage(message);
      if (typeof message.content !== 'string') return invalid();
      return this.save(req, message.content, typeof value.model === 'string' ? value.model : req.model, counts);
    });
  }
  async stream(req: ModelRequest, onDelta: (text: string) => void): Promise<ModelReply> {
    return this.exchange(this.config.kind === 'openai' ? '/chat/completions' : '/api/chat', this.payload(req, true), req, async response => {
      let text = ''; let model = req.model; let counts: ModelUsage | undefined;
      let terminal = false; let finished = false; let lineBuffer = ''; let eventData: string[] = []; let eventLength = 0; let secretBuffer = '';
      const deliver = (value: string) => { try { onDelta(value); } catch { throw new ResponseError('Model stream consumer failed'); } };
      const emit = (chunk: string, flush = false) => {
        secretBuffer += chunk;
        const key = this.apiKey;
        if (!key) { if (secretBuffer) deliver(secretBuffer); secretBuffer = ''; return; }
        let output = ''; let index: number;
        while ((index = secretBuffer.indexOf(key)) !== -1) { output += secretBuffer.slice(0, index) + '[REDACTED]'; secretBuffer = secretBuffer.slice(index + key.length); }
        let hold = 0;
        if (!flush) for (let length = 1; length < key.length && length <= secretBuffer.length; length++) if (secretBuffer.endsWith(key.slice(0, length))) hold = length;
        output += secretBuffer.slice(0, secretBuffer.length - hold); secretBuffer = secretBuffer.slice(secretBuffer.length - hold);
        if (output) deliver(output);
      };
      const processValue = (raw: string) => {
        if (terminal) return invalid();
        if (this.config.kind === 'openai' && raw === '[DONE]') { terminal = true; return; }
        const value = parse(raw); if (value.error !== undefined) return invalid();
        if (typeof value.model === 'string') model = value.model;
        let message: Record<string, unknown> = {};
        if (this.config.kind === 'openai') {
          if (!Array.isArray(value.choices) || value.choices.length > 1) return invalid();
          if (value.choices.length === 1) {
            if (finished) return invalid();
            const choice = record(value.choices[0]); message = record(choice.delta);
            if (choice.finish_reason !== null && choice.finish_reason !== undefined) { this.checkFinish(choice.finish_reason); finished = true; }
          }
          if (value.usage !== undefined && value.usage !== null) { const rawUsage = record(value.usage); counts = usage(rawUsage.prompt_tokens, rawUsage.completion_tokens); }
        } else {
          message = record(value.message);
          if (value.done === true) { this.checkFinish(value.done_reason); terminal = true; finished = true; counts = usage(value.prompt_eval_count, value.eval_count); }
        }
        this.checkMessage(message);
        if (message.content !== undefined && typeof message.content !== 'string') return invalid();
        const chunk = message.content ?? '';
        if (typeof chunk !== 'string') return invalid();
        text += chunk;
        if (text.length > MAX_TEXT_CHARS) throw new ResponseError('Model response text too large');
        emit(chunk);
      };
      const line = (raw: string) => {
        if (raw.length > MAX_LINE_CHARS) throw new ResponseError('Model stream line too large');
        const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (this.config.kind === 'ollama') { if (value.trim()) processValue(value); return; }
        if (value === '') { if (eventData.length) processValue(eventData.join('\n')); eventData = []; eventLength = 0; }
        else if (value.startsWith('data:')) {
          const data = value.slice(5).replace(/^ /, ''); eventLength += data.length;
          if (eventLength > MAX_LINE_CHARS) throw new ResponseError('Model stream event too large');
          eventData.push(data);
        } else if (!value.startsWith(':') && !/^(?:event|id|retry):/.test(value)) return invalid();
      };
      await this.read(response, chunk => {
        lineBuffer += chunk;
        let newline: number;
        while ((newline = lineBuffer.indexOf('\n')) !== -1) { line(lineBuffer.slice(0, newline)); lineBuffer = lineBuffer.slice(newline + 1); }
        if (lineBuffer.length > MAX_LINE_CHARS) throw new ResponseError('Model stream line too large');
      });
      if (lineBuffer) line(lineBuffer);
      if (eventData.length) processValue(eventData.join('\n'));
      if (!terminal || !finished) throw new ResponseError('Model stream ended before completion');
      emit('', true);
      return this.save(req, text, model, counts);
    });
  }
}
