import test from 'node:test';
import assert from 'node:assert/strict';
import { initOrganizer } from '../js/organizer.js?v=50';

function organizer(t, replies, { planFileSearch, saved = new Map(), sessionVersion = 2, missingIds = [] } = {}) {
  const nodes = new Map();
  const absent = new Set(missingIds);
  function element(tag = 'div') {
    const classes = new Set();
    return {
      tag, value: '', textContent: '', children: [],
      classList: { contains: name => classes.has(name), toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, add: name => classes.add(name) },
      get childElementCount() { return this.children.length; },
      replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); if (tag === 'organizerRoot') this.value = children[0]?.value || ''; },
      append(...children) { for (const child of children) child.parent = this; this.children.push(...children); },
      insertBefore(child, before) { child.parent = this; this.children.splice(Math.max(0, this.children.indexOf(before)), 0, child); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; },
      querySelector(selector) { return this.children.find(child => child.tag === selector) || null; },
      reset() {}, focus() {}, setAttribute() {},
    };
  }
  const node = id => { if (absent.has(id)) return null; if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  const scans = [];
  const globals = {
    document: { getElementById: node, createElement: element },
    window: {}, location: { origin: 'http://127.0.0.1:4781', hostname: '127.0.0.1' },
    Option: class { constructor(text, value) { Object.assign(this, { text, value }); } },
    fetch: async (url, options = {}) => {
      if (url === '/api/files/roots') return Response.json({ roots: [{ path: 'C:\\Documents' }, { path: 'D:\\' }] });
      if (url === '/api/files/session') return Response.json({ csrf: 'fixture-csrf', fileSearchVersion: sessionVersion });
      assert.equal(url, '/api/files/scan');
      scans.push(JSON.parse(options.body));
      return Response.json(replies.shift());
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => before ? Object.defineProperty(globalThis, name, before) : delete globalThis[name]);
  }
  node('organizerSource').value = 'files';
  if (node('organizerSearchScope')) node('organizerSearchScope').value = 'both';
  initOrganizer({ localAgentOrigin: () => true, planFileSearch, settings: {
    get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback,
    set: (key, value) => { saved.set(key, value); return true; },
  } });
  const settled = async () => {
    for (let count = 0; count < 50 && node('organizerSource').disabled; count++) await new Promise(setImmediate);
    assert.equal(node('organizerSource').disabled, false);
  };
  const search = async query => {
    node('organizerTask').value = query;
    node('organizerSearch').onsubmit({ preventDefault() {} });
    await settled();
  };
  return { node, scans, settled, search, saved };
}

test('cached markup without the newer AI controls still initializes and searches without blocking account startup', async t => {
  const a = organizer(t, [{ files: [], scanned: 3, contentScanned: 3, exhausted: true }], {
    missingIds: ['organizerAiSearch', 'organizerAiSearchRow', 'organizerSearchScope', 'organizerSearchScopeRow'],
    saved: new Map([['organizerAiSearch', true]]),
    planFileSearch: () => assert.fail('Missing AI control must not silently enable AI'),
  });
  assert.equal(a.node('organizerAiSearch'), null);
  assert.equal(a.node('organizerSearchScope'), null);
  a.node('openOrganizer').onclick(); await a.settled();
  await a.search('مطار');
  assert.equal(a.scans.length, 1);
  assert.equal(a.scans[0].searchIn, 'both');
  assert.equal(a.scans[0].searchContent, true);
  assert.match(a.node('organizerStatus').textContent, /تم فحص 3 ملف/);
  a.node('organizerSource').value = 'gmail';
  a.node('organizerSource').onchange();
  assert.equal(a.node('organizerSource').disabled, false);
});

test('plain local searches include content and continue a partial search without losing prior results', async t => {
  const a = organizer(t, [
    { files: [], scanned: 100, contentScanned: 20, partial: true, nextCursor: 'resume-1' },
    { files: [{ name: 'رحلة.docx', path: 'C:\\Documents\\رحلة.docx', size: 1234, match: { type: 'content', format: 'docx', snippet: 'الاجتماع قرب مطار الكويت' } }], scanned: 10, contentScanned: 10 },
  ]);
  a.node('openOrganizer').onclick(); await a.settled();
  await a.search('مطار');
  assert.equal(a.scans[0].query, 'مطار');
  assert.equal(a.scans[0].searchContent, true);
  assert.equal(a.scans[0].searchIn, 'both');
  assert.match(a.node('organizerStatus').textContent, /لم يشمل كل المحتوى/);
  assert.match(a.node('organizerStatus').textContent, /متابعة البحث/);
  a.node('organizerMore').onclick(); await a.settled();
  assert.equal(a.scans[1].cursor, 'resume-1');
  assert.equal(a.scans[1].root, a.scans[0].root);
  assert.equal(a.node('organizerResults').childElementCount, 1);
  const card = a.node('organizerResults').children[0];
  assert.match(card.children[1].textContent, /C:\\Documents\\رحلة.docx/);
  assert.match(card.children[2].textContent, /تطابق داخل المحتوى.*DOCX\nالاجتماع قرب مطار الكويت/);
  assert.match(a.node('organizerStatus').textContent, /110 ملف/);
  assert.equal(a.node('organizerMore').classList.contains('hidden'), true);
});

