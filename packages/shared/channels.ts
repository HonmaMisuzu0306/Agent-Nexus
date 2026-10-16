// Dependency-free allowlist: sandboxed preload can only require Electron APIs.
export const channels = [
  'workflow.list', 'workflow.save', 'workflow.remove', 'leader.plan.update',
  'history.search', 'diagnostics.get', 'diagnostics.export', 'snapshot.get', 'project.pick', 'project.add', 'project.create', 'project.remove',
  'models.list', 'models.save', 'models.remove', 'models.health', 'models.generate', 'models.cancel', 'models.calls',
  'settings.set', 'agents.detect', 'tasks.list', 'task.start', 'task.cancel', 'tasks.stopAll', 'events.list', 'events.tail', 'approvals.list', 'approval.respond',
  'handoff.prepare', 'handoffs.list', 'handoff.import', 'handoff.copy', 'provider.open',
  'workbuddy.enable', 'workbuddy.status', 'workbuddy.revoke', 'workbuddy.config.copy', 'workbuddy.bootstrap.copy',
  'leader.start', 'leader.list', 'leader.get', 'leader.approve', 'leader.action', 'leader.pause', 'leader.resume', 'leader.stop', 'leader.events', 'leader.handoff', 'leader.recover', 'leader.pauseAll', 'leader.merge.preview', 'leader.merge.apply'
] as const;
export type Channel = typeof channels[number];
