import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareProjectPush, pushProject } from '../js/project-github.js?v=48';
import { extractProjectProposal, readProjectFiles } from '../js/project.js?v=48';
import { writeProjectDirectory } from '../js/project-folder.js?v=48';

test('folder input keeps nested paths relative to the chosen root', async () => {
  const files = [
    { webkitRelativePath: 'My Project/src/app.js', size: 5, text: async () => 'hello' },
    { webkitRelativePath: 'My Project/.git/secret.txt', size: 1, text: async () => { throw Error('private path read'); } },
  ];
  assert.deepEqual(await readProjectFiles(files), {
    changes: [{ path: 'src/app.js', content: 'hello' }], skipped: 1,
  });
});

test('a targeted model edit must match one exact source range', () => {
  const response = edits => ['اقتراح', '\x60\x60\x60sowalif-project', JSON.stringify([{ path: 'app.js', edits }]), '\x60\x60\x60'].join('\n');
  const project = { revision: 2, files: [{ path: 'app.js', content: 'const before = 1; // comment' }] };
  const result = extractProjectProposal(response([{ before: 'before = 1', after: 'after = 2' }]), project);
  assert.deepEqual(result.proposal.changes, [{ path: 'app.js', content: 'const after = 2; // comment' }]);
  assert.equal(extractProjectProposal(response([{ before: 'o', after: 'x' }]), project), null);
});

test('saving a linked folder checks for outside changes before writing', async () => {
  const data = new Map([['a.js', 'before'], ['b.js', 'external']]);
  const baseline = new Map([['a.js', 'before'], ['b.js', 'original']]);
  const root = {
    async getFileHandle(name, { create } = {}) {
      if (!create && !data.has(name)) throw new DOMException('Missing', 'NotFoundError');
      return {
        getFile: async () => ({ text: async () => data.get(name) }),
        createWritable: async () => ({ write: async value => data.set(name, value), close: async () => {} }),
      };
    },
    removeEntry: async name => data.delete(name),
  };
  const files = [{ path: 'a.js', content: 'after' }, { path: 'new.js', content: 'new' }];
  await assert.rejects(writeProjectDirectory(root, baseline, files, ['b.js']), /b\.js/);
  assert.equal(data.get('a.js'), 'before');
  data.set('b.js', 'original');
  assert.equal(await writeProjectDirectory(root, baseline, files, ['b.js']), 3);
  assert.deepEqual([...data], [['a.js', 'after'], ['new.js', 'new']]);
  assert.equal(await writeProjectDirectory(root, baseline, files, ['b.js']), 0);
});

test('GitHub reviews a delta and publishes one commit on a new branch', async (t) => {
  const sha = n => String(n).repeat(40);
  const keep = createHash('sha1').update('blob 4\0keep').digest('hex');
  const writes = [];
  let base = sha(1);
  let createdRef;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer test-token');
    const path = url.replace('https://api.github.com/repos/owner/repo', '');
    if (request.method === 'GET') {
      if (!path) return Response.json({ default_branch: 'main' });
      if (path === '/git/ref/heads/main') return Response.json({ object: { sha: base } });
      if (path.startsWith('/git/ref/heads/sowalif/')) return Response.json({ object: { sha: createdRef.sha } });
      if (path.startsWith('/git/commits/')) return Response.json({ tree: { sha: sha(2) } });
      if (path.startsWith('/git/trees/')) return Response.json({ tree: [
        { path: 'keep.js', type: 'blob', mode: '100644', sha: keep },
        { path: 'remove.js', type: 'blob', mode: '100755', sha: sha(3) },
      ] });
    }
    const body = JSON.parse(request.body);
    writes.push({ path, body });
    if (path === '/git/trees') return Response.json({ sha: sha(4) });
    if (path === '/git/commits') return Response.json({ sha: sha(5) });
    if (path === '/git/refs') {
      createdRef = body;
      throw new TypeError('Connection lost after GitHub created the branch');
    }
    throw new Error('Unexpected request');
  });
  const plan = await prepareProjectPush({
    repository: 'https://github.com/owner/repo.git', token: 'test-token',
    files: [{ path: 'keep.js', content: 'keep' }, { path: 'add.js', content: 'new' }], removed: ['remove.js'],
  });
  assert.equal(writes.length, 0);
  assert.deepEqual(plan.changes.map(change => change.entry.path), ['add.js', 'remove.js']);
  base = sha(9);
  await assert.rejects(pushProject(plan, 'test-token', 'Update project'), /تغيّر الفرع/);
  assert.equal(writes.length, 0);
  base = sha(1);
  assert.match(await pushProject(plan, 'test-token', 'Update project'), /github\.com\/owner\/repo\/compare\/main/);
  assert.deepEqual(writes.map(write => write.path), ['/git/trees', '/git/commits', '/git/refs']);
  assert.equal(writes[0].body.base_tree, sha(2));
  assert.equal(writes[0].body.tree[1].sha, null);
  assert.deepEqual(createdRef, { ref: `refs/heads/${plan.branch}`, sha: sha(5) });
  await pushProject(plan, 'test-token', 'Update project');
  assert.equal(writes.length, 3);
});

