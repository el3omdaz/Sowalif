import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map([['sc.openRouterKey', '"or-test-key"'], ['sc.kieKey', '"kie-test-key"']]);
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const { runModel, diagnoseModels } = await import('../js/kie.js?v=13');
const { checkOpenRouterKey, refreshOpenRouterModels } = await import('../js/openrouter.js?v=13');
const { modelById, modelsFor, OR_DEFAULT_MODEL } = await import('../js/models.js?v=13');
const opts = { system: 'Test', messages: [{ role: 'user', text: 'مرحبا' }] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

test('OpenRouter streams directly using only its own key and correct slug', async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, ...init, body: JSON.parse(init.body) };
    return sse([{ choices: [{ delta: { content: 'أهلاً' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
  };
  let text = '';
  const out = await runModel(OR_DEFAULT_MODEL, { ...opts, onDelta: (delta) => text += delta });
  assert.equal(out.text, text);
  assert.equal(text, 'أهلاً');
  assert.equal(out.connection.provider, 'openrouter');
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer or-test-key');
  assert.equal(request.body.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(request.body.tools, undefined);
  assert.equal(JSON.stringify(request).includes('kie-test-key'), false);
});

test('web search stays in OpenRouter and image input is inline', async () => {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.deepEqual(body.tools, [{ type: 'openrouter:web_search' }]);
    assert.equal(body.messages[1].content[0].image_url.url, 'data:image/png;base64,AAAA');
    return json({ choices: [{ message: { content: 'نتيجة البحث' }, finish_reason: 'stop' }] });
  };
  await runModel(OR_DEFAULT_MODEL, { ...opts, search: true, messages: [{ role: 'user', text: 'حلل', files: [{ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' }] }] });
});

test('audio is sent as base64 without upload to kie.ai', async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.messages[1].content[0], { type: 'input_audio', input_audio: { data: 'AAAA', format: 'm4a' } });
    return json({ choices: [{ message: { content: 'نص الصوت' }, finish_reason: 'stop' }] });
  };
  await runModel('or:google/gemini-3.8-flash', { ...opts, messages: [{ role: 'user', text: 'transcribe', files: [{ kind: 'audio', data: 'AAAA', format: 'm4a' }] }] });
  assert.equal(calls, 1);
});

test('key validation uses /key and never confuses spending limit with account balance', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key');
    assert.equal(init.headers.Authorization, 'Bearer or-test-key');
    return json({ data: { limit_remaining: null, usage: 1 } });
  };
  assert.equal((await checkOpenRouterKey()).limit_remaining, null);
});

test('catalog loads public models, filters batches and persists supported capabilities', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/models');
    assert.equal(init.headers.Authorization, undefined);
    return json({ data: [
      { id: 'test/new-model', name: 'Test: Fresh model', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: [] },
      { id: 'test/new-model:batch', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
      { id: 'bad"id', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    ] });
  };
  assert.equal(await refreshOpenRouterModels(), 1);
  assert.equal(modelById('or:test/new-model').vision, false);
  assert.equal(modelById('or:test/new-model').name, 'Fresh model');
  assert.ok(modelsFor('openrouter').some((m) => m.id === 'or:test/new-model'));
  assert.ok(storage.has('sc.orCatalog'));
});

test('OpenRouter errors and incomplete streams do not identify themselves as kie.ai', async () => {
  for (const code of [401, 402, 429, 503]) {
    globalThis.fetch = async () => json({ error: { code, message: 'upstream error' } }, code);
    await assert.rejects(runModel(OR_DEFAULT_MODEL, opts), (e) => e.message.includes('OpenRouter') && !e.message.includes('kie.ai'));
  }
  let received = '';
  globalThis.fetch = async () => sse([{ choices: [{ delta: { content: 'جزء' }, finish_reason: null }] }]);
  await assert.rejects(runModel(OR_DEFAULT_MODEL, { ...opts, onDelta: (s) => received += s }), /انقطع بث OpenRouter/);
  assert.equal(received, 'جزء');
  globalThis.fetch = async () => sse([{ error: { code: 503, message: 'provider down' } }]);
  await assert.rejects(runModel(OR_DEFAULT_MODEL, opts), /OpenRouter/);
});

test('missing OpenRouter key never falls back to kie.ai key', async () => {
  storage.delete('sc.openRouterKey');
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; };
  await assert.rejects(runModel(OR_DEFAULT_MODEL, opts), /أضف مفتاح OpenRouter/);
  assert.equal(fetched, false);
  storage.set('sc.openRouterKey', '"or-test-key"');
});

test('diagnostics stays on selected provider', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }); };
  const out = await diagnoseModels([OR_DEFAULT_MODEL, 'or:google/gemini-3.8-flash']);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.ok && r.provider === 'openrouter'));
  assert.ok(urls.every((url) => url.startsWith('https://openrouter.ai/')));
});

test('recorded speech conversion routes directly to OpenRouter with no kie.ai upload', async () => {
  const { transcribe } = await import('../js/chat.js?v=13');
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((bytes) => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload(); });
    }
  };
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer or-test-key');
    assert.equal(JSON.parse(init.body).model, 'google/gemini-3.8-flash');
    return json({ choices: [{ message: { content: 'تجربة إملاء' }, finish_reason: 'stop' }] });
  };
  assert.equal(await transcribe(new Blob(['fake recording'], { type: 'audio/mp4' }), undefined, 'openrouter'), 'تجربة إملاء');
  assert.equal(requests, 1);
});
