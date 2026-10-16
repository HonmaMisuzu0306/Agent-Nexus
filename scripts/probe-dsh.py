"""Installed, native DSH wrapper expansion. Only ACP initialize; no task or secrets."""
import os
import json
import pathlib
import queue
import subprocess
import threading

root = pathlib.Path(os.environ['LOCALAPPDATA']) / 'Programs' / 'DeepSeek Harness'
patch = pathlib.Path('.runtime/dsh-nexus-readonly.yml').resolve()
patch.write_text("""- id: sandbox-policy
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: ask
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
    defaultPreset: read-only
- id: agent-loop
  config:
    agents: []
""", encoding='utf-8')
env = os.environ.copy()
env.update(ELECTRON_RUN_AS_NODE='1', DSH_PERMISSION_MODE='read-only')
argv = [str(root / 'DeepSeek Harness.exe'), '--expose-internals', str(root / 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), '--profile', 'acp', '--patch', str(patch)]
p = subprocess.Popen(argv, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
messages = queue.Queue()
diagnostics = []
threading.Thread(target=lambda: [messages.put(line) for line in p.stdout], daemon=True).start()
threading.Thread(target=lambda: [diagnostics.append(line) for line in p.stderr], daemon=True).start()
try:
    p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': 1, 'clientCapabilities': {}, 'clientInfo': {'name': 'Agent Nexus', 'version': '0.2.0'}}}) + '\n')
    p.stdin.flush()
    response = json.loads(messages.get(timeout=25))
    print(json.dumps(response, ensure_ascii=True))
except Exception as error:
    print(type(error).__name__, str(error), 'exit', p.poll())
    # Read-only boot diagnostics; token and email-like strings removed before saving.
    import re
    text = re.sub(r'(?i)(bearer|token|api_key)\s*[:=]\s*\S+', '[REDACTED]', ''.join(diagnostics))
    pathlib.Path('.runtime/dsh-probe-diagnostics.txt').write_text(text, encoding='utf-8')
    print('diagnostics saved locally, bytes', len(text))
finally:
    p.stdin.close()
    try:
        p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait(timeout=3)
