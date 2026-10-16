import { createInterface } from 'node:readline';
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => output({ method, params });
let thread = 0; let turn = 0; let current; let approval;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const reply = result => output({ id: m.id, result });
  if (m.method === 'initialize') reply({ userAgent: 'fixture' });
  else if (m.method === 'account/read') reply({ account: { type: 'chatgpt', email: 'private@fixture.invalid' }, requiresOpenaiAuth: true });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') reply({ thread: { id: m.params.threadId ?? `thread-${++thread}` }, model: 'fixture-model', cwd: m.params.cwd, sandbox: { type: m.params.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
  else if (m.method === 'turn/start') {
    current = { threadId: m.params.threadId, turn: { id: `turn-${++turn}`, status: 'inProgress' } };
    notify('turn/started', current); reply({ turn: current.turn });
    const prompt = m.params.input[0].text;
    if (prompt === 'exit') { process.exit(0); }
    else if (prompt === 'approval') {
      approval = current;
      output({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: current.threadId, turnId: current.turn.id, itemId: 'command-1', command: 'echo fixture', cwd: m.params.cwd, reason: 'fixture approval' } });
    } else if (prompt !== 'wait') {
      // Split a multi-byte UTF-8 character between stdout chunks.
      const delta = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: current.threadId, turnId: current.turn.id, itemId: 'message-1', delta: '真实中文输出' } }) + '\n');
      const split = delta.indexOf(Buffer.from('中')) + 1;
      process.stdout.write(delta.subarray(0, split));
      setTimeout(() => {
        process.stdout.write(delta.subarray(split));
        notify('thread/tokenUsage/updated', { threadId: current.threadId, turnId: current.turn.id, tokenUsage: { total: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } } });
        notify('turn/completed', { ...current, turn: { ...current.turn, status: prompt === 'fail' ? 'failed' : 'completed', error: prompt === 'fail' ? { message: 'fixture error' } : null } });
      }, 10);
    }
  } else if (m.method === 'turn/interrupt') { reply({}); notify('turn/completed', { ...current, turn: { ...current.turn, status: 'interrupted' } }); }
  else if (m.id === 'approval-1' && m.result) {
    if (process.env.NEXUS_FIXTURE_DECISION) writeFileSync(process.env.NEXUS_FIXTURE_DECISION, m.result.decision);
    notify('turn/completed', { ...approval, turn: { ...approval.turn, status: m.result.decision === 'accept' ? 'completed' : 'failed' } });
  }
});
