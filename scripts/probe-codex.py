"""Read-only local App Server handshake; never reads or prints authentication tokens."""
import json
import queue
import shutil
import subprocess
import threading

executable = shutil.which('codex')
if not executable:
    raise SystemExit('Codex not installed')
process = subprocess.Popen([executable, 'app-server', '--listen', 'stdio://'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1)
messages = queue.Queue()
threading.Thread(target=lambda: [messages.put(line) for line in process.stdout], daemon=True).start()
threading.Thread(target=lambda: [None for _ in process.stderr], daemon=True).start()

def request(identifier, method, params):
    process.stdin.write(json.dumps({'id': identifier, 'method': method, 'params': params}) + '\n')
    process.stdin.flush()
    while True:
        message = json.loads(messages.get(timeout=15))
        if message.get('id') == identifier:
            if 'error' in message:
                raise RuntimeError(message['error']['message'])
            return message['result']

try:
    initialization = request(1, 'initialize', {'clientInfo': {'name': 'agent_nexus', 'title': 'Agent Nexus', 'version': '0.2.0'}, 'capabilities': None})
    process.stdin.write('{"method":"initialized"}\n')
    process.stdin.flush()
    auth = request(2, 'account/read', {'refreshToken': False})
    models = request(3, 'model/list', {'limit': 10})
    print(json.dumps({'initialized': True, 'server': initialization.get('userAgent'), 'authType': (auth.get('account') or {}).get('type'), 'requiresOpenaiAuth': auth.get('requiresOpenaiAuth'), 'models': [{'id': m.get('id'), 'default': m.get('isDefault')} for m in models.get('data', [])]}, ensure_ascii=True))
finally:
    process.stdin.close()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)
