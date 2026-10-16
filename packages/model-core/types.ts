export interface ModelConfig {
  id: string;
  name: string;
  kind: 'openai' | 'ollama';
  baseUrl: string;
  scope: 'local' | 'external';
  timeoutMs: number;
  maxOutputTokens: number;
  structuredOutput: 'json-schema' | 'json-object';
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  source: 'provider';
  cost: 'unknown';
}

export interface ModelReply { text: string; model: string; usage?: ModelUsage }
export interface ModelRequest {
  id: string;
  model: string;
  prompt: string;
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelProvider {
  detect(): Promise<{ available: boolean; detail: string }>;
  health(): Promise<{ available: boolean; detail: string }>;
  listModels(): Promise<string[]>;
  generate(req: ModelRequest): Promise<ModelReply>;
  stream(req: ModelRequest, onDelta: (text: string) => void): Promise<ModelReply>;
  cancel(id: string): void;
  getUsage(id: string): ModelUsage | undefined;
}
