import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentTools } from '../js/document-tools.js?v=50';
import { readZipEntries } from '../js/zip-text.js?v=50';
import { projectZip } from '../js/project.js?v=50';

test('document tools paginate every character and every file beyond initial excerpts', () => {
  const text = Array.from({ length: 120 }, (_, i) => `[صفحة ${i + 1}]\n` + `Line ${i + 1} `.repeat(150)).join('\n');
  const workspace = createDocumentTools([{ name: 'book.pdf', text, extraction: { pagesTotal: 120, complete: true } }]);
  let received = '', offset = 0;
  do {
    const result = JSON.parse(workspace.execute('read_document', { document_id: 'd1', offset }));
    received += result.text;
    offset = result.next_offset;
  } while (offset !== null);
  assert.equal(received, text);
  const result = JSON.parse(workspace.execute('read_document', { document_id: 'd1', start_page: 119, end_page: 120 }));
  assert.match(result.text, /Line 119/);
  assert.match(result.text, /Line 120/);
  assert.doesNotMatch(result.text, /Line 118 /);
  const many = createDocumentTools(Array.from({ length: 77 }, (_, i) => ({ name: `file${i}`, text: 'complete' })));
  const all = [];
  offset = 0;
  do { const result = JSON.parse(many.execute('list_documents', { offset })); all.push(...result.documents); offset = result.next_offset; } while (offset !== null);
  assert.equal(all.length, 77);
  assert.equal(all.at(-1).name, 'file76');
});

test('document search reaches the final page and exposes incomplete OCR in inventory', () => {
  const workspace = createDocumentTools([{ name: 'scan.pdf', text: '[صفحة 1]\nمقدمة\n' + 'تفاصيل\n'.repeat(10000) + '[صفحة 93]\nالضمان ١٢٥٠٠',
    originalAvailable: true, extraction: { pagesTotal: 94, pagesRead: 93, complete: false, unreadablePages: [94] } }]);
  const result = JSON.parse(workspace.execute('search_documents', { query: 'الضمان' }));
  assert.equal(result.total_hits, 1);
  assert.equal(result.hits[0].page, 93);
  const range = JSON.parse(workspace.execute('read_document', { document_id: 'd1', offset: result.hits[0].offset }));
  assert.match(range.text, /١٢٥٠٠/);
  assert.deepEqual(JSON.parse(workspace.execute('list_documents')).documents[0].extraction.unreadablePages, [94]);
  assert.throws(() => workspace.execute('read_document', { document_id: '../../secret' }), /not found/);
});

test('ZIP binary reading retains complete mixed-file inventory and validates bytes', async () => {
  const bytes = new Uint8Array(250_123).map((_, i) => i % 251);
  const archive = projectZip([{ path: 'عقد.pdf', encoding: 'base64', content: Buffer.from(bytes).toString('base64') }, { path: 'notes.txt', content: 'full text' }]);
  const result = await readZipEntries(archive, () => true, undefined, { binary: true });
  assert.equal(result.inventory.length, 2);
  assert.deepEqual(result.entries.find(([name]) => name === 'عقد.pdf')[1], bytes);
  assert.equal(result.inventory.find(entry => entry.name === 'عقد.pdf').size, bytes.length);
  const filtered = await readZipEntries(archive, name => name.endsWith('.txt'));
  assert.deepEqual(filtered.skipped, ['عقد.pdf']);
  assert.equal(filtered.inventory.find(entry => entry.name === 'عقد.pdf').status, 'unsupported');
  const broken = new Uint8Array(await archive.arrayBuffer());
  broken[30 + new TextEncoder().encode('notes.txt').length + 2] ^= 1;
  await assert.rejects(readZipEntries(new Blob([broken]), () => true), /CRC/);
  await assert.rejects(readZipEntries(new Blob(['bad']), () => true), /غير مكتملة/);
});
