import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createMediaPushService } from '../server/media-push.js';

test('provider completion sends one notification for the registered conversation', async (t) => {
  const origin = 'https://sowalif.example';
  const sent = [];
  const server = createMediaPushService({
    origin, key: 'public-key', database: ':memory:',
    sendPush: async (subscription, payload) => sent.push({ subscription, payload: JSON.parse(payload) }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const local = `http://127.0.0.1:${server.address().port}`;
  const api = local + '/api/media-push/';
  const subscription = {
    endpoint: 'https://web.push.apple.com/fake',
    keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) },
  };
  const post = (url, body, headers) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  assert.deepEqual(await (await fetch(api + 'key')).json(), { key: 'public-key' });
  for (const provider of ['kie', 'piapi']) {
    const at = provider === 'kie' ? 1 : 2;
    const registration = await post(api + 'ticket', { provider, chatId: 'chat-123', at, subscription }, { Origin: origin });
    assert.equal(registration.status, 201);
    const { endpoint, secret } = await registration.json();
    const callback = local + new URL(endpoint).pathname;
    const headers = provider === 'piapi' ? { 'x-webhook-secret': secret } : {};
    if (provider === 'piapi') assert.equal((await post(callback, { data: { status: 'completed' } })).status, 403);
    assert.equal((await post(callback, { data: { state: 'processing', status: 'processing' } }, headers)).status, 204);
    assert.equal(sent.length, at - 1);
    const terminal = { data: { state: 'success', status: 'completed' } };
    assert.equal((await post(callback, terminal, headers)).status, 204);
    assert.equal((await post(callback, terminal, headers)).status, 204);
    assert.deepEqual(sent.at(-1), {
      subscription, payload: { chatId: 'chat-123', tag: `chat-123-${at}`, outcome: 'ready' },
    });
  }
  assert.equal(sent.length, 2);
});
