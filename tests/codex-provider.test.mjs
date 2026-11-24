import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runCodex } from '../server/local-agent/codex.mjs';

const key = 'sk-or-fake-codex-test-secret';
const model = 'openai/gpt-5.3-codex';

function fixture(handle, { config, approve = async () => false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const requests = [];
  const events = [];
  const removed = [];
  let launched;
  const send = record => child.stdout.write(JSON.stringify(record) + '\n');
  const rpc = createInterface({ input: child.stdin });
  rpc.on('line', line => {
    const message = JSON.parse(line);
    requests.push(message);
    if (message.method === 'initialize' || message.method === 'account/login/start') send({ id: message.id, result: {} });
    else handle(message, send);
  });
  child.kill = reason => { child.killed = reason; rpc.close(); };
  const run = runCodex({ provider: 'openrouter', model, key, prompt: 'عدّل المشروع', ...config }, {
    send: (type, payload) => events.push({ type, ...payload }), approve,
  }, {
    timeout: 500,
    spawnAgent: (binary, args, options) => { launched = { binary, args, options }; return child; },
    removeAuth: async (...args) => { removed.push(args); },
  });
  return { run, child, requests, events, removed, launched: () => launched };
}

function finish(message, send, provider = 'openrouter') {
  if (['thread/start', 'thread/resume'].includes(message.method)) send({ id: message.id, result: { modelProvider: provider, thread: { id: 'codex-thread', modelProvider: provider } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
}

test('Codex routes OpenRouter through Responses with its key only in the provider environment', async () => {
  let asked;
  const f = fixture((message, send) => {
    if (message.method === 'turn/start') {
      assert.equal(message.params.input[0].text, 'عدّل المشروع');
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: 'اختبار التعديل' } });
    } else if (message.id === 'approval') {
      assert.deepEqual(message.result, { decision: 'accept' });
      send({ method: 'item/agentMessage/delta', params: { delta: `جاهز ${key}` } });
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    } else finish(message, send);
  }, { approve: async (engine, request) => { asked = { engine, request }; return true; } });
  await f.run;
  const { args, options } = f.launched();
  const overrides = args.filter((_, index) => index > 0 && args[index - 1] === '-c');
  assert.ok(overrides.includes('model_provider="openrouter"'));
  assert.ok(overrides.includes('model_providers.openrouter.base_url="https://openrouter.ai/api/v1"'));
  assert.ok(overrides.includes('model_providers.openrouter.wire_api="responses"'));
  assert.ok(overrides.includes('model_providers.openrouter.env_key="OPENROUTER_API_KEY"'));
  assert.ok(overrides.includes('model_providers.openrouter.requires_openai_auth=false'));
  assert.equal(args.join(' ').includes(key), false);
  assert.equal(options.env.OPENROUTER_API_KEY, key);
  assert.equal(Object.hasOwn(options.env, 'OPENAI_API_KEY'), false);
  assert.equal(options.cwd, '/workspace');
  assert.equal(options.env.CODEX_HOME, '/sessions/codex');
  assert.equal(f.requests.some(request => request.method === 'account/login/start'), false);
  assert.equal(JSON.stringify(f.requests).includes(key), false);
  assert.equal(f.requests.find(request => request.method === 'thread/start').params.modelProvider, 'openrouter');
  assert.equal(f.requests.find(request => request.method === 'thread/start').params.model, model);
  assert.equal(asked.engine, 'Codex');
  assert.equal(asked.request.command, 'npm test');
  assert.equal(f.events.find(event => event.type === 'delta').text, 'جاهز [key]');
  assert.deepEqual(f.events.at(-1), { type: 'result', sessionId: 'codex-thread' });
  assert.equal(f.removed.length, 0);
  assert.equal(f.child.killed, 'SIGTERM');
});

test('Codex retains OpenAI login and removes its persisted API-key file', async () => {
  const f = fixture((message, send) => finish(message, send, 'openai'), { config: { provider: undefined, model: 'gpt-5.3-codex' } });
  await f.run;
  assert.deepEqual(f.requests.find(request => request.method === 'account/login/start').params, { type: 'apiKey', apiKey: key });
  assert.equal(f.requests.find(request => request.method === 'thread/start').params.modelProvider, 'openai');
  assert.deepEqual(f.launched().args, ['app-server', '-c', 'model_provider="openai"']);
  assert.equal(Object.hasOwn(f.launched().options.env, 'OPENROUTER_API_KEY'), false);
  assert.equal(f.launched().args.join(' ').includes(key), false);
  assert.equal(f.removed.length, 1);
  assert.match(f.removed[0][0], /[/\\]sessions[/\\]codex[/\\]auth\.json$/);
  assert.deepEqual(f.removed[0][1], { force: true });
});

test('Codex resumes the existing OpenRouter session with the requested provider and full model id', async () => {
  const f = fixture(finish, { config: { sessionId: 'saved-openrouter-thread' } });
  await f.run;
  const resume = f.requests.find(request => request.method === 'thread/resume');
  assert.deepEqual(resume.params, { threadId: 'saved-openrouter-thread', cwd: '/workspace', modelProvider: 'openrouter', model, approvalPolicy: 'on-request' });
  assert.equal(f.requests.some(request => request.method === 'thread/start'), false);
});

test('Codex reports a rejected OpenRouter model without switching provider or exposing its key', async () => {
  const f = fixture((message, send) => {
    if (message.method === 'thread/start') send({ id: message.id, error: { code: -32600, message: `Model unavailable for ${key}` } });
  });
  await assert.rejects(f.run, error => error.message === 'Model unavailable for [key]');
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
  assert.equal(f.requests.some(request => request.method === 'account/login/start'), false);
  assert.equal(f.events.some(event => event.type === 'result'), false);
  assert.equal(f.child.killed, 'SIGTERM');
});

test('Codex stops before a model call when a resumed session has the wrong provider', async () => {
  const f = fixture((message, send) => finish(message, send, 'openai'), { config: { sessionId: 'wrong-provider-thread' } });
  await assert.rejects(f.run, /تعذر تأكيد مزوّد/);
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
});

test('Codex validates provider, key and full OpenRouter model before starting a process', async () => {
  let launched = 0;
  const spawnAgent = () => { launched++; throw new Error('must not start'); };
  const handlers = { send() {}, approve() {} };
  await assert.rejects(runCodex({ provider: 'unknown', key, model }, handlers, { spawnAgent }), /غير مدعوم/);
  await assert.rejects(runCodex({ provider: 'openrouter', model }, handlers, { spawnAgent }), /مفتاح OpenRouter/);
  await assert.rejects(runCodex({ provider: 'openrouter', key, model: 'gpt-5.3-codex' }, handlers, { spawnAgent }), /الكامل/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCodex({ provider: 'openrouter', key, model }, { ...handlers, signal: controller.signal }, { spawnAgent }), /الإيقاف/);
  assert.equal(launched, 0);
});
