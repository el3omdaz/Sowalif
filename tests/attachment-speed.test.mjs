import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';

globalThis.indexedDB = new IDBFactory();
const storage = new Map([['sc.openRouterKey', '"mock-key"'], ['sc.memoryEnabled', 'false']]);
globalThis.localStorage = { getItem: key => storage.get(key) ?? null };
const { getBlob, putBlob } = await import('../js/db.js?v=48');
const { makeAttachment, readAttachmentDocuments, respond } = await import('../js/chat.js?v=48');
const { createDocumentTools } = await import('../js/document-tools.js?v=48');
const { projectZip } = await import('../js/project.js?v=48');

function nativePdf(body) {
  const bodies = Array.isArray(body) ? body : [body];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${bodies.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${bodies.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, text] of bodies.entries()) {
    const lines = [''];
    for (const word of text.split(' ')) {
      if ((lines.at(-1) + word).length > 70) lines.push('');
      lines[lines.length - 1] += (lines.at(-1) ? ' ' : '') + word;
    }
    const stream = 'BT /F1 12 Tf 10 770 Td ' + lines.map(line => `(${line}) Tj 0 -16 Td`).join(' ') + ' ET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new File([pdf], 'native.pdf', { type: 'application/pdf' });
}

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

test('OCR caches are reused across vision models and for text-only models without another request', async () => {
  const original = await putBlob(new Blob(['not needed for cached OCR'], { type: 'application/pdf' }));
  const extractedText = await putBlob(new Blob(['[صفحة 1]\nAll previously transcribed text']));
  const file = { kind: 'doc', name: 'scan.pdf', deferredPdf: true, localFile: original,
    extractedText, extractedModel: 'or:anthropic/claude-sonnet-5.5', text: 'preview' };
  const before = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected paid/model request'); };
  try {
    for (const modelId of ['or:google/gemini-4-carbon', undefined]) {
      const [document] = await readAttachmentDocuments([file], { modelId });
      assert.match(document.text, /All previously transcribed text/);
      assert.equal(file.extractedText, extractedText);
    }
  } finally { globalThis.fetch = before; }
});

test('native-only caches upgrade to vision extraction when the cached document still has unread images', async () => {
  const original = nativePdf('Fresh extracted text');
  const file = await makeAttachment(original);
  file.extractedText = await putBlob(new Blob(['incomplete native text']));
  file.extractedModel = 'native';
  file.extractedInfo = { needsVision: true };
  const [document] = await readAttachmentDocuments([file], { modelId: 'or:anthropic/claude-sonnet-5.5' });
  assert.match(document.text, /Fresh extracted text/);
  assert.doesNotMatch(document.text, /incomplete native text/);
  assert.equal(document.extraction.pagesTotal, 1);
  assert.equal(document.extraction.pagesRead, 1);
  assert.equal(await (await getBlob(file.localFile)).text(), await original.text());
});

test('incomplete OCR caches can be explicitly retried while ordinary model changes reuse them', async () => {
  const original = nativePdf('Recovered full page text');
  const file = await makeAttachment(original);
  file.extractedText = await putBlob(new Blob(['[صفحة 1]\nprevious incomplete OCR']));
  file.extractedModel = 'or:anthropic/claude-sonnet-5.5';
  file.extractedInfo = { format: 'pdf', complete: false, unreadablePages: [1], needsVision: false };
  const [cached] = await readAttachmentDocuments([file], { modelId: 'or:google/gemini-4-carbon' });
  assert.match(cached.text, /previous incomplete OCR/);
  const [retried] = await readAttachmentDocuments([file], { modelId: 'or:google/gemini-4-carbon', retryExtraction: true });
  assert.match(retried.text, /Recovered full page text/);
  assert.equal(retried.extraction.complete, true);
  assert.equal(file.extractedInfo.complete, true);
});

test('an incomplete reread retains the previous OCR cache instead of replacing it with another partial result', async () => {
  const file = await makeAttachment(nativePdf(''));
  const previousText = '[صفحة 1]\nPreviously recovered text';
  const previousCache = await putBlob(new Blob([previousText]));
  const previousInfo = { format: 'pdf', complete: false, pagesTotal: 1, unreadablePages: [1] };
  Object.assign(file, { extractedText: previousCache, extractedModel: 'or:anthropic/claude-sonnet-5.5', extractedInfo: previousInfo });
  const [retried] = await readAttachmentDocuments([file], { retryExtraction: true });
  assert.equal(retried.extraction.complete, false);
  assert.equal(file.extractedText, previousCache);
  assert.deepEqual(file.extractedInfo, previousInfo);
  assert.equal(await (await getBlob(previousCache)).text(), previousText);
});

test('all 125 pages of a valid PDF remain extracted, searchable and readable through an OpenRouter document-tool round trip', async () => {
  const bodies = Array.from({ length: 125 }, (_, index) => `Page ${index + 1}. ` + 'Document reference details. '.repeat(12));
  bodies[124] += ' FINAL_PAGE_UNIQUE_736291';
  const original = nativePdf(bodies);
  const file = await makeAttachment(original);
  const [document] = await readAttachmentDocuments([file]);
  assert.equal(document.extraction.pagesTotal, 125);
  assert.equal(document.extraction.pagesRead, 125);
  assert.equal(document.extraction.pagesWithText, 125);
  assert.equal(document.extraction.complete, true);
  assert.equal([...document.text.matchAll(/^\[صفحة \d+\]/gm)].length, 125);
  assert.match(document.text, /\[صفحة 125\][\s\S]*FINAL_PAGE_UNIQUE_736291/);
  assert.deepEqual(new Uint8Array(await (await getBlob(file.localFile)).arrayBuffer()), new Uint8Array(await original.arrayBuffer()));
  const tools = createDocumentTools([document]);
  const found = JSON.parse(tools.execute('search_documents', { query: 'FINAL_PAGE_UNIQUE_736291' }));
  assert.equal(found.total_hits, 1);
  assert.equal(found.hits[0].page, 125);

  const before = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.ok(body.tools.some(tool => tool.type === 'function' && tool.function.name === 'read_document'));
    if (++requests === 1) return Response.json({ choices: [{ message: { content: '',
      tool_calls: [{ id: 'late-page', type: 'function', function: { name: 'read_document', arguments: JSON.stringify({ document_id: 'd1', start_page: 125 }) } }] }, finish_reason: 'tool_calls' }] });
    const read = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'late-page');
    assert.ok(read, 'the full-file tool result must reach the next model request');
    const result = JSON.parse(read.content);
    assert.match(result.text, /\[صفحة 125\][\s\S]*FINAL_PAGE_UNIQUE_736291/);
    assert.equal(result.next_offset, null);
    return Response.json({ choices: [{ message: { content: 'Found FINAL_PAGE_UNIQUE_736291 on page 125.' }, finish_reason: 'stop' }] });
  };
  try {
    const reply = await respond({ id: '125-page-document', title: 'Long PDF', messages: [
      { role: 'user', text: 'Inspect the final page with the document reader.', files: [file] },
    ] }, { model: 'or:anthropic/claude-sonnet-5.5' }, () => {});
    assert.equal(reply.error, undefined);
    assert.match(reply.text, /FINAL_PAGE_UNIQUE_736291/);
    assert.equal(reply.documentSources[0].pagesTotal, 125);
    assert.equal(requests, 2);
  } finally { globalThis.fetch = before; }
});

