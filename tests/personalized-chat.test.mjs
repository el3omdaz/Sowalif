import test from 'node:test';
import assert from 'node:assert/strict';
const local = new Map([['sc.kieKey', '"fake-kie"'], ['sc.openRouterKey', '"fake-or"']]);
globalThis.localStorage = { getItem: (key) => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) };
const chats = new Map([['old', { id: 'old', title: 'خطة متابعة الذهب', updatedAt: 10, messages: [{ role: 'user', text: 'في متابعة الذهب ركّز على حركة العائد الحقيقي والدولار', at: 10 }, { role: 'assistant', text: 'سأربط الأخبار بالعوائد والدولار.' }] }]]);
globalThis.indexedDB = { open() {
  const request = {};
  queueMicrotask(() => {
    request.result = { transaction() {
      const tx = { objectStore: () => ({ getAll: () => ({ result: structuredClone([...chats.values()]) }), put: (value) => { chats.set(value.id, structuredClone(value)); return { result: value.id }; } }) };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    } };
    request.onsuccess();
  });
  return request;
} };
const { savePersonalization, saveRule } = await import('../js/memory.js?v=7');
const { respond } = await import('../js/chat.js?v=7');

test('custom instructions, cross-chat context and gold rule reach both providers without extra model requests', async () => {
  savePersonalization({ instructions: 'رد باللهجة الكويتية وبنقاط واضحة', notes: 'أفضل توقيت الكويت', enabled: true });
  saveRule({ trigger: 'ذهب', action: 'ابحث عن آخر أخبار الذهب وتأثير العوائد والدولار', search: true });
  const outgoing = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    outgoing.push({ url, body });
    return new Response(JSON.stringify(url.startsWith('https://openrouter.ai') ? { choices: [{ message: { content: 'أخبار محدثة مع المصادر' }, finish_reason: 'stop' }] } : { content: [{ type: 'text', text: 'أخبار محدثة مع المصادر' }] }), { headers: { 'content-type': 'application/json' } });
  };
  for (const model of ['claude-sonnet-5-5', 'or:anthropic/claude-sonnet-5.5']) {
    const chat = { id: `current-${model}`, title: 'محادثة جديدة', messages: [{ role: 'user', text: 'ذهب', at: Date.now() }] };
    const reply = await respond(chat, { model, search: false }, () => {});
    assert.equal(reply.error, undefined);
    assert.ok(reply.contextSources.some((c) => c.id === 'old'));
    assert.equal(chat.messages[0].text, 'ذهب');
  }
  assert.equal(outgoing.length, 2);
  const first = outgoing[0].body;
  assert.match(first.system, /باللهجة الكويتية/);
  assert.match(first.system, /توقيت الكويت/);
  assert.match(first.system, /العائد الحقيقي/);
  assert.ok(first.tools.some((t) => t.name === 'web_search'));
  assert.match(first.messages.at(-1).content.at(-1).text, /آخر أخبار الذهب/);
  const second = outgoing[1].body;
  assert.match(second.messages[0].content, /باللهجة الكويتية/);
  assert.match(second.messages[0].content, /العائد الحقيقي/);
  assert.deepEqual(second.tools, [{ type: 'openrouter:web_search' }]);
});

test('personalization backup excludes API keys and can be exported with chats', async () => {
  const { exportAll } = await import('../js/db.js?v=7');
  const text = await (await exportAll()).text();
  const backup = JSON.parse(text);
  assert.equal(backup.version, 2);
  assert.match(backup.personalization.instructions, /باللهجة الكويتية/);
  assert.equal(backup.personalization.rules[0].trigger, 'ذهب');
  assert.equal(text.includes('fake-kie'), false);
  assert.equal(text.includes('fake-or'), false);
});
