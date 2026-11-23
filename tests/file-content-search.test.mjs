import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileService } from '../server/local-agent/files.mjs';
import { projectZip } from '../js/project.js?v=40';
import { fileNameMatches, markupText, rtfText } from '../server/local-agent/content-search.mjs';

async function fixture(t, options) {
  const base = await mkdtemp(join(tmpdir(), 'sowalif-content-find-'));
  const root = join(base, 'documents');
  await mkdir(root);
  const service = createFileService(join(base, 'control'), options);
  await service.changeRoots({ path: root });
  t.after(async () => { await service.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, service };
}

const docx = xml => projectZip([{ path: 'word/document.xml', content: '<w:document xmlns:w="urn:word"><w:body>' + xml + '</w:body></w:document>' }]);
const wordParagraph = text => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>';

async function allPages(service, request) {
  const pages = [];
  let cursor;
  do {
    const page = await service.scan({ ...request, ...(cursor ? { cursor } : {}) });
    pages.push(page); cursor = page.nextCursor;
    assert.ok(pages.length < 100, 'search continuation must make progress');
  } while (cursor);
  return pages;
}

test('Word search reads late body text, split Arabic runs, optional filenames and previews', async t => {
  const { root, service } = await fixture(t);
  const report = join(root, 'تقرير المطار.docx');
  const body = wordParagraph('تفاصيل '.repeat(190_000)) + '<w:p><w:r><w:t>مَ</w:t></w:r><w:r><w:t>طَار الكويت LATE_WORD_SENTINEL</w:t></w:r></w:p>';
  await writeFile(report, Buffer.from(await docx(body).arrayBuffer()));
  await writeFile(join(root, 'other.docx'), Buffer.from(await docx(wordParagraph('مطار آخر')).arrayBuffer()));
  const result = await service.scan({ root, action: 'find', query: 'مطار', searchIn: 'content', fileQuery: 'تقرير' });
  assert.equal(result.exhausted, true);
  assert.equal(result.partial, false);
  assert.deepEqual(result.files.map(file => file.path), [report]);
  assert.equal(result.files[0].match.type, 'content');
  assert.equal(result.files[0].match.format, 'docx');
  assert.match(result.files[0].match.snippet, /LATE_WORD_SENTINEL/);
  const preview = await service.read({ root, path: report });
  assert.equal(preview.format, 'docx');
  assert.equal(preview.partial, true, 'large previews are explicitly bounded');
});

test('streamed text finds content beyond 1MB and can resume within a large file', async t => {
  const { root, service } = await fixture(t, { searchBytes: 70_000 });
  const target = join(root, 'long.txt');
  await writeFile(target, 'x'.repeat(1_100_000) + 'مطار FINISH_OF_LARGE_FILE');
  const pages = await allPages(service, { root, action: 'find', query: 'مطار', searchIn: 'content' });
  assert.ok(pages.length > 2);
  assert.ok(pages.slice(0, -1).every(page => page.partial && page.nextCursor));
  assert.deepEqual(pages.flatMap(page => page.files).map(file => file.path), [target]);
  assert.equal(pages.at(-1).partial, false);
});

test('filename discovery precedes content reading and resumes beyond a scan page', async t => {
  const { root, service } = await fixture(t, { scanEntries: 2 });
  await mkdir(join(root, 'first-folder'));
  for (let i = 0; i < 8; i++) await writeFile(join(root, 'first-folder', `nested-${i}.txt`), 'unrelated');
  const target = join(root, 'أُجور المَطار.txt');
  await writeFile(target, 'body unrelated to query');
  const pages = await allPages(service, { root, action: 'find', query: 'اجور المطار', searchContent: true });
  assert.deepEqual(pages.flatMap(page => page.files).map(file => file.path), [target]);
  assert.equal(pages.find(page => page.files.length).files[0].match.type, 'name');
  assert.ok(pages.length > 2);
  assert.equal(pages.at(-1).exhausted, true);
  assert.equal(pages.at(-1).partial, false);
});

test('a packaged document larger than a page byte budget converges instead of retrying forever', async t => {
  const { root, service } = await fixture(t, { searchBytes: 200 });
  const target = join(root, 'report.docx');
  await writeFile(target, Buffer.from(await docx(wordParagraph('a'.repeat(90_000) + 'مطار')).arrayBuffer()));
  const pages = await allPages(service, { root, action: 'find', query: 'مطار', searchIn: 'content' });
  assert.deepEqual(pages.flatMap(page => page.files).map(file => file.path), [target]);
  assert.equal(pages.at(-1).exhausted, true);
  assert.ok(pages.length <= 2);
});

test('unsupported and damaged files keep a no-hit search explicitly incomplete across continuations', async t => {
  const { root, service } = await fixture(t, { scanEntries: 1 });
  await writeFile(join(root, 'legacy.doc'), 'OLE document');
  await writeFile(join(root, 'bad.docx'), 'broken zip');
  await writeFile(join(root, 'notes.txt'), 'none');
  const pages = await allPages(service, { root, action: 'find', query: 'مطار', searchIn: 'content' });
  assert.equal(pages.flatMap(page => page.files).length, 0);
  assert.equal(pages.at(-1).exhausted, true);
  assert.equal(pages.at(-1).partial, true);
  assert.equal(pages.reduce((count, page) => count + page.contentUnsupported, 0), 1);
  assert.equal(pages.reduce((count, page) => count + page.contentErrors, 0), 1);
  assert.ok(pages.flatMap(page => page.issues).some(issue => issue.path.endsWith('legacy.doc')));
});

test('continuation is tied to authorized roots, query and filters', async t => {
  const { root, service } = await fixture(t, { scanEntries: 1 });
  await writeFile(join(root, 'a.txt'), 'data'); await writeFile(join(root, 'b.txt'), 'data');
  const page = await service.scan({ root, action: 'find', query: 'none' });
  assert.ok(page.nextCursor);
  await assert.rejects(service.scan({ root, action: 'find', query: 'other', cursor: page.nextCursor }), { code: 409 });
  await service.changeRoots({ path: root, remove: true });
  await assert.rejects(service.scan({ root, action: 'find', query: 'none', cursor: page.nextCursor }), { code: 403 });
});

test('alternative search terms share one traversal and extract each Word document once', async t => {
  const { root, service } = await fixture(t);
  const target = join(root, 'trip.docx');
  await writeFile(target, Buffer.from(await docx(wordParagraph('موعد الوصول إلى المطار')).arrayBuffer()));
  const result = await service.scan({ root, action: 'find', query: 'الطيران', queries: ['المطار', 'السفر'], searchIn: 'content' });
  assert.deepEqual(result.files.map(file => file.path), [target]);
  assert.equal(result.files[0].match.matchedQuery, 'المطار');
  assert.equal(result.contentScanned, 1);
  await assert.rejects(service.scan({ root, action: 'find', query: 'x', queries: Array(6).fill('y') }), { code: 400 });
});

test('largest, duplicate and browse reports honor filename and file-type filters', async t => {
  const { root, service } = await fixture(t);
  const word = Buffer.from(await docx(wordParagraph('مطار '.repeat(800))).arrayBuffer());
  const first = join(root, 'target-a.docx'), second = join(root, 'target-b.docx');
  await writeFile(first, word); await writeFile(second, word);
  await writeFile(join(root, 'unrelated.docx'), Buffer.from(await docx(wordParagraph('other')).arrayBuffer()));
  await writeFile(join(root, 'target-large.bin'), Buffer.alloc(word.length * 4, 120));
  await writeFile(join(root, 'target-copy.bin'), Buffer.alloc(word.length * 4, 120));
  const filters = { fileTypes: ['.DOCX'], fileQuery: 'target-*' };
  const largest = await service.scan({ root, action: 'largest', limit: 1, ...filters });
  assert.equal(largest.files.length, 1);
  assert.ok([first, second].includes(largest.files[0].path));
  assert.equal(largest.files[0].size, word.length);
  const duplicates = await service.scan({ root, action: 'duplicates', ...filters });
  assert.equal(duplicates.groups.length, 1);
  assert.deepEqual(new Set(duplicates.groups[0].files.map(file => file.path)), new Set([first, second]));
  const browse = await service.scan({ root, action: 'browse', ...filters });
  assert.deepEqual(new Set(browse.files.map(file => file.path)), new Set([first, second]));
  const named = await service.scan({ root, action: 'largest', query: 'target-b', fileTypes: ['docx'] });
  assert.deepEqual(named.files.map(file => file.path), [second]);
  for (const action of ['find', 'browse', 'largest', 'duplicates']) {
    for (const invalid of [{ fileTypes: 'docx' }, { fileTypes: ['../docx'] }, { fileQuery: 42 }]) {
      await assert.rejects(service.scan({ root, action, query: 'target', ...invalid }), { code: 400 });
    }
  }
});

test('recursive search reaches deeply nested folders across continuation pages without a depth ceiling', async t => {
  const { root, service } = await fixture(t, { scanEntries: 3 });
  let nested = root;
  for (let level = 0; level < 22; level++) { nested = join(nested, 'd' + level); await mkdir(nested); }
  const target = join(nested, 'المطار.docx');
  await writeFile(target, Buffer.from(await docx(wordParagraph('موقع البوابة في مطار الكويت')).arrayBuffer()));
  const byName = await allPages(service, { root, action: 'find', query: 'المطار' });
  assert.deepEqual(byName.flatMap(page => page.files).map(file => file.path), [target]);
  const byContent = await allPages(service, { root, action: 'find', query: 'بوابة', searchIn: 'content' });
  assert.deepEqual(byContent.flatMap(page => page.files).map(file => file.path), [target]);
  assert.ok(byContent.length > 5);
  assert.equal(byContent.at(-1).partial, false);
});

test('RTF Unicode, HTML entities and wildcards search their human-readable text', async t => {
  const { root, service } = await fixture(t);
  await writeFile(join(root, 'airport.rtf'), '{\\rtf1\\ansi\\uc1 \\u1605?\\u1591?\\u1575?\\u1585?}');
  await writeFile(join(root, 'airport.html'), '<html><p>&#1605;طار &amp; السفر</p><script>HIDDEN_TOKEN</script></html>');
  const result = await service.scan({ root, action: 'find', query: 'مطار', searchIn: 'content' });
  assert.equal(result.files.length, 2);
  assert.equal(rtfText('{\\rtf1 \\u1605?\\u1591?\\u1575?\\u1585?}'), 'مطار');
  assert.equal(markupText('<p>مطار &amp; السفر</p>').trim(), 'مطار & السفر');
  assert.equal(fileNameMatches('تقرير[1].docx', '*.docx'), true);
});

function pdfFixture(text) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = 'BT /F1 12 Tf 50 700 Td (' + text + ') Tj ET';
  objects.push('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream');
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(out)); out += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(out);
  out += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return out + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}

test('digital PDF and XLSX contents use local bundled extractors', async t => {
  const { root, service } = await fixture(t);
  await writeFile(join(root, 'airport.pdf'), pdfFixture('AIRPORT_LOCAL_SENTINEL'));
  await writeFile(join(root, 'sheet.xlsx'), Buffer.from(await projectZip([{ path: 'xl/sharedStrings.xml', content: '<sst><si><t>مطار</t></si></sst>' }, { path: 'xl/worksheets/sheet1.xml', content: '<worksheet><row><c t="s"><v>0</v></c></row></worksheet>' }]).arrayBuffer()));
  const pdf = await service.scan({ root, action: 'find', query: 'AIRPORT_LOCAL_SENTINEL', searchIn: 'content', fileQuery: '*.pdf' });
  assert.equal(pdf.files.length, 1, JSON.stringify(pdf));
  assert.equal(pdf.files[0].match.format, 'pdf');
  const spreadsheet = await service.scan({ root, action: 'find', query: 'مطار', searchIn: 'content', fileTypes: ['xlsx'] });
  assert.equal(spreadsheet.files.length, 1);
  assert.equal(spreadsheet.files[0].match.format, 'xlsx');
});
