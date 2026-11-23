import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLocalServer, IMAGE, snapshot } from '../server/local-agent/server.mjs';
import { projectZip } from '../js/project.js?v=50';
import { materializeInputs, stageInput } from '../server/local-agent/inputs.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sowalif-original-inputs-'));
  const launches = [];
  const server = createLocalServer({ dataDir, ready: async () => IMAGE, launch(job) { launches.push(job); return { stop() {} }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { csrf } = await (await fetch(origin + '/api/agent/status')).json();
  const headers = { Origin: origin, 'X-Sowalif-CSRF': csrf };
  const upload = async (name, bytes, project = 'chat-files', extra = {}) => {
    const response = await fetch(origin + '/api/agent/input?' + new URLSearchParams({ project, name }), {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', ...extra }, body: bytes,
    });
    return { response, data: await response.json() };
  };
  const run = async (attachments, { projectId = 'chat-files', direct = false, engine = 'claude', files = [] } = {}) => {
    const response = await fetch(origin + '/api/agent/runs', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, direct, attachments, engine, provider: engine === 'codex' ? 'openai' : 'openrouter', key: 'fake-test-key', prompt: 'Read every page and relevant archive entry, then create a ZIP.', files }),
    });
    return { response, data: await response.json() };
  };
  return { dataDir, origin, headers, upload, run, launches };
}

test('original PDF and whole archive stream into the coding workspace and return as exact downloadable bytes', async t => {
  const f = await fixture(t);
  const pdf = Buffer.from('%PDF-1.7\n' + Array.from({ length: 125 }, (_, n) => `/Page ${n + 1}: complete original text\n`).join('') + '\n%%EOF');
  const archive = Buffer.from(await projectZip(Array.from({ length: 121 }, (_, n) => ({ path: `pages/page-${n}.txt`, content: 'Page ' + n + ' content.' }))).arrayBuffer());
  const names = ["تقرير كامل 125 صفحة.pdf", "أرشيف كامل + ملحق 'نهائي'.zip"];
  const uploads = [];
  for (const [index, bytes] of [pdf, archive].entries()) {
    const { response, data } = await f.upload(names[index], bytes);
    assert.equal(response.status, 201, JSON.stringify(data));
    assert.equal(data.size, bytes.length);
    assert.equal(data.sha256, digest(bytes));
    const cached = await (await fetch(f.origin + '/api/agent/input?' + new URLSearchParams({ project: 'chat-files', id: data.id }))).json();
    assert.deepEqual(cached, data);
    uploads.push(data);
  }
  const { response, data } = await f.run(uploads.map(({ id }) => ({ id })));
  assert.equal(response.status, 202, JSON.stringify(data));
  const job = f.launches[0];
  assert.match(job.config.prompt, /Complete original attachments/);
  assert.match(job.config.prompt, /all pages, sheets/);
  assert.match(job.config.prompt, /Deploy or publish only when the user explicitly requests it/);
  assert.match(job.config.prompt, /GitHub Pages cannot run a backend/);
  assert.doesNotMatch(job.config.prompt, /Do not deploy or publish\./);
  for (const [index, uploaded] of uploads.entries()) {
    const inputPath = join(job.workspace, '.sowalif-inputs', uploaded.id, uploaded.name);
    assert.deepEqual(await readFile(inputPath), [pdf, archive][index]);
    assert.ok(job.config.prompt.includes(uploaded.sha256));
    assert.ok(job.config.prompt.includes('/workspace/.sowalif-inputs/' + uploaded.id + '/' + uploaded.name));
  }
  assert.deepEqual(await snapshot(job.workspace), []);
  await mkdir(join(job.workspace, 'outputs'));
  await copyFile(join(job.workspace, '.sowalif-inputs', uploads[1].id, names[1]), join(job.workspace, 'outputs', names[1]));
  job.emit({ type: 'result' }); await job.done(null);
  const result = await (await fetch(f.origin + '/api/agent/runs/' + data.id)).json();
  assert.equal(result.artifacts[0].name, names[1]);
  const download = await fetch(f.origin + '/api/agent/artifact?' + new URLSearchParams({ project: 'chat-files', path: 'outputs/' + names[1] }));
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  const filename = /filename\*=UTF-8''([^;]+)/.exec(download.headers.get('content-disposition'))[1];
  assert.equal(decodeURIComponent(filename), names[1]);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), archive);
});