test('explicit content commands retain the named file filter regardless of the search selector', async t => {
  const a = organizer(t, [{ files: [], scanned: 5, contentErrors: 1, issues: [{ path: 'locked.docx', reason: 'الملف مشفر' }] }]);
  a.node('openOrganizer').onclick(); await a.settled();
  a.node('organizerSearchScope').value = 'name';
  await a.search('ابحث عن كلمة مطار داخل ملف تقرير.docx');
  assert.equal(a.scans[0].query, 'مطار');
  assert.equal(a.scans[0].fileQuery, 'تقرير.docx');
  assert.equal(a.scans[0].searchIn, 'content');
  assert.equal(a.scans[0].searchContent, true);
  assert.match(a.node('organizerStatus').textContent, /تعذّرت قراءة محتوى 1 ملف/);
  assert.match(a.node('organizerStatus').textContent, /locked.docx: الملف مشفر/);
  assert.doesNotMatch(a.node('organizerStatus').textContent, /اكتمل فحصه/);
});

test('an exhausted search identifies the unreadable file without asking to narrow the folder', async t => {
  const a = organizer(t, [{ files: [], scanned: 1, contentScanned: 1, contentSkipped: 1, contentUnsupported: 1, exhausted: true, partial: true,
    issues: [{ path: 'C:\\Documents\\العقد.doc', reason: 'هذا الملف يحتاج قارئ Word القديم.' }] }]);
  a.node('openOrganizer').onclick(); await a.settled();
  await a.search('طه محمد القطان');
  const status = a.node('organizerStatus').textContent;
  assert.match(status, /تم فحص 1 ملف/);
  assert.match(status, /لا يمكن نفي وجود الاسم أو العبارة داخلها/);
  assert.match(status, /العقد\.doc: هذا الملف يحتاج قارئ Word القديم/);
  assert.doesNotMatch(status, /حدّد مجلد|أصغر|متابعة البحث/);
  assert.equal(a.node('organizerMore').classList.contains('hidden'), true);
  const details = a.node('organizerResults').children[0];
  assert.equal(details.tag, 'details');
  assert.match(details.children[0].textContent, /الملفات التي لم تُقرأ وأسبابها/);
  assert.match(details.children[1].children[0].textContent, /C:\\Documents\\العقد.doc/);
});

test('unread-file reasons remain available after later continuation pages and reset on a new search', async t => {
  const a = organizer(t, [
    { files: [], scanned: 1, contentSkipped: 1, contentErrors: 1, partial: true, nextCursor: 'next-errors', issues: [{ path: 'old-error.docx', reason: 'المستند مشفر.' }] },
    { files: [], scanned: 2, contentScanned: 2, exhausted: true, partial: true, issues: [] },
    { files: [], scanned: 3, contentScanned: 3, exhausted: true, partial: false, issues: [] },
  ]);
  a.node('openOrganizer').onclick(); await a.settled();
  await a.search('القطان');
  a.node('organizerMore').onclick(); await a.settled();
  assert.match(a.node('organizerStatus').textContent, /تم فحص 3 ملف/);
  assert.match(a.node('organizerStatus').textContent, /old-error\.docx: المستند مشفر/);
  const details = a.node('organizerResults').children.find(child => child.tag === 'details');
  assert.equal(details.children[1].children.length, 1);
  assert.match(details.children[1].children[0].textContent, /old-error.docx/);
  await a.search('بحث جديد');
  assert.equal(a.node('organizerResults').childElementCount, 0);
  assert.doesNotMatch(a.node('organizerStatus').textContent, /old-error|مشفر/);
  assert.match(a.node('organizerStatus').textContent, /النطاق الذي اكتمل فحصه/);
});

