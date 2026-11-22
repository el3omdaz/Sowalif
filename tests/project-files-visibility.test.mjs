import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const snippet = app.split('function renderProjectCount() {')[1]?.split('\nfunction projectProposalHTML(')[0];
assert.ok(snippet, 'renderProjectCount function exists');

function render({ direct = '', linked = null, files = [] } = {}) {
  const dom = new Map();
  function item(id) {
    if (!dom.has(id)) {
      const classes = new Set(id === '#openProject' || id === '#projectLinkTop' ? ['hidden'] : []);
      dom.set(id, {
        classList: {
          contains: name => classes.has(name),
          add: name => classes.add(name),
          remove: name => classes.delete(name),
          toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
        },
        textContent: '',
      });
    }
    return dom.get(id);
  }
  const localAgentOrigin = () => Boolean(direct);
  const agentDirectory = () => direct;
  const linkedFolders = new Map(linked ? [['work-1', linked]] : []);
  const projectFiles = () => files;
  const S = { chat: { id: 'work-1' }, mode: 'work' };
  const window = { showDirectoryPicker() {} };
  const $ = item;
  runInNewContext(`function renderProjectCount() {${snippet}\nrenderProjectCount();`, {
    localAgentOrigin, agentDirectory, linkedFolders, projectFiles, S, window, $,
  });
  return item;
}

test('linked local-agent folder: Files Project stays visible, alongside folder link and GitHub', () => {
  const $ = render({ direct: 'C:\\Projects\\Sowalif' });
  assert.equal($('#openProject').classList.contains('hidden'), false);
  assert.equal($('#projectLinkTop').classList.contains('hidden'), false);
  assert.equal($('#agentGit').classList.contains('hidden'), false);
  assert.equal($('#projectCount').textContent, 'Sowalif');
});

test('unlinked work project: Files Project stays visible', () => {
  const $ = render({ files: [{ path: 'README.md' }] });
  assert.equal($('#openProject').classList.contains('hidden'), false);
  assert.equal($('#agentGit').classList.contains('hidden'), true);
  assert.match($('#projectCount').textContent, /1 ملف/);
});

test('browser folder linked: Files Project remains visible even when link action is hidden', () => {
  const $ = render({ linked: { directory: { name: 'my-project' } } });
  assert.equal($('#openProject').classList.contains('hidden'), false);
  assert.equal($('#projectLinkTop').classList.contains('hidden'), true);
});

test('work header retains button, handler and v46 cache busting', () => {
  assert.match(html, /id="openProject"[^>]*>ملفات المشروع<\/button>/);
  assert.match(app, /\$\('#openProject'\)\.onclick = \(\) => \{/);
  assert.match(app, /\$\('#projectBar'\)\.classList\.toggle\('hidden', mode !== 'work'\)/);
  assert.match(html, /js\/app\.js\?v=48/);
  assert.match(sw, /shell-v48/);
  assert.match(sw, /js\/app\.js\?v=48/);
});
