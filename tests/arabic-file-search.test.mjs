import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectZip } from '../js/project.js?v=40';
import { extractKnownFileText, fileNameMatches, normalizeSearchText, pdfItemsText, searchKnownFile } from '../server/local-agent/content-search.mjs';

async function fixture(t, name, contents) {
  const directory = await mkdtemp(join(tmpdir(), 'sowalif-arabic-name-'));
  const path = join(directory, name);
  await writeFile(path, contents);
  const file = await open(path, 'r');
  const { size } = await file.stat();
  t.after(async () => { await file.close(); await rm(directory, { recursive: true, force: true }); });
  return { file, path, name, size };
}

test('Arabic names ignore directional formatting and tashkeel while preserving word boundaries', () => {
  const name = 'طَ\u200eه\u200f،\u00a0مُحَ\u200dمَّد\u2067\tالقَطَّان\u2069.docx';
  assert.equal(fileNameMatches(name, 'طه محمد القطان'), true);
  assert.equal(fileNameMatches('طهمحمد القطان.docx', 'طه محمد القطان'), false);
  assert.equal(fileNameMatches('طه أحمد محمد القطان.docx', 'طه محمد القطان'), false);
  assert.equal(normalizeSearchText('\ufeffطَـه\u061c\u202b محمد\u202c'), 'طه محمد');
});

test('Word run fragments and paragraph separators remain searchable with original source snippets', async t => {
  const name = 'طَ\u200eه،\u00a0مُحَ\u200dمَّد\tالقَطَّان';
  const parts = [
    '<w:p><w:r><w:t>تفاصيل القضية: </w:t></w:r><w:r><w:t>طَ\u200e</w:t></w:r><w:r><w:t>ه،\u00a0مُحَ\u200dمَّد</w:t></w:r><w:tab/><w:r><w:t>القَطَّان ORIGINAL_CASE</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>وثيقة ثانية</w:t></w:r></w:p>',
  ];
  const bytes = await projectZip([{ path: 'word/document.xml', content: '<w:document><w:body>' + parts.join('') + '</w:body></w:document>' }]).arrayBuffer();
  const input = await fixture(t, 'names.docx', Buffer.from(bytes));
  const extracted = await extractKnownFileText(input.file, input);
  const result = await searchKnownFile(input.file, { ...input, query: 'طه محمد القطان' });
  assert.equal(result.matched, true);
  assert.equal(result.incomplete, false);
  assert.equal(extracted.text.slice(result.offset, result.endOffset), name);
  assert.ok(result.snippet.includes(name));
  assert.match(result.snippet, /ORIGINAL_CASE/);
});

test('Arabic matching resumes across UTF-8 chunks and retains absolute extracted-text offsets', async t => {
  const prefix = 'x'.repeat(65_530);
  const target = 'طَ\u200fه\u00a0محمد\nالقطان';
  const input = await fixture(t, 'names.txt', prefix + target + ' FINAL_CASE');
  let resume;
  let consumed = 0;
  await assert.rejects(searchKnownFile(input.file, { ...input, query: 'طه محمد القطان',
    onProgress: value => { resume = value; },
    onBytes: count => { if (consumed + count > 65_536) throw new Error('PAGE_BUDGET'); consumed += count; },
  }), /PAGE_BUDGET/);
  assert.equal(resume.offset, 65_536);
  await input.file.close();
  const resumed = await open(input.path, 'r');
  t.after(() => resumed.close());
  const result = await searchKnownFile(resumed, { ...input, query: 'طه محمد القطان', resume });
  assert.equal(result.matched, true);
  assert.equal(result.offset, prefix.length);
  assert.equal(result.endOffset, prefix.length + target.length);
  assert.ok(result.snippet.includes(target));
  assert.match(result.snippet, /FINAL_CASE/);
});

test('PDF glyph geometry joins Arabic letters without joining separate words or lines', () => {
  const glyph = (str, x, width, y = 700) => ({ str, width, transform: [12, 0, 0, 12, x, y], dir: 'rtl' });
  const text = pdfItemsText([
    glyph('ط', 150, 8), glyph('ه', 142, 8),
    glyph('محمد', 100, 30), glyph('القطان', 55, 35),
    glyph('مستند', 100, 35, 680),
  ]);
  assert.equal(text, 'طه محمد القطان\nمستند');
  assert.equal(pdfItemsText([{ str: 'one' }, { str: 'two', hasEOL: true }, { str: 'next' }]), 'one two\nnext');
});

function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  const stream = 'BT /F1 12 Tf 1 0 0 1 50 700 Tm (AIR) Tj /F2 12 Tf (PORT) Tj 1 0 0 1 170 700 Tm (GATE) Tj ET';
  objects.push('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream');
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(text);
  text += 'xref\n0 7\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return text + `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}

test('real PDF font-fragmented words are searchable while distinct words retain a separator', async t => {
  const input = await fixture(t, 'fragmented.pdf', pdfFixture());
  const extracted = await extractKnownFileText(input.file, input);
  assert.match(extracted.text, /AIRPORT GATE/);
  assert.equal(extracted.incomplete, false);
  const present = await searchKnownFile(input.file, { ...input, query: 'AIRPORT' });
  assert.equal(present.matched, true);
  assert.match(present.snippet, /AIRPORT GATE/);
  assert.equal((await searchKnownFile(input.file, { ...input, query: 'AIRPORTGATE' })).matched, false);
});
