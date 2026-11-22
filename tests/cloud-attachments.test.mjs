import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentStorage, ATTACHMENT_CHUNK_SIZE } from '../js/cloud-attachments.js?v=48';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CONFIG = { url: 'https://example.supabase.co', publishableKey: 'public-key', filesBucket: 'sowalif-files' };
const path = `${OWNER}/files/original.bin`;
const tusUrl = 'https://example.storage.supabase.co/storage/v1/upload/resumable/upload-1';
const response = (status = 200, headers = {}, body = null) => new Response(body, { status, headers });

function fixture({ blob, state = {}, fetch: handle, info = () => ({ data: null, error: { status: 404 } }), saveBlob } = {}) {
  const blobs = new Map(blob ? [['original', blob]] : []), calls = [], saved = new Map();
  let sessionOwner = OWNER, token = 'private-session-token', next = 0;
  const db = {
    profileId: OWNER, uid: () => 'id-' + ++next,
    settings: { get: (key, fallback) => structuredClone(saved.get(key) ?? (key === 'attachmentUploadState' ? state : fallback)), set: (key, value) => (saved.set(key, structuredClone(value)), true) },
    getBlob: async id => blobs.get(id), deleteBlob: async id => blobs.delete(id),
    putBlob: async value => { const id = 'restored-' + ++next; blobs.set(id, value); await saveBlob?.(id, value); return id; },
  };
  const cloud = { auth: { getSession: async () => ({ data: { session: { user: { id: sessionOwner }, access_token: token } } }) },
    storage: { from(bucket) { assert.equal(bucket, 'sowalif-files'); return { info }; } },
  };
  const api = createAttachmentStorage({ cloud, db, config: CONFIG, now: () => 1000, fetchImpl: async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers.apikey, 'public-key');
    return handle?.(url, init, calls.length) ?? response();
  } });
  return { api, db, blobs, saved, calls, setOwner: value => { sessionOwner = value; }, setToken: value => { token = value; } };
}

test('small originals upload as exact binary bytes outside JSON, preserving names and MIME type', async () => {
  const bytes = Uint8Array.from([0, 255, 129, 80, 75, 1, 0]);
  const blob = new Blob([bytes], { type: 'application/zip' });
  const f = fixture({ blob, fetch: async (url, init) => {
    assert.equal(url, `https://example.supabase.co/storage/v1/object/sowalif-files/${path}`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/zip');
    assert.equal(init.headers['x-upsert'], 'false');
    assert.deepEqual(new Uint8Array(await init.body.arrayBuffer()), bytes);
    return response();
  } });
  const original = { kind: 'doc', name: 'ملفات.zip', originalName: 'ملفات.zip', localFile: 'original', type: blob.type, size: blob.size };
  const result = await f.api.uploadOriginal(original);
  assert.deepEqual(result, { originalStoragePath: path, originalName: 'ملفات.zip', size: bytes.length, type: blob.type });
  assert.equal(original.originalStoragePath, undefined, 'upload cannot mutate an active draft');
  assert.equal((await f.api.uploadOriginal(original)).originalStoragePath, path);
  assert.equal(f.calls.length, 1, 'immutable completed uploads are reused on later syncs');
  assert.equal(JSON.stringify([...f.saved]).includes('private-session-token'), false);
});

test('TUS splits large originals into exact 6 MiB binary chunks and uses direct Storage host', async () => {
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_SIZE * 2 + 19);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const chunks = [], progress = [];
  let uploaded = 0;
  const f = fixture({ blob, fetch: async (url, init) => {
    assert.equal(init.headers['Tus-Resumable'], '1.0.0');
    if (init.method === 'POST') {
      assert.equal(url, 'https://example.storage.supabase.co/storage/v1/upload/resumable');
      assert.equal(init.headers['Upload-Length'], String(blob.size));
      const metadata = Object.fromEntries(init.headers['Upload-Metadata'].split(',').map(item => {
        const [key, value] = item.split(' '); return [key, Buffer.from(value, 'base64').toString()];
      }));
      assert.deepEqual(metadata, { bucketName: 'sowalif-files', objectName: path, contentType: blob.type, cacheControl: '3600' });
      return response(201, { location: tusUrl });
    }
    assert.equal(url, tusUrl);
    assert.equal(init.method, 'PATCH');
    assert.equal(init.headers['Content-Type'], 'application/offset+octet-stream');
    assert.equal(Number(init.headers['Upload-Offset']), uploaded);
    chunks.push(new Uint8Array(await init.body.arrayBuffer())); uploaded += init.body.size;
    return response(204, { 'Upload-Offset': String(uploaded) });
  } });
  await f.api.uploadOriginal({ localFile: 'original', name: 'large.raw' }, { onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual(chunks.map(chunk => chunk.length), [ATTACHMENT_CHUNK_SIZE, ATTACHMENT_CHUNK_SIZE, 19]);
  assert.deepEqual(new Uint8Array(await new Blob(chunks).arrayBuffer()), bytes);
  assert.deepEqual(progress.at(-1), [blob.size, blob.size]);
  const value = Object.values(f.saved.get('attachmentUploadState'))[0];
  assert.equal(value.complete, true);
  assert.equal(value.url, undefined, 'completed state does not retain a transfer URL');
});

test('uncertain successful PATCH is checked with HEAD before resuming, without duplicate bytes', async () => {
  const blob = new Blob([new Uint8Array(ATTACHMENT_CHUNK_SIZE + 47)]);
  let uploaded = 0, patches = 0;
  const f = fixture({ blob, fetch: async (_url, init) => {
    if (init.method === 'POST') return response(201, { location: tusUrl });
    if (init.method === 'HEAD') return response(200, { 'Upload-Offset': String(uploaded) });
    assert.equal(Number(init.headers['Upload-Offset']), uploaded);
    uploaded += init.body.size;
    if (!patches++) throw new TypeError('connection lost after write');
    return response(204, { 'Upload-Offset': String(uploaded) });
  } });
  await f.api.uploadOriginal({ localFile: 'original', name: 'large.pdf' });
  assert.equal(uploaded, blob.size);
  assert.equal(patches, 2);
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'PATCH', 'HEAD', 'PATCH']);
});