test('all attachment types retain original bytes and defer parsing errors until content is requested', async () => {
  for (const name of ['test.txt', 'broken.docx', 'broken.xlsx', 'broken.zip', 'binary.unknown']) {
    const bytes = new Uint8Array([0, 255, 4, 12, 16]);
    const file = await makeAttachment(new File([bytes], name));
    assert.equal(file.deferredDocument, true);
    assert.equal(file.originalName, name);
    assert.equal(file.size, bytes.length);
    assert.deepEqual(new Uint8Array(await (await getBlob(file.localFile)).arrayBuffer()), bytes);
    if (/broken\.zip|binary\.unknown/.test(name)) {
      const [read] = await readAttachmentDocuments([file]);
      assert.equal(read.extraction.complete, false);
      assert.match(read.text, /الأصل|الأصلي/);
    }
  }
});

test('image attachments retain the original independently from the optimized preview', async () => {
  const original = new File(['full original image bytes'], 'photo.png', { type: 'image/png' });
  const preview = new Blob(['optimized image bytes'], { type: 'image/png' });
  const file = await makeAttachment(original, preview);
  assert.equal(file.kind, 'image');
  assert.equal(await (await getBlob(file.localFile)).text(), await original.text());
  assert.equal(await (await getBlob(file.blob)).text(), await preview.text());
});

