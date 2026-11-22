import test from 'node:test';
import assert from 'node:assert/strict';
import { initHistoryLayout } from '../js/nav-layout.js?v=48';

function fixture(initial = undefined) {
  const classes = new Set();
  const storage = new Map(initial ? [['sowalif.historyPanelMode.v1',initial]] : []);
  const element = () => ({ attrs: {}, events: {}, classList: { toggle: () => {}, remove: () => {} },
    addEventListener(name,callback) { this.events[name] = callback; },
    setAttribute(name,value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    fire(name) { this.events[name]?.(); } });
  const app = element();
  app.classList = {
    toggle: (name, state) => { const enabled = state === undefined ? !classes.has(name) : state; if (enabled) classes.add(name); else classes.delete(name); return enabled; },
    remove: (name) => classes.delete(name),
    contains: (name) => classes.has(name),
  };
  const sidebar=element(), menu=element(), collapse=element(), select=element(), list=element(), search=element(), scrim=element();
  const dom = new Map([['#app',app],['#side',sidebar],['#menuBtn',menu],['#historyCollapse',collapse],['#historyPanelMode',select],['#chatList',list],['#search',search],['#scrim',scrim]]);
  const media = { matches: true, addEventListener(_, f) { this.update=f; } };
  const original={window:globalThis.window,document:globalThis.document,localStorage:globalThis.localStorage};
  globalThis.document={querySelector: key => dom.get(key) || null};
  globalThis.window={matchMedia: ()=>media};
  globalThis.localStorage={getItem: key=>storage.get(key) ?? null, setItem:(key,val)=>storage.set(key,val)};
  const restore=()=>{for(const [key,val] of Object.entries(original)) if(val===undefined) delete globalThis[key]; else globalThis[key]=val;};
  return {app,sidebar,menu,collapse,select,list,search,scrim,media,storage,restore};
}

test('history: compact default / expand / hide / restore / persistence', t=>{
  const f=fixture(); t.after(f.restore);
  initHistoryLayout();
  assert.equal(f.select.value,'compact');
  assert.equal(f.app.classList.contains('history-compact'),true);
  assert.equal(f.list.inert,true);
  f.collapse.fire('click');
  assert.equal(f.select.value,'expanded');
  assert.equal(f.list.inert,false);
  assert.equal(f.storage.get('sowalif.historyPanelMode.v1'),'expanded');
  globalThis.window.sowalifHistoryLayout.toggle();
  assert.equal(f.select.value,'hidden');
  assert.equal(f.menu.getAttribute('aria-expanded'),'false');
  globalThis.window.sowalifHistoryLayout.toggle();
  assert.equal(f.select.value,'expanded');
  f.select.value='compact'; f.select.fire('change');
  assert.equal(f.select.value,'compact');
  assert.equal(f.search.inert,true);
  assert.equal(f.collapse.getAttribute('aria-label'),'توسيع سجل المحادثات');
});

test('history: mobile drawer works regardless of saved desktop hidden state', t=>{
  const f=fixture('hidden'); t.after(f.restore);
  initHistoryLayout();
  assert.equal(f.select.value,'hidden');
  f.media.matches=false; f.media.update();
  assert.equal(f.app.classList.contains('history-hidden'),false);
  assert.equal(f.list.inert,false);
  globalThis.window.sowalifHistoryLayout.toggle();
  assert.equal(f.app.classList.contains('side-open'),true);
  globalThis.window.sowalifHistoryLayout.toggle();
  assert.equal(f.app.classList.contains('side-open'),false);
  f.media.matches=true; f.media.update();
  assert.equal(f.app.classList.contains('history-hidden'),true);
  assert.equal(f.select.value,'hidden');
});
