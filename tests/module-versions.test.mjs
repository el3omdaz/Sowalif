import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// المتصفح يعامل x.js?v=39 و x.js?v=40 كملفين مختلفين: يحمّل الوحدة مرتين بحالتين منفصلتين
// (مثلاً عميلا Supabase بنفس التخزين، فيضيع تسجيل الدخول بين نسختين). كل وحدة لازم تُطلب برابط واحد.
const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

function references() {
  const refs = [];
  for (const f of readdirSync(new URL('js/', root)).filter((f) => f.endsWith('.js'))) {
    for (const m of read(`js/${f}`).matchAll(/['"]\.\/([a-z0-9-]+\.js)(\?v=\d+)?['"]/g)) refs.push({ file: m[1], v: m[2] || '', from: `js/${f}` });
  }
  for (const page of ['index.html', 'sw.js']) {
    for (const m of read(page).matchAll(/['"]js\/([a-z0-9-]+\.js)(\?v=\d+)?['"]/g)) refs.push({ file: m[1], v: m[2] || '', from: page });
  }
  return refs;
}

// استيرادات الاختبارات نفسها (وليس قراءة الملف كنص): لازم تطابق نسخة التطبيق وإلا يشتغل الاختبار على نسخة ثانية من الوحدة
function testImports() {
  const refs = [];
  for (const f of readdirSync(new URL('tests/', root)).filter((f) => f.endsWith('.mjs'))) {
    for (const m of read(`tests/${f}`).matchAll(/(?:from\s+|import\(\s*)['"]\.\.\/js\/([a-z0-9-]+\.js)(\?v=\d+)?['"]/g)) refs.push({ file: m[1], v: m[2] || '', from: `tests/${f}` });
  }
  return refs;
}

function conflicts(refs) {
  const byFile = new Map();
  for (const r of refs) {
    if (!byFile.has(r.file)) byFile.set(r.file, new Map());
    byFile.get(r.file).set(r.v, r.from);
  }
  return [...byFile].filter(([, vs]) => vs.size > 1).map(([f, vs]) => `${f}: ${[...vs].map(([v, from]) => `${v || '(بدون)'} في ${from}`).join(' · ')}`);
}

test('كل وحدة JS تُطلب بنسخة واحدة فقط في كل التطبيق', () => {
  assert.deepEqual(conflicts(references()), []);
});

test('الاختبارات تستورد الوحدات بنفس نسخة التطبيق', () => {
  const app = references();
  const used = new Set(app.map((r) => r.file));
  assert.deepEqual(conflicts([...app, ...testImports().filter((r) => used.has(r.file))]), []);
});
