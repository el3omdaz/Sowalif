import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../server/local-agent/server.mjs';

test('local file tools keep actions in approved folders and preserve deleted files', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sowalif-files-test-')));
  const root = join(base, 'home');
  const dataDir = join(base, 'control');
  const outside = join(base, 'outside.txt');
  const nested = join(root, 'documents');
  await mkdir(nested, { recursive: true });
  const first = join(root, 'a.txt');
  const duplicate = join(nested, 'copy.txt');
  const other = join(root, 'b.txt');
  await writeFile(first, 'welcome');
  await writeFile(duplicate, 'welcome');
  await writeFile(other, 'general');
  await writeFile(join(root, 'large.bin'), Buffer.alloc(100));
  await writeFile(outside, 'private');
  const symlinkPath = join(root, 'escape.txt');
  const linked = await symlink(outside, symlinkPath, 'file').then(() => true, error => {
    if (error.code === 'EPERM') return false;
    throw error;
  });
  let dockerChecks = 0;
  const server = createLocalServer({ dataDir, ready: async () => { dockerChecks++; return true; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const { csrf } = await (await fetch(origin + '/api/files/session')).json();
  assert.equal(typeof csrf, 'string');
  assert.equal((await fetch(origin + '/api/files/session', { headers: { Origin: 'https://other.test' } })).status, 403);
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Sowalif-CSRF': csrf };
  const request = (route, params, overrides = {}) => fetch(origin + '/api/files/' + route, {
    method: 'POST',
    headers: { ...headers, ...overrides },
    body: JSON.stringify(params),
  });
  const post = async (route, params) => {
    const response = await request(route, params);
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    return result;
  };

  assert.equal((await request('roots', { path: root }, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await request('roots', { path: root }, { 'X-Sowalif-CSRF': 'wrong' })).status, 403);
  assert.equal((await request('scan', { root, action: 'largest' })).status, 403);
  assert.deepEqual((await post('roots', { path: root })).roots, [{ path: root }]);
  assert.deepEqual(await (await fetch(origin + '/api/files/roots')).json(), { roots: [{ path: root }] });
  assert.equal((await fetch(origin + '/api/files/roots', { headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await post('scan', { root, action: 'largest', limit: 1 })).files[0].size, 100);
  assert.equal((await post('scan', { root, action: 'browse' })).files[0].kind, 'directory');
  assert.deepEqual((await post('scan', { root, directory: nested, action: 'browse' })).files.map(file => file.path), [duplicate]);
  assert.deepEqual((await post('scan', { root, action: 'find', query: 'copy' })).files.map(file => file.path), [duplicate]);
  assert.equal((await post('scan', { root, action: 'find', query: 'welcome' })).files.length, 0);
  assert.equal((await post('scan', { root, action: 'find', query: 'welcome', searchContent: true })).files.length, 2);
  const { groups } = await post('scan', { root, action: 'duplicates' });
  assert.equal(groups.length, 1);
  assert.deepEqual(new Set(groups[0].files.map(file => file.path)), new Set([first, duplicate]));
  assert.deepEqual(await post('read', { root, path: other }), { text: 'general', partial: false });
  assert.equal((await request('read', { root, path: outside })).status, 403);
  if (linked) assert.equal((await request('read', { root, path: symlinkPath })).status, 400);
  await post('change', { action: 'mkdir', path: join(root, 'sub') });
  const note = join(root, 'sub', 'note.txt');
  await post('change', { action: 'create', path: note, content: 'note' });
  const copy = join(root, 'sub', 'other.txt');
  await post('change', { action: 'copy', path: note, destination: copy });
  assert.equal(await readFile(copy, 'utf8'), 'note');
  assert.equal((await request('change', { action: 'move', path: note, destination: copy })).status, 409);
  assert.equal((await request('change', { action: 'move', path: note, destination: outside })).status, 403);
  const trash = await post('change', { action: 'trash', path: note });
  assert.match(trash.destination, /\.sowalif-trash/);
  await assert.rejects(readFile(note), { code: 'ENOENT' });
  assert.equal(await readFile(trash.destination, 'utf8'), 'note');
  assert.equal((await request('change', { action: 'restore', path: trash.destination, destination: join(root, 'somewhere.txt') })).status, 400);
  await post('change', { action: 'restore', path: trash.destination, destination: note });
  assert.equal(await readFile(note, 'utf8'), 'note');
  const moved = join(root, 'moved.txt');
  await post('change', { action: 'move', path: note, destination: moved });
  assert.equal(await readFile(moved, 'utf8'), 'note');
  const secondRoot = join(base, 'second');
  await mkdir(secondRoot);
  const secondCopy = join(secondRoot, 'welcome.txt');
  await writeFile(secondCopy, 'welcome');
  await post('roots', { path: nested });
  await post('roots', { path: secondRoot });
  const combined = await post('scan', { root: '*', action: 'duplicates' });
  assert.ok(combined.groups.some(group => group.count === 3 &&
    new Set(group.files.map(file => file.path)).size === 3 && group.files.some(file => file.path === secondCopy)));
  assert.deepEqual(await post('read', { root: '*', path: secondCopy }), { text: 'welcome', partial: false });
  await post('roots', { path: nested, remove: true });
  await post('roots', { path: secondRoot, remove: true });
  assert.deepEqual((await post('roots', { path: root, remove: true })).roots, []);
  assert.equal((await request('scan', { root, action: 'largest' })).status, 403);
  assert.equal(await readFile(outside, 'utf8'), 'private');
  assert.equal(dockerChecks, 0);
});
