import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { runOpenCode } from '../server/local-agent/opencode.mjs';

const sessionID = 'ses_sample';
const key = 'sk-or-test-value';
const config = { key, prompt: 'عدّل المشروع وشغّل الاختبارات' };

function fixture({ decision = true, failed = false } = {}) {
  const requests = [];
  const events = [];
  const approvals = [];
  let processOptions;
  let emit;
  let answer;
  let killed;
  const buildResult = new Promise(resolve => { answer = resolve; });
  const child = new EventEmitter();
  child.kill = signal => { killed = signal; };
  const tool = { type: 'tool', tool: 'bash', id: 'prt_tool', sessionID };
  const permission = { id: 'per_shell', sessionID, permission: 'bash', patterns: ['npm test'], metadata: { description: 'Run tests' } };
  const deltas = ['تم التشغيل ', 'sk-or-', 'test-value', '.'];
  const result = () => Response.json(failed ? { info: { error: { data: { message: `Provider rejected ${key}` } } }, parts: [] } : {
    info: { cost: .05 }, parts: [{ id: 'prt_summary', type: 'text', text: deltas.join('') + ' النتيجة جاهزة.' }],
  });

  return {
    requests, events, approvals,
    get processOptions() { return processOptions; },
    get killed() { return killed; },
    options: {
      launch(executable, args, options) { processOptions = { executable, args, ...options }; return child; },
      async request(url, init) {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'http://127.0.0.1:4096');
        assert.match(init.headers.Authorization, /^Basic /);
        assert.equal(init.headers.Authorization.includes(key), false);
        const path = parsed.pathname;
        requests.push({ path, method: init.method, body: init.body && JSON.parse(init.body) });
        if (path === '/global/health') return Response.json({ healthy: true });
        if (path === '/session') return Response.json({ id: sessionID });
        if (path === '/event') return new Response(new ReadableStream({ start(controller) {
          emit = (type, properties) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`));
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        } }));
        if (path === `/session/${sessionID}/message`) {
          if (failed) return result();
          emit('permission.asked', { ...permission, id: 'per_other_session', sessionID: 'ses_other' });
          emit('permission.asked', permission);
          const aborted = new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
          return Promise.race([buildResult, aborted]);
        }
        if (path === '/permission/per_shell/reply') {
          for (const delta of deltas) emit('message.part.delta', { sessionID, field: 'text', partID: 'prt_summary', delta });
          if (decision) {
            emit('message.part.updated', { part: { ...tool, state: { status: 'running', input: { command: 'npm test' } } } });
            emit('message.part.updated', { part: { ...tool, state: { status: 'completed', output: 'passed' } } });
          } else {
            emit('message.part.updated', { part: { ...tool, state: { status: 'error', error: 'User rejected tool access' } } });
          }
          setImmediate(() => answer(result()));
          return Response.json(true);
        }
        throw new Error(`Unexpected OpenCode endpoint ${path}`);
      },
      send(type, data) { events.push({ type, ...data }); },
      async approve(toolName, input) { approvals.push({ toolName, input }); return decision; },
    },
  };
}

test('OpenCode uses Kimi on OpenRouter and requests one-use approval within the project', async () => {
  const run = fixture();
  await runOpenCode(config, run.options);
  assert.equal(run.processOptions.executable, 'opencode');
  assert.deepEqual(run.processOptions.args, ['serve', '--hostname', '127.0.0.1', '--port', '4096']);
  assert.equal(run.processOptions.cwd, '/workspace');
  assert.equal(run.processOptions.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  const permissions = JSON.parse(run.processOptions.env.OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(permissions.bash, 'ask');
  assert.equal(permissions.external_directory, 'deny');
  assert.deepEqual(run.approvals, [{ toolName: 'OpenCode', input: { command: 'npm test', description: 'Run tests' } }]);
  assert.equal(run.requests.find(({ path }) => path.startsWith('/permission/')).body.reply, 'once');
  const prompt = run.requests.find(({ path }) => path.endsWith('/message')).body;
  assert.match(prompt.system, /Deploy or publish only when the user explicitly requests it/);
  assert.doesNotMatch(prompt.system, /Do not publish, deploy/);
  assert.deepEqual(prompt.model, { providerID: 'openrouter', modelID: 'moonshotai/kimi-k3.1-pro' });
  assert.deepEqual(prompt.parts, [{ type: 'text', text: config.prompt }]);
  assert.equal(run.events.find(({ type }) => type === 'session').id, sessionID);
  assert.equal(run.events.filter(({ type }) => type === 'delta').map(({ text }) => text).join(''), 'تم التشغيل [key]. النتيجة جاهزة.');
  assert.ok(run.events.some(({ type, text }) => type === 'tool-result' && text === 'passed'));
  assert.equal(run.events.at(-1).type, 'result');
  assert.equal(run.killed, 'SIGTERM');
});

test('OpenCode resumes a session and forwards a declined command as a rejection', async () => {
  const run = fixture({ decision: false });
  await runOpenCode({ ...config, sessionId: sessionID, model: 'moonshotai/kimi-k3.1-pro' }, run.options);
  assert.equal(run.requests.some(({ path }) => path === '/session'), false);
  assert.deepEqual(run.requests.find(({ path }) => path.startsWith('/permission/')).body, { reply: 'reject' });
  assert.ok(run.events.some(({ type, error }) => type === 'tool-result' && error));
  assert.equal(run.events.some(({ type, text }) => type === 'tool-result' && text === 'passed'), false);
});

test('OpenCode cleans up after a failed reply and redacts the key', async () => {
  const run = fixture({ failed: true });
  await assert.rejects(runOpenCode(config, run.options), /Provider rejected \[key\]/);
  assert.equal(run.events.some(({ type }) => type === 'result'), false);
  assert.equal(run.killed, 'SIGTERM');
});

test('OpenCode rejects an invalid router model before launching', async () => {
  const run = fixture();
  await assert.rejects(runOpenCode({ ...config, model: 'https://other.net/models' }, run.options), /معرّف نموذج/);
  assert.equal(run.processOptions, undefined);
});

test('cancellation tears down OpenCode while it is waiting for approval', async () => {
  const run = fixture();
  const controller = new AbortController();
  const approve = () => {
    controller.abort(new Error('Cancelled by the user'));
    return new Promise(() => {});
  };
  await assert.rejects(runOpenCode(config, { ...run.options, approve, signal: controller.signal }), /Cancelled by the user/);
  assert.equal(run.killed, 'SIGTERM');
  assert.equal(run.events.some(({ type }) => type === 'result'), false);
  assert.equal(run.requests.some(({ path }) => path.startsWith('/permission/')), false);
});
