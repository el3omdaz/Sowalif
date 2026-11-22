import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../js/local-agent.js', import.meta.url), 'utf8');

const safeSetChecked = app.match(/function setChecked\(selector, value\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(safeSetChecked, 'safe checkbox setter exists');
function setter(dom = new Map()) {
  const warnings = [];
  const context = {
    $: key => dom.get(key) ?? null,
    console: { warn: message => warnings.push(message) },
    Boolean,
  };
  runInNewContext(safeSetChecked + '\nthis.setChecked = setChecked;', context);
  return { setChecked: context.setChecked, warnings };
}

test('account reload: missing checkbox cannot throw a null.checked error', () => {
  const { setChecked, warnings } = setter();
  assert.equal(setChecked('#reuseMedia', true), false);
  assert.equal(setChecked('#memoryEnabled', true), false);
  assert.equal(setChecked('#completionNotifications', false), false);
  assert.equal(warnings.length, 3);
});

test('available checkboxes get correct values', () => {
  const dom = new Map([['#reuseMedia', { checked: false }], ['#memoryEnabled', { checked: false }]]);
  const { setChecked } = setter(dom);
  assert.equal(setChecked('#reuseMedia', true), true);
  assert.equal(dom.get('#reuseMedia').checked, true);
  assert.equal(setChecked('#memoryEnabled', false), true);
  assert.equal(dom.get('#memoryEnabled').checked, false);
});

test('account restoration and settings use the guarded setter', () => {
  assert.match(app, /setChecked\('#reuseMedia', draft\.reuseMedia !== false\)/);
  assert.match(app, /setChecked\('#memoryEnabled', config\.enabled\)/);
  assert.match(app, /setChecked\('#completionNotifications'/);
  assert.doesNotMatch(app, /\$\('#(?:reuseMedia|memoryEnabled|memorySearch|completionNotifications)'\)\.checked\s*=/);
});

test('Claude Code permission control does not require element after async response', () => {
  assert.match(agent, /const autoApproveControl = document\.querySelector/);
  assert.match(agent, /if \(autoApprove && autoApproveControl\) autoApproveControl\.checked = false/);
});

test('HTML and cached source versions are in sync', () => {
  assert.match(html, /js\/app\.js\?v=48/);
  assert.match(sw, /shell-v48/);
  assert.match(sw, /js\/app\.js\?v=48/);
  assert.match(sw, /js\/local-agent\.js\?v=48/);
  assert.match(sw, /js\/market\.js\?v=48/);
});
