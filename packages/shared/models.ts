import { z } from 'zod';
import type { ModelConfig, ModelUsage } from '../model-core/types';

const configId=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const modelConfigSchema=z.object({id:configId,name:z.string().trim().min(1).max(100),kind:z.enum(['openai','ollama']),baseUrl:z.string().trim().min(1).max(1024),scope:z.enum(['local','external']),timeoutMs:z.number().int().min(1000).max(180000).default(60000),maxOutputTokens:z.number().int().min(128).max(8192).default(4096),structuredOutput:z.enum(['json-schema','json-object']).default('json-schema')}).strict();
export const modelSelectionSchema=z.object({providerId:configId,model:z.string().trim().min(1).max(200)}).strict();
export const reasoningSchema=z.object({primary:modelSelectionSchema,fallback:modelSelectionSchema.optional(),externalAcknowledged:z.boolean().default(false)}).strict();
export type ModelSelection=z.infer<typeof modelSelectionSchema>;
export type ModelReasoning=z.infer<typeof reasoningSchema>;
export interface StoredModelConfig extends ModelConfig {createdAt:string;updatedAt:string}
export interface ModelConfigView extends StoredModelConfig {hasSecret:boolean}
export interface ModelHealth {available:boolean;detail:string;models:string[]}
export interface ModelCall {id:string;runId?:string;providerId:string;model:string;status:'running'|'completed'|'failed'|'cancelled'|'interrupted';purpose:string;scope:'local'|'external';endpoint:string;createdAt:string;finishedAt?:string;requestHash:string;text:string;usage?:ModelUsage;error?:string;fallbackOf?:string}
export const modelRequests={
  'models.list':z.object({}).strict(),
  'models.save':z.object({config:modelConfigSchema,apiKey:z.string().trim().min(1).max(4096).refine(s=>!/[\r\n]/.test(s)).optional(),clearSecret:z.boolean().default(false)}).strict().refine(a=>!(a.apiKey&&a.clearSecret),'不能同时设置和清除凭证'),
  'models.remove':z.object({providerId:configId}).strict(),
  'models.health':z.object({providerId:configId}).strict(),
  'models.generate':z.object({id:z.string().uuid(),selection:modelSelectionSchema,prompt:z.string().trim().min(1).max(4000),externalAcknowledged:z.boolean().default(false)}).strict(),
  'models.cancel':z.object({id:z.string().uuid()}).strict(),
  'models.calls':z.object({runId:z.string().min(1).max(100).optional(),limit:z.number().int().min(1).max(100).default(30)}).strict()
};
