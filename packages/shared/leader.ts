import { z } from 'zod';
import type { WorkspaceRecord, WorkspaceSnapshot, MergePreview } from '../git-workspace';
import type { MeetingState } from '../orchestrator/meeting';
import { reasoningSchema, type ModelReasoning } from './models';
import { providers } from './constants';
import type { Provider } from './index';

const id = z.string().min(1).max(100);
const provider = z.enum(providers);
const nodeSchema = z.object({ taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), title: z.string().min(1).max(200), instruction: z.string().min(1).max(6000), assignedAgentId: provider, dependsOn: z.array(z.string().min(1).max(64)).max(10), acceptance: z.array(z.string().min(1).max(500)).min(1).max(8), needsWriteAccess: z.boolean(), paths: z.array(z.string().min(1).max(1024)).max(20).default([]) }).strict();
export const planSchema = z.object({ runId: id, revision: z.number().int().min(1), goal: z.string().min(1).max(8000), tasks: z.array(nodeSchema).min(1).max(10) }).strict();
export const actionSchema = z.object({ actionId: id, runId: id, expectedRevision: z.number().int().min(1), type: z.enum(['assign_task', 'request_review', 'request_retry', 'mark_blocked', 'finish_run']), taskId: z.string().min(1).max(64).optional(), agentId: provider.optional(), reason: z.string().min(1).max(1000) }).strict();
export const reviewSchema = z.object({ runId: id, revision: z.number().int().min(1), verdict: z.enum(['passed', 'needs_changes', 'blocked']), summary: z.string().min(1).max(6000), unmet: z.array(z.string().max(500)).max(20) }).strict();
export type LeaderPlan = z.infer<typeof planSchema>;
export type DispatchAction = z.infer<typeof actionSchema>;
export type LeaderReview = z.infer<typeof reviewSchema>;
export type RunStatus = 'draft' | 'awaiting_plan_approval' | 'running' | 'paused' | 'waiting_approval' | 'stopping' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'interrupted';
export const activeRunStatuses: RunStatus[] = ['draft', 'awaiting_plan_approval', 'running', 'paused', 'waiting_approval', 'stopping'];
export interface WorkerResult { runId: string; taskId: string; agentId: Provider; source: 'real' | 'mock'; outcome: 'success' | 'failed' | 'cancelled' | 'blocked'; summary: string; summaryTruncated?: boolean; artifacts: { path: string; kind: string }[]; tests: { name: string; outcome: string; evidence?: string }[]; rawEventRefs: string[]; providerTaskId: string; attempt?: number }
export const nodeReviewSchema = z.object({ runId: id, revision: z.number().int().min(1), taskId: id, attempt: z.number().int().min(1).max(3), verdict: z.enum(['passed','needs_changes','blocked']), summary: z.string().min(1).max(6000), unmet: z.array(z.string().min(1).max(1000)).max(8) }).strict();
export type NodeReview = z.infer<typeof nodeReviewSchema>;
export const teamSchema = z.object({ concurrency: z.number().int().min(1).max(2).default(2), reviewer: z.enum(providers), maxReworks: z.number().int().min(0).max(2).default(2), maxDispatches: z.number().int().min(1).max(20).default(20) }).strict();
export const meetingConfigSchema = z.object({ topic: z.string().trim().min(1).max(4000), participants: z.array(z.enum(providers)).min(2).max(3).refine(a=>new Set(a).size===a.length), rounds: z.number().int().min(1).max(3).default(1) }).strict();
export type TeamSettings = z.infer<typeof teamSchema>;
export interface AttemptRecord { attempt: number; result?: WorkerResult; review?: NodeReview; reviewTaskId?: string; reviewEventRefs?: string[]; diff?: WorkspaceSnapshot }
export interface LeaderNode extends z.infer<typeof nodeSchema> { runId: string; status: 'pending' | 'assigned' | 'running' | 'waiting_approval' | 'awaiting_review' | 'reviewing' | 'rework_pending' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'interrupted'; attempt: number; providerTaskId?: string; result?: WorkerResult; review?: NodeReview; reviewTaskId?: string; history?: AttemptRecord[]; workspace?: WorkspaceRecord; diff?: WorkspaceSnapshot }
export interface LeaderRun { id: string; projectId: string; rootPath: string; goal: string; leader: Provider; workers: Provider[]; mode: 'real' | 'mock'; control: 'manual' | 'supervised' | 'bounded-auto'; allowWrites: boolean; status: RunStatus; phase: 'meeting' | 'planning' | 'workers' | 'reviewing'; planRevision: number; planApproved: boolean; plannerAttempts: number; stepTimeoutMs: number; deadline: number; createdAt: string; updatedAt: string; currentTaskId?: string; currentNodeId?: string; reason?: string; review?: LeaderReview; report?: string; team?: TeamSettings; nativeCalls?: number; dispatches?: number; activeTaskIds?: string[]; meetingId?: string; handoffId?: string; reasoning?: ModelReasoning }
export interface RunEvent { id: string; runId: string; sequence: number; type: string; text: string; timestamp: string; source: 'orchestrator' | 'user'; taskId?: string }
export interface ActionRecord { action: DispatchAction; result: { ok: boolean; reason?: string; pending?: boolean }; createdAt: string }
export interface PlanApproval { id: string; runId: string; revision: number; status: 'pending' | 'approved' | 'rejected' | 'expired'; createdAt: string; reviewedAt?: string }
export interface LeaderTransfer { id: string; runId: string; from: Provider; to: Provider; revision: number; reason: string; summary: string; references: string[]; createdAt: string }
export interface WorkspaceMerge { id: string; runId: string; hash: string; status: 'requested' | 'applied' | 'failed'; preview: MergePreview; reason?: string; createdAt: string }
export interface LeaderView { run: LeaderRun; plan?: LeaderPlan; tasks: LeaderNode[]; approvals: PlanApproval[]; events: RunEvent[]; meeting?: MeetingState; handoffs?: LeaderTransfer[]; merges?: WorkspaceMerge[] }
export const leaderRequests = {
  'leader.start': z.object({ projectId: id, goal: z.string().trim().min(1).max(8000), leader: provider, workers: z.array(provider).min(1).max(4).refine(a => new Set(a).size === a.length), mode: z.enum(['real', 'mock']).default('real'), control: z.enum(['manual', 'supervised','bounded-auto']).default('supervised'), allowWrites: z.boolean().default(false), stepTimeoutMs: z.number().int().min(10_000).max(300_000).default(180_000), initialTasks: planSchema.shape.tasks.optional(), team: teamSchema.optional(), meeting: meetingConfigSchema.optional(), reasoning: reasoningSchema.optional() }).strict().refine(a=>!!a.team || !a.meeting && a.control !== 'bounded-auto', '会议和 Bounded Auto 需要 M3.5 团队模式').refine(a=>!a.reasoning || !!a.team && a.mode==='real', 'Model Provider 推理需要真实团队模式').refine(a=>!a.initialTasks || !a.meeting, '工作流草案不能同时启动规划会议'),
  'leader.plan.update': z.object({ runId: id, expectedRevision: z.number().int().min(1), tasks: planSchema.shape.tasks }).strict(),
  'leader.list': z.object({ projectId: id, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  'leader.get': z.object({ runId: id }).strict(),
  'leader.approve': z.object({ runId: id, expectedRevision: z.number().int().min(1), decision: z.enum(['approve', 'reject']) }).strict(),
  'leader.action': actionSchema,
  'leader.pause': z.object({ runId: id }).strict(),
  'leader.resume': z.object({ runId: id }).strict(),
  'leader.stop': z.object({ runId: id }).strict(),
  'leader.events': z.object({ runId: id, after: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50), query: z.string().max(200).optional() }).strict(),
  'leader.handoff': z.object({ runId: id, expectedRevision: z.number().int().min(1), leader: provider, reason: z.string().trim().min(1).max(1000) }).strict(),
  'leader.recover': z.object({ runId: id, expectedRevision: z.number().int().min(0), acknowledged: z.literal(true) }).strict(),
  'leader.pauseAll': z.object({}).strict(),
  'leader.merge.preview': z.object({ runId: id }).strict(),
  'leader.merge.apply': z.object({ runId: id, expectedHash: z.string().min(1).max(100), acknowledged: z.literal(true) }).strict()
};
