import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeToolPermission } from '../server/local-agent/agent-policy.mjs';

test('Claude project file tools work while commands keep the existing approval decision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sowalif-tool-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'workspace'));
  const workspace = join(root, 'workspace');
  await writeFile(join(workspace, 'index.html'), 'before');
  const asked = [];
  const approve = async (...args) => { asked.push(args); return true; };
  for (const [tool, args] of [
    ['Read', { file_path: join(workspace, 'index.html') }],
    ['Write', { file_path: join(workspace, 'new', 'app.js?v=40'), content: 'new' }],
    ['Edit', { file_path: 'index.html' }], ['Glob', { pattern: '**/*.html' }], ['Grep', { pattern: 'before', path: workspace }],
  ]) assert.deepEqual(await claudeToolPermission(tool, args, approve, workspace), { behavior: 'allow', updatedInput: args });
  assert.equal(asked.length, 0);
  const args = { command: 'npm test', description: 'Verify app' };
  assert.equal((await claudeToolPermission('Bash', args, approve, workspace)).behavior, 'allow');
  assert.deepEqual(asked, [['Bash', args]]);
  assert.equal((await claudeToolPermission('Bash', args, async () => false, workspace)).behavior, 'deny');
  assert.equal((await claudeToolPermission('WebFetch', {}, approve, workspace)).behavior, 'deny');
});

test('file tool approval denies paths and symlinks outside the project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sowalif-tool-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'private');
  await mkdir(workspace); await mkdir(outside);
  await symlink(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const [tool, args] of [
    ['Read', { file_path: '../private/secret' }], ['Write', { file_path: join(outside, 'secret') }],
    ['Edit', { file_path: join(workspace, 'linked', 'secret') }],
    ['Glob', { pattern: '../private/*' }], ['Grep', { pattern: 'anything', path: '../private' }],
  ]) assert.equal((await claudeToolPermission(tool, args, async () => assert.fail('File tools must not ask for a shell approval'), workspace)).behavior, 'deny');
});