test('GitHub compares binary bytes and creates base64 blobs without changing unchanged binary files', async t => {
  const sha = value => String(value).repeat(40);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x80]);
  const zip = Buffer.from([0x50, 0x4b, 3, 4, 0, 0xfe, 0, 0xff]);
  const pngHash = createHash('sha1').update(`blob ${png.length}\0`).update(png).digest('hex');
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const path = url.replace('https://api.github.com/repos/owner/repo', '');
    if (request.method === 'GET') {
      if (!path) return Response.json({ default_branch: 'main' });
      if (path === '/git/ref/heads/main') return Response.json({ object: { sha: sha(1) } });
      if (path.startsWith('/git/commits/')) return Response.json({ tree: { sha: sha(2) } });
      if (path.startsWith('/git/trees/')) return Response.json({ tree: [{ path: 'logo.png', type: 'blob', mode: '100644', sha: pngHash }] });
    }
    const body = JSON.parse(request.body);
    writes.push({ path, body });
    if (path === '/git/blobs') return Response.json({ sha: sha(3) });
    if (path === '/git/trees') return Response.json({ sha: sha(4) });
    if (path === '/git/commits') return Response.json({ sha: sha(5) });
    if (path === '/git/refs') return Response.json({ object: { sha: sha(5) } });
    throw new Error('Unexpected request ' + path);
  });
  const plan = await prepareProjectPush({ repository: 'owner/repo', token: 'test-token', files: [
    { path: 'logo.png', content: png.toString('base64'), encoding: 'base64' },
    { path: 'archive.zip', content: zip.toString('base64'), encoding: 'base64' },
  ] });
  assert.equal(writes.length, 0, 'review never writes remote objects');
  assert.deepEqual(plan.changes.map(change => change.entry.path), ['archive.zip']);
  await pushProject(plan, 'test-token', 'Upload ZIP');
  assert.deepEqual(writes[0], { path: '/git/blobs', body: { content: zip.toString('base64'), encoding: 'base64' } });
  assert.deepEqual(writes[1].body.tree, [{ path: 'archive.zip', mode: '100644', type: 'blob', sha: sha(3) }]);
});

test('GitHub commits to a selected existing branch without force and recovers an interrupted push', async t => {
  const sha = value => String(value).repeat(40);
  let head = sha(1);
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const path = url.replace('https://api.github.com/repos/owner/repo', '');
    if (request.method === 'GET') {
      if (!path) return Response.json({ default_branch: 'main' });
      if (path === '/git/ref/heads/release/v1') return Response.json({ object: { sha: head } });
      if (path.startsWith('/git/commits/')) return Response.json({ tree: { sha: sha(2) } });
      if (path.startsWith('/git/trees/')) return Response.json({ tree: [] });
    }
    const body = JSON.parse(request.body);
    writes.push({ path, method: request.method, body });
    if (path === '/git/trees') return Response.json({ sha: sha(4) });
    if (path === '/git/commits') return Response.json({ sha: sha(5) });
    if (path === '/git/refs/heads/release/v1') {
      assert.equal(request.method, 'PATCH');
      assert.equal(body.force, false);
      head = body.sha;
      throw new TypeError('Connection lost after GitHub accepted push');
    }
    throw new Error('Unexpected request ' + path);
  });
  const plan = await prepareProjectPush({ repository: 'owner/repo', token: 'test-token', files: [{ path: 'a.txt', content: 'revision' }], baseBranch: 'release/v1', pushMode: 'current' });
  assert.equal(plan.branch, 'release/v1');
  const url = await pushProject(plan, 'test-token', 'Update release');
  assert.equal(url, `https://github.com/owner/repo/commit/${sha(5)}`);
  assert.equal(writes.length, 3);
  assert.equal(await pushProject(plan, 'test-token', 'Update release'), url);
  assert.equal(writes.length, 3, 'a retry does not create duplicate commits');
});

test('a GitHub push never forces over a concurrent update after review', async t => {
  const sha = value => String(value).repeat(40);
  let head = sha(1);
  let updates = 0;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const path = url.replace('https://api.github.com/repos/owner/repo', '');
    if (request.method === 'GET') {
      if (!path) return Response.json({ default_branch: 'main' });
      if (path === '/git/ref/heads/main') return Response.json({ object: { sha: head } });
      if (path.startsWith('/git/commits/')) return Response.json({ tree: { sha: sha(2) } });
      if (path.startsWith('/git/trees/')) return Response.json({ tree: [] });
    }
    if (path === '/git/trees') return Response.json({ sha: sha(4) });
    if (path === '/git/commits') { head = sha(6); return Response.json({ sha: sha(5) }); }
    if (path === '/git/refs/heads/main') {
      updates++;
      assert.equal(JSON.parse(request.body).force, false);
      return Response.json({ message: 'Update is not a fast forward' }, { status: 422 });
    }
    throw new Error('Unexpected request ' + path);
  });
  const plan = await prepareProjectPush({ repository: 'owner/repo', token: 'test-token', files: [{ path: 'a.txt', content: 'revision' }], pushMode: 'current' });
  await assert.rejects(pushProject(plan, 'test-token', 'Update main'), /أعد المراجعة/);
  assert.equal(head, sha(6));
  assert.equal(updates, 1);
});
