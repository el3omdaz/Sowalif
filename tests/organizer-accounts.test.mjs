import test from 'node:test';
import assert from 'node:assert/strict';
import { initOrganizer } from '../js/organizer.js?v=40';

test('Google and Microsoft accounts route mail and drive requests independently', async t => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', classList: { toggle() {} }, replaceChildren(...children) { this.children = children; },
      reset() {}, focus() {}, setAttribute() {}, append() {}, childElementCount: 0,
    });
    return nodes.get(id);
  };
  let token = 'first';
  let channel;
  let microsoftAuthorization;
  const requests = [];
  const globals = {
    document: { getElementById: node, createElement: () => ({}) },
    location: { origin: 'https://example.test' },
    BroadcastChannel: class {
      constructor() { channel = this; }
      close() {}
    },
    window: { open: () => ({
      location: { set href(value) {
        microsoftAuthorization = new URL(value);
        channel.onmessage({ origin: 'https://example.test', data: { state: microsoftAuthorization.searchParams.get('state'), code: 'test-code' } });
      } },
      close() {},
    }) },
    Option: class { constructor(text, value) { Object.assign(this, { text, value }); } },
    google: { accounts: { oauth2: {
      hasGrantedAllScopes: () => true,
      initTokenClient: ({ callback }) => ({ requestAccessToken: () => callback({ access_token: token }) }),
    } } },
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const bearer = options.headers?.Authorization;
      requests.push([path, bearer]);
      if (path.endsWith('/token')) return Response.json({ access_token: token });
      if (path === '/v1.0/me') return Response.json({ id: token, mail: token + '@outlook.test' });
      return Response.json(path.endsWith('/about') ? { user: { permissionId: token, emailAddress: token + '@example.test' } } : { messages: [], files: [] });
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  initOrganizer({ localAgentOrigin: () => false, settings: { get: key => key.endsWith('microsoft') ? '12345678-1234-1234-1234-123456789abc' : 'client.apps.googleusercontent.com', set() {} } });
  const source = node('organizerSource');
  const picker = node('organizerAccount');
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
  const connectMicrosoft = async value => {
    token = value;
    node('organizerConnect').onclick();
    for (let tries = 0; node('organizerSource').disabled && tries < 30; tries++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(node('organizerSource').disabled, false);
    assert.equal(picker.value, value, node('organizerStatus').textContent);
  };
  chooseSource('outlook');
  assert.equal(picker.children.length, 0);
  await connectMicrosoft('outlook-first');
  assert.match(microsoftAuthorization.searchParams.get('scope'), /User\.Read/);
  chooseSource('onedrive');
  await connectMicrosoft('onedrive-second');
  await search();
  assert.equal(requests.at(-1)[1], 'Bearer onedrive-second');
  assert.match(requests.at(-1)[0], /^\/v1\.0\/me\/drive\//);
  chooseSource('outlook');
  assert.equal(picker.value, 'outlook-first');
  await search();
  assert.deepEqual(requests.at(-1), ['/v1.0/me/messages', 'Bearer outlook-first']);
  chooseSource('gmail');
  assert.deepEqual(picker.children.map(option => option.value), ['first']);
});
