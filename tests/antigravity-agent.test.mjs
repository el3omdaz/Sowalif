import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runAntigravity } from '../server/local-agent/antigravity.mjs';

const key = 'gemini-mock-provider-secret';
const model = 'gemini-4-carbon-high';
const sessionId = 'antigravity-session';
const sessionModel = { id: 'model', category: 'model', currentValue: model, options: [{ value: model }] };

async function fixture(t, handle, { config, approve = async () => false, signal } = {}) {
  const base = await realpath(tmpdir());
  const home = await mkdtemp(join(base, 'sowalif-antigravity-test-'));
  t.after(async () => {
    const name = relative(base, await realpath(home));
    assert.match(name, /^sowalif-antigravity-test-[a-zA-Z0-9]+$/);
    await rm(home, { recursive: true, force: true });
  });
  const events = [];
  const requests = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const send = record => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...record }) + '\n');
  const rpc = createInterface({ input: child.stdin });
  rpc.on('line', line => {
    const message = JSON.parse(line);
    requests.push(message);
    handle(message, send);
  });
  child.kill = (reason) => { child.killed = reason; rpc.close(); };
  const run = runAntigravity({ key, prompt: 'نفّذ التطبيق', ...config }, {
    send: (type, payload) => events.push({ type, ...payload }), approve, signal,
  }, { home, timeout: 500, spawnAgent: (binary, args, options) => {
    assert.equal(binary, 'agy');
    assert.equal(args[0], 'acp');
    assert.equal(args.join(' ').includes(key), false);
    assert.equal(options.cwd, '/workspace');
    assert.equal(options.env.GEMINI_API_KEY, key);
    return child;
  } });
  return { run, events, requests, child, home };
}

const chunk = (text) => ({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });

function approval(id, command, cwd = '/workspace') {
  return { id, method: 'session/request_permission', params: { sessionId,
    toolCall: { kind: 'execute', title: 'Run tests', rawInput: { command, cwd } },
    options: [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
  } };
}

test('Antigravity picks Carbon, authenticates, and forwards only one-time approval', async t => {
  let authenticated = false;
  let promptId;
  const actedOn = [];
  const { run, events, requests, child, home } = await fixture(t, (message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1, authMethods: [{ id: 'gemini-api-key' }] } });
    if (message.method === 'session/new') {
      if (!authenticated) send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
      else send({ id: message.id, result: { sessionId, configOptions: [{ ...sessionModel, currentValue: 'another-model' }] } });
    }
    if (message.method === 'authenticate') {
      assert.equal(message.params.methodId, 'gemini-api-key');
      authenticated = true;
      send({ id: message.id, result: {} });
    }
    if (message.method === 'session/set_config_option') {
      assert.equal(message.params.value, model);
      send({ id: message.id, result: { configOptions: [sessionModel] } });
    }
    if (message.method === 'session/prompt') {
      promptId = message.id;
      assert.equal(message.params.prompt[0].text, 'نفّذ التطبيق');
      const request = approval('shell', 'npm test');
      send({ method: 'session/update', params: { sessionId, update: { ...request.params.toolCall, toolCallId: 'tool-shell', sessionUpdate: 'tool_call' } } });
      send({ ...request, params: { ...request.params, toolCall: { toolCallId: 'tool-shell' } } });
    }
    if (message.id === 'shell') {
      assert.deepEqual(message.result.outcome, { outcome: 'selected', optionId: 'once' });
      send(chunk(`نتيجة الاختبار ${key.slice(0, 10)}`));
      send(chunk(`${key.slice(10)} جاهزة`));
      send({ id: promptId, result: { stopReason: 'end_turn' } });
    }
  }, { approve: async (tool, input) => { actedOn.push([tool, input.command]); return true; } });
  await run;
  assert.equal(child.killed, 'SIGTERM');
  assert.deepEqual(actedOn, [['Antigravity', 'npm test']]);
  assert.deepEqual(events[0], { type: 'session', id: sessionId, model });
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'نتيجة الاختبار [key] جاهزة');
  assert.deepEqual(events.at(-1), { type: 'result', sessionId });
  assert.equal(requests.some(message => JSON.stringify(message).includes(key)), false);
  const settings = JSON.parse(await readFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.equal(settings.modelProvider, 'gemini');
  assert.deepEqual(settings.permissions.ask, ['command(*)']);
  assert.equal(JSON.stringify(settings).includes(key), false);
});

