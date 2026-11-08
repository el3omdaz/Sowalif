// Offline protocol check against the real pinned Codex binary; no model call.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const binary = '/opt/sowalif-agent/node_modules/.bin/codex';
execFileSync(binary, ['app-server', 'generate-json-schema', '--out', '/tmp/codex-schema']);
const names = await readdir('/tmp/codex-schema');
assert.ok(names.length);
const schemas = (await Promise.all(names.filter(n => n.endsWith('.json')).map(n => readFile('/tmp/codex-schema/' + n, 'utf8')))).join('\n');
assert.match(schemas, /externalSandbox/);
assert.match(schemas, /networkAccess/);
await mkdir('/sessions/codex', { recursive: true });
const child = spawn(binary, ['app-server'], { cwd: '/workspace', env: { ...process.env, CODEX_HOME: '/sessions/codex' }, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let id = 0;
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  const callback = pending.get(message.id);
  if (message.error) callback?.reject(new Error(message.error.message));
  else callback?.resolve(message.result);
});
child.stderr.resume();
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => reject(new Error('Protocol timeout: ' + method)), 20000);
    pending.set(next, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ id: next, method, params }) + '\n');
  });
}
try {
  await rpc('initialize', { clientInfo: { name: 'sowalif', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  await rpc('account/login/start', { type: 'apiKey', apiKey: 'sk-offline-smoke-not-real' });
  const result = await rpc('thread/start', { cwd: '/workspace', approvalPolicy: 'on-request' });
  assert.ok(result.thread.id);
  console.log('CODEX_PROTOCOL_SMOKE_OK: initialize, API-key login, thread/start and sandbox schema verified; no model request.');
} finally { child.kill(); lines.close(); }
