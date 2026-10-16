import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpModelProvider, ModelTransportError, validateEndpoint } from '../packages/model-core/http';
import type { ModelConfig } from '../packages/model-core/types';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => unknown) {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closes.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}
function config(baseUrl: string, kind: ModelConfig['kind'] = 'openai', timeoutMs = 1000): ModelConfig {
  return { id: 'fixture', name: 'fixture', kind, baseUrl, scope: 'local', timeoutMs, maxOutputTokens: 100, structuredOutput: 'json-schema' };
}
const request = { id: 'r1', model: 'fixture-model', prompt: 'hello', schema: { type: 'object' } };
async function body(req: IncomingMessage) {
  let value = ''; for await (const chunk of req) value += chunk.toString(); return JSON.parse(value);
}
function openai(text = '{"ok":true}', finish_reason = 'stop') {
  return { model: 'fixture-model', choices: [{ message: { role: 'assistant', content: text }, finish_reason }], usage: { prompt_tokens: 3, completion_tokens: 4 } };
}
function sse(value: unknown) { return `data: ${JSON.stringify(value)}\n\n`; }

describe('endpoint boundary', () => {
  it('normalizes literal local hosts and prefixes', () => {
    expect(validateEndpoint('http://localhost:8080/v1/', 'local')).toBe('http://127.0.0.1:8080/v1');
    expect(validateEndpoint('http://[::1]:8080/', 'local')).toBe('http://[::1]:8080');
    expect(validateEndpoint('https://example.org/v1/', 'external')).toBe('https://example.org/v1');
  });
  it.each(['http://example.com', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0.0.0.0', 'http://127.0.0.2', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/?key=x', 'http://127.0.0.1/#x', 'http://127.0.0.1/%2e%2e/v1', 'http://127.0.0.1/a/../v1'])('rejects unsafe local %s', url => {
    expect(() => validateEndpoint(url, 'local')).toThrow();
  });
  it('rejects traversal after repeated percent decoding', () => {
    expect(() => validateEndpoint('http://127.0.0.1/%25252e%25252e/v1', 'local')).toThrow();
  });
  it.each(['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://0.0.0.0'])('rejects unsafe external %s', url => {
    expect(() => validateEndpoint(url, 'external')).toThrow();
  });
});

