import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalApp } from '../server/local-agent/start.mjs';
import { FILE_SEARCH_VERSION } from '../server/local-agent/search-capabilities.mjs';

test('launcher reports an old running service without opening it or launching a duplicate', async () => {
  for (const state of [{ local: true }, { local: true, fileSearchVersion: FILE_SEARCH_VERSION - 1 }, { local: true, fileSearchVersion: String(FILE_SEARCH_VERSION) }]) {
    const errors = [];
    assert.equal(await startLocalApp({
      request: async () => Response.json(state),
      launch: () => assert.fail('An old service must not launch another server or open a browser'),
      log: () => assert.fail('An old service must not be reported ready'), error: message => errors.push(message), platform: 'win32',
    }), false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /إعادة تشغيل/);
    assert.match(errors[0], /Start-Sowalif\.cmd/);
  }
});

test('launcher reuses a compatible running service and opens only its local app', async () => {
  const launched = [], logs = [];
  assert.equal(await startLocalApp({
    request: async () => Response.json({ local: true, fileSearchVersion: FILE_SEARCH_VERSION }),
    launch: (...args) => { launched.push(args); return { unref() {} }; },
    log: message => logs.push(message), error: () => assert.fail('Compatible service must not warn'), platform: 'win32',
  }), true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0][0], 'powershell.exe');
  assert.match(launched[0][1].at(-1), /http:\/\/127\.0\.0\.1:4781\//);
  assert.equal(launched[0][2].windowsHide, true);
  assert.equal(logs.length, 1);
});

test('launcher starts the current server in the chosen workspace when no service is running', async t => {
  const base = await mkdtemp(join(tmpdir(), 'sowalif-launcher-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const launched = [];
  assert.equal(await startLocalApp({
    request: async () => { throw new TypeError('Connection refused'); },
    launch: (...args) => { launched.push(args); return { unref() {} }; }, base, platform: 'linux', log() {}, error: () => assert.fail('Offline service must start'),
  }), true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0][0], process.execPath);
  assert.deepEqual(launched[0][1], [join(base, 'server/local-agent/server.mjs')]);
  assert.equal(launched[0][2].cwd, base);
  assert.equal(launched[0][2].windowsHide, true);
  assert.equal(launched[0][2].detached, true);
  assert.equal(await readFile(join(base, '.local-agent/server.log'), 'utf8'), '');
});
