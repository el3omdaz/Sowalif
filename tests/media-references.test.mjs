import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
const local = new Map();
globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) };
globalThis.indexedDB = new IDBFactory();
globalThis.location = { hostname: 'example.test', port: '' };
const { settings, putBlob } = await import('../js/db.js?v=20');
const { resolveReferences } = await import('../js/media-references.js?v=20');
const { mediaSpec, createMedia } = await import('../js/piapi.js?v=20');

test('all uploaded references reach Veo and upload credentials stay separate from generation credentials', async () => {
  const files = await Promise.all(['person', 'bag'].map(async name => ({ kind: 'image', name, blob: await putBlob(new Blob([name], { type: 'image/png' })) })));
  settings.set('kieKey', 'fake-upload-key'); settings.set('piapiKey', 'fake-generation-key');
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    if (url.includes('file-stream-upload')) {
      assert.equal(init.headers.Authorization, 'Bearer fake-upload-key');
      assert.equal(JSON.stringify(init.headers).includes('fake-generation-key'), false);
      return Response.json({ data: { downloadUrl: `https://files.test/reference-${calls.length}.png` } });
    }
    assert.equal(init.headers['X-API-Key'], 'fake-generation-key');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.input.reference_image_urls, ['https://files.test/reference-1.png', 'https://files.test/reference-2.png']);
    assert.equal(JSON.stringify(init).includes('fake-upload-key'), false);
    return Response.json({ code: 200, data: { task_id: 'video-with-two-references' } });
  };
  await assert.rejects(resolveReferences(files, { provider: 'piapi' }), /سجّل الدخول/);
  assert.equal(calls.length, 0); // No cross-provider upload until the user selects it.
  settings.set('referenceUploadProvider', 'kie');
  const references = await resolveReferences(files, { provider: 'piapi' });
  assert.equal(await createMedia(mediaSpec('video', 'keep the bag logo', { references, videoModel: 'veo3.1-video' })), 'video-with-two-references');
  assert.equal(calls.length, 3);
  assert.ok(files.every(file => file.url && file.urlAt));
});
