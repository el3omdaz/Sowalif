import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactFile, listArtifacts, validArtifactPath } from '../server/local-agent/artifacts.mjs';
import { snapshot, createLocalServer } from '../server/local-agent/server.mjs';

test('generated documents are listed as binary downloads, outside source snapshots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sowalif-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'outputs'));
  const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 1, 2]);
  await writeFile(join(root, 'outputs', 'تقرير.xlsx'), bytes);
  await writeFile(join(root, 'outputs', 'private.env'), 'not downloadable');
  await writeFile(join(root, 'index.html'), 'source');
  assert.deepEqual(await listArtifacts(root), [{ path: 'outputs/تقرير.xlsx', name: 'تقرير.xlsx', size: bytes.length }]);
  assert.equal((await artifactFile(root, 'outputs/تقرير.xlsx')).size, bytes.length);
  assert.deepEqual(await snapshot(root), [{ path: 'index.html', content: 'source' }]);
  for (const path of ['../outputs/a.pdf', 'outputs/../a.pdf', 'outputs/.hidden.pdf', 'outputs/a.exe', 'outputs/a\\b.pdf', 'outputs/a.pdf\r\nx-header: bad']) {
    assert.equal(validArtifactPath(path), false);
    await assert.rejects(artifactFile(root, path));
  }
});

test('artifact endpoint preserves bytes, Unicode filename and persisted downloads after server restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sowalif-download-'));
  let job;
  const server = createLocalServer({ dataDir, ready: async () => true, launch(options) { job = options; return { stop() {} }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { csrf } = await (await fetch(origin + '/api/agent/status')).json();
  const response = await fetch(origin + '/api/agent/runs', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Sowalif-CSRF': csrf }, body: JSON.stringify({ projectId: 'docs', prompt: 'Make a PDF', engine: 'codex', provider: 'openai', key: 'fake-test-key', files: [] }) });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  await mkdir(join(job.workspace, 'outputs'));
  const bytes = Buffer.from('%PDF-1.7\n test document\n%%EOF');
  await writeFile(join(job.workspace, 'outputs', 'تقرير.pdf'), bytes);
  assert.match(job.config.prompt, /without requiring a special mode/);
  job.emit({ type: 'result' }); await job.done(null);
  const run = await (await fetch(origin + '/api/agent/runs/' + id)).json();
  assert.equal(run.artifacts[0].name, 'تقرير.pdf');
  assert.deepEqual(run.files, []);
  const url = '/api/agent/artifact?project=docs&path=' + encodeURIComponent('outputs/تقرير.pdf');
  const file = await fetch(origin + url);
  assert.match(file.headers.get('content-disposition'), /attachment;/);
  assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  assert.equal((await fetch(origin + '/api/agent/artifact?project=docs&path=../state.json')).status, 400);
  assert.equal((await fetch(origin + '/api/agent/project?id=docs').then(r => r.json())).artifacts.length, 1);
  // A new server instance can recover artifacts from disk without a job in RAM.
  const second = createLocalServer({ dataDir });
  await new Promise(resolve => second.listen(0, '127.0.0.1', resolve));
  try { assert.equal((await fetch(`http://127.0.0.1:${second.address().port}${url}`)).status, 200); }
  finally { await new Promise(resolve => second.close(resolve)); }
});

test('symlinks cannot expose files outside generated output directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sowalif-artifact-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'outputs')); await writeFile(join(root, 'secret.pdf'), 'private');
  try { await symlink(join(root, 'secret.pdf'), join(root, 'outputs', 'leak.pdf')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  assert.deepEqual(await listArtifacts(root), []);
  await assert.rejects(artifactFile(root, 'outputs/leak.pdf'));
});
