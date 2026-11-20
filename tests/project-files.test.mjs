import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import {
  readProjectFiles, mergeProjectFiles, projectFileBytes, projectFileFromBytes, projectFileSignature,
  isBinaryProjectFile, validProjectPath, projectZip, compressProjectZip,
  applyProjectProposal, extractProjectProposal,
} from '../js/project.js?v=40';
import { readProjectDirectory, writeProjectDirectory } from '../js/project-folder.js?v=40';

test('projects import large text and more than 40 files without the previous fixed caps', async () => {
  const large = '\ufeffسوالف\r\n'.repeat(70_000);
  const files = [new File([large], 'notes.txt'), ...Array.from({ length: 60 }, (_, n) => new File(['x'.repeat(7000)], `file-${n}.unknown`))];
  const { changes, skipped } = await readProjectFiles(files);
  assert.equal(skipped, 0);
  assert.equal(changes.length, 61);
  assert.equal(changes.find(file => file.path === 'notes.txt').content, large);
  assert.equal(mergeProjectFiles([], changes).length, 61);
});

test('all file types and archives preserve exact bytes instead of decoding binary as source text', async () => {
  const data = new Uint8Array([0, 1, 255, 254, 80, 75, 13, 10]);
  const items = ['image.png', 'contract.pdf', 'bundle.zip', 'bundle.rar', 'bundle.7z', 'bundle.tar.gz', 'custom.unknown'].map(name => new File([data], name));
  // Even an archive containing UTF8-compatible bytes stays an archive.
  items.push(new File(['plain-looking archive bytes'], 'validutf8.zip'));
  items.push(new File(['FROM node:24\n'], 'Dockerfile'));
  const { changes } = await readProjectFiles(items);
  for (const file of changes.filter(file => file.path !== 'Dockerfile')) {
    assert.ok(isBinaryProjectFile(file));
    assert.deepEqual(projectFileBytes(file), file.path === 'validutf8.zip' ? new TextEncoder().encode('plain-looking archive bytes') : data);
  }
  assert.equal(changes.find(file => file.path === 'Dockerfile').content, 'FROM node:24\n');
  assert.throws(() => mergeProjectFiles([], [{ path: 'bad.png', encoding: 'base64', content: 'not valid base64!' }]), /غير صالح/);
  assert.throws(() => mergeProjectFiles([], [{ path: 'bad.bin', encoding: 'base64', content: 'AAAA=' }]), /غير صالح/);
});

test('multi-megabyte binary uploads validate without a regex stack limit', () => {
  const bytes = new Uint8Array(8 * 1024 * 1024).fill(255);
  const file = projectFileFromBytes('large.bin', bytes);
  assert.equal(mergeProjectFiles([], [file]).length, 1);
  assert.deepEqual(projectFileBytes(file), bytes);
});

test('text model proposals cannot replace binary files, and typed binary signatures cannot collide with text', () => {
  const file = projectFileFromBytes('image.png', new Uint8Array([0]));
  const project = { revision: 2, files: [file] };
  const proposal = { revision: 2, changes: [{ path: 'IMAGE.PNG', content: 'text replacement' }] };
  assert.throws(() => applyProjectProposal(project, proposal), /الملف الثنائي/);
  const response = '```sowalif-project\n' + JSON.stringify(proposal.changes) + '\n```';
  assert.equal(extractProjectProposal(response, project), null);
  assert.deepEqual(projectFileBytes(project.files[0]), new Uint8Array([0]));
  const text = { path: 'file.txt', content: 'base64:AA==' };
  const binary = projectFileFromBytes('file.txt', new Uint8Array([0]));
  assert.notEqual(projectFileSignature(text), projectFileSignature(binary));
  // File import remains capable of intentional binary replacement.
  const replacement = projectFileFromBytes('image.png', new Uint8Array([1, 2]));
  assert.deepEqual(projectFileBytes(mergeProjectFiles(project.files, [replacement])[0]), new Uint8Array([1, 2]));
});

