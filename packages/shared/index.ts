import type { DiagnosticReport } from './diagnostics';
import { z } from 'zod';
import { workflowRequests, type WorkflowDraft } from './workflows';
import type { Channel } from './channels';
import { providers } from './constants';
import { leaderRequests, type LeaderRun, type LeaderView, type RunEvent } from './leader';
import type { MergePreview } from '../git-workspace';
import { modelRequests, type ModelConfigView, type ModelHealth, type ModelCall } from './models';
export { providers } from './constants';
export { channels, type Channel } from './channels';

export type Provider = typeof providers[number];
export type TaskStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type Mode = 'mock' | 'real' | 'bridge';
export type Capability = 'detect' | 'sendPrompt' | 'streamEvents' | 'resumeSession' | 'cancel' | 'structuredOutput' | 'toolApproval' | 'fileChanges' | 'usage' | 'leaderEligible';
export type AgentCapabilities = Record<Capability, { supported: boolean; reason?: 'unsupported' | 'not_installed' | 'needs_auth' }>;
export interface AgentInstallation { id: Provider; executablePath: string | null; version: string | null; state: 'detected' | 'not_installed' | 'unverified'; detail: string; probeAt: string; capabilities: AgentCapabilities; auth?: 'authenticated' | 'needs_auth' | 'unknown' }
export interface Project { id: string; name: string; rootPath: string; createdAt: string; lastOpenedAt: string }
export type Sandbox = 'read-only' | 'workspace-write';
export interface AgentSession { id: string; projectId: string; provider: Provider; mode: Mode; status: 'idle' | 'running' | 'interrupted'; createdAt: string; externalSessionId?: string; rootPath?: string; sandbox?: Sandbox; model?: string }
export interface Task { id: string; projectId: string; sessionId: string; provider: Provider; prompt: string; mode: Mode; status: TaskStatus; createdAt: string; finishedAt: string | null; leaderRunId?: string; parentId?: string; sandbox?: Sandbox; model?: string }
export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number; reasoningOutputTokens?: number; cost: null; source: string }
export interface Approval { id: string; taskId: string; kind: 'command' | 'file'; command?: string; cwd?: string; reason: string; status: 'pending' | 'accept' | 'decline' | 'expired'; createdAt: string }
export interface Handoff { id: string; projectId: string; provider: 'antigravity' | 'workbuddy'; prompt: string; result: string | null; source: 'manual'; status: 'prepared' | 'imported'; createdAt: string; importedAt: string | null }
export type EventType = 'bridge.queued' | 'bridge.cancel_requested' | 'task.started' | 'message.delta' | 'tool.request' | 'tool.result' | 'approval.required' | 'approval.resolved' | 'usage' | 'file.changes' | 'task.completed' | 'task.failed' | 'task.cancelled' | 'task.interrupted';
export interface AgentEvent { eventId: string; taskId: string; agentId: Provider; sessionId: string; timestamp: string; sequence: number; type: EventType; payload: { text?: string; mock?: boolean; source?: 'mcp-client' | 'bridge'; code?: string; approval?: Approval; usage?: Usage; model?: string; native?: unknown }; rawRef?: string }
export interface Settings { theme: 'dark' | 'light'; layout: 'grid' | 'columns' | 'focus'; projectId: string | null; focusedAgent: Provider }
export interface StartSessionRequest { projectId: string; rootPath: string; sandbox?: Sandbox }
export interface SendPromptRequest { sessionId: string; prompt: string; scenario: 'success' | 'failure'; taskId?: string; outputSchema?: Record<string, unknown> }
export interface OperationResult { ok: boolean; reason?: string; pending?: boolean }
export interface WorkBuddyStatus { enabled: boolean; url?: string; connectedClients: number; lastSeenAt?: string; cancelRequested: boolean; persistence: 'encrypted' | 'session'; saved: boolean; error?: string; connectionIssue?: 'session_expired'; activeTask?: { taskId: string; status: 'queued' | 'running'; expiresAt: string; lastContactAt?: string; cancelDeadline?: string } }
export interface ServiceIssue { taskId?: string; agentId?: Provider; message: string; fatal: boolean }
export interface SessionStatus { status: AgentSession['status'] }
export interface Snapshot { projects: Project[]; settings: Settings; installations: AgentInstallation[]; activeTaskCount: number }
export interface TaskPage { tasks: Task[]; hasMore: boolean }
export interface LeaderHandoff { goal: string; planRevision: number; completedWork: string[]; pendingApprovals: string[]; references: string[]; resumeHints: string[] }

