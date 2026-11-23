import test from 'node:test';
import assert from 'node:assert/strict';
import { planFileSearch } from '../js/file-search-ai.js?v=50';

const base = { action: 'find', query: 'مطار', searchIn: 'content', explanation: 'سأبحث عن كلمة مطار داخل الملفات.' };
const plan = (value, options = {}) => planFileSearch({ text: 'ابحث عن كلمة مطار داخل أي ملف', model: 'or:chosen/model', run: async () => ({ text: JSON.stringify(value) }), ...options });

test('AI file search plans Arabic synonyms and file filters using only the selected model and request', async () => {
  const controller = new AbortController();
  const request = 'ابحث عن كلمة مطار داخل ملف تقرير الرحلة وورد';
  let calls = 0;
  const result = await planFileSearch({ text: request, model: 'or:chosen/model', signal: controller.signal,
    run: async (model, options) => {
      calls++;
      assert.equal(model, 'or:chosen/model');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.maxOutputTokens, 1200);
      assert.equal(options.reasoningLevel, 'normal');
      assert.equal(options.deep, false);
      assert.equal(options.search, false);
      assert.deepEqual(options.tools, []);
      assert.deepEqual(JSON.parse(options.messages[0].text), { request, searchIn: 'both' });
      assert.equal(options.messages.length, 1);
      assert.match(options.system, /لا تعرف الملفات الموجودة/);
      return { text: '```json\n' + JSON.stringify({ ...base, queries: ['airport', 'Airport', 'مطار', 'المطار'], fileTypes: ['.DOCX', 'doc', 'docx'], fileQuery: 'تقرير الرحلة', limit: 25 }) + '\n```' };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ...base, queries: ['airport', 'المطار'], fileTypes: ['docx', 'doc'], fileQuery: 'تقرير الرحلة', limit: 25 });
});

test('read-only report actions are allowed without inventing a query or results', async () => {
  for (const action of ['largest', 'duplicates', 'browse']) {
    const value = { action, searchIn: 'name', explanation: 'سأفحص الملفات ضمن النطاق الذي اخترته.' };
    assert.deepEqual(await plan(value, { searchIn: 'name' }), value);
  }
});

test('planner rejects malformed responses, unknown actions and fabricated result fields', async () => {
  for (const value of [null, [], {}, { ...base, action: 'delete' }, { ...base, action: 'run' }, { ...base, searchIn: 'disk' }, { ...base, results: [{ path: 'report.docx' }] }, { ...base, root: 'C:\\' }, { ...base, command: 'rm -r /' }, { ...base, explanation: '<b>ready</b>' }, { ...base, explanation: 'I found 2 files.' }, { ...base, explanation: 'وجدت الملف المطلوب.' }, { ...base, explanation: 'تم العثور على تقرير.docx' }]) {
    await assert.rejects(plan(value), /خطة البحث/);
  }
  for (const text of ['not JSON', 'The plan is ' + JSON.stringify(base), '```json\n{}\n``` extra', '{"action":']) {
    await assert.rejects(plan(base, { run: async () => ({ text }) }), /خطة البحث/);
  }
});

test('planner rejects paths, invalid extensions and every field outside the search schema', async () => {
  for (const name of ['C:\\secret.docx', '/tmp/a.docx', '..', '../private', '\\\\server\\share', 'file:///tmp/a', '*.docx']) await assert.rejects(plan({ ...base, fileQuery: name }), /خطة البحث/);
  for (const value of [
    { ...base, fileTypes: ['docx', '../txt'] }, { ...base, fileTypes: ['docx;delete'] }, { ...base, fileTypes: Array(11).fill('pdf') },
    { ...base, fileQuery: '' }, { ...base, path: 'a.docx' }, { ...base, directory: 'reports' }, { ...base, query: null },
    { ...base, explanation: '' }, { ...base, limit: 0 }, { ...base, limit: 201 }, { ...base, limit: 1.5 },
  ]) await assert.rejects(plan(value), /خطة البحث/);
});

test('query and alternative budgets reject silent truncation while boundary values are retained', async () => {
  for (const value of [{ ...base, query: 'x'.repeat(301) }, { ...base, query: ' ' }, { ...base, queries: Array.from({ length: 6 }, (_, index) => String(index)) }, { ...base, queries: ['x'.repeat(301)] }, { ...base, queries: [''] }, { ...base, explanation: 'x'.repeat(601) }, { ...base, fileQuery: 'x'.repeat(301) }]) await assert.rejects(plan(value), /خطة البحث/);
  const value = { ...base, query: 'x'.repeat(300), queries: ['y'.repeat(300)], explanation: 'x'.repeat(600), limit: 200 };
  assert.deepEqual(await plan(value), value);
});

test('provider errors and cancellation propagate without model fallback or another request', async () => {
  let calls = 0;
  const failure = new Error('provider unavailable');
  await assert.rejects(plan(base, { run: async () => { calls++; throw failure; } }), error => error === failure);
  assert.equal(calls, 1);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(plan(base, { signal: stopped.signal, run: () => assert.fail('Cancelled requests must not reach the model') }), { name: 'AbortError' });
  const pending = new AbortController();
  await assert.rejects(plan(base, { signal: pending.signal, run: async () => { pending.abort(); return { text: JSON.stringify(base) }; } }), { name: 'AbortError' });
});

test('invalid user requests or missing model choices do not invoke a provider', async () => {
  for (const options of [{ text: '' }, { text: 'x'.repeat(6001) }, { model: '' }, { searchIn: 'all-disks' }]) await assert.rejects(plan(base, { ...options, run: () => assert.fail('Invalid input must be rejected before a provider request') }));
});
