import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
test('connect button triggers real local check, not settings-only loop', () => {
  assert.match(app, /async function connectCodingEngine\(\)/);
  assert.match(app, /\$\('#codingSetup'\)\.onclick = \(\) => \{ void connectCodingEngine\(\); \};/);
  assert.doesNotMatch(app, /\$\('#codingSetup'\)\.onclick = \(\) => openSettings\('agent'\);/);
  assert.match(app, /const status = await localStatus\(\);/);
  assert.match(app, /\(status\.engines \|\| \[\]\)\.includes\(engine\)/);
  assert.match(app, /toast\(`✓ \$\{codingEngineName\(engine\)\} جاهز على الكمبيوتر/);
});
test('new engine selection checks local state, and only asks for key if absent', () => {
  assert.match(app, /if \(!agentCredentials\(\)\.key\) openSettings\('agent'\);\s*else void connectCodingEngine\(\);/);
});
test('project permissions and sidebar preserved, cache version bumped', () => {
  assert.match(app, /\$\('#agentAutoApprove'\)\.addEventListener\('change'/);
  assert.match(html, /id="historyCollapse"/);
  assert.match(html, /js\/nav-layout\.js\?v=50/);
  assert.match(html, /js\/app\.js\?v=51/);
  assert.match(sw, /shell-v51/);
  assert.match(sw, /js\/app\.js\?v=51/);
});
