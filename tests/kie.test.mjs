import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: (k) => k === 'sc.kieKey' ? '"test-key"' : null };
const { runModel } = await import('../js/kie.js');
const opts = { system: 'Test', messages: [{ role: 'user', text: 'مرحبا' }] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const sse = (text) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) {
    // تفتيت حتى الحروف العربية لاختبار TextDecoder.
    for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
    c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
};

test('Responses streams Arabic and handles a final event without trailing newline', async () => {
  let body;
  let visible = '';
  globalThis.fetch = async (_, init) => {
    body = JSON.parse(init.body);
    return sse('data: {"type":"response.output_text.delta","delta":"أهلاً"}\r\n\r\ndata: {"type":"response.completed","response":{"output":[]}}');
  };
  const result = await runModel('gpt-6-1-sol', { ...opts, onDelta: (s) => visible += s });
  assert.equal(result.text, 'أهلاً');
  assert.equal(visible, 'أهلاً');
  assert.equal(body.reasoning.effort, 'low');
});

test('temporary server rejection retries once, including HTTP 200 error bodies', async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? json({ code: 500, msg: 'Internal error' }) : json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Recovered' }] }] });
  assert.equal((await runModel('gpt-6-1-sol', opts)).text, 'Recovered');
  assert.equal(calls, 2);
});

test('authentication failure is not retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ code: 401 }, 401); };
  await assert.rejects(runModel('gpt-6-1-sol', opts), /مفتاح/);
  assert.equal(calls, 1);
});

test('Load failed is readable and does not duplicate an uncertain request', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('Load failed'); };
  await assert.rejects(runModel('gpt-6-1-sol', opts), /انقطع الاتصال/);
  assert.equal(calls, 1);
});

test('stream errors and truncated streams fail without retrying or losing visible text', async () => {
  for (const tail of ['', '\n\ndata: {"error":{"message":"Internal error"}}']) {
    let calls = 0;
    let visible = '';
    globalThis.fetch = async () => { calls++; return sse('data: {"type":"response.output_text.delta","delta":"جزء محفوظ"}\n\n' + tail); };
    await assert.rejects(runModel('gpt-6-1-sol', { ...opts, onDelta: (s) => visible += s }));
    assert.equal(visible, 'جزء محفوظ');
    assert.equal(calls, 1);
  }
});

test('Anthropic completion and thinking switch', async () => {
  let body;
  globalThis.fetch = async (_, init) => {
    body = JSON.parse(init.body);
    return sse('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"تمام"}}\n\ndata: {"type":"message_stop"}');
  };
  assert.equal((await runModel('claude-sonnet-5-5', opts)).text, 'تمام');
  assert.equal(body.thinkingFlag, false);
  await runModel('claude-sonnet-5-5', { ...opts, deep: true });
  assert.equal(body.thinkingFlag, true);
});

test('Gemini audio media contract and complete SSE response', async () => {
  let body;
  globalThis.fetch = async (_, init) => {
    body = JSON.parse(init.body);
    return sse('data: {"choices":[{"delta":{"content":"نص التسجيل"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  assert.equal((await runModel('gemini-3-8-flash', { ...opts, messages: [{ role: 'user', files: [{ kind: 'audio', url: 'https://example.test/voice.m4a' }] }] })).text, 'نص التسجيل');
  assert.equal(body.messages[1].content[0].image_url.url, 'https://example.test/voice.m4a');
  assert.equal(body.tools, undefined);
});

test('abort during retry delay stops the second request', async () => {
  let calls = 0;
  const ctrl = new AbortController();
  globalThis.fetch = async () => { calls++; setTimeout(() => ctrl.abort(), 10); return json({ code: 503 }); };
  await assert.rejects(runModel('gpt-6-1-sol', { ...opts, signal: ctrl.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('empty successful response is an error instead of an ellipsis', async () => {
  globalThis.fetch = async () => json({ output: [] });
  await assert.rejects(runModel('gpt-6-1-sol', opts), /فارغاً/);
});

test('waiting for response headers times out with an actionable message', async () => {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 60000 ? 5 : ms, ...args);
  try {
    globalThis.fetch = (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    await assert.rejects(runModel('gpt-6-1-sol', opts), /تأخرت في بدء الرد/);
  } finally { globalThis.setTimeout = original; }
});

test('a stalled stream times out and releases its reader', async () => {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 60000 ? 5 : ms, ...args);
  let cancelled = false;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(runModel('gpt-6-1-sol', opts), /توقف وصول الرد/);
    assert.equal(cancelled, true);
  } finally { globalThis.setTimeout = original; }
});
