import test from 'node:test';
import assert from 'node:assert/strict';
import { initWorkspaceNavigation } from '../js/nav-layout.js';

class MockElement {
  constructor(name = '') {
    this.name = name;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.handlers = {};
    this.textContent = name;
    const classes = new Set();
    this.classList = {
      contains: (name) => classes.has(name),
      toggle: (name, enable) => {
        if (enable) classes.add(name);
        else classes.delete(name);
      },
    };
  }
  append(...elements) {
    for (const el of elements) {
      el.parentElement = this;
      this.children.push(el);
    }
  }
  insertBefore(el, sibling) {
    if (el.parentElement) el.parentElement.children.splice(el.parentElement.children.indexOf(el), 1);
    this.children.splice(this.children.indexOf(sibling), 0, el);
    el.parentElement = this;
  }
  insertAdjacentElement(position, el) {
    assert.equal(position, 'afterend');
    const parent = this.parentElement;
    if (el.parentElement) el.parentElement.children.splice(el.parentElement.children.indexOf(el), 1);
    parent.children.splice(parent.children.indexOf(this) + 1, 0, el);
    el.parentElement = parent;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) || ''; }
  addEventListener(event, callback) { this.handlers[event] = callback; }
  fire(event) { this.handlers[event]({ target: this }); }
  querySelector(selector) { return this.queries?.[selector] || null; }
  querySelectorAll(selector) { return selector === 'button' ? this.buttons || [] : []; }
}

function fixture() {
  const app = new MockElement('app');
  const main = new MockElement('main');
  const top = new MockElement('top');
  const tabs = new MockElement('tabs');
  const select = new MockElement('select');
  const collapse = new MockElement('collapse');
  const sidebar = new MockElement('sidebar');
  const buttons = ['الشات', 'الصور', 'الفيديو', 'الشغل', 'الإدارة', 'السوق'].map(name => {
    const button = new MockElement(name);
    button.queries = { span: { textContent: name } };
    return button;
  });
  tabs.buttons = [...buttons, collapse];
  main.append(top, tabs);
  app.append(sidebar, main);
  app.queries = { '.main': main };
  main.queries = { '.top': top };
  const dom = { '#app': app, '#workspaceTabs': tabs, '#workspaceNavPosition': select, '#workspaceNavCollapse': collapse };
  const stored = new Map();
  const media = { matches: true, addEventListener(event, callback) { this.update = callback; } };
  return { app, main, tabs, select, collapse, buttons, stored, media, dom };
}

test('top / side / collapsed / mobile switches preserve the same navigation and save preferences', (t) => {
  const f = fixture();
  const previous = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage };
  globalThis.document = { querySelector: (selector) => f.dom[selector] ?? null };
  globalThis.window = { matchMedia: () => f.media };
  globalThis.localStorage = { getItem: key => f.stored.get(key) ?? null, setItem: (key, value) => f.stored.set(key, value) };
  t.after(() => { for (const [key,value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });

  initWorkspaceNavigation();
  assert.equal(f.tabs.parentElement, f.main);
  assert.equal(f.select.value, 'top');
  assert.equal(f.buttons[0].getAttribute('aria-label'), 'الشات');

  f.select.value = 'side';
  f.select.fire('change');
  assert.equal(f.tabs.parentElement, f.app);
  assert.ok(f.app.classList.contains('workspace-nav-side'));
  assert.equal(f.stored.get('sowalif.workspaceNavPosition.v1'), 'side');

  f.collapse.fire('click');
  assert.ok(f.app.classList.contains('workspace-nav-collapsed'));
  assert.equal(f.stored.get('sowalif.workspaceNavCollapsed.v1'), 'true');
  assert.equal(f.collapse.getAttribute('aria-label'), 'توسيع شريط الأقسام');

  f.media.matches = false;
  f.media.update();
  assert.equal(f.tabs.parentElement, f.main);
  assert.ok(!f.app.classList.contains('workspace-nav-side'));
  assert.equal(f.select.value, 'side', 'mobile keeps the preferred desktop setting');

  f.media.matches = true;
  f.media.update();
  assert.equal(f.tabs.parentElement, f.app);
  assert.ok(f.app.classList.contains('workspace-nav-collapsed'));

  f.select.value = 'top';
  f.select.fire('change');
  assert.equal(f.tabs.parentElement, f.main);
  assert.ok(!f.app.classList.contains('workspace-nav-collapsed'));
});
