// Renderer-safe values; importing these does not initialize main-process schemas.
export const appVersion = '1.0.0-beta.1';
export const providers = ['codex', 'antigravity', 'dsh', 'workbuddy'] as const;
export const activeStatuses = ['queued', 'running', 'waiting_approval'] as const;
