import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalServer, IMAGE, uploadPiapi } from '../server/local-agent/server.mjs';

test('PiAPI local upload targets only the official host and forwards only its key', async () => {
  const input = { key: 'fake-piapi-key', fileName: 'reference-1.png', data: 'data:image/png;base64,AA==' };
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.equal(url, 'https://upload.theapi.app/api/ephemeral_resource');
    assert.equal(options.headers['x-api-key'], input.key);
    assert.deepEqual(JSON.parse(options.body), { file_name: input.fileName, file_data: input.data });
    return Response.json({ code: 200, data: { url: 'https://files.test/photo.png' } });
  };
  assert.deepEqual(await uploadPiapi(input, request), { url: 'https://files.test/photo.png' });
  await assert.rejects(uploadPiapi({ ...input, fileName: '../private.png' }, request));
  await assert.rejects(uploadPiapi({ ...input, data: 'https://private.test/' }, request));
  assert.equal(calls, 1);
});

test('local runner guards origins, isolates projects, preserves results and never returns provider keys', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sowalif-agent-test-'));
  let job;
  let started = 0;
  const server = createLocalServer({ dataDir, ready: async () => true, launch(options) {
    started++; job = options;
    options.emit({ type: 'approval', id: 'approval1', input: { command: 'node --test' } });
    return { send(answer) { assert.equal(answer.allow, true); }, stop() { options.done(new Error('stopped')); } };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const state = await (await fetch(origin + '/api/agent/status')).json();
  const headers = { 'Content-Type': 'application/json', Origin: origin, 'X-Sowalif-CSRF': state.csrf };
  const post = (path, data, override = {}) => fetch(origin + '/api/agent/' + path, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(data) });
  const input = { projectId: 'project-1', prompt: 'Fix the test', engine: 'claude', provider: 'openrouter', key: 'fake-secret-not-for-output', files: [{ path: 'index.html', content: 'before' }] };
  assert.equal((await post('runs', input, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('runs', input, { 'X-Sowalif-CSRF': 'wrong' })).status, 403);
  assert.equal((await fetch(origin + '/server/local-agent/server.mjs')).status, 404);
  assert.equal((await fetch(origin + '/.local-agent/state.json')).status, 404);
  assert.equal((await post('runs', { ...input, files: [{ path: '../outside.js', content: 'bad' }] })).status, 400);
  assert.equal((await post('runs', { ...input, autoApprove: 'true' })).status, 400);
  assert.equal(started, 0);
  const response = await post('runs', input);
  assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.equal(started, 1);
  assert.equal(job.config.autoApprove, false);
  assert.equal((await readFile(join(job.workspace, 'index.html'), 'utf8')), 'before');
  assert.equal((await post('runs', input)).status, 409);
  assert.equal(started, 1);
  const running = await (await fetch(origin + '/api/agent/project?id=project-1')).json();
  assert.equal(running.activeRun, id);
  assert.equal((await post(`runs/${id}/approval`, { id: 'approval1', allow: true })).status, 200);
  job.emit({ type: 'delta', text: input.key + ' Finished' });
  job.emit({ type: 'result', sessionId: 'session-test' });
  await writeFile(join(job.workspace, 'index.html'), 'after');
  await job.done(null);
  const output = await (await fetch(origin + `/api/agent/runs/${id}`)).json();
  assert.equal(output.state, 'completed');
  assert.equal(output.files[0].content, 'after');
  assert.equal(JSON.stringify(output).includes(input.key), false);
  assert.equal(output.revision, 1);
  assert.equal(output.previewPath, 'index.html');
  const preview = await fetch(origin + '/preview/project-1/index.html');
  assert.match(preview.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.equal(await preview.text(), 'after');
  assert.equal((await fetch(origin + '/js/missing-file.js')).status, 404);
  assert.equal((await fetch(origin + '/api/agent/status')).status, 200);
  assert.equal((await post('runs', input)).status, 409);
  // A project altered outside the browser can be explicitly recovered, then reused.
  await writeFile(join(job.workspace, 'index.html'), 'external edit');
  const recovered = await (await post('recover', { projectId: input.projectId })).json();
  assert.equal(recovered.files[0].content, 'external edit');
  assert.equal(recovered.revision, 2);
  const stateDirectory = (await readdir(dataDir))[0];
  assert.equal((await readFile(join(dataDir, stateDirectory, 'state.json'), 'utf8')).includes(input.key), false);
  const next = await post('runs', { ...input, files: recovered.files, workspaceRevision: recovered.revision, engine: 'codex', provider: 'openai', autoApprove: true });
  assert.equal(next.status, 202);
  const nextId = (await next.json()).id;
  assert.equal((await post(`runs/${nextId}/stop`, {})).status, 200);
  let stopped;
  const deadline = Date.now() + 2000;
  do {
    stopped = await (await fetch(origin + `/api/agent/runs/${nextId}`)).json();
    if (stopped.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(stopped.state, 'stopped');
  assert.equal(started, 2);
  assert.equal(job.config.autoApprove, true);
});

test('the new engine image supports Carbon and Kimi, with legacy fallback for Codex and Claude', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sowalif-modern-engines-'));
  let upgraded = false;
  const launched = [];
  const legacyImage = 'sowalif-coding-agent:1';
  const server = createLocalServer({ dataDir,
    ready: async engine => upgraded ? IMAGE : ['claude', 'codex'].includes(engine) && legacyImage,
    launch(options) {
      launched.push(options);
      return { send() {}, stop() {} };
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const status = async () => (await fetch(origin + '/api/agent/status')).json();
  const before = await status();
  assert.deepEqual(before.engines, ['claude', 'codex']);
  const post = (engine, provider) => fetch(origin + '/api/agent/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Sowalif-CSRF': before.csrf },
    body: JSON.stringify({ engine, provider, projectId: engine, prompt: 'Build the app', key: 'fixture-key', files: [] }),
  });
  assert.equal((await post('antigravity', 'google')).status, 503);
  assert.equal((await post('codex', 'openai')).status, 202);
  assert.equal(launched.at(-1).image, legacyImage);
  launched.at(-1).emit({ type: 'result' });
  await launched.at(-1).done(null);

  upgraded = true;
  assert.deepEqual((await status()).engines, ['claude', 'codex', 'antigravity', 'opencode']);
  assert.equal((await post('antigravity', 'openrouter')).status, 400);
  assert.equal((await post('opencode', 'google')).status, 400);
  for (const [engine, provider, model] of [
    ['antigravity', 'google', 'gemini-4-carbon-high'], ['opencode', 'openrouter', 'openrouter/moonshotai/kimi-k3.1-pro'],
  ]) {
    const response = await post(engine, provider);
    assert.equal(response.status, 202);
    const { id } = await response.json();
    const options = launched.at(-1);
    assert.equal(options.image, IMAGE);
    assert.equal(options.config.model, model);
    const active = await (await fetch(`${origin}/api/agent/project?id=${engine}`)).json();
    assert.deepEqual(active, { activeRun: id, activeEngine: engine });
    options.emit({ type: 'delta', text: 'Implemented' });
    options.emit({ type: 'result' });
    await options.done(null);
    assert.equal((await (await fetch(`${origin}/api/agent/runs/${id}`)).json()).state, 'completed');
  }
});

test('project run transfers large text, binary and archive files without the former JSON/file limits', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sowalif-large-project-'));
  let job;
  const server = createLocalServer({ dataDir, ready: async () => true, launch(options) { job = options; return { stop() {} }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const { csrf } = await (await fetch(origin + '/api/agent/status')).json();
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0xff, 0, 0x80, 0x33]);
  const files = [
    { path: 'large.txt', content: 'long content\n'.repeat(100_000) },
    { path: 'photos.zip', content: bytes.toString('base64'), encoding: 'base64' },
    { path: 'image.png', content: bytes.toString('base64'), encoding: 'base64' },
    ...Array.from({ length: 45 }, (_, index) => ({ path: `file-${index}.txt`, content: 'kept' })),
  ];
  const response = await fetch(origin + '/api/agent/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Sowalif-CSRF': csrf },
    body: JSON.stringify({ projectId: 'large-project', prompt: 'Inspect the project', engine: 'claude', provider: 'openrouter', key: 'fake-api-key', files }),
  });
  assert.equal(response.status, 202, await response.clone().text());
  const { id } = await response.json();
  assert.deepEqual(await readFile(join(job.workspace, 'photos.zip')), bytes);
  assert.deepEqual(await readFile(join(job.workspace, 'image.png')), bytes);
  assert.equal((await readFile(join(job.workspace, 'large.txt'), 'utf8')).length, files[0].content.length);
  assert.match(job.config.prompt, /zipfile\.ZIP_DEFLATED/);
  job.emit({ type: 'result' }); await job.done(null);
  const run = await (await fetch(origin + '/api/agent/runs/' + id)).json();
  assert.equal(run.state, 'completed');
  assert.equal(run.files.length, files.length);
  assert.equal(run.files.find(file => file.path === 'photos.zip').encoding, 'base64');
  assert.deepEqual(Buffer.from(run.files.find(file => file.path === 'image.png').content, 'base64'), bytes);
  assert.equal(run.files.find(file => file.path === 'large.txt').content, files[0].content);
});
