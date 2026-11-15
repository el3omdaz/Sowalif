import test from 'node:test';
import assert from 'node:assert/strict';
import { initOrganizer } from '../js/organizer.js';

test('Gmail and Drive retain independent Google accounts and route requests with their own tokens', async t => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', classList: { toggle() {} }, replaceChildren(...children) { this.children = children; },
      reset() {}, focus() {}, setAttribute() {}, append() {}, childElementCount: 0,
    });
    return nodes.get(id);
  };
  let token = 'first';
  const requests = [];
  const globals = {
    document: { getElementById: node, createElement: () => ({}) },
    location: { origin: 'https://example.test' },
    Option: class { constructor(text, value) { Object.assign(this, { text, value }); } },
    google: { accounts: { oauth2: {
      hasGrantedAllScopes: () => true,
      initTokenClient: ({ callback }) => ({ requestAccessToken: () => callback({ access_token: token }) }),
    } } },
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const bearer = options.headers.Authorization;
      requests.push([path, bearer]);
      return Response.json(path.endsWith('/about') ? { user: { permissionId: token, emailAddress: token + '@example.test' } } : { messages: [], files: [] });
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  initOrganizer({ localAgentOrigin: () => false, settings: { get: () => 'client.apps.googleusercontent.com', set() {} } });
  const source = node('organizerSource');
  const picker = node('organizerGoogleAccount');
  const chooseSource = value => { source.value = value; source.onchange(); };
  const tick = () => new Promise(setImmediate);
  const search = async () => {
    node('organizerTask').value = 'report';
    node('organizerSearch').onsubmit({ preventDefault() {} });
    await tick();
  };
  chooseSource('gmail');
  node('organizerConnect').onclick();
  await tick();
  assert.equal(picker.value, 'first');
  chooseSource('gdrive');
  token = 'second';
  node('organizerConnect').onclick();
  await tick();
  assert.deepEqual(picker.children.map(option => option.text), ['first@example.test', 'second@example.test']);
  assert.equal(picker.value, 'second');
  await search();
  assert.deepEqual(requests.at(-1), ['/drive/v3/files', 'Bearer second']);
  chooseSource('gmail');
  assert.equal(picker.value, 'first');
  await search();
  assert.deepEqual(requests.at(-1), ['/gmail/v1/users/me/messages', 'Bearer first']);
  picker.value = 'second';
  picker.onchange();
  await search();
  assert.deepEqual(requests.at(-1), ['/gmail/v1/users/me/messages', 'Bearer second']);
  node('organizerDisconnect').onclick();
  assert.equal(picker.value, 'first');
  chooseSource('gdrive');
  assert.equal(picker.value, 'first');
});