test('Antigravity resumes and visibly declines commands outside the project', async t => {
  let promptId;
  let asked = 0;
  const { run, events, requests } = await fixture(t, (message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
    if (message.method === 'session/resume') {
      assert.equal(message.params.sessionId, sessionId);
      send({ id: message.id, result: { configOptions: [sessionModel] } });
    }
    if (message.method === 'session/prompt') {
      promptId = message.id;
      send(approval('outside', 'npm test', '/tmp'));
    }
    if (message.id === 'outside') {
      assert.deepEqual(message.result.outcome, { outcome: 'selected', optionId: 'deny' });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
    }
  }, { config: { sessionId }, approve: async () => { asked++; return true; } });
  await run;
  assert.equal(asked, 0);
  assert.equal(requests.some(message => message.method === 'session/new'), false);
  assert.match(events.find(event => event.type === 'tool-result').text, /رفض/);
});

test('Antigravity never silently substitutes an unavailable model', async t => {
  const { run, requests } = await fixture(t, (message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1 } });
    if (message.method === 'session/new') send({ id: message.id, result: { sessionId, configOptions: [{ ...sessionModel, currentValue: 'another-model', options: [] }] } });
  });
  await assert.rejects(run, /غير متاح/);
  assert.equal(requests.some(message => message.method === 'session/prompt'), false);
});

test('Antigravity selects a grouped model and stops if its settings change', async t => {
  const carbon = { ...sessionModel, currentValue: 'gemini-4-carbon', options: [{ value: 'gemini-4-carbon' }] };
  const thinking = { id: 'thinking_level', category: 'thought_level', currentValue: 'medium', options: [{ value: 'high' }, { value: 'medium' }] };
  const { run, requests, events } = await fixture(t, (message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1 } });
    if (message.method === 'session/new') send({ id: message.id, result: { sessionId, configOptions: [carbon, thinking] } });
    if (message.method === 'session/set_config_option') {
      assert.deepEqual(message.params, { sessionId, configId: 'thinking_level', value: 'high' });
      send({ id: message.id, result: { configOptions: [carbon, { ...thinking, currentValue: 'high' }] } });
    }
    if (message.method === 'session/prompt') send({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'config_option_update', configOptions: [{ ...carbon, currentValue: 'different-model' }, thinking],
    } } });
  });
  await assert.rejects(run, /تغيّر نموذج/);
  assert.equal(requests.filter(message => message.method === 'session/set_config_option').length, 1);
  assert.equal(events.some(event => event.type === 'result'), false);
});

test('Antigravity cancellation clears an open approval and terminates the worker', async t => {
  const controller = new AbortController();
  const { run, requests, child, events } = await fixture(t, (message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1 } });
    if (message.method === 'session/new') send({ id: message.id, result: { sessionId, configOptions: [sessionModel] } });
    if (message.method === 'session/prompt') send(approval('waiting', 'npm test'));
  }, { signal: controller.signal, approve: async () => { controller.abort(); return false; } });
  await assert.rejects(run, /إيقاف/);
  assert.ok(requests.some(message => message.method === 'session/cancel'));
  assert.deepEqual(requests.find(message => message.id === 'waiting').result.outcome, { outcome: 'cancelled' });
  assert.equal(child.killed, 'SIGTERM');
  assert.equal(events.some(event => event.type === 'result'), false);
});
