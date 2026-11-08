import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { cloudChat, cloudMemory } from '../js/cloud-payload.js?v=20';

function fixture({ local = [], remote = [], versions = {}, dirty = {}, beforeUpdate } = {}) {
  const user = { id: '11111111-1111-4111-8111-111111111111' };
  const chats = new Map(local.map(c => [c.id, structuredClone(c)]));
  const rows = new Map(remote.map(c => [c.id, { user_id: user.id, ...structuredClone(c) }]));
  let listener, counter = 0, refreshed = 0;
  const settings = new Map([['cloudSyncState', { versions, dirty }]]);
  const queue = { versions: structuredClone(versions), dirty: structuredClone(dirty) };
  for (const item of local) if (!queue.versions[item.id] && !queue.dirty[item.id]) queue.dirty[item.id] = { generation: 'initial-' + item.id };
  const memory = { instructions: 'Local instructions', notes: '', enabled: true, rules: [] };
  const db = {
    profileId: user.id, uid: () => 'new-' + ++counter,
    settings: { get: (key, fallback) => structuredClone(settings.get(key) ?? fallback), set: (key, value) => (settings.set(key, structuredClone(value)), true) },
    onLocalChange: fn => { listener = fn; }, listChats: async () => [...chats.values()], getChat: async id => structuredClone(chats.get(id)),
    getBlob: async () => null,
    saveChat: async chat => { chats.set(chat.id, structuredClone(chat)); queue.dirty[chat.id] = { generation: 'g-' + ++counter }; await listener({ id: chat.id }); },
    readCloudState: async () => structuredClone(queue),
    queueCloudMemory: async () => { queue.dirty['@memory'] = { generation: 'g-' + ++counter }; },
    recordCloudVersion: async (id, revision, generation, signature) => { queue.versions[id] = revision; if (queue.dirty[id]?.generation === generation) delete queue.dirty[id]; if (signature !== undefined) queue.memorySignature = signature; },
    clearCloudDirty: async (id, generation) => { if (queue.dirty[id]?.generation === generation) delete queue.dirty[id]; },
    applyCloudChat: async (chat, expected, deleted) => { if ((chats.get(chat.id)?.updatedAt || 0) !== expected) return false; if (deleted) chats.delete(chat.id); else chats.set(chat.id, structuredClone(chat)); return true; },
  };
  class Query {
    filters = []; op = 'select';
    select() { return this; } eq(key, value) { this.filters.push([key, value]); return this; } order() { return this; }
    range() { return this; } update(value) { this.op = 'update'; this.value = value; return this; }
    insert(value) { this.op = 'insert'; this.value = value; return this; } single() { this.one = true; return this; }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
    async execute() {
      if (this.op === 'insert') {
        if (rows.has(this.value.id)) return { error: { code: '23505' } };
        const row = { ...structuredClone(this.value), revision: 1 }; rows.set(row.id, row); return { data: [row] };
      }
      if (this.op === 'update') await beforeUpdate?.({ rows, chats, db, listener });
      const matches = [...rows.values()].filter(row => this.filters.every(([key, value]) => row[key] === value));
      if (this.op === 'update') for (const row of matches) Object.assign(row, structuredClone(this.value), { revision: row.revision + 1 });
      return { data: structuredClone(this.one ? matches[0] : matches) };
    }
  }
  const client = { auth: { getSession: async () => ({ data: { session: { user } } }) }, from: () => new Query() };
  const context = vm.createContext({ db, CLOUD: { url: 'https://test.invalid', publishableKey: 'public-only' }, createClient: () => client,
    cloudChat, cloudMemory, readPersonalization: () => structuredClone(memory), structuredClone, Blob, AbortSignal,
    setTimeout: () => 1, clearTimeout() {}, setInterval() {}, document: { visibilityState: 'visible', addEventListener() {} }, window: { addEventListener() {} },
    localStorage: { setItem(key, value) { const property = { customInstructions: 'instructions', personalNotes: 'notes', memoryEnabled: 'enabled', sharedRules: 'rules' }[key.split('.').at(-1)]; if (property) memory[property] = JSON.parse(value); } },
  });
  const source = readFileSync(new URL('../js/cloud.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source + '\nthis.api = { initCloud, syncCloud, resolveMemoryConflict, memoryConflict };', context);
  return { chats, rows, memory, db, settings, api: context.api, init: () => context.api.initCloud({ refresh: () => { refreshed++; } }), get refreshed() { return refreshed; } };
}
const chat = (text, updatedAt = 1) => ({ id: 'a', title: 'A', updatedAt, messages: [{ role: 'user', text }] });
const remote = (text, revision) => ({ id: 'chat:a', kind: 'chat', revision, payload: chat(text), deleted: false });

test('cloud payload keeps conversation content while excluding credentials, local blobs and execution state', () => {
  const value = cloudChat({ ...chat('hello'), openRouterKey: 'secret', project: { files: [], agentWorkspaceRevision: 10 }, messages: [{ role: 'assistant', text: 'ok', agentRunId: 'private-run', images: [{ kind: 'image', blob: 'local-id', preview: 'blob:private', url: 'https://image', storagePath: 'owner/images/1.png' }] }] });
  const text = JSON.stringify(value);
  for (const privateValue of ['secret', 'private-run', 'local-id', 'blob:private', 'agentWorkspaceRevision']) assert.equal(text.includes(privateValue), false);
  assert.equal(value.messages[0].images[0].storagePath, 'owner/images/1.png');
});
test('cloud sync sends new chats and retains a durable version without provider keys', async () => {
  const f = fixture({ local: [{ ...chat('local'), kieKey: 'secret' }] }); await f.init();
  assert.equal(f.rows.get('chat:a').payload.messages[0].text, 'local');
  assert.equal(JSON.stringify(f.rows.get('chat:a')).includes('secret'), false);
  assert.equal(f.settings.get('cloudSyncState').versions.a, 1);
  assert.equal(Object.keys(f.settings.get('cloudSyncState').dirty).length, 0);
});
test('concurrent edits preserve both conversations instead of overwriting either device', async () => {
  const f = fixture({ local: [chat('offline edit', 3)], remote: [remote('other device', 2)], versions: { a: 1 }, dirty: { a: { generation: 'g' } } });
  await f.init();
  assert.equal(f.chats.get('a').messages[0].text, 'other device');
  const copy = [...f.chats.values()].find(c => c.id !== 'a');
  assert.equal(copy.messages[0].text, 'offline edit');
  await f.api.syncCloud();
  assert.equal(f.rows.get('chat:a').payload.messages[0].text, 'other device');
  assert.equal(f.rows.get('chat:' + copy.id).payload.messages[0].text, 'offline edit');
});
test('an edit made during upload stays queued and is sent on the next sync', async () => {
  let once = false;
  const f = fixture({ local: [chat('first', 2)], remote: [remote('old', 1)], versions: { a: 1 }, dirty: { a: { generation: 'first' } },
    async beforeUpdate({ db }) { if (!once) { once = true; await db.saveChat(chat('newer edit', 3)); } } });
  await f.init();
  assert.ok(f.settings.get('cloudSyncState').dirty.a);
  await f.api.syncCloud();
  assert.equal(f.rows.get('chat:a').payload.messages[0].text, 'newer edit');
  assert.equal(f.chats.size, 1);
});
test('memory conflicts require a choice and retain both versions until then', async () => {
  const f = fixture({ remote: [{ id: 'memory', kind: 'memory', revision: 2, payload: { instructions: 'Remote instructions' } }], versions: { '@memory': 1 }, dirty: { '@memory': { generation: 'g' } } });
  await f.init();
  assert.equal(f.api.memoryConflict(), true);
  assert.equal(f.memory.instructions, 'Local instructions');
  assert.equal(f.rows.get('memory').payload.instructions, 'Remote instructions');
  await f.api.resolveMemoryConflict('local');
  assert.equal(f.api.memoryConflict(), false);
  assert.equal(f.rows.get('memory').payload.instructions, 'Local instructions');
});
