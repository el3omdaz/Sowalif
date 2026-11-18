import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

globalThis.indexedDB = new IDBFactory();
globalThis.localStorage = { getItem: () => null };
const { getBlob, putBlob } = await import('../js/db.js?v=37');
const { makeAttachment, readAttachmentDocuments } = await import('../js/chat.js?v=36');

test('attaching a PDF stores its original immediately without PDF parsing or model requests', async () => {
  const original = new File(['not parsed during attachment\n' + 'x'.repeat(1_000_000)], 'scan.pdf', { type: 'application/pdf' });
  let requests = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error('No remote request is allowed during attachment'); };
  try {
    const states = [];
    const file = await makeAttachment(original, undefined, 'or:anthropic/claude-sonnet-5.5', { onProgress: value => states.push(value) });
    assert.equal(file.deferredPdf, true);
    assert.equal(file.kind, 'doc');
    assert.equal(requests, 0);
    assert.equal(await (await getBlob(file.localFile)).text(), await original.text());
    assert.match(states.join(' '), /أحفظ/);
    assert.equal(file.extractedText, undefined);
  } finally { globalThis.fetch = previous; }
});

test('deferred PDF reading reuses extracted text while retaining the original bytes', async () => {
  const original = await putBlob(new Blob(['original PDF bytes'], { type: 'application/pdf' }));
  const fullText = '[صفحة 1]\nComplete cached document text';
  const extractedText = await putBlob(new Blob([fullText], { type: 'text/plain' }));
  const file = { kind: 'doc', name: 'cached.pdf', localFile: original, deferredPdf: true,
    extractedText, extractedModel: 'native', text: 'preview only' };
  const [document] = await readAttachmentDocuments([file]);
  assert.equal(document.text, fullText);
  assert.equal(await (await getBlob(file.localFile)).text(), 'original PDF bytes');
});

test('a PDF from another device clearly requests its missing original and supports cancellation', async () => {
  const file = { kind: 'doc', name: 'missing.pdf', deferredPdf: true, localFile: 'absent', text: 'preview' };
  const [document] = await readAttachmentDocuments([file]);
  assert.match(document.text, /أعد إرفاق الأصل/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readAttachmentDocuments([file], { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(makeAttachment(new File(['test'], 'cancelled.pdf'), undefined, undefined, { signal: controller.signal }), { name: 'AbortError' });
});
