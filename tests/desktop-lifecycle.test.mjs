import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const tick = () => new Promise(resolve => setImmediate(resolve));

function desktop({ pendingLoad = false, loadError, lock = true } = {}) {
  const windows = [];
  const dialogs = [];
  let ready, finishLoad;
  let quitCalls = 0;
  let closeCallback;
  const server = {
    closes: 0, drained: 0,
    close(callback) { this.closes++; closeCallback = callback; },
    closeAllConnections() { this.drained++; },
    listening: true,
  };
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setAppUserModelId() {},
    requestSingleInstanceLock: () => lock,
    whenReady: () => new Promise(resolve => { ready = resolve; }),
    isReady: () => Boolean(ready),
    getAppPath: () => '/sowalif', getPath: () => '/profile',
    getVersion: () => '1.0.0',
    quit() { quitCalls++; },
  });
  class Window extends EventEmitter {
    constructor(options) {
      super(); windows.push(this); this.options = options;
      this.visible = Boolean(options.show); this.destroyed = false;
      this.minimized = false; this.restores = 0; this.shows = 0; this.focuses = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {}, isDestroyed: () => false,
        getURL: () => 'http://127.0.0.1:4782/',
      });
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    isVisible() { return this.visible; }
    restore() { this.minimized = false; this.restores++; }
    show() { this.visible = true; this.shows++; }
    focus() { this.focuses++; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    loadURL() {
      if (loadError) return Promise.reject(loadError);
      const complete = () => { this.emit('ready-to-show'); this.webContents.emit('did-finish-load'); };
      if (pendingLoad) return new Promise(resolve => { finishLoad = () => { complete(); resolve(); }; });
      complete(); return Promise.resolve();
    }
  }
  Window.getAllWindows = () => windows.filter(window => !window.destroyed);
  class Tray extends EventEmitter {
    setToolTip() {} setContextMenu(menu) { this.menu = menu; } destroy() {}
  }
  const browserSession = {
    setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, webRequest: { onHeadersReceived() {} },
  };
  const icon = { resize() { return this; } };
  const timers = new Map(); let timerId = 0;
  const addTimer = callback => { const id = { id: ++timerId, unref() {} }; timers.set(id, callback); return id; };
  const ctx = vm.createContext({
    app, BrowserWindow: Window, Tray,
    dialog: { showErrorBox: (...args) => dialogs.push(args), showOpenDialog: async () => ({ canceled: true }) },
    ipcMain: { handle() {} }, Menu: { setApplicationMenu() {}, buildFromTemplate: entries => entries },
    nativeImage: { createFromPath: () => icon }, session: { fromPartition: () => browserSession },
    shell: { openExternal: async () => {} }, join,
    allowDesktopPermission: () => false, externalWebLink: () => '', isDesktopDocument: () => true,
    ORIGIN: 'http://127.0.0.1:4782', startDesktopServer: async () => server,
    process: Object.assign(new EventEmitter(), { platform: 'win32', pid: 123, env: {}, execPath: '/sowalif/Sowalif.exe' }),
    setTimeout: addTimer, clearTimeout: timer => timers.delete(timer),
    console: { log() {}, error() {}, warn() {} },
  });
  const source = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, ctx);
  return { app, windows, server, dialogs, timers,
    start: async () => { ready(); await tick(); },
    finishLoad: async () => { finishLoad?.(); await tick(); },
    finishClose: () => closeCallback?.(), quitCalls: () => quitCalls,
  };
}

test('closing the desktop window hides to tray and a second launch restores the same window', async () => {
  const d = desktop(); await d.start();
  assert.equal(d.windows.length, 1);
  const window = d.windows[0];
  let prevented = false;
  window.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(window.visible, false);
  window.minimized = true;
  d.app.emit('second-instance'); await tick();
  assert.equal(window.visible, true);
  assert.equal(window.restores, 1);
  assert.equal(d.windows.length, 1);
});

test('repeated launches during first page load do not create duplicate windows', async () => {
  const d = desktop({ pendingLoad: true }); await d.start();
  assert.equal(d.windows.length, 1);
  d.app.emit('second-instance'); d.app.emit('activate'); await tick();
  assert.equal(d.windows.length, 1);
  await d.finishLoad();
  assert.equal(d.windows[0].visible, true);
});

test('desktop shutdown drains local HTTP connections and does not prevent the final quit', async () => {
  const d = desktop(); await d.start();
  let prevented = 0;
  d.app.emit('before-quit');
  d.app.emit('will-quit', { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(d.server.closes, 1);
  assert.equal(d.server.drained, 1);
  d.finishClose();
  assert.equal(d.quitCalls(), 1);
  d.app.emit('will-quit', { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
});

test('failed page startup reports a visible error and requests app shutdown', async () => {
  const d = desktop({ loadError: new Error('load failed') }); await d.start();
  assert.equal(d.dialogs.length, 1);
  assert.equal(d.quitCalls(), 1);
});

test.todo('activating after the last window was destroyed recreates exactly one window');