test('raw uploads above the former 40MB ceiling preserve every byte without JSON/base64 buffering', async t => {
  const f = await fixture(t);
  const length = 41 * 1024 * 1024 + 123;
  const hash = createHash('sha256');
  let sent = 0;
  const chunks = Readable.from((function* () {
    while (sent < length) {
      const next = Buffer.alloc(Math.min(64 * 1024, length - sent), sent % 251);
      sent += next.length; hash.update(next); yield next;
    }
  })());
  const response = await fetch(f.origin + '/api/agent/input?project=large&name=whole-archive.7z', {
    method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/octet-stream' }, body: chunks, duplex: 'half',
  });
  const uploaded = await response.json();
  assert.equal(response.status, 201, JSON.stringify(uploaded));
  assert.equal(uploaded.size, length);
  assert.equal(uploaded.sha256, hash.digest('hex'));
  const result = await f.run([{ id: uploaded.id }], { projectId: 'large', engine: 'codex' });
  assert.equal(result.response.status, 202, JSON.stringify(result.data));
  const bytes = await readFile(join(f.launches[0].workspace, '.sowalif-inputs', uploaded.id, uploaded.name));
  assert.equal(bytes.length, length);
  assert.equal(digest(bytes), uploaded.sha256);
  f.launches[0].emit({ type: 'result' }); await f.launches[0].done(null);
});

test('input IDs are project-isolated and cannot introduce paths, symlinks, or corrupted bytes', async t => {
  const f = await fixture(t);
  const raw = Buffer.from([0, 0xff, 1, 2, 3, 4]);
  assert.equal((await f.upload('../outside.pdf', raw)).response.status, 400);
  assert.equal((await f.upload('ok.pdf', raw, 'chat-files', { Origin: 'https://other.test' })).response.status, 403);
  assert.equal((await f.upload('ok.pdf', raw, 'chat-files', { 'X-Sowalif-CSRF': 'wrong' })).response.status, 403);
  assert.equal((await f.upload('ok.pdf', raw, 'chat-files', { 'Content-Type': 'application/json' })).response.status, 403);
  const { data } = await f.upload('original.pdf', raw);
  assert.equal((await f.run([{ id: data.id }], { projectId: 'other-chat' })).response.status, 404);
  assert.equal((await f.run([{ id: '../outside' }])).response.status, 400);
  assert.equal(f.launches.length, 0);
  const base = createHash('sha256').update('chat-files').digest('hex').slice(0, 32);
  await writeFile(join(f.dataDir, base, 'inputs', data.id, 'original'), Buffer.from([9, 9, 9, 9, 9, 9]));
  const rejected = await f.run([{ id: data.id }]);
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.data.error, /غير مكتمل|تغيّر/);
  assert.equal(f.launches.length, 0);
});

test('linked coding folders receive original chat inputs without replacing user project files', async t => {
  const f = await fixture(t);
  const linked = join(f.dataDir, 'user-project'); await mkdir(linked);
  await writeFile(join(linked, 'keep.txt'), 'existing user content');
  const link = await fetch(f.origin + '/api/agent/link', { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'chat-files', directory: linked }) });
  assert.equal(link.status, 200);
  const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 19]);
  const { data } = await f.upload('all-files.zip', bytes);
  const request = await f.run([{ id: data.id }], { direct: true, engine: 'codex' });
  assert.equal(request.response.status, 202, JSON.stringify(request.data));
  const job = f.launches[0];
  assert.deepEqual(await readFile(join(job.workspace, '.sowalif-inputs', data.id, data.name)), bytes);
  assert.equal(await readFile(join(job.workspace, 'keep.txt'), 'utf8'), 'existing user content');
  job.emit({ type: 'result' }); await job.done(null);
});

test('interrupted original streams are removed and input directories cannot redirect copies outside the project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sowalif-interrupted-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, 'staging'); await mkdir(staging);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const outside = join(root, 'outside'); await mkdir(outside);
  const broken = Readable.from((async function* () { yield Buffer.from('incomplete'); throw new Error('Upload disconnected'); })());
  await assert.rejects(stageInput(staging, 'whole.zip', broken), /Upload disconnected/);
  assert.deepEqual(await readdir(join(staging, 'inputs')), []);
  const input = await stageInput(staging, 'whole.zip', Readable.from([Buffer.from([0x50, 0x4b, 0, 0xff])]));
  await symlink(outside, join(workspace, '.sowalif-inputs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(materializeInputs(staging, workspace, [{ id: input.id }]), /مجلد المرفقات غير صالح/);
  assert.deepEqual(await readdir(outside), []);
});