describe('HTTP model provider', () => {
  it('detects and lists models without leaking errors', async () => {
    const urls: string[] = [];
    const base = await fixture((req, res) => { urls.push(req.url!); res.end(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] })); });
    const provider = new HttpModelProvider(config(`${base}/v1`));
    expect(await provider.listModels()).toEqual(['a', 'b']);
    expect((await provider.detect()).available).toBe(true);
    expect((await provider.health()).available).toBe(true);
    expect(urls).toEqual(['/v1/models', '/v1/models', '/v1/models']);
  });
  it('sends constrained OpenAI JSON generation and records real usage', async () => {
    const base = await fixture(async (req, res) => {
      expect(req.url).toBe('/v1/chat/completions');
      expect(req.headers.authorization).toBe('Bearer secret-value');
      const value = await body(req);
      expect(value.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(value.tools).toBeUndefined();
      expect(value.max_tokens).toBe(100);
      expect(value.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'response', strict: true, schema: { type: 'object' } } });
      res.end(JSON.stringify(openai()));
    });
    const provider = new HttpModelProvider(config(`${base}/v1`), 'secret-value');
    expect(await provider.generate(request)).toEqual({ text: '{"ok":true}', model: 'fixture-model', usage: { inputTokens: 3, outputTokens: 4, source: 'provider', cost: 'unknown' } });
    expect(provider.getUsage('r1')?.outputTokens).toBe(4);
  });
  it('uses json-object fallback and omits invented usage', async () => {
    const base = await fixture(async (req, res) => {
      expect((await body(req)).response_format).toEqual({ type: 'json_object' });
      res.end(JSON.stringify({ ...openai(), usage: { prompt_tokens: 1.2, completion_tokens: -1 } }));
    });
    const provider = new HttpModelProvider({ ...config(base), structuredOutput: 'json-object' });
    expect((await provider.generate(request)).usage).toBeUndefined();
    expect(provider.getUsage('r1')).toBeUndefined();
  });
  it('supports Ollama tags, schema and usage', async () => {
    let receivedThinking: unknown;
    const base = await fixture(async (req, res) => {
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'local:4b' }] })); return; }
      expect(req.url).toBe('/api/chat');
      const value = await body(req);
      expect(value.format).toEqual({ type: 'object' });
      receivedThinking = value.think;
      expect(value.options).toEqual({ num_predict: 100, temperature: 0 });
      res.end(JSON.stringify({ model: 'local:4b', message: { role: 'assistant', content: '{}' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 6 }));
    });
    const provider = new HttpModelProvider(config(base, 'ollama'));
    expect(await provider.listModels()).toEqual(['local:4b']);
    expect((await provider.generate(request)).usage).toEqual({ inputTokens: 5, outputTokens: 6, source: 'provider', cost: 'unknown' });
    expect(receivedThinking).toBe(false);
  });
  it('uses Ollama JSON format when json-object is explicitly selected', async () => {
    let receivedFormat: unknown;
    const base = await fixture(async (req, res) => {
      receivedFormat = (await body(req)).format;
      res.end(JSON.stringify({ model: 'local:4b', message: { role: 'assistant', content: '{}' }, done: true, done_reason: 'stop' }));
    });
    const provider = new HttpModelProvider({ ...config(base, 'ollama'), structuredOutput: 'json-object' });
    expect((await provider.generate(request)).text).toBe('{}');
    expect(receivedFormat).toBe('json');
  });
  it('constrains only structured Ollama prompts to deterministic final JSON', async () => {
    const received: Array<Record<string, unknown>> = [];
    const base = await fixture(async (req, res) => {
      received.push(await body(req));
      res.end(JSON.stringify({ model: 'local:4b', message: { role: 'assistant', content: '{}' }, done: true, done_reason: 'stop' }));
    });
    const provider = new HttpModelProvider(config(base, 'ollama'));
    await provider.generate(request);
    await provider.generate({ id: 'ordinary', model: request.model, prompt: 'plain text' });
    expect(received[0].messages).toEqual([
      { role: 'system', content: 'Return only the requested final JSON object. Do not output reasoning or analysis. You have no tools or file access. /no_think' },
      { role: 'user', content: 'hello\n/no_think' },
    ]);
    expect(received[0].options).toEqual({ num_predict: 100, temperature: 0 });
    expect(received[1].messages).toEqual([{ role: 'user', content: 'plain text' }]);
    expect(received[1].options).toEqual({ num_predict: 100 });
  });
  it('decodes split UTF8/SSE chunks and retains final usage after finish', async () => {
    const base = await fixture((req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      const bytes = Buffer.from(sse({ model: 'fixture-model', choices: [{ delta: { content: '你好' }, finish_reason: null }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 9 } }) + 'data: [DONE]\n\n');
      const split = bytes.indexOf(Buffer.from('你')) + 1;
      res.write(bytes.subarray(0, split)); setTimeout(() => res.end(bytes.subarray(split)), 5);
    });
    const provider = new HttpModelProvider(config(base));
    const deltas: string[] = [];
    const reply = await provider.stream(request, text => deltas.push(text));
    expect(deltas.join('')).toBe('你好');
    expect(reply.text).toBe('你好');
    expect(reply.usage?.outputTokens).toBe(9);
  });
  it('decodes NDJSON including final line without newline', async () => {
    const base = await fixture((req, res) => {
      res.write(JSON.stringify({ model: 'fixture-model', message: { content: '好' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { content: '的' }, done: true, done_reason: 'stop', eval_count: 2 }));
    });
    const provider = new HttpModelProvider(config(base, 'ollama'));
    const deltas: string[] = [];
    expect((await provider.stream(request, text => deltas.push(text))).text).toBe('好的');
    expect(deltas).toEqual(['好', '的']);
  });
  it.each([401, 408, 429, 500])('returns safe HTTP %s without response credential echo', async status => {
    let calls = 0;
    const base = await fixture((_req, res) => { calls++; res.writeHead(status); res.end('private secret-value'); });
    const provider = new HttpModelProvider(config(base), 'secret-value');
    const error = await provider.generate(request).catch(error => error);
    expect(error.message).toContain(String(status)); expect(error.message).not.toContain('secret-value'); expect(error.message).not.toContain('private');
    expect(error instanceof ModelTransportError).toBe(status !== 401);
    expect(calls).toBe(1);
    expect((await provider.detect()).detail).not.toContain('secret-value');
  });
  it('redacts only exact credential echoes in replies and streaming deltas', async () => {
    const base = await fixture(async (req, res) => {
      if ((await body(req)).stream) {
        res.end(sse({ choices: [{ delta: { content: 'before secret-' }, finish_reason: null }] }) + sse({ choices: [{ delta: { content: 'value after secret' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
      } else res.end(JSON.stringify(openai('before secret-value after secret')));
    });
    const provider = new HttpModelProvider(config(base), 'secret-value');
    expect((await provider.generate(request)).text).toBe('before [REDACTED] after secret');
    const deltas: string[] = [];
    expect((await provider.stream(request, text => deltas.push(text))).text).toBe('before [REDACTED] after secret');
    expect(deltas.join('')).toBe('before [REDACTED] after secret');
  });
  it('rejects redirects without following the destination', async () => {
    let followed = false;
    const base = await fixture((req, res) => {
      if (req.url === '/target') { followed = true; res.end('{}'); return; }
      res.writeHead(302, { location: '/target' }); res.end();
    });
    await expect(new HttpModelProvider(config(base)).generate(request)).rejects.toThrow();
    expect(followed).toBe(false);
  });
  it.each(['{', JSON.stringify(openai('', 'stop')), JSON.stringify(openai('partial', 'length')), JSON.stringify({ ...openai(), choices: [{ message: { content: 'run', tool_calls: [{ function: { name: 'exec' } }] }, finish_reason: 'tool_calls' }] }), JSON.stringify({ error: { message: 'private secret-value' } })])('rejects malformed, empty, truncated or tool response', async value => {
    const base = await fixture((_req, res) => res.end(value));
    const error = await new HttpModelProvider(config(base), 'secret-value').generate(request).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(ModelTransportError); expect(error.message).not.toContain('secret-value');
  });
  it.each([
    sse({ choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }] }),
    sse({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }) + 'data: [DONE]\n\n',
    sse({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }) + 'data: [DONE]\n\n',
    sse({ choices: [{ delta: { tool_calls: [{}] }, finish_reason: null }] }) + 'data: [DONE]\n\n',
    'data: {broken}\n\n',
    sse({ error: { message: 'secret-value' } }),
  ])('rejects invalid or incomplete SSE without storing usage', async value => {
    const base = await fixture((_req, res) => res.end(value));
    const provider = new HttpModelProvider(config(base), 'secret-value');
    await expect(provider.stream(request, () => {})).rejects.toThrow();
    expect(provider.getUsage('r1')).toBeUndefined();
  });
  it('rejects incomplete or tool Ollama streams', async () => {
    for (const value of [JSON.stringify({ message: { content: 'partial' }, done: false }), JSON.stringify({ message: { tool_calls: [{}] }, done: true, done_reason: 'stop' }), JSON.stringify({ message: { content: 'partial' }, done: true, done_reason: 'length' })]) {
      const base = await fixture((_req, res) => res.end(value));
      await expect(new HttpModelProvider(config(base, 'ollama')).stream(request, () => {})).rejects.toThrow();
    }
  });
  it.each(['openai', 'ollama'] as const)('rejects tool-role messages from %s without fallback classification', async kind => {
    const base = await fixture((_req, res) => res.end(JSON.stringify(kind === 'openai'
      ? { choices: [{ message: { role: 'tool', content: 'execute this' }, finish_reason: 'stop' }] }
      : { message: { role: 'tool', content: 'execute this' }, done: true, done_reason: 'stop' })));
    const error = await new HttpModelProvider(config(base, kind)).generate(request).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(ModelTransportError);
  });
  it('rejects SSE content after a completed choice', async () => {
    const base = await fixture((_req, res) => res.end(sse({ choices: [{ delta: { content: 'first' }, finish_reason: 'stop' }] }) + sse({ choices: [{ delta: { content: 'late' }, finish_reason: null }] }) + 'data: [DONE]\n\n'));
    await expect(new HttpModelProvider(config(base)).stream(request, () => {})).rejects.toThrow();
  });
  it('classifies an interrupted response body as incomplete rather than retryable', async () => {
    const base = await fixture((_req, res) => {
      res.write(sse({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }));
      setTimeout(() => res.destroy(), 10);
    });
    const error = await new HttpModelProvider(config(base)).stream(request, () => {}).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(ModelTransportError);
  });
  it('bounds generated text in otherwise valid JSON and SSE responses', async () => {
    for (const stream of [false, true]) {
      const base = await fixture((_req, res) => res.end(stream
        ? sse({ choices: [{ delta: { content: 'x'.repeat(100001) }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
        : JSON.stringify(openai('x'.repeat(100001)))));
      const provider = new HttpModelProvider(config(base));
      await expect(stream ? provider.stream(request, () => {}) : provider.generate(request)).rejects.toThrow(/too large/i);
    }
  });
  it('bounds cumulative bytes even when every SSE line is short', async () => {
    const base = await fixture((_req, res) => res.end(':comment\n'.repeat(270000)));
    await expect(new HttpModelProvider(config(base)).stream(request, () => {})).rejects.toThrow(/too large/i);
  });
  it('bounds response bytes, lines and generated text', async () => {
    for (const value of [' '.repeat(2 * 1024 * 1024 + 1), JSON.stringify(openai('x'.repeat(100001))), 'data: ' + 'x'.repeat(256 * 1024 + 1)]) {
      const base = await fixture((_req, res) => res.end(value));
      await expect(new HttpModelProvider(config(base)).stream(request, () => {})).rejects.toThrow();
    }
  });
  it('times out stalled response bodies as a transport failure', async () => {
    const base = await fixture((_req, res) => { res.writeHead(200); res.write('data: '); });
    const error = await new HttpModelProvider(config(base, 'openai', 100)).stream(request, () => {}).catch(error => error);
    expect(error).toBeInstanceOf(ModelTransportError); expect(error.message).toMatch(/timed out/i);
  });
  it('supports signal abort and cancel without retry or transport classification', async () => {
    let calls = 0;
    const base = await fixture((_req, res) => { calls++; res.writeHead(200); res.write('{'); });
    const provider = new HttpModelProvider(config(base));
    const controller = new AbortController();
    const pending = provider.generate({ ...request, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const error = await pending.catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(ModelTransportError);
    const pending2 = provider.generate(request); setTimeout(() => provider.cancel('r1'), 30);
    await expect(pending2).rejects.toThrow(/cancel/i); expect(calls).toBe(2);
  });
  it('does not classify consumer callback failures as retryable network errors', async () => {
    const base = await fixture((_req, res) => res.end(sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'));
    const error = await new HttpModelProvider(config(base)).stream(request, () => { throw new Error('private consumer detail'); }).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(ModelTransportError); expect(error.message).not.toContain('private consumer');
  });
});
