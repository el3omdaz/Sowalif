import test from 'node:test';
import assert from 'node:assert/strict';
import { requestText } from '../js/text-dialog.js?v=50';

class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
  }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  showModal() { this.open = true; }
  close(value = '') { this.returnValue = value; this.dispatchEvent(new Event('close')); }
  remove() { this.removed = true; }
  select() { this.selected = true; }
}

test('text entry keeps the native prompt in the web app', async t => {
  globalThis.window = { prompt(message, value) {
    assert.equal(message, 'اسم المشروع');
    assert.equal(value, 'قديم');
    return 'جديد';
  } };
  t.after(() => delete globalThis.window);
  assert.equal(await requestText('اسم المشروع', 'قديم'), 'جديد');
});

test('desktop shows its own dialog and returns input only when accepted', async t => {
  globalThis.window = { sowalifDesktop: {}, prompt() { assert.fail('Electron must not call window.prompt'); } };
  const body = new Element('body');
  let restored = 0;
  globalThis.document = {
    body,
    activeElement: { isConnected: true, focus() { restored++; } },
    createElement: tag => new Element(tag),
  };
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
  });

  const requesting = requestText('اسم المشروع', 'قديم');
  const dialog = body.children.at(-1);
  const [form] = dialog.children;
  const [label, input, actions] = form.children;
  assert.equal(dialog.open, true);
  assert.equal(form.method, 'dialog');
  assert.equal(dialog.attributes['aria-labelledby'], label.id);
  assert.equal(label.htmlFor, input.id);
  assert.equal(label.textContent, 'اسم المشروع');
  assert.equal(input.value, 'قديم');
  assert.equal(input.selected, true);
  assert.equal(await requestText('لا تفتح حوارًا ثانيًا'), null);
  input.value = 'جديد';
  dialog.close(actions.children[1].value);
  assert.equal(await requesting, 'جديد');
  assert.equal(dialog.removed, true);
  assert.equal(restored, 1);

  const cancelling = requestText('اختر المسار');
  const other = body.children.at(-1);
  const [cancel] = other.children[0].children[2].children;
  cancel.dispatchEvent(new Event('click'));
  assert.equal(await cancelling, null);
});
