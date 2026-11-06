import test from 'node:test';
import assert from 'node:assert/strict';
const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
const { readPersonalization, savePersonalization, saveRule, removeRule, captureMemory, preparePersonalContext, parseMemoryCommand, retrieveContext, mergePersonalization } = await import('../js/memory.js?v=16');
test.beforeEach(() => storage.clear());

test('gold shortcut is captured once and works in another chat with fresh search enabled', async () => {
  const saved = await preparePersonalContext({ id: 'first' }, 'متى ما قلت كلمة ذهب بس روح جيبلي آخر أخباره وتأثير الدولار', async () => []);
  assert.match(saved.action.text, /حُفظ اختصار/);
  assert.equal(saved.search, false);
  const later = await preparePersonalContext({ id: 'other' }, 'ذَهَب!', async () => []);
  assert.equal(later.search, true);
  assert.match(later.expanded, /آخر أخباره وتأثير الدولار/);
  assert.equal(readPersonalization().rules.length, 1);
  assert.equal((await preparePersonalContext({ id: 'other' }, 'ذهب صديقي للبيت', async () => [])).search, false);
});

test('quoted multiword rules, updates, deletion and normal quoted discussion', () => {
  assert.equal(parseMemoryCommand('اشرح الجملة: متى ما قلت كلمة ذهب جيب آخر الأخبار'), null);
  assert.equal(parseMemoryCommand('تذكر موضوعنا السابق؟'), null);
  assert.equal(parseMemoryCommand('تذكر موضوعنا السابق'), null);
  const command = parseMemoryCommand('احفظ عندك متى ما قلت "تقرير السوق" ابحث عن الأخبار');
  assert.equal(command.trigger, 'تقرير السوق');
  const first = saveRule(command);
  const updated = saveRule({ id: first.id, trigger: 'تقرير يومي', action: 'لخص مستجدات اليوم', search: true });
  assert.equal(updated.id, first.id);
  assert.equal(readPersonalization().rules.length, 1);
  removeRule(first.id);
  assert.equal(readPersonalization().rules.length, 0);
});

test('explicit preferences are stored once while ordinary conversation is not copied to permanent notes', () => {
  captureMemory('تذكر أني أفضل الرد باللهجة الكويتية');
  captureMemory('تذكر أني أفضل الرد باللهجة الكويتية');
  assert.equal(readPersonalization().notes.split('\n').length, 1);
  assert.equal(captureMemory('اليوم تكلمت مع صديقي عن الأسهم'), null);
});

test('custom instructions work with memory disabled without reading history or applying saved rules', async () => {
  saveRule({ trigger: 'ذهب', action: 'ابحث عن الذهب', search: true });
  savePersonalization({ instructions: 'رد باللهجة الكويتية', notes: 'معلومة شخصية', enabled: false });
  const context = await preparePersonalContext({ id: 'new' }, 'ذهب', async () => { throw new Error('must not load'); });
  assert.match(context.prompt, /رد باللهجة الكويتية/);
  assert.equal(context.prompt.includes('معلومة شخصية'), false);
  assert.equal(context.search, false);
  assert.equal(context.recallUnavailable, false);
  assert.equal(captureMemory('تذكر معلومة جديدة'), null);
});

test('recall finds matching Arabic topics across chats, excludes the current chat and deleted rule definitions', () => {
  const chats = [
    { id: 'old', title: 'تحليل الأسواق', updatedAt: 10, messages: [{ role: 'user', text: 'تابع تأثير عوائد السندات على الذهب', at: 10 }, { role: 'assistant', text: 'ارتفاع العائد الحقيقي يضغط على الذهب.' }] },
    { id: 'other', title: 'وصفة كيك', updatedAt: 11, messages: [{ role: 'user', text: 'مكونات الكيك' }, { role: 'assistant', text: 'بيض وطحين' }] },
    { id: 'rules', title: 'ذهب', messages: [{ role: 'user', text: 'متى ما قلت كلمة ذهب ابحث عن الأخبار' }] },
    { id: 'current', title: 'ذهب', messages: [{ role: 'user', text: 'الذهب' }, { role: 'assistant', text: 'الرد الحالي' }] },
  ];
  const result = retrieveContext(chats, 'شنو تأثير العوائد على الذهب؟', 'current');
  assert.equal(result[0].chatId, 'old');
  assert.match(result[0].assistant, /العائد الحقيقي/);
  assert.ok(result.every((r) => r.chatId !== 'current' && r.chatId !== 'rules' && r.chatId !== 'other'));
});

test('recall is bounded and labels ambiguous references as tentative', () => {
  const huge = 'ذهب '.repeat(4000);
  const chats = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: 'ذهب', updatedAt: i, messages: [{ role: 'user', text: huge }, { role: 'assistant', text: huge }] }));
  const result = retrieveContext(chats, 'ذهب', 'current');
  assert.ok(result.length <= 4);
  assert.ok(result.reduce((n, r) => n + r.user.length + r.assistant.length, 0) <= 6500);
  const fallback = retrieveContext([{ id: 'old', title: 'سابق', updatedAt: 5, messages: [{ role: 'user', text: 'تصميم حديقة المنزل' }] }], 'كمل عن الموضوع السابق', 'current');
  assert.equal(fallback[0].tentative, true);
});

test('unavailable history is reported without losing custom instructions', async () => {
  savePersonalization({ instructions: 'اختصر', notes: '', enabled: true });
  const result = await preparePersonalContext({ id: 'new' }, 'سؤال', async () => { throw new Error('db unavailable'); });
  assert.equal(result.recallUnavailable, true);
  assert.match(result.prompt, /اختصر/);
});

test('backup memory merges without overwriting existing instructions or duplicate rules', () => {
  savePersonalization({ instructions: 'تعليماتي الحالية', notes: 'معلومة قديمة', enabled: true });
  saveRule({ trigger: 'ذهب', action: 'طلبي الحالي', search: false });
  mergePersonalization({ instructions: 'تعليمات مستوردة', notes: 'معلومة قديمة\nمعلومة جديدة', rules: [{ trigger: 'ذهب', action: 'طلب مستورد', search: true }, { trigger: 'نفط', action: 'أخبار النفط', search: true }] });
  const config = readPersonalization();
  assert.equal(config.instructions, 'تعليماتي الحالية');
  assert.equal(config.notes.split('\n').length, 2);
  assert.equal(config.rules.find((r) => r.trigger === 'ذهب').action, 'طلبي الحالي');
  assert.equal(config.rules.length, 2);
});

test('storage failures do not falsely acknowledge saved memory', () => {
  const save = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('full'); };
  try { assert.throws(() => captureMemory('تذكر أني أحب القراءة'), /تعذّر حفظ الذاكرة/); }
  finally { localStorage.setItem = save; }
});
