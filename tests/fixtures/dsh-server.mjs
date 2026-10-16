import { createInterface } from 'node:readline';
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let pending;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); const reply = result => write({ id: m.id, result });
  if (m.method === 'initialize') reply({ protocolVersion: 1, agentInfo: { name: 'deepseek-harness-acp' }, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [] });
  else if (m.method === 'session/new') reply({ sessionId: 'fixture-dsh-session', configOptions: [{ id: 'model', currentValue: 'fixture-dsh' }] });
  else if (m.method === 'session/resume') reply({ configOptions: [{ id: 'model', currentValue: 'fixture-dsh' }] });
  else if (m.method === 'session/close') reply({});
  else if (m.method === 'session/prompt') {
    const text = m.params.prompt[0].text;
    if (text === 'exit') process.exit(0);
    if (text === 'wait') { pending = m; return; }
    if (text === 'permission') {
      pending = m; write({ id: 'permission-1', method: 'session/request_permission', params: { sessionId: m.params.sessionId, toolCall: { toolCallId: 'opaque-tool' }, options: [{ optionId: 'allow-once', kind: 'allow_once' }] } }); return;
    }
    write({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DSH 真实中文' } } } });
    reply({ stopReason: text === 'fail' ? 'refusal' : 'end_turn' });
  } else if (m.method === 'session/cancel') write({ id: pending.id, result: { stopReason: 'cancelled' } });
  else if (m.id === 'permission-1') {
    if (m.result.outcome.outcome !== 'cancelled') process.exit(2);
    write({ id: pending.id, result: { stopReason: 'refusal' } });
  }
});
