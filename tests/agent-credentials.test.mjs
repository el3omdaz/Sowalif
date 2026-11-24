import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CODING_ENGINES, CODING_PROVIDERS, codingEngineById, codingEngineName, codingModelConfig } from '../js/agent-engines.js?v=51';

function client(initial = [], { codexOpenRouter = true } = {}) {
  const saved = new Map([['codingEngine', 'codex'], ...initial]);
  const requests = [];
  const context = vm.createContext({
    settings: { get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback, set: (key, value) => saved.set(key, value) },
    CODING_ENGINES, CODING_PROVIDERS, codingEngineById, codingEngineName, codingModelConfig,
    profileId: '', location: { hostname: '127.0.0.1', port: '4781' },
    saveChat: async () => {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/agent/status') return Response.json({ local: true, ready: true, engines: ['codex'], codexOpenRouter, csrf: 'fixture-csrf' });
      throw new Error('Unexpected submission before capability check');
    },
    Date, AbortSignal, Blob, URLSearchParams, setTimeout,
  });
  const source = readFileSync(new URL('../js/local-agent.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  vm.runInContext('reconcileBeforeRun=async()=>false;', context);
  return { saved, requests, ...vm.runInContext('({ agentCredentials, respondLocal })', context) };
}

test('Codex keeps OpenAI as the default provider while Claude still defaults to OpenRouter', () => {
  const a = client([['codingOpenAIKey', 'fixture-openai'], ['openRouterKey', 'fixture-router']]);
  assert.deepEqual({ ...a.agentCredentials() }, { engine: 'codex', provider: 'openai', providerSetting: 'codingProvider.codex', key: 'fixture-openai', keyName: 'codingOpenAIKey', modelSetting: 'codingCodexModel', defaultModel: '', model: '' });
  a.saved.set('codingEngine', 'claude');
  assert.equal(a.agentCredentials().provider, 'openrouter');
});

test('legacy shared OpenRouter does not switch existing Codex users and each engine remembers its provider', () => {
  const a = client([['codingProvider', 'openrouter'], ['codingOpenAIKey', 'fixture-openai'], ['openRouterKey', 'fixture-router']]);
  assert.equal(a.agentCredentials().provider, 'openai');
  assert.equal(a.agentCredentials().key, 'fixture-openai');
  a.saved.set('codingEngine', 'claude');
  assert.equal(a.agentCredentials().provider, 'openrouter');
  a.saved.set('codingProvider.claude', 'anthropic');
  a.saved.set('codingEngine', 'codex');
  assert.equal(a.agentCredentials().provider, 'openai');
  a.saved.set('codingProvider.codex', 'openrouter');
  assert.equal(a.agentCredentials().provider, 'openrouter');
  assert.equal(a.agentCredentials().key, 'fixture-router');
  a.saved.set('codingEngine', 'claude');
  assert.equal(a.agentCredentials().provider, 'anthropic');
  a.saved.set('codingEngine', 'codex');
  assert.equal(a.agentCredentials().provider, 'openrouter');
});

test('Codex provider switches isolate keys and model IDs and preserve each saved choice', () => {
  const a = client([['codingOpenAIKey', 'fixture-openai'], ['openRouterKey', 'fixture-router'], ['codingCodexModel', 'gpt-native-choice']]);
  a.saved.set('codingProvider.codex', 'openrouter');
  assert.equal(a.agentCredentials().model, 'openai/gpt-5.3-codex');
  assert.equal(a.agentCredentials().key, 'fixture-router');
  assert.equal(a.agentCredentials().modelSetting, 'codingCodexOpenRouterModel');
  a.saved.set('codingCodexOpenRouterModel', 'openai/router-choice');
  a.saved.set('codingProvider.codex', 'openai');
  assert.equal(a.agentCredentials().model, 'gpt-native-choice');
  assert.equal(a.agentCredentials().key, 'fixture-openai');
  a.saved.set('codingProvider.codex', 'openrouter');
  assert.equal(a.agentCredentials().model, 'openai/router-choice');
});

test('a missing provider key never falls back to the other provider', () => {
  const a = client([['codingProvider.codex', 'openrouter'], ['codingOpenAIKey', 'fixture-openai']]);
  assert.equal(a.agentCredentials().key, '');
  a.saved.set('openRouterKey', 'fixture-router');
  a.saved.delete('codingOpenAIKey');
  a.saved.set('codingProvider.codex', 'openai');
  assert.equal(a.agentCredentials().key, '');
});

test('an old runtime cannot submit an OpenRouter Codex job before the engine is updated', async () => {
  const a = client([['codingProvider.codex', 'openrouter'], ['openRouterKey', 'fixture-router']], { codexOpenRouter: false });
  const chat = { id: 'project', title: 'Fixture', mode: 'work', messages: [{ role: 'user', text: 'Fix the app' }], project: { revision: 0, files: [] } };
  const reply = await a.respondLocal(chat, () => {});
  assert.match(reply.error, /npm run agent:setup/);
  assert.match(reply.error, /OpenRouter/);
  assert.deepEqual(a.requests.map(request => request.url), ['/api/agent/status']);
});
