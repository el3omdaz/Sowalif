import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map([['sc.openRouterKey', '"or-test-key"'], ['sc.kieKey', '"kie-test-key"']]);
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const { runModel, diagnoseModels } = await import('../js/kie.js?v=48');
const { checkOpenRouterKey, refreshOpenRouterModels } = await import('../js/openrouter.js?v=48');
const { modelById, modelsFor, OR_DEFAULT_MODEL } = await import('../js/models.js?v=48');
const { reasoningLevels } = await import('../js/reasoning.js?v=48');
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

test('source comparison enables provider page reading alongside search', async () => {
  globalThis.fetch = async (_url, { body }) => {
    assert.deepEqual(JSON.parse(body).tools, [{ type: 'openrouter:web_search' }, { type: 'openrouter:web_fetch' }]);
    return json({ choices: [{ message: { content: 'Result' }, finish_reason: 'stop' }] });
  };
  await runModel(OR_DEFAULT_MODEL, { ...opts, search: true, webFetch: true });
});

const documentTool = { name: 'document_read', description: 'Read pages of an attached document', parameters: { type: 'object', properties: { file: { type: 'string' }, start_page: { type: 'integer' } }, required: ['file'] } };

test('OpenRouter returns JSON function calls and replays them with results and native search', async () => {
  const reasoningDetails = [{ type: 'reasoning.encrypted', data: 'opaque-state', index: 0 }];
  let turn = 0;
  globalThis.fetch = async (_url, { body }) => {
    const request = JSON.parse(body);
    assert.deepEqual(request.tools, [
      { type: 'function', function: documentTool }, { type: 'openrouter:web_search' }, { type: 'openrouter:web_fetch' },
    ]);
    assert.equal(request.tool_choice, 'auto');
    if (!turn++) return json({ choices: [{ message: { content: null, reasoning_details: reasoningDetails, tool_calls: [
      { id: 'read_1', type: 'function', function: { name: 'document_read', arguments: '{"file":"report.pdf","start_page":37}' } },
    ] }, finish_reason: 'tool_calls' }] });
    assert.deepEqual(request.messages.slice(-2), [
      { role: 'assistant', content: null, reasoning_details: reasoningDetails, tool_calls: [
        { id: 'read_1', type: 'function', function: { name: 'document_read', arguments: '{"file":"report.pdf","start_page":37}' } },
      ] },
      { role: 'tool', tool_call_id: 'read_1', content: '[page 37] Full evidence' },
    ]);
    return json({ choices: [{ message: { content: 'Based on page 37' }, finish_reason: 'stop' }] });
  };
  const options = { ...opts, tools: [documentTool], search: true, webFetch: true };
  const first = await runModel(OR_DEFAULT_MODEL, options);
  assert.deepEqual(first.calls, [{ id: 'read_1', name: 'document_read', args: { file: 'report.pdf', start_page: 37 } }]);
  const second = await runModel(OR_DEFAULT_MODEL, { ...options, messages: [
    ...opts.messages, { role: 'assistant', text: first.text, calls: first.calls, reasoningDetails: first.reasoningDetails },
    { role: 'tool', id: first.calls[0].id, name: first.calls[0].name, output: '[page 37] Full evidence' },
  ] });
  assert.equal(second.text, 'Based on page 37');
  assert.equal(turn, 2);
});

