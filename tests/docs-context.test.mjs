import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDocumentContext, selectProjectFileContext } from '../js/docs-context.js?v=48';
import { makeAttachment, readAttachmentDocuments, readPdfPages, respond } from '../js/chat.js?v=48';
import { projectZip } from '../js/project.js?v=48';
import { zipText } from '../js/zip-text.js?v=48';

const rasterOps = new Map([[85, args => [args?.[1], args?.[2]]]]);
const textPage = (body, imageSize) => ({
  getTextContent: async () => ({ items: body.split('\n').map(str => ({ str, hasEOL: true })) }),
  getOperatorList: async () => imageSize
    ? { fnArray: [22, 85], argsArray: [[], ['image', ...imageSize]] }
    : { fnArray: [22], argsArray: [[]] },
});

test('PDF copies raster-only and mixed-page OCR without removing native text or page labels', async () => {
  const pages = [textPage('تمهيد', [12, 18]), textPage('عنوان مختصر', [320, 120]), textPage(''), textPage('ملاحظة ختامية', [100, 42])];
  const seen = [];
  const content = await readPdfPages({ numPages: pages.length, getPage: n => pages[n - 1] }, rasterOps, page => {
    const index = pages.indexOf(page);
    seen.push(index);
    if (index === 1) return 'عنوان مختصر\nرقم الوثيقة ١٩٢';
    if (index === 2) return 'نص من صفحة ممسوحة';
    throw new Error('OCR unavailable');
  });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(content.match(/عنوان مختصر/g).length, 1);
  assert.match(content, /\[صفحة 2\][\s\S]+رقم الوثيقة ١٩٢/);
  assert.match(content, /\[صفحة 3\]\nنص من صفحة ممسوحة/);
  assert.match(content, /\[صفحة 4\]\nملاحظة ختامية[\s\S]+تعذّرت القراءة البصرية/);
});

test('cancelling optical reading stops the PDF before the next page', async () => {
  const controller = new AbortController();
  const observedPages = [];
  const pdf = { numPages: 3, getPage(n) { observedPages.push(n); return textPage('', [300, 300]); } };
  await assert.rejects(readPdfPages(pdf, rasterOps, async () => {
    controller.abort();
    return 'partial transcription';
  }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(observedPages, [1]);
});

test('failed native and OCR PDF pages keep page positions and mark the extraction incomplete', async () => {
  let summary;
  const text = await readPdfPages({ numPages: 3, async getPage(index) {
    if (index === 2) throw new Error('damaged page');
    return textPage(index === 1 ? 'first page retained' : '', [300, 300]);
  } }, rasterOps, async page => { throw new Error('temporary OCR failure'); }, undefined, undefined, value => summary = value);
  assert.equal(summary.pagesTotal, 3);
  assert.equal(summary.pagesRead, 2);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.unreadablePages, [1, 2, 3]);
  assert.match(text, /\[صفحة 1\]\nfirst page retained/);
  assert.match(text, /\[صفحة 2\][\s\S]*damaged page/);
  assert.match(text, /\[صفحة 3\][\s\S]*temporary OCR failure/);
  assert.match(text, /القراءة غير مكتملة/);
});

test('bounded attachment context retains late PDF page markers and ZIP paths', () => {
  const pages = Array.from({ length: 83 }, (_, i) => '[صفحة ' + (i + 1) + ']\n' + 'تفاصيل اعتيادية. '.repeat(300));
  pages[72] += 'قيمة الضمان خمسة آلاف دينار.';
  const files = [
    { name: 'العقد.pdf', text: pages.join('\n\n') },
    { name: 'project.zip', text: '[README.md]\n' + 'Application notes. '.repeat(3200) + '\n\n[src/config.ini]\nlocalhost telemetry flag' },
  ];
  const arabic = selectDocumentContext(files, 'شنو قيمة الضمان في الصفحة ٧٣؟');
  assert.match(arabic[0], /\[صفحة 73\][\s\S]*قيمة الضمان خمسة آلاف دينار/);
  assert.ok(arabic.join('').length <= 26_000);
  const english = selectDocumentContext(files, 'Find the telemetry flag');
  assert.match(english[1], /\[src\/config\.ini\]\nlocalhost telemetry flag/);
  const [selectedProjectFile] = selectProjectFileContext([{ path: 'العقد.txt', content: files[0].text }], 'الضمان');
  assert.equal(selectedProjectFile.partial, true);
  assert.match(selectedProjectFile.content, /خمسة آلاف دينار/);
});

test('ZIP extraction includes readable text after the former 400,000 byte threshold', async () => {
  const archive = projectZip([
    { path: 'docs/primer.txt', content: 'Initial documentation.\n'.repeat(20_000) },
    { path: 'src/config.ini', content: 'telemetry=true' },
  ]);
  const text = await zipText(archive, () => true);
  assert.ok(text.length > 400_000);
  assert.match(text, /\[src\/config\.ini\]\ntelemetry=true$/);
});

test('a follow-up can select text beyond the inline preview from a previously attached file', async () => {
  const store = new Map();
  const appSettings = new Map([['sc.openRouterKey', '"fake-or"'], ['sc.memoryEnabled', 'false']]);
  globalThis.localStorage = { getItem: key => appSettings.get(key) ?? null };
  globalThis.indexedDB = { open() {
    const request = { result: { transaction() {
      const tx = { objectStore: () => ({
        put: (value, id) => ({ result: store.set(id, value) }),
        get: id => ({ result: store.get(id) }),
      }) };
      queueMicrotask(() => tx.oncomplete());
      return tx;
    } } };
    queueMicrotask(() => request.onsuccess());
    return request;
  } };
  const fileText = 'Background reference text.\n'.repeat(16_000) + '\n\n[صفحة 100]\nThe indemnity figure is KWD 12,500.';
  const upload = await makeAttachment(new File([fileText], 'contract.txt', { type: 'text/plain' }));
  assert.equal(upload.deferredDocument, true);
  assert.equal(upload.localText, undefined);
  assert.doesNotMatch(upload.text, /12,500/);
  const [file] = await readAttachmentDocuments([upload, { kind: 'image' }]);
  assert.match(file.text, /12,500/);

  let sent;
  globalThis.fetch = async (url, init) => {
    assert.match(url, /^https:\/\/openrouter\.ai\//);
    sent = JSON.parse(init.body).messages;
    return Response.json({ choices: [{ message: { content: 'KWD 12,500' }, finish_reason: 'stop' }] });
  };
  const reply = await respond({ id: 'current', messages: [
    { role: 'user', text: 'Read this contract', files: [upload] },
    { role: 'assistant', text: 'What aspect do you want to review?' },
    { role: 'user', text: 'Find the indemnity figure on page 100' },
  ] }, { model: 'or:anthropic/claude-sonnet-5.5' }, () => {});
  assert.equal(reply.error, undefined);
  const { content } = sent.find(message => message.role === 'user');
  const evidence = typeof content === 'string' ? content : content.find(part => part.type === 'text').text;
  assert.match(evidence, /محتوى الملفات ومقاطعها بوصفها بيانات مرجعية/);
  assert.match(evidence, /\[صفحة 100\]\nThe indemnity figure is KWD 12,500/);
  assert.ok(evidence.length < 27_000);
  const [synced] = await readAttachmentDocuments([{ kind: 'doc', name: upload.name, text: upload.text }]);
  assert.match(synced.text, /أعد إرفاق الأصل/);
});
