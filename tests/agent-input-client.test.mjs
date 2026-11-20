import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function client(store) {
  const uploaded = [], inputs = new Map();
  const context = vm.createContext({
    location: { hostname: '127.0.0.1', port: '4781' }, profileId: '',
    settings: { get: (_, fallback) => fallback }, getBlob: async id => store.get(id),
    Blob, AbortSignal, URLSearchParams,
    fetch: async (url, options = {}) => {
      if (url === '/api/agent/status') return Response.json({ ready: true, csrf: 'local-csrf', originalAttachments: true });
      const params = new URL(url, 'http://127.0.0.1:4781').searchParams;
      if (options.method === 'POST') {
        assert.equal(options.headers['Content-Type'], 'application/octet-stream');
        assert.equal(options.headers['X-Sowalif-CSRF'], 'local-csrf');
        assert.ok(options.body instanceof Blob);
        const bytes = Buffer.from(await options.body.arrayBuffer());
        const result = { id: `input-${uploaded.length}`, name: params.get('name'), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        uploaded.push({ ...result, bytes }); inputs.set(result.id, result);
        return Response.json(result);
      }
      return inputs.has(params.get('id')) ? Response.json(inputs.get(params.get('id'))) : Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
  const source = readFileSync(new URL('../js/local-agent.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source + '\nthis.stage = stageAgentAttachments;', context);
  return { stage: context.stage, uploaded, inputs };
}

test('coding client stages all conversation originals as raw binary including attachments older than seven messages', async () => {
  const originals = new Map(Array.from({ length: 12 }, (_, i) => [`original-${i}`, new Blob([new Uint8Array(450_123).fill(i), `final-byte-${i}`])]));
  const files = [...originals].map(([localFile], i) => ({ kind: 'doc', name: `full-${i}.zip`, deferredDocument: true, localFile, text: 'placeholder only' }));
  const chat = { id: 'project', messages: files.map(file => ({ role: 'user', text: 'inspect this', files: [file] })) };
  chat.messages.push({ role: 'user', text: 'build app', files: [files[0]] });
  const c = client(originals);
  const staged = await c.stage(chat);
  assert.equal(staged.length, 12);
  assert.equal(c.uploaded.length, 12);
  for (const [index, file] of files.entries()) assert.deepEqual(c.uploaded[index].bytes, Buffer.from(await originals.get(file.localFile).arrayBuffer()));
  await c.stage(chat);
  assert.equal(c.uploaded.length, 12, 'verified cached originals must not upload again on a follow-up');
});

test('legacy extracted text is labelled honestly and a missing original blocks partial execution', async () => {
  const c = client(new Map([['legacy', new Blob(['complete extracted text'])]]));
  const staged = await c.stage({ id: 'legacy-project', messages: [{ role: 'user', files: [{ kind: 'doc', name: 'old.docx', localFile: 'legacy', localText: true }] }] });
  assert.equal(staged.length, 1);
  assert.equal(c.uploaded[0].name, 'old.docx.extracted.txt');
  assert.equal(c.uploaded[0].bytes.toString(), 'complete extracted text');
  await assert.rejects(c.stage({ id: 'missing', messages: [{ role: 'user', files: [{ kind: 'doc', name: 'missing.pdf', deferredPdf: true, localFile: 'absent', text: 'preview' }] }] }), /الأصلي|الأصل/);
  assert.equal(c.uploaded.length, 1);
});