test('OpenRouter assembles interleaved streamed function calls and reasoning details', async () => {
  let displayed = '';
  globalThis.fetch = async () => sse([
    { choices: [{ delta: { content: 'أراجع الملف', reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-', index: 0 }], tool_calls: [
      { index: 1, id: 'read_b', type: 'function', function: { name: 'document_read', arguments: '{"file":"b' } },
      { index: 0, id: 'read_a', type: 'function', function: { name: 'document_read', arguments: '{"file":"a' } },
    ] }, finish_reason: null }] },
    { choices: [{ delta: { reasoning_details: [{ data: 'state', index: 0 }], tool_calls: [
      { index: 0, function: { arguments: '.pdf","start_page":42}' } },
      { index: 1, function: { arguments: '.pdf","start_page":1}' } },
    ] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const out = await runModel(OR_DEFAULT_MODEL, { ...opts, tools: [documentTool], onDelta: chunk => displayed += chunk });
  assert.equal(out.text, displayed);
  assert.deepEqual(out.calls, [
    { id: 'read_a', name: 'document_read', args: { file: 'a.pdf', start_page: 42 } },
    { id: 'read_b', name: 'document_read', args: { file: 'b.pdf', start_page: 1 } },
  ]);
  assert.deepEqual(out.reasoningDetails, [{ type: 'reasoning.encrypted', data: 'opaque-state', index: 0 }]);
});

test('malformed tool arguments never become an executable empty object', async () => {
  for (const args of ['{"file":', 'null', '[]', 'true']) {
    globalThis.fetch = async () => json({ choices: [{ message: { content: '', tool_calls: [
      { id: 'bad', type: 'function', function: { name: 'document_read', arguments: args } },
    ] }, finish_reason: 'tool_calls' }] });
    await assert.rejects(runModel(OR_DEFAULT_MODEL, { ...opts, tools: [documentTool] }), /معاملات أداة غير صالحة/);
  }
  globalThis.fetch = async () => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'document_read', arguments: '{"file":' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  await assert.rejects(runModel(OR_DEFAULT_MODEL, { ...opts, tools: [documentTool] }), /معاملات أداة غير صالحة/);
});

test('incomplete or token-limited tool streams cannot execute even complete argument fragments', async () => {
  const delta = { tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: 'document_read', arguments: '{"file":"report.pdf"}' } }] };
  for (const finish of [null, 'length']) {
    globalThis.fetch = async () => sse([{ choices: [{ delta, finish_reason: finish }] }]);
    await assert.rejects(runModel(OR_DEFAULT_MODEL, { ...opts, tools: [documentTool] }), finish === 'length' ? /الحد المتاح/ : /انقطع بث OpenRouter/);
  }
  globalThis.fetch = async () => sse([{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
  await assert.rejects(runModel(OR_DEFAULT_MODEL, { ...opts, tools: [documentTool] }), /طلب أداة غير مكتمل/);
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
      { id: 'test/tool-model', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'] },
      { id: 'test/new-model:batch', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
      { id: 'bad"id', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    ] });
  };
  assert.equal(await refreshOpenRouterModels(), 2);
  assert.equal(modelById('or:test/new-model').vision, false);
  assert.equal(modelById('or:test/new-model').name, 'Fresh model');
  assert.equal(modelById('or:test/new-model').tools, false);
  assert.equal(modelById('or:test/tool-model').tools, true);
  assert.equal(modelById('or:unknown/model').tools, false);
  assert.ok(modelsFor('openrouter').some((m) => m.id === 'or:test/new-model'));
  assert.ok(storage.has('sc.orCatalog'));
});

test('models without advertised tools do not receive function schemas', async () => {
  globalThis.fetch = async (_url, { body }) => {
    assert.deepEqual(JSON.parse(body).tools, [{ type: 'openrouter:web_search' }]);
    return json({ choices: [{ message: { content: 'Result' }, finish_reason: 'stop' }] });
  };
  await runModel('or:test/new-model', { ...opts, tools: [documentTool], search: true });
});

test('OpenRouter respects advertised effort values and preserves them in its cache', async () => {
  const architecture = { input_modalities: ['text'], output_modalities: ['text'] };
  const supportedEfforts = ['xhigh', 'high', 'medium'];
  let body;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/models')) return json({ data: [
      { id: 'test/reasoner', architecture, reasoning: { supported_efforts: supportedEfforts } },
      { id: 'test/fixed-reasoner', architecture, reasoning: { mandatory: true }, supported_parameters: ['reasoning'] },
    ] });
    body = JSON.parse(init.body);
    return json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
  };
  await refreshOpenRouterModels();
  assert.deepEqual(JSON.parse(storage.get('sc.orCatalog'))[0].reasoning.supported_efforts, supportedEfforts);
  assert.deepEqual(reasoningLevels(modelById('or:test/reasoner')), ['normal', 'deep', 'max']);
  assert.deepEqual(reasoningLevels(modelById('or:test/fixed-reasoner')), ['normal']);
  await runModel('or:test/reasoner', { ...opts, reasoningLevel: 'max' });
  assert.deepEqual(body.reasoning, { effort: 'xhigh' });
  await runModel('or:test/reasoner', { ...opts, reasoningLevel: 'normal', deep: true });
  assert.deepEqual(body.reasoning, { effort: 'medium' });
  await runModel('or:test/fixed-reasoner', { ...opts, reasoningLevel: 'deep' });
  assert.equal(body.reasoning, undefined);
  await runModel(OR_DEFAULT_MODEL, { ...opts, deep: true });
  assert.deepEqual(body.reasoning, { effort: 'high' });
  await runModel('or:anthropic/claude-fable-5.2', { ...opts, reasoningLevel: 'max' });
  assert.deepEqual(body.reasoning, { effort: 'max' });
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
  const { transcribe } = await import('../js/chat.js?v=48');
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
