import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { rm } from 'node:fs/promises';

export async function runCodex(config, { send, approve, signal }) {
  const child = spawn('/opt/sowalif-agent/node_modules/.bin/codex', ['app-server'], {
    cwd: '/workspace', env: { ...process.env, CODEX_HOME: '/sessions/codex' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let id = 0;
  let finish;
  let fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const redact = value => String(value || '').replaceAll(config.key || '\0', '[key]').slice(0, 12000);
  const write = message => child.stdin.write(JSON.stringify(message) + '\n');
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`Codex: ${method} timed out`)); }, 60_000);
    pending.set(next, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } });
    write({ id: next, method, params });
  });
  let threadId;
  let turnId;
  const cancel = () => { if (threadId && turnId) rpc('turn/interrupt', { threadId, turnId }).catch(() => {}); child.kill('SIGTERM'); };
  signal?.addEventListener('abort', cancel, { once: true });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', async line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && !message.method) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(redact(message.error.message)));
      else waiter?.resolve(message.result);
      return;
    }
    const p = message.params || {};
    if (message.id != null) {
      let result;
      if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
        const allow = await approve('Codex', { command: p.command || 'تعديل ملفات المشروع', description: p.reason || '' });
        result = { decision: allow ? 'accept' : 'decline' };
      } else if (message.method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
      else if (message.method === 'item/tool/requestUserInput') result = { answers: {} };
      else { write({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } }); return; }
      write({ id: message.id, result });
      return;
    }
    if (message.method === 'item/agentMessage/delta') send('delta', { text: redact(p.delta) });
    if (message.method === 'item/commandExecution/outputDelta') send('tool-result', { text: redact(p.delta) });
    if (message.method === 'item/started' && ['commandExecution', 'fileChange'].includes(p.item?.type)) send('tool', { name: p.item.type, input: redact(p.item.command || JSON.stringify(p.item.changes || [])) });
    if (message.method === 'turn/completed') {
      if (p.turn?.status === 'failed') fail(new Error(redact(p.turn.error?.message || 'Codex turn failed')));
      else if (p.turn?.status === 'interrupted') fail(new Error('تم الإيقاف'));
      else { send('result', { sessionId: threadId }); finish(); }
    }
    if (message.method === 'error' && !p.willRetry) fail(new Error(redact(p.error?.message || 'Codex error')));
  });
  child.stderr.on('data', () => {}); // Do not log auth diagnostics or tokens.
  child.on('error', fail);
  child.on('exit', () => { const e = new Error('توقّف محرك Codex'); for (const waiter of pending.values()) waiter.reject(e); pending.clear(); fail(e); });
  // Consume failures even if initialization fails before awaiting done.
  done.catch(() => {});
  try {
    await rpc('initialize', { clientInfo: { name: 'sowalif', title: 'Sowalif', version: '1.0.0' } });
    write({ method: 'initialized', params: {} });
    await rpc('account/login/start', { type: 'apiKey', apiKey: config.key });
    const options = { cwd: '/workspace', approvalPolicy: 'on-request', ...(config.model ? { model: config.model } : {}) };
    const thread = await rpc(config.sessionId ? 'thread/resume' : 'thread/start', config.sessionId ? { ...options, threadId: config.sessionId } : options);
    threadId = thread.thread.id;
    send('session', { id: threadId, model: config.model || 'Codex' });
    const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: config.prompt }], sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' } });
    turnId = turn.turn.id;
    await done;
  } finally {
    signal?.removeEventListener('abort', cancel);
    child.kill('SIGTERM');
    lines.close();
    for (const waiter of pending.values()) waiter.reject(new Error('Closed'));
    // Keep conversation history, remove the API key file created by login/start.
    await rm('/sessions/codex/auth.json', { force: true }).catch(() => {});
  }
}