test('a text-cache quota failure still returns every character and retains the full original', async () => {
  const body = 'complete original source\n'.repeat(20_000) + 'FINAL_KEPT_CHARACTER';
  const file = await makeAttachment(new File([body], 'large.txt', { type: 'text/plain' }));
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, key) {
    if (value instanceof Blob && value.type.startsWith('text/plain')) throw new DOMException('Storage quota', 'QuotaExceededError');
    return originalPut.call(this, value, key);
  };
  try {
    const [document] = await readAttachmentDocuments([file]);
    assert.equal(document.text, body);
    assert.equal(await (await getBlob(file.localFile)).text(), body);
    assert.equal(file.cacheUnavailable, true);
    assert.equal(file.extractedText, undefined);
    assert.match(file.text, /أعد إرفاق الأصل/);
    assert.doesNotMatch(file.text, /FINAL_KEPT_CHARACTER/);
  } finally { IDBObjectStore.prototype.put = originalPut; }
});

test('cancellation during cache saving does not mutate attachment metadata or retain a partial cache', async () => {
  const file = await makeAttachment(new File(['full text'], 'cancel.txt', { type: 'text/plain' }));
  const snapshot = JSON.stringify(file);
  const controller = new AbortController();
  const originalPut = IDBObjectStore.prototype.put;
  let attemptedCache;
  IDBObjectStore.prototype.put = function(value, key) {
    if (value instanceof Blob && value.type.startsWith('text/plain')) { attemptedCache = key; controller.abort(); }
    return originalPut.call(this, value, key);
  };
  try {
    await assert.rejects(readAttachmentDocuments([file], { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(JSON.stringify(file), snapshot);
    assert.equal(await getBlob(attemptedCache), undefined);
    assert.equal(await (await getBlob(file.localFile)).text(), 'full text');
  } finally { IDBObjectStore.prototype.put = originalPut; }
});

test('ZIP reading keeps the complete inventory and reads a PDF member alongside text and binary files', async () => {
  const pdf = nativePdf('Nested PDF page was read');
  const archive = projectZip([
    { path: 'docs/notes.txt', content: 'Text member was read' },
    { path: 'docs/scan.pdf', content: await pdf.text() },
    { path: 'design/source.psd', content: 'preserved binary bytes' },
  ]);
  const file = await makeAttachment(new File([archive], 'mixed.zip', { type: 'application/zip' }));
  const [document] = await readAttachmentDocuments([file]);
  assert.match(document.text, /Text member was read/);
  assert.match(document.text, /Nested PDF page was read/);
  assert.match(document.text, /design\/source.psd/);
  assert.equal(document.extraction.entriesTotal, 3);
  assert.equal(document.extraction.entriesRead, 2);
  assert.equal(document.extraction.complete, false);
  assert.deepEqual(new Uint8Array(await (await getBlob(file.localFile)).arrayBuffer()), new Uint8Array(await archive.arrayBuffer()));
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
