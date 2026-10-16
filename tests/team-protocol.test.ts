import { expect, it } from 'vitest';
import { parseRequest } from '../packages/shared';
it('accepts bounded M3.5 settings and rejects excess concurrency, rounds and permission-like fields', () => {
  const input = { projectId: 'p', goal: 'G', leader: 'codex', workers: ['codex','dsh'], control: 'bounded-auto', team: { concurrency: 2, reviewer: 'dsh', maxReworks: 2, maxDispatches: 20 } };
  expect(parseRequest('leader.start', input)).toMatchObject(input);
  expect(() => parseRequest('leader.start', { ...input, team: { ...input.team, concurrency: 3 } })).toThrow();
  expect(() => parseRequest('leader.start', { ...input, team: { ...input.team, maxReworks: 3 } })).toThrow();
  expect(() => parseRequest('leader.start', { ...input, meeting: { topic: 'G', participants: ['codex','dsh'], rounds: 4 } })).toThrow();
  expect(() => parseRequest('leader.start', { ...input, team: { ...input.team, shell: true } })).toThrow();
});
