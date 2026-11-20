import test from 'node:test';
import assert from 'node:assert/strict';
import { readZipEntries } from '../js/zip-text.js?v=40';
import { projectZip } from '../js/project.js?v=40';
import { selectPdfPreviewPages } from '../js/pdf-preview.js?v=40';

test('binary ZIP extraction respects supported-member filter before allocating size budget', async () => {
  const archive = projectZip([
    { path: 'assets/oversized.psd', content: '#'.repeat(470) },
    { path: 'reports/summary.txt', content: 'FINAL_READABLE_REPORT_' + 'x'.repeat(80) },
  ]);
  const { entries, inventory, skipped } = await readZipEntries(archive,
    name => name.endsWith('.txt'), undefined, { binary: true, maxExpandedBytes: 200 });
  assert.deepEqual(entries.map(([name]) => name), ['reports/summary.txt']);
  assert.match(new TextDecoder().decode(entries[0][1]), /FINAL_READABLE_REPORT/);
  assert.deepEqual(skipped, ['assets/oversized.psd']);
  assert.equal(inventory[0].status, 'unsupported');
  assert.equal(inventory[1].status, 'read');
});

test('single broken ZIP member can be reported without hiding healthy member content', async () => {
  const archive = projectZip([
    { path: 'bad.txt', content: 'CHANGED_PAYLOAD' },
    { path: 'good.txt', content: 'SAFE_FULL_CONTENT' },
  ]);
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const start = new TextEncoder().encode('CHANGED_PAYLOAD');
  let corruptAt = -1;
  for (let i = 0; i < bytes.length - start.length; i++) {
    if (start.every((b, j) => b === bytes[i + j])) { corruptAt = i; break; }
  }
  assert.ok(corruptAt >= 0, 'store-mode test fixture');
  bytes[corruptAt] ^= 1;
  await assert.rejects(readZipEntries(new Blob([bytes]), () => true), /CRC/);
  const result = await readZipEntries(new Blob([bytes]), () => true, undefined, { binary: true, tolerateErrors: true });
  assert.equal(result.inventory.find(e => e.name === 'bad.txt').status, 'corrupt');
  assert.equal(result.inventory.find(e => e.name === 'good.txt').status, 'read');
  assert.equal(new TextDecoder().decode(result.entries[0][1]), 'SAFE_FULL_CONTENT');
});

test('short PDFs include their original page images, long PDFs require targeted pages', () => {
  assert.deepEqual(selectPdfPreviewPages(1, 'ما رقم النموذج؟', true), [1]);
  assert.deepEqual(selectPdfPreviewPages(2, 'لخص المستند', true), [1, 2]);
  assert.deepEqual(selectPdfPreviewPages(110, 'لخص المستند', true), []);
  assert.deepEqual(selectPdfPreviewPages(110, 'افحص الجدول في الصفحة ٤٢ بصرياً', false), [42]);
  assert.deepEqual(selectPdfPreviewPages(110, 'افحص الصفحة الأخيرة بصرياً', false), [110]);
  assert.deepEqual(selectPdfPreviewPages(110, 'كيف شكل الخانات والتواقيع؟', false), [1]);
  assert.deepEqual(selectPdfPreviewPages(0, 'x', true), []);
});
