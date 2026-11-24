import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

// CLI overrides stay outside the project and never contain credentials.
export function codexProviderArgs(provider) {
  if (!['openai', 'openrouter'].includes(provider)) throw new Error('مزوّد Codex غير مدعوم');
  const settings = [`model_provider="${provider}"`];
  if (provider === 'openrouter') settings.push(
    'model_providers.openrouter.name="OpenRouter"',
    'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
    'model_providers.openrouter.wire_api="responses"',
    'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
    'model_providers.openrouter.requires_openai_auth=false',
  );
  return settings.flatMap(value => ['-c', value]);
}

export async function runCodex(config, { send, approve, signal }, {
  spawnAgent = spawn, removeAuth = rm, binary = '/opt/sowalif-agent/node_modules/.bin/codex',
  workspace = '/workspace', home = '/sessions/codex', timeout = 60_000,
} = {}) {
  const provider = config.provider || 'openai';
  const args = ['app-server', ...codexProviderArgs(provider)];
  const key = String(config.key || '');
  const model = String(config.model || '').trim();
  if (!key) throw new Error(`أدخل مفتاح ${provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} قبل تشغيل Codex`);
  if (provider === 'openrouter' && !/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error('اختر معرّف نموذج OpenRouter الكامل، مثل openai/gpt-5.3-codex');
  if (signal?.aborted) throw new Error('تم الإيقاف');
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  if (provider === 'openrouter') env.OPENROUTER_API_KEY = key;
  const child = spawnAgent(binary, args, {
    cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let id = 0;
  let finish;
  let fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const redact = value => String(value || '').replaceAll(key, '[key]').slice(0, 12000);
  const write = message => child.stdin.write(JSON.stringify(message) + '\n');
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`Codex: ${method} timed out`)); }, timeout);
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
    // An OpenRouter key belongs only to its custom provider, never OpenAI login.
    if (provider === 'openai') await rpc('account/login/start', { type: 'apiKey', apiKey: key });
    const options = { cwd: workspace, modelProvider: provider, approvalPolicy: 'on-request', ...(model ? { model } : {}) };
    const thread = await rpc(config.sessionId ? 'thread/resume' : 'thread/start', config.sessionId ? { ...options, threadId: config.sessionId } : options);
    if ((thread.modelProvider && thread.modelProvider !== provider) || (thread.thread.modelProvider && thread.thread.modelProvider !== provider)) throw new Error('تعذر تأكيد مزوّد Codex المختار؛ أعد ربط المحرك');
    threadId = thread.thread.id;
    send('session', { id: threadId, model: model || 'Codex' });
    const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: config.prompt }], sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' } });
    turnId = turn.turn.id;
    await done;
  } finally {
    signal?.removeEventListener('abort', cancel);
    child.kill('SIGTERM');
    lines.close();
    for (const waiter of pending.values()) waiter.reject(new Error('Closed'));
    // Keep conversation history, remove the API key file created by login/start.
    if (provider === 'openai') await removeAuth(join(home, 'auth.json'), { force: true }).catch(() => {});
  }
}