const id = z.string().min(1).max(100);
const provider = z.enum(providers);
const manualProvider = z.enum(['antigravity', 'workbuddy']);
const schemas = {
  ...leaderRequests,
  ...workflowRequests,
  ...modelRequests,
  'history.search': z.object({ projectId: id, query: z.string().max(200).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) }).strict(),
  'diagnostics.get': z.object({}).strict(), 'diagnostics.export': z.object({}).strict(),
  'snapshot.get': z.object({}).strict(),
  'project.pick': z.object({}).strict(),
  'project.add': z.object({ name: z.string().trim().min(1).max(80), rootPath: z.string().min(1).max(4096) }).strict(),
  'project.create': z.object({ name: z.string().trim().min(1).max(80).refine(v => !/[<>:"/\\|?*]/.test(v) && [...v].every(c => c.charCodeAt(0) >= 32) && !/[. ]$/.test(v) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v), '无效的文件夹名'), parentPath: z.string().min(1).max(4096) }).strict(),
  'project.remove': z.object({ projectId: id }).strict(),
  'settings.set': z.object({ theme: z.enum(['dark', 'light']).optional(), layout: z.enum(['grid', 'columns', 'focus']).optional(), projectId: id.nullable().optional(), focusedAgent: provider.optional() }).strict(),
  'agents.detect': z.object({}).strict(),
  'tasks.list': z.object({ projectId: id, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) }).strict(),
  'task.start': z.object({ projectId: id, provider, prompt: z.string().trim().min(1).max(16000), scenario: z.enum(['success', 'failure']).default('success'), mode: z.enum(['mock', 'real', 'bridge']).default('mock'), sessionId: id.optional(), sandbox: z.enum(['read-only', 'workspace-write']).optional() }).strict().refine(a => a.mode !== 'bridge' || a.provider === 'workbuddy' && !a.sandbox && !a.sessionId, '桥接只支持 WorkBuddy；权限和对话由原生客户端管理'),
  'task.cancel': z.object({ taskId: id }).strict(),
  'tasks.stopAll': z.object({}).strict(),
  'events.list': z.object({ taskId: id, query: z.string().max(200).optional(), after: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  'events.tail': z.object({ taskId: id, limit: z.number().int().min(1).max(100).default(50) }).strict(),
  'approvals.list': z.object({ taskId: id }).strict(),
  'approval.respond': z.object({ approvalId: id, decision: z.enum(['accept', 'decline']) }).strict(),
  'handoff.prepare': z.object({ projectId: id, provider: manualProvider, prompt: z.string().trim().min(1).max(16000) }).strict(),
  'handoffs.list': z.object({ projectId: id, provider: manualProvider }).strict(),
  'handoff.import': z.object({ handoffId: id, result: z.string().trim().min(1).max(100000) }).strict(),
  'handoff.copy': z.object({ handoffId: id }).strict(),
  'provider.open': z.object({ provider: manualProvider }).strict(),
  'workbuddy.enable': z.object({ projectId: id }).strict(),
  'workbuddy.status': z.object({ projectId: id }).strict(),
  'workbuddy.revoke': z.object({ projectId: id }).strict(),
  'workbuddy.config.copy': z.object({ projectId: id }).strict(),
  'workbuddy.bootstrap.copy': z.object({ projectId: id }).strict()
} satisfies Record<Channel, z.ZodType>;
export type RequestMap = { [K in Channel]: z.infer<typeof schemas[K]> };
export interface ResponseMap {
  'history.search': TaskPage; 'diagnostics.get': DiagnosticReport; 'diagnostics.export': { cancelled: boolean };
  'workflow.list': WorkflowDraft[]; 'workflow.save': WorkflowDraft; 'workflow.remove': OperationResult; 'leader.plan.update': LeaderView;
  'models.list':ModelConfigView[]; 'models.save':ModelConfigView; 'models.remove':OperationResult; 'models.health':ModelHealth; 'models.generate':ModelCall; 'models.cancel':OperationResult; 'models.calls':ModelCall[];
  'leader.handoff': OperationResult; 'leader.recover': OperationResult; 'leader.pauseAll': OperationResult; 'leader.merge.preview': MergePreview; 'leader.merge.apply': MergePreview;
  'leader.start': LeaderRun; 'leader.list': LeaderRun[]; 'leader.get': LeaderView; 'leader.approve': OperationResult; 'leader.action': OperationResult; 'leader.pause': OperationResult; 'leader.resume': OperationResult; 'leader.stop': OperationResult; 'leader.events': RunEvent[];
  'snapshot.get': Snapshot; 'project.pick': string | null; 'project.add': Project; 'project.create': Project;
  'project.remove': OperationResult; 'settings.set': Settings; 'agents.detect': AgentInstallation[];
  'tasks.list': TaskPage; 'task.start': Task; 'task.cancel': OperationResult; 'tasks.stopAll': OperationResult; 'events.list': AgentEvent[]; 'events.tail': AgentEvent[]; 'approvals.list': Approval[]; 'approval.respond': OperationResult;
  'handoff.prepare': Handoff; 'handoffs.list': Handoff[]; 'handoff.import': Handoff; 'handoff.copy': string; 'provider.open': OperationResult;
  'workbuddy.enable': WorkBuddyStatus; 'workbuddy.status': WorkBuddyStatus; 'workbuddy.revoke': OperationResult; 'workbuddy.config.copy': string; 'workbuddy.bootstrap.copy': string;
}
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
export interface NexusBridge {
  call<K extends Channel>(channel: K, args: RequestMap[K]): Promise<Reply<ResponseMap[K]>>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  onIssue(handler: (issue: ServiceIssue) => void): () => void;
}
export function parseRequest<K extends Channel>(channel: K, args: unknown): RequestMap[K] {
  const schema = schemas[channel];
  if (!schema) throw new Error('unsupported IPC channel');
  return schema.parse(args) as RequestMap[K];
}
export const activeStatuses: TaskStatus[] = ['queued', 'running', 'waiting_approval'];
export function transition(from: TaskStatus, to: TaskStatus): TaskStatus {
  const allowed: Partial<Record<TaskStatus, TaskStatus[]>> = {
    queued: ['running', 'cancelled', 'interrupted', 'failed'],
    running: ['completed', 'failed', 'cancelled', 'interrupted', 'waiting_approval'],
    waiting_approval: ['running', 'completed', 'failed', 'cancelled', 'interrupted']
  };
  if (!allowed[from]?.includes(to)) throw new Error(`Invalid transition: ${from} → ${to}`);
  return to;
}