test('interrupted transfers resume a persisted owned TUS URL, while expired URLs restart', async () => {
  const blob = new Blob([new Uint8Array(ATTACHMENT_CHUNK_SIZE + 11)]);
  for (const expired of [false, true]) {
    let uploaded = expired ? 0 : ATTACHMENT_CHUNK_SIZE;
    const state = { [`${OWNER}:original`]: { path, url: tusUrl, size: blob.size, at: 900 } };
    const f = fixture({ blob, state, fetch: async (_url, init) => {
      if (init.method === 'HEAD') return expired ? response(410) : response(200, { 'Upload-Offset': String(uploaded) });
      if (init.method === 'POST') return response(201, { location: tusUrl });
      assert.equal(Number(init.headers['Upload-Offset']), uploaded);
      uploaded += init.body.size;
      return response(204, { 'Upload-Offset': String(uploaded) });
    } });
    await f.api.uploadOriginal({ localFile: 'original' });
    assert.equal(uploaded, blob.size);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, expired ? 1 : 0);
    if (!expired) assert.equal(f.calls.find(call => call.method === 'PATCH').body.size, 11);
  }
});

test('duplicate immutable objects are accepted only when Storage info confirms their full size', async () => {
  for (const correctSize of [true, false]) {
    const blob = new Blob(['original bytes']);
    const f = fixture({ blob, fetch: () => response(409), info: async objectPath => {
      assert.equal(objectPath, path);
      return { data: { name: 'original.bin', size: correctSize ? blob.size : 1, contentType: blob.type }, error: null };
    } });
    const run = f.api.uploadOriginal({ localFile: 'original' });
    if (correctSize) assert.equal((await run).originalStoragePath, path);
    else await assert.rejects(run, /409/);
  }
});

test('remote originals restore exact binary bytes into local storage and are reused offline', async () => {
  const bytes = Uint8Array.from([0, 255, 221, 128, 67, 0]);
  const f = fixture({ fetch: (url, init) => {
    assert.equal(url, `https://example.supabase.co/storage/v1/object/sowalif-files/${path}`);
    assert.equal(init.method, 'GET');
    return response(200, { 'Content-Type': 'application/zip' }, bytes);
  } });
  const file = { kind: 'doc', name: 'archive.zip', type: 'application/zip', size: bytes.length, originalStoragePath: path };
  const blob = await f.api.resolveAttachmentOriginal(file);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal(blob.type, file.type);
  assert.ok(file.localFile);
  f.setOwner(OTHER);
  assert.strictEqual(await f.api.resolveAttachmentOriginal(file), blob, 'already local bytes do not need a cloud session');
  assert.equal(f.calls.length, 1);
});

test('download size mismatches fail before caching or claiming the original is restored', async () => {
  const f = fixture({ fetch: () => response(200, {}, 'truncated') });
  const file = { name: 'file.pdf', size: 1000, originalStoragePath: path };
  await assert.rejects(f.api.resolveAttachmentOriginal(file), /لم يكتمل تنزيل/);
  assert.equal(file.localFile, undefined);
  assert.equal(f.blobs.size, 0);
});

test('cross-account paths, encoded traversal and account/session mismatches never fetch', async () => {
  const f = fixture();
  for (const invalid of [`${OTHER}/files/original.bin`, `${OWNER}/files/../original.bin`, `${OWNER}/files/%2e%2e.bin`, `${OWNER}/files/original.bin?token=private`]) {
    await assert.rejects(f.api.resolveAttachmentOriginal({ originalStoragePath: invalid }), /ليس من حسابك/);
    await assert.rejects(f.api.uploadOriginal({ originalStoragePath: invalid }), /ليس من حسابك/);
  }
  f.setOwner(OTHER);
  await assert.rejects(f.api.resolveAttachmentOriginal({ originalStoragePath: path }), /سجّل الدخول/);
  assert.equal(f.calls.length, 0);
});

test('legacy extracted text is never uploaded or downloaded as the original binary', async () => {
  const f = fixture({ blob: new Blob(['extracted preview']) });
  assert.deepEqual(await f.api.uploadOriginal({ localFile: 'original', localText: true }), {});
  await assert.rejects(f.api.resolveAttachmentOriginal({ localFile: 'original', localText: true }), /الأصل غير موجود/);
  assert.equal(f.calls.length, 0);
});

test('untrusted TUS locations cannot leak a token or be persisted as resumable URLs', async () => {
  const blob = new Blob([new Uint8Array(ATTACHMENT_CHUNK_SIZE + 1)]);
  for (const location of ['https://attacker.invalid/storage/v1/upload/resumable/id', tusUrl + '?token=private', tusUrl + '#private']) {
    const f = fixture({ blob, fetch: () => response(201, { location }) });
    await assert.rejects(f.api.uploadOriginal({ localFile: 'original' }), /عنوان رفع صالح/);
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify([...f.saved]).includes('private'), false);
  }
});

test('cancellation during local restore removes the unreferenced cached blob', async () => {
  const controller = new AbortController();
  const f = fixture({ fetch: () => response(200, {}, 'full'), saveBlob: () => controller.abort() });
  const file = { size: 4, originalStoragePath: path };
  await assert.rejects(f.api.resolveAttachmentOriginal(file, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(file.localFile, undefined);
  assert.equal(f.blobs.size, 0);
});