test('unread-file details stay bounded and render returned paths as literal text', async t => {
  const issues = Array.from({ length: 105 }, (_, index) => ({ path: index ? `file-${index}.docx` : '<img src=x onerror=alert(1)>.docx', reason: 'تعذّرت القراءة.' }));
  const a = organizer(t, [{ files: [], scanned: 105, contentSkipped: 105, contentErrors: 105, exhausted: true, partial: true, issues }]);
  a.node('openOrganizer').onclick(); await a.settled();
  await a.search('القطان');
  const details = a.node('organizerResults').children[0];
  assert.equal(details.children[1].children.length, 100);
  assert.equal(details.children[1].children[0].textContent, '<img src=x onerror=alert(1)>.docx: تعذّرت القراءة.');
  assert.equal(details.children[1].children[0].innerHTML, undefined);
  assert.match(details.children[2].textContent, /5 ملاحظات إضافية/);
});

test('an outdated file service is rejected before AI planning or submitting a search', async t => {
  let planned = false;
  const a = organizer(t, [], { sessionVersion: null, saved: new Map([['organizerAiSearch', true]]), planFileSearch: async () => { planned = true; assert.fail('Old service must be detected first'); } });
  a.node('openOrganizer').onclick(); await a.settled();
  await a.search('ابحث عن طه محمد القطان');
  assert.equal(planned, false);
  assert.equal(a.scans.length, 0);
  assert.match(a.node('organizerStatus').textContent, /أعد تشغيل|تحديث/);
});

test('optional AI search understands the description once and resumes the same plan within the selected root', async t => {
  const plans = [];
  const a = organizer(t, [
    { files: [], scanned: 20, partial: true, nextCursor: 'ai-next' },
    { files: [], scanned: 8 },
  ], {
    planFileSearch: async request => {
      plans.push(request);
      assert.equal(a.node('organizerAiSearch').disabled, true);
      assert.match(a.node('organizerStatus').textContent, /أفهم وصفك/);
      return { action: 'find', query: 'مطار', queries: ['مطار', 'airport'], searchIn: 'content', fileTypes: ['docx'], explanation: 'أبحث عن مستندات Word تتكلم عن المطار.', root: 'D:\\', path: 'D:\\private.docx' };
    },
  });
  a.node('openOrganizer').onclick(); await a.settled();
  assert.equal(a.node('organizerAiSearch').checked, false);
  a.node('organizerAiSearch').checked = true;
  a.node('organizerAiSearch').onchange();
  assert.equal(a.saved.get('organizerAiSearch'), true);
  const description = 'عندي مستند وورد ناسي اسمه عن ترتيبات السفر من مطار الكويت';
  await a.search(description);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].text, description);
  assert.equal(plans[0].searchIn, 'both');
  assert.ok(plans[0].signal instanceof AbortSignal);
  assert.deepEqual(a.scans[0].queries, ['مطار', 'airport']);
  assert.equal(a.scans[0].root, 'C:\\Documents');
  assert.equal(a.scans[0].path, undefined);
  assert.equal(a.scans[0].searchIn, 'content');
  assert.match(a.node('organizerStatus').textContent, /فهم الطلب: أبحث عن مستندات Word/);
  a.node('organizerMore').onclick(); await a.settled();
  assert.equal(plans.length, 1);
  assert.equal(a.scans[1].cursor, 'ai-next');
  assert.deepEqual(a.scans[1].queries, ['مطار', 'airport']);
  assert.equal(a.scans[1].root, a.scans[0].root);
  assert.equal(a.node('organizerAiSearch').disabled, false);
});

test('AI planning failure does not submit a literal search or invent file results', async t => {
  const a = organizer(t, [], {
    saved: new Map([['organizerAiSearch', true]]),
    planFileSearch: async () => { throw new Error('أضف مفتاح النموذج أولًا.'); },
  });
  a.node('openOrganizer').onclick(); await a.settled();
  assert.equal(a.node('organizerAiSearch').checked, true);
  await a.search('دور لي على المستند اللي يتكلم عن السفر');
  assert.equal(a.scans.length, 0);
  assert.equal(a.node('organizerResults').childElementCount, 0);
  assert.equal(a.node('organizerStatus').textContent, 'أضف مفتاح النموذج أولًا.');
  assert.equal(a.node('organizerAiSearch').disabled, false);
});

test('AI search stays optional and is never invoked for mail', async t => {
  let calls = 0;
  const a = organizer(t, [{ files: [], scanned: 2 }], { planFileSearch: async () => { calls++; assert.fail('AI is off'); } });
  a.node('openOrganizer').onclick(); await a.settled();
  await a.search('اسم الملف');
  assert.equal(calls, 0);
  a.node('organizerAiSearch').checked = true;
  a.node('organizerSource').value = 'gmail';
  a.node('organizerSource').onchange();
  await a.search('مطار');
  assert.equal(calls, 0);
  assert.match(a.node('organizerStatus').textContent, /اربط الحساب/);
  assert.equal(a.node('organizerAiSearchRow').classList.contains('hidden'), true);
});
