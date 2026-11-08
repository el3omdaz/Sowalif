import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
const storage = new Map([['sc.cloudProfile', '11111111-1111-4111-8111-111111111111'], ['sc.kieKey', '"base-key"']]);
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
const first = await import('../js/db.js?tab-one');
const second = await import('../js/db.js?tab-two');
const chat = id => ({ id, title: id, updatedAt: 100, messages: [{ role: 'user', text: id }] });

test('two database connections queue changes atomically and cannot acknowledge a newer edit', async () => {
  await Promise.all([first.saveChat(chat('a'), false), second.saveChat(chat('b'), false)]);
  const initial = await first.readCloudState();
  assert.ok(initial.dirty.a); assert.ok(initial.dirty.b);
  const edited = { ...chat('a'), messages: [{ role: 'user', text: 'new edit' }] };
  await second.saveChat(edited, false); // Same timestamp deliberately: the outbox must still protect it.
  await first.recordCloudVersion('a', 1, initial.dirty.a.generation);
  let queue = await first.readCloudState();
  assert.ok(queue.dirty.a);
  assert.notEqual(queue.dirty.a.generation, initial.dirty.a.generation);
  assert.equal(await first.applyCloudChat({ ...chat('a'), title: 'stale remote' }, 100), false);
  assert.equal((await first.getChat('a')).messages[0].text, 'new edit');
  await first.recordCloudVersion('a', 2, queue.dirty.a.generation);
  queue = await second.readCloudState();
  assert.equal(queue.dirty.a, undefined);
  assert.equal(await second.applyCloudChat({ ...chat('a'), title: 'new remote' }, 100), true);
  await second.deleteChat('a');
  assert.equal((await first.readCloudState()).dirty.a.deleted, true);
});

test('cloud accounts keep their local provider keys and memory separate from device mode', async () => {
  assert.equal(first.settings.get('kieKey', ''), '');
  first.settings.set('kieKey', 'account-one-key');
  first.settings.set('customInstructions', 'account-one-memory');
  assert.equal(storage.get('sc.kieKey'), '"base-key"');
  storage.set('sc.cloudProfile', '22222222-2222-4222-8222-222222222222');
  const other = await import('../js/db.js?other-account');
  assert.equal(other.settings.get('kieKey', ''), '');
  assert.equal(other.settings.get('customInstructions', ''), '');
  assert.equal((await other.listChats()).length, 0);
  assert.equal(first.settings.get('kieKey', ''), 'account-one-key');
});
