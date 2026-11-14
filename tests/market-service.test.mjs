import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMarketService } from '../server/market-service.mjs';

const origin = 'https://sowalif.example';
const token = 'example-test-secret-that-has-at-least-32-characters';
const eventId = '0123456789abcdef0123456789abcdef';
const subscription = (device) => ({
  endpoint: `https://web.push.apple.com/device-${device}`,
  keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) },
  expirationTime: null,
});

async function launch(t, { dataDir, ...options } = {}) {
  if (!dataDir) {
    dataDir = await mkdtemp(join(tmpdir(), 'sowalif-market-service-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
  }
  let notices;
  let started = false;
  let configured = {};
  let refreshed = 0;
  const analyses = new Map();
  const marketFactory = ({ onEvents }) => {
    notices = onEvents;
    return {
      start() { started = true; },
      close() { started = false; },
      async status() { return { config: configured, started }; },
      async events(asset) { return { events: [{ asset, analyses: analyses.get(eventId) }] }; },
      async article(id) { return { id, text: 'Source article' }; },
      async saveAnalysis(id, asset, analysis) { analyses.set(id, { ...analyses.get(id), [asset]: analysis }); },
      async refresh() { return { refreshed: ++refreshed }; },
      async configure(config) { return { config: configured = config }; },
    };
  };
  const server = createMarketService({ origin, token, dataDir, marketFactory, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/market/`;
  const close = () => new Promise((resolve) => server.close(resolve));
  t.after(close);
  const request = (path, body, moreHeaders = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...moreHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { request, notices, close, dataDir };
}

test('only authorized same-origin requests can read or change market data', async (t) => {
  const { request } = await launch(t);
  const status = await request('status');
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await status.json(), { config: {}, started: true, pushKey: null, analysisEnabled: false });
  assert.equal((await request('events?asset=XAU%2FUSD', undefined, { Authorization: '' })).status, 401);
  assert.equal((await request('status', undefined, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await request('config', {}, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await request('config', {}, { Origin: '' })).status, 403);
  assert.equal((await request('config')).status, 405);
  assert.equal((await request('config', { text: 'x'.repeat(20_000) })).status, 413);
  assert.equal((await request('config', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.deepEqual(await (await request('config', { enabled: true })).json(), { config: { enabled: true }, pushKey: null, analysisEnabled: false });
  assert.deepEqual(await (await request('events?asset=XAU%2FUSD')).json(), { events: [{ asset: 'XAU/USD' }] });
  assert.deepEqual(await (await request(`article?id=${eventId}`)).json(), { id: eventId, text: 'Source article' });
  assert.deepEqual(await (await request('refresh', {})).json(), { refreshed: 1, pushKey: null, analysisEnabled: false });
  assert.equal((await request('subscription', { subscription: subscription('test'), enabled: true })).status, 503);
});

test('automatic analysis is stored and opposite directions get distinct notifications', async (t) => {
  const sent = [];
  const analysis = (direction) => ({ direction, summary: 'Analysis of the published release' });
  const { request, notices } = await launch(t, {
    key: 'sample-key',
    analysisFactory: () => async (_event, asset, article) => {
      assert.equal(article?.id, eventId);
      return analysis(asset === 'XAU/USD' ? 'positive' : 'negative');
    },
    sendPush: async (_item, raw) => sent.push(JSON.parse(raw)),
  });
  assert.equal((await (await request('status')).json()).analysisEnabled, true);
  await request('subscription', { subscription: subscription('phone'), enabled: true });
  await notices([{ id: eventId, kind: 'news', title: 'Published release', assets: ['XAU/USD', 'USD/JPY'] }]);
  assert.deepEqual(sent.map(({ asset, direction, tag }) => ({ asset, direction, tag })), [
    { asset: 'XAU/USD', direction: 'positive', tag: `market-${eventId}-positive` },
    { asset: 'USD/JPY', direction: 'negative', tag: `market-${eventId}-negative` },
  ]);
  const { events } = await (await request('events')).json();
  assert.deepEqual(events[0].analyses, { 'XAU/USD': analysis('positive'), 'USD/JPY': analysis('negative') });
});

test('push registrations survive restart, expire independently, and are removable per device', async (t) => {
  const sent = [];
  const key = 'public-key';
  const sendPush = async (item, raw) => {
    sent.push({ item, payload: JSON.parse(raw) });
    if (item.endpoint.endsWith('-stale')) throw Object.assign(new Error('gone'), { statusCode: 410 });
  };
  const first = await launch(t, { key, sendPush });
  assert.equal((await (await first.request('status')).json()).pushKey, key);
  const subscribe = (instance, device, enabled = true) => instance.request('subscription', { subscription: subscription(device), enabled });
  for (const device of ['phone', 'laptop', 'stale']) {
    assert.deepEqual(await (await subscribe(first, device)).json(), { registered: true });
  }
  const unsupported = { ...subscription('unsafe'), endpoint: 'https://127.0.0.1/internal' };
  assert.equal((await first.request('subscription', { subscription: unsupported, enabled: true })).status, 400);
  await first.close();

  const second = await launch(t, { dataDir: first.dataDir, key, sendPush });
  const marketEvent = { id: eventId, kind: 'price', title: 'Price threshold reached', assets: ['XAU/USD'], direction: 'positive' };
  await second.notices([marketEvent]);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0].payload, {
    id: eventId, type: 'market', title: 'Price threshold reached', asset: 'XAU/USD', direction: 'positive', tag: `market-${eventId}`,
  });
  assert.deepEqual(await (await subscribe(second, 'laptop', false)).json(), { registered: false });
  const stored = JSON.parse(await readFile(join(first.dataDir, 'market-subscriptions.json'), 'utf8'));
  assert.deepEqual(stored, [subscription('phone')]);
  await second.notices([{ ...marketEvent, id: '9'.repeat(32), direction: 'unrecognized' }]);
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.at(-1).item, subscription('phone'));
  assert.equal(sent.at(-1).payload.direction, 'neutral');
});
