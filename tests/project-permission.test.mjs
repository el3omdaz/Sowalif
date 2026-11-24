import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { codingModelConfig } from '../js/agent-engines.js?v=51';

function localAgent({ storage = new Map(), profile = '', hostname = '127.0.0.1', port = '4781', failWrites = false, failedRuns = 0, desktop = false } = {}) {
  const defaults = new Map([['codingEngine', 'codex'], ['codingProvider', 'openai'], ['codingOpenAIKey', 'fixture-key']]);
  const runs = [];
  const engine = { id: 'codex', providers: ['openai'], modelSetting: 'codingModel' };
  const context = vm.createContext({
    profileId: profile,
    location: { hostname, port },
    sowalifDesktop: desktop,
    settings: {
      get: (key, fallback) => storage.has(key) ? storage.get(key) : defaults.has(key) ? defaults.get(key) : fallback,
      set(key, value) { if (failWrites) return false; storage.set(key, value); return true; },
    },
    CODING_ENGINES: { claude: engine }, codingModelConfig,
    CODING_PROVIDERS: { openai: { key: 'codingOpenAIKey' } },
    codingEngineById: id => id === 'codex' ? engine : null,
    codingEngineName: id => id,
    preparePersonalContext: async (_chat, text) => ({ expanded: text, prompt: '' }),
    saveChat: async () => {},
    document: { querySelector: () => assert.fail('Execution permissions must come from the selected project, not a shared checkbox') },
    fetch: async (url, options) => {
      if (url === '/api/agent/status') return Response.json({ local: true, ready: true, engines: ['codex'], csrf: 'fixture-csrf' });
      if (url.startsWith('/api/agent/project?')) return Response.json({ revision: 0, files: [] });
      assert.equal(url, '/api/agent/runs');
      const body = JSON.parse(options.body);
      runs.push(body);
      if (failedRuns-- > 0) return Response.json({ error: 'recoverable fixture failure' }, { status: 503 });
      return Response.json({ id: `run-${runs.length}` }, { status: 202 });
    },
    Date, AbortSignal, Blob, URLSearchParams, setTimeout,
  });
  const source = readFileSync(new URL('../js/local-agent.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  vm.runInContext('stageAgentAttachments = async () => []; collectAgentRun = async (_chat, reply) => { reply.text = "done"; reply.agentCompleted = true; return reply; };', context);
  return { ...vm.runInContext('({ projectAutoApprove, setProjectAutoApprove, respondLocal })', context), storage, runs };
}

const project = (id = 'project-a') => ({ id, mode: 'work', model: 'fixture-model', title: 'Fixture project', messages: [{ role: 'user', text: 'Run the project tests' }], project: { files: [], revision: 0 } });

test('project execution permission survives consecutive runs and a recoverable submission failure', async () => {
  const agent = localAgent({ failedRuns: 1 });
  const chat = project();
  assert.equal(agent.projectAutoApprove(chat), false);
  assert.equal(agent.setProjectAutoApprove(chat, true), true);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) chat.messages.push({ role: 'user', text: `Continue task ${attempt}` });
    const reply = await agent.respondLocal(chat, () => {});
    if (!attempt) assert.match(reply.error, /recoverable fixture failure/);
    else assert.equal(reply.error, undefined);
    assert.equal(agent.projectAutoApprove(chat), true);
  }
  assert.deepEqual(agent.runs.map(run => run.autoApprove), [true, true, true]);
});

test('project permission survives reload, stays with its project, and can be disabled', async () => {
  const storage = new Map();
  const first = localAgent({ storage });
  assert.equal(first.setProjectAutoApprove(project('a'), true), true);
  const reloaded = localAgent({ storage });
  assert.equal(reloaded.projectAutoApprove(project('a')), true);
  assert.equal(reloaded.projectAutoApprove(project('b')), false);
  await reloaded.respondLocal(project('b'), () => {});
  await reloaded.respondLocal(project('a'), () => {});
  assert.deepEqual(reloaded.runs.map(run => run.autoApprove), [false, true]);
  assert.equal(reloaded.setProjectAutoApprove(project('a'), false), true);
  assert.equal(localAgent({ storage }).projectAutoApprove(project('a')), false);
  await reloaded.respondLocal(project('a'), () => {});
  assert.equal(reloaded.runs.at(-1).autoApprove, false);
});

test('the same project ID cannot inherit execution permissions from another profile', () => {
  const storage = new Map();
  const device = localAgent({ storage });
  const account = localAgent({ storage, profile: 'account-a' });
  const other = localAgent({ storage, profile: 'account-b' });
  const chat = project();
  assert.equal(device.setProjectAutoApprove(chat, true), true);
  assert.equal(account.projectAutoApprove(chat), false);
  assert.equal(other.projectAutoApprove(chat), false);
  assert.equal(account.setProjectAutoApprove(chat, true), true);
  assert.equal(localAgent({ storage, profile: 'account-a' }).projectAutoApprove(chat), true);
  assert.equal(other.projectAutoApprove(chat), false);
});

test('permission requires a real project, local execution and an exact stored boolean', () => {
  const storage = new Map([['agentAutoApprove.device.project-a', 'true']]);
  const agent = localAgent({ storage });
  assert.equal(agent.projectAutoApprove(project()), false);
  for (const chat of [null, {}, { id: '' }, { id: 123 }]) {
    assert.equal(agent.projectAutoApprove(chat), false);
    assert.equal(agent.setProjectAutoApprove(chat, true), false);
  }
  assert.equal(agent.setProjectAutoApprove(project(), true), true);
  const remote = localAgent({ storage, hostname: 'example.test', port: '' });
  assert.equal(remote.projectAutoApprove(project()), false);
  assert.equal(remote.setProjectAutoApprove(project(), true), false);
  assert.equal(localAgent({ storage, port: '4782' }).projectAutoApprove(project()), false);
  assert.equal(localAgent({ storage, port: '4782', desktop: true }).projectAutoApprove(project()), true);
});

test('failed local saving never acknowledges a changed execution permission', () => {
  const storage = new Map();
  const blocked = localAgent({ storage, failWrites: true });
  assert.equal(blocked.setProjectAutoApprove(project(), true), false);
  assert.equal(blocked.projectAutoApprove(project()), false);
  assert.equal(storage.size, 0);
  assert.equal(localAgent({ storage }).setProjectAutoApprove(project(), true), true);
  assert.equal(blocked.setProjectAutoApprove(project(), false), false);
  assert.equal(blocked.projectAutoApprove(project()), true);
});
