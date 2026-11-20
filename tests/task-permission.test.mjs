import test from 'node:test';
import assert from 'node:assert/strict';
import { taskApproval, claudeToolPermission } from '../server/local-agent/agent-policy.mjs';

test('default permission asks about every Bash command', async () => {
  let count = 0;
  const approve = async () => { count++; return true; };
  const decision = taskApproval(approve);
  await claudeToolPermission('Bash', { command: 'npm test' }, decision);
  await claudeToolPermission('Bash', { command: 'git status' }, decision);
  assert.equal(count, 2);
});

test('explicit full permission bypasses prompts only within the selected run', async () => {
  let count = 0;
  const approve = async () => { count++; return false; };
  const decision = taskApproval(approve, true);
  for (const command of ['npm test', 'git status']) assert.equal((await claudeToolPermission('Bash', { command }, decision)).behavior, 'allow');
  assert.equal(count, 0);
  assert.equal((await claudeToolPermission('Bash', { command: 'git status' }, taskApproval(approve, false))).behavior, 'deny');
  assert.equal(count, 1);
});

test('automatic mode does not bypass file confinement or enable new tools', async () => {
  const decision = taskApproval(async () => true, true);
  assert.equal((await claudeToolPermission('Read', { file_path: '../private' }, decision)).behavior, 'deny');
  assert.equal((await claudeToolPermission('WebFetch', {}, decision)).behavior, 'deny');
  assert.equal(taskApproval(async () => false, 'true') instanceof Function, true);
});
