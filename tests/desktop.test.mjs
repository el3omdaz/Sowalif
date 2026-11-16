import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { allowDesktopPermission, externalWebLink, isDesktopDocument, ORIGIN, startDesktopServer } from '../desktop/runtime.mjs';

test('desktop confines main navigation and permissions to the local app document', () => {
  assert.equal(isDesktopDocument(`${ORIGIN}/#chat-12`), true);
  assert.equal(isDesktopDocument(`${ORIGIN}/preview/project/index.html`), false);
  assert.equal(isDesktopDocument('https://example.org/'), false);
  assert.equal(externalWebLink('https://example.org/'), 'https://example.org/');
  for (const target of [ORIGIN, 'file:///C:/user/private.txt', 'javascript:alert(1)', 'https://u:p@example.org/']) {
    assert.equal(externalWebLink(target), '');
  }
  const audio = { url: `${ORIGIN}/`, isMainFrame: true, mediaTypes: ['audio'] };
  assert.equal(allowDesktopPermission('media', audio), true);
  assert.equal(allowDesktopPermission('media', { ...audio, isMainFrame: false }), false);
  assert.equal(allowDesktopPermission('media', { ...audio, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(allowDesktopPermission('notifications', { url: 'https://example.org/' }), false);
  assert.equal(allowDesktopPermission('geolocation', audio), false);
});

test('desktop starts its own loopback service and refuses to reuse an occupied port', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sowalif-desktop-test-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await startDesktopServer({ root, dataDir, port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1');
  await assert.rejects(startDesktopServer({ root, dataDir, port }), { code: 'EADDRINUSE' });
  const origin = `http://${address}:${port}`;
  assert.match(await (await fetch(origin)).text(), /<title>سوالف<\/title>/);
  const { csrf } = await (await fetch(`${origin}/api/files/session`)).json();
  assert.match(csrf, /^[a-f0-9]{64}$/);
  const headers = { 'Content-Type': 'application/json', 'X-Sowalif-CSRF': csrf, Origin: 'https://example.org' };
  assert.equal((await fetch(`${origin}/api/files/scan`, { method: 'POST', headers, body: '{}' })).status, 403);
});
