import test from 'node:test';
import assert from 'node:assert/strict';
const local = new Map([['sc.piapiKey', '"fake-piapi"'], ['sc.kieKey', '"never-send-kie"'], ['sc.openRouterKey', '"never-send-or"']]);
globalThis.localStorage = { getItem: k => local.get(k) ?? null, setItem: (k,v) => local.set(k,v) };
const { mediaIntent, mediaSpec, createMedia, waitMedia, taskResult } = await import('../js/piapi.js?v=8');
const { mediaProvider, kieMediaSpec } = await import('../js/media.js?v=8');

test('media provider and kie model selection are independent from chat, with no silent failover', () => {
  assert.equal(mediaProvider(), 'piapi');
  local.set('sc.mediaProvider', '"kie"');
  assert.equal(mediaProvider(), 'kie');
  assert.equal(kieMediaSpec('video', 'waves').body.model, 'kling-2.6/text-to-video');
  assert.equal(kieMediaSpec('video', 'move', { reference: 'https://image' }).body.model, 'kling-2.6/image-to-video');
  assert.equal(kieMediaSpec('image', 'cat', { reference: 'https://image' }).body.input.image_input[0], 'https://image');
  local.set('sc.kieVideoModel', '"wan-2.6"');
  assert.throws(() => kieMediaSpec('video', 'waves'), /يحتاج صورة/);
  assert.equal(kieMediaSpec('video', 'move', { reference: 'https://image' }).body.model, 'wan/2-6-image-to-video');
  local.delete('sc.kieVideoModel');
  local.delete('sc.mediaProvider');
});

test('explicit Arabic and English media requests route while discussion and negatives do not', () => {
  for (const text of ['ارسم قطة', 'ابي صورة سيارة', 'سويلي صورة حصان', 'ممكن ارسم لي صورة', 'generate an image']) assert.equal(mediaIntent(text), 'image', text);
  for (const text of ['سوي فيديو للبحر', 'حول الصورة الى فيديو', 'حرك الصورة', 'make a video', 'animate this image']) assert.equal(mediaIntent(text), 'video', text);
  for (const text of ['كيف انشئ صورة؟', 'هل تقدر تسوي فيديو؟', 'لا ترسم صورة', 'اشرح طريقة عمل فيديو', 'ابي اعرف تكلفة صورة', 'أخبار الفيديو اليوم', '"ارسم صورة" مثال على طلب']) assert.equal(mediaIntent(text), null, text);
});
test('automatic and manual choices honor reference capabilities and video duration', () => {
  assert.equal(mediaSpec('image', 'cat').body.model, 'Qubico/flux1-schnell');
  const edit = mediaSpec('image', 'edit', { reference: 'https://ref.test/a.png' });
  assert.equal(edit.body.task_type, 'kontext');
  assert.equal(edit.body.input.image, 'https://ref.test/a.png');
  assert.throws(() => mediaSpec('image', 'cat', { imageModel: 'dev', reference: 'https://ref' }), /لا يقبل/);
  assert.throws(() => mediaSpec('image', 'cat', { imageModel: 'kontext' }), /أرفق/);
  const v = mediaSpec('video', 'waves', { videoModel: '4.0-flash', duration: 10, reference: 'https://ref', aspect: '4:5' });
  assert.equal(v.body.input.version, '4.0-flash');
  assert.equal(v.body.input.duration, 10);
  assert.equal(v.body.input.image_url, 'https://ref');
  assert.equal(v.body.input.aspect_ratio, '16:9');
  assert.equal(v.body.config.service_mode, 'public');
  assert.equal(v.body.input.enable_audio, undefined);
});
test('creation and polling use only PiAPI key, accept success/completed and read canonical video field', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ code: 200, data: init.method === 'POST' ? { task_id: 'task1' } : { status: 'completed', output: { video: 'https://cdn.test/movie.mp4' } } });
  };
  const id = await createMedia(mediaSpec('video', 'waves'));
  assert.equal(await waitMedia({ id, kind: 'video' }, { interval: 0 }), 'https://cdn.test/movie.mp4');
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.match(url, /^https:\/\/api.piapi.ai\/api\/v1\/task/);
    assert.equal(init.headers['X-API-Key'], 'fake-piapi');
    assert.equal(JSON.stringify(init).includes('never-send'), false);
  }
  assert.equal(taskResult({ status: 'success', output: { image_url: 'https://cdn.test/a.png' } }, 'image'), 'https://cdn.test/a.png');
  assert.throws(() => taskResult({ status: 'completed', output: { video: 'javascript:bad' } }, 'video'), /صالح/);
});
test('uncertain submission is never retried and missing PiAPI key never falls back', async () => {
  let count = 0;
  globalThis.fetch = async () => { count++; throw new TypeError('Load failed'); };
  await assert.rejects(createMedia(mediaSpec('video', 'waves')), /تكرار التكلفة/);
  assert.equal(count, 1);
  local.delete('sc.piapiKey');
  await assert.rejects(createMedia(mediaSpec('video', 'waves')), /أضف مفتاح PiAPI/);
  assert.equal(count, 1);
  local.set('sc.piapiKey', '"fake-piapi"');
});
test('failed polling and cancellation never create another job', async () => {
  const methods = [];
  globalThis.fetch = async (_, init) => { methods.push(init.method); return Response.json({ code: 200, data: { status: 'failed', error: { code: 1, message: 'upstream failure' } } }); };
  await assert.rejects(waitMedia({ id: 'existing', kind: 'video' }), /upstream failure/);
  const ctrl = new AbortController();
  globalThis.fetch = async (_, init) => { methods.push(init.method); ctrl.abort(); return Response.json({ data: { status: 'pending' } }); };
  await assert.rejects(waitMedia({ id: 'existing', kind: 'image' }, { signal: ctrl.signal }));
  assert.deepEqual(methods, ['GET', 'GET']);
});
test('local image animation uses inline base64 without an upload service', () => {
  const spec = mediaSpec('video', 'gentle motion', { reference: 'data:image/png;base64,AA==' });
  assert.equal(spec.body.model, 'Qubico/framepack');
  assert.equal(spec.body.input.start_image, 'AA==');
  assert.equal(spec.body.input.duration, 10);
  assert.throws(() => mediaSpec('video', 'move', { reference: 'data:image/png;base64,AA==', videoModel: '2.6' }), /Kling/);
  assert.equal(taskResult({ status: 'completed', output: { video_url: 'https://cdn.test/framepack.mp4' } }, 'video'), 'https://cdn.test/framepack.mp4');
});
