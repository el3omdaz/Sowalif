import test from 'node:test';
import assert from 'node:assert/strict';
import { fitViewport } from '../js/viewport.js?v=21';

function fixture({ touch = true, visual = true } = {}) {
  const win = Object.assign(new EventTarget(), {
    innerHeight: 844, innerWidth: 390, navigator: { maxTouchPoints: touch ? 5 : 0 },
  });
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  if (visual) win.visualViewport = viewport;
  let pending;
  win.requestAnimationFrame = callback => { pending = callback; return 1; };
  win.cancelAnimationFrame = () => { pending = undefined; };
  const values = new Map();
  const classes = new Set();
  const messages = { scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 };
  const doc = Object.assign(new EventTarget(), {
    activeElement: null,
    documentElement: {
      style: { setProperty: (key, value) => values.set(key, value) },
      classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
    },
    querySelector: () => messages,
  });
  const heights = [];
  const dispose = fitViewport(win, doc, height => heights.push(height));
  function resize(height, offset = 0) {
    viewport.height = height; viewport.offsetTop = offset;
    (visual ? viewport : win).dispatchEvent(new Event('resize'));
    const callback = pending; pending = undefined; callback?.();
  }
  function focus(on) { doc.activeElement = on ? { matches: () => true } : null; }
  return { win, doc, viewport, values, classes, messages, heights, resize, focus, dispose };
}

test('iPhone keyboard docks to visible bottom including Safari focus panning and dismissal', () => {
  const f = fixture();
  f.focus(true);
  f.resize(440, 36);
  assert.equal(f.values.get('--app-height'), '440px');
  assert.equal(f.values.get('--app-top'), '36px');
  assert.ok(f.classes.has('keyboard-open'));
  // Tapping send blurs before the keyboard finishes closing.
  f.focus(false); f.resize(480, 12);
  assert.ok(f.classes.has('keyboard-open'));
  f.resize(844);
  assert.ok(!f.classes.has('keyboard-open'));
  assert.equal(f.values.get('--app-top'), '0px');
});

test('content-resizing keyboards, desktop windows and address bars are distinguished', () => {
  const f = fixture();
  f.focus(true); f.win.innerHeight = 440; f.resize(440);
  assert.ok(f.classes.has('keyboard-open'));
  const desktop = fixture({ touch: false });
  desktop.focus(true); desktop.win.innerHeight = 440; desktop.resize(440);
  assert.ok(!desktop.classes.has('keyboard-open'));
  const addressBar = fixture();
  addressBar.focus(true); addressBar.resize(780);
  assert.ok(!addressBar.classes.has('keyboard-open'));
});

test('pinch zoom keeps layout stable and scrolling back is preserved', () => {
  const f = fixture();
  f.messages.scrollTop = 200;
  f.focus(true); f.resize(440);
  assert.equal(f.messages.scrollTop, 200);
  f.viewport.scale = 2; f.resize(220, 120);
  assert.equal(f.values.get('--app-height'), '440px');
  assert.equal(f.values.get('--app-top'), '0px');
  f.viewport.scale = 1; f.resize(440, 24);
  assert.equal(f.values.get('--app-top'), '24px');
});

test('rotation resets keyboard baseline; fallback and listener cleanup work', () => {
  const f = fixture();
  f.win.innerWidth = 844; f.win.innerHeight = 390; f.resize(390);
  assert.ok(!f.classes.has('keyboard-open'));
  f.focus(true); f.resize(220);
  assert.ok(f.classes.has('keyboard-open'));
  f.dispose(); f.resize(390);
  assert.equal(f.values.get('--app-height'), '220px');
  const fallback = fixture({ visual: false });
  fallback.win.innerHeight = 500; fallback.resize(500);
  assert.equal(fallback.values.get('--app-height'), '500px');
});
