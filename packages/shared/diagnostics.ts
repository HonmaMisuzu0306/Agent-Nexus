export interface DiagnosticReport {
  formatVersion: 1; applicationVersion: string; exportedAt: string; schemaVersion: number;
  projectCount: number; taskCount: number; eventCount: number; runCount: number; interruptedTasks: number; workflowCount: number;
}
