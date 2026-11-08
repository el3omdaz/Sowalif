import test from 'node:test';
import assert from 'node:assert/strict';
const local = new Map([['sc.piapiKey', '"fake-piapi"'], ['sc.kieKey', '"never-send-kie"'], ['sc.openRouterKey', '"never-send-or"']]);
globalThis.localStorage = { getItem: k => local.get(k) ?? null, setItem: (k,v) => local.set(k,v) };
const { mediaIntent, mediaSpec, createMedia, waitMedia, taskResult } = await import('../js/piapi.js?v=20');
const { mediaProvider, kieMediaSpec } = await import('../js/media.js?v=20');

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

test('new model families use their own input schemas and read array image results', () => {
  const reference = 'https://ref.test/photo.png';
  const banana = mediaSpec('image', 'change the light', { imageModel: 'nano-banana-2.1', reference });
  assert.deepEqual(banana.body, {
    model: 'gemini', task_type: 'nano-banana-2.1',
    input: { prompt: 'change the light', aspect_ratio: '1:1', output_format: 'png', resolution: '1K', image_urls: [reference] },
  });
  assert.equal(mediaSpec('image', 'sky', { imageModel: 'seedream-5-pro' }).body.input.size, '2K');
  const veo = mediaSpec('video', 'pan left', { videoModel: 'veo3.1-video-fast', reference, aspect: '9:16' });
  assert.equal(veo.body.input.image_url, reference);
  assert.equal(veo.body.input.duration, '8s');
  assert.equal(veo.body.input.aspect_ratio, '9:16');
  assert.equal(taskResult({ status: 'completed', output: { image_urls: [reference] } }, 'image'), reference);
});

test('Veo sends every reference as subject assets, validates counts and ratio before creation', () => {
  const references = ['https://files.test/person.png', 'https://files.test/bag.png'];
  const explicit = mediaSpec('video', 'keep the logo and change the clothes', { videoModel: 'veo3.1-video', references });
  assert.deepEqual(explicit.body.input.reference_image_urls, references);
  assert.equal(explicit.body.input.image_url, references[0]);
  assert.equal(explicit.body.input.tail_image_url, undefined);
  assert.equal(explicit.body.input.aspect_ratio, '16:9');
  assert.equal(explicit.body.input.duration, '8s');
  assert.equal(mediaSpec('video', 'use both', { references }).body.task_type, 'veo3.1-video');
  assert.throws(() => mediaSpec('video', 'use both', { references, aspect: '9:16' }), /16:9/);
  assert.throws(() => mediaSpec('video', 'use all', { references: [...references, ...references] }), /3/);
  for (const videoModel of ['framepack', '2.6', 'veo3.1-video-fast']) assert.throws(() => mediaSpec('video', 'use both', { videoModel, references }), /صورة واحدة/);
  assert.throws(() => kieMediaSpec('video', 'use both', { references }), /صورة واحدة/);
});

test('automatic PiAPI video follow-ups submit the existing clip for editing or extension', () => {
  const videoReference = 'https://ref.test/clip.mp4';
  const edit = mediaSpec('video', 'غيّر الإضاءة', { videoReference });
  assert.equal(edit.body.task_type, 'seedance-2.5');
  assert.deepEqual(edit.body.input.video_urls, [videoReference]);
  assert.equal(edit.body.input.omni_reference_task_type, 'edit');
  assert.equal(edit.body.input.duration, -1);
  assert.equal(edit.body.input.aspect_ratio, 'adaptive');
  const extension = mediaSpec('video', 'كمّل المقطع', { videoReference, duration: 10 });
  assert.equal(extension.body.input.omni_reference_task_type, 'extend');
  assert.equal(extension.body.input.duration, 10);
});

test('Kie Seedance accepts the uploaded image URL and leaves PiAPI URL validation intact', () => {
  local.set('sc.kieVideoModel', '"seedance-2.5"');
  try {
    const reference = 'https://files.test/reference.png';
    const spec = kieMediaSpec('video', 'حرّك الصورة', { reference, aspect: '9:16' });
    assert.equal(spec.body.model, 'bytedance/seedance-2-5');
    assert.deepEqual(spec.body.input.reference_image_urls, [reference]);
    assert.equal(spec.body.input.aspect_ratio, '9:16');
    assert.throws(() => mediaSpec('video', 'حرّك الصورة', { videoModel: 'seedance-2.5', reference: 'data:image/png;base64,AAAA' }), /PiAPI.*kie\.ai/);
  } finally {
    local.delete('sc.kieVideoModel');
  }
});

test('a foreground status check only reads the existing task once', async () => {
  const ids = [];
  const url = await waitMedia({ id: 'existing', kind: 'video' }, {
    once: true,
    readTask: async id => { ids.push(id); return { status: 'pending' }; },
  });
  assert.equal(url, null);
  assert.deepEqual(ids, ['existing']);
});

test('a browser-aborted media status read retries the same task', async () => {
  const ids = [];
  const url = await waitMedia({ id: 'existing', kind: 'video' }, {
    interval: 0,
    readTask: async id => {
      ids.push(id);
      if (ids.length === 1) throw new DOMException('Fetch is aborted', 'AbortError');
      if (ids.length === 2) return { status: 'pending' };
      return { status: 'success', output: { video: 'https://cdn.test/clip.mp4' } };
    },
  });
  assert.equal(url, 'https://cdn.test/clip.mp4');
  assert.deepEqual(ids, ['existing', 'existing', 'existing']);
});