test('safe dotfiles are accepted while traversal, private credential paths and collisions stay blocked', () => {
  for (const path of ['.gitignore', '.github/workflows/test.yml', '.env.example', '.env.template', 'dist/app.js', 'vendor/library.min.js', 'README', 'folder/document.docx']) assert.ok(validProjectPath(path), path);
  for (const path of ['../file.txt', '/file.png', 'a/../../bad.zip', 'a\\bad.zip', 'a/.git/config', '.env', '.env.production', '.ssh/id_rsa', '.aws/credentials', 'CON.txt', 'a/b:stream']) assert.equal(validProjectPath(path), false, path);
  assert.throws(() => mergeProjectFiles([], [{ path: 'folder', content: '' }, { path: 'folder/image.png', encoding: 'base64', content: '' }]), /ملف ومجلد/);
});

async function unzip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const files = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const packed = view.getUint32(offset + 18, true);
    const size = view.getUint32(offset + 22, true);
    const nameSize = view.getUint16(offset + 26, true);
    const extraSize = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameSize));
    const start = offset + 30 + nameSize + extraSize;
    const data = bytes.subarray(start, start + packed);
    const unpacked = method === 8 ? new Uint8Array(inflateRawSync(data)) : data;
    assert.equal(unpacked.length, size);
    files.push({ name, method, bytes: unpacked });
    offset = start + packed;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint32(end + 16, true), offset);
  assert.equal(view.getUint16(end + 10, true), files.length);
  return files;
}

test('ZIP export compresses content and round-trips binary files and UTF8 filenames', async () => {
  const binary = new Uint8Array(Array.from({ length: 12_000 }, (_, n) => n % 256));
  const files = [{ path: 'شرح.txt', content: 'نص يتكرر للضغط\n'.repeat(10_000) }, projectFileFromBytes('assets/image.png', binary)];
  const stored = projectZip(files);
  const compressed = await compressProjectZip(files);
  assert.ok(compressed.size < stored.size / 10);
  const unpacked = await unzip(compressed);
  assert.ok(unpacked.every(file => file.method === 8));
  assert.deepEqual(unpacked.find(file => file.name === 'assets/image.png').bytes, binary);
  assert.equal(new TextDecoder().decode(unpacked.find(file => file.name === 'شرح.txt').bytes), files[0].content);
  assert.deepEqual((await unzip(stored)).find(file => file.name === 'assets/image.png').bytes, binary);
});

test('ZIP compression falls back to the native zlib wrapper when raw deflate is unavailable', async t => {
  const NativeCompressionStream = globalThis.CompressionStream;
  t.mock.method(globalThis, 'CompressionStream', function (format) {
    if (format === 'deflate-raw') throw new TypeError('Unsupported raw Deflate');
    return new NativeCompressionStream(format);
  });
  const content = 'Fallback test\n'.repeat(5000);
  const files = await unzip(await compressProjectZip([{ path: 'fallback.txt', content }]));
  assert.equal(files[0].method, 8);
  assert.equal(new TextDecoder().decode(files[0].bytes), content);
});

test('folder import and write preserve binary bytes and detect outside edits', async () => {
  const original = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const data = new Map([['photo.png', original]]);
  const root = {
    async *values() { for (const name of data.keys()) yield { kind: 'file', name, getFile: async () => new File([data.get(name)], name) }; },
    async getFileHandle(name, { create } = {}) {
      if (!create && !data.has(name)) throw new DOMException('Missing', 'NotFoundError');
      return {
        getFile: async () => new File([data.get(name)], name),
        createWritable: async () => ({ write: async value => data.set(name, value), close: async () => {}, abort: async () => {} }),
      };
    },
    removeEntry: async name => data.delete(name),
  };
  const files = await readProjectDirectory(root);
  assert.deepEqual(projectFileBytes(files[0]), original);
  const baseline = new Map(files.map(file => [file.path, projectFileSignature(file)]));
  const edited = new Uint8Array([137, 80, 78, 71, 0, 128, 1]);
  const changes = [projectFileFromBytes('photo.png', edited)];
  data.set('photo.png', new Uint8Array([1, 2, 3]));
  await assert.rejects(writeProjectDirectory(root, baseline, changes, []), /تغيّر الملف خارج/);
  data.set('photo.png', original);
  assert.equal(await writeProjectDirectory(root, baseline, changes, []), 1);
  assert.deepEqual(data.get('photo.png'), edited);
  assert.equal(await writeProjectDirectory(root, baseline, changes, []), 0);
});
