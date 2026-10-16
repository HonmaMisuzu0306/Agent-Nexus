import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../packages/persistence';
import { NexusService } from '../apps/desktop/src/main/service';
it('retains manual results on restart without marking any native task completed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'Nexus manual 中文 ')); const db = join(root, 'db.sqlite'); let repo = await Repository.open(db); let service = new NexusService(repo);
  try {
    const project = await service.call('project.add', { name: 'manual', rootPath: root });
    const handoff = await service.call('handoff.prepare', { projectId: project.id, provider: 'workbuddy', prompt: 'Prepare an office report' });
    expect(await service.call('handoff.copy', { handoffId: handoff.id })).toContain(root);
    await service.call('handoff.import', { handoffId: handoff.id, result: 'User-reported result' });
    expect(repo.tasks(project.id)).toHaveLength(0); expect(repo.activeTasks()).toHaveLength(0);
    await service.dispose(); repo.close(); repo = await Repository.open(db); service = new NexusService(repo);
    const restored = await service.call('handoffs.list', { projectId: project.id, provider: 'workbuddy' });
    expect(restored[0]).toMatchObject({ result: 'User-reported result', source: 'manual', status: 'imported' });
    await expect(service.call('handoff.prepare', { projectId: project.id, provider: 'codex', prompt: 'unexpected' })).rejects.toThrow();
  } finally { await service.dispose(); repo.close(); rmSync(root, { recursive: true, force: true }); }
});
