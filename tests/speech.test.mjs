import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { applyProjectProposal } from '../js/project.js?v=20';
import { writeProjectDirectory } from '../js/project-folder.js?v=20';

function app({ navigator = {}, coarsePointer = false } = {}) {
  const nodes = new Map();
  const documentEvents = {};
  const node = (s) => {
    if (!nodes.has(s)) {
      const classes = new Set();
      nodes.set(s, { value: '', innerHTML: '<svg>mic</svg>', textContent: '', style: {}, scrollHeight: 48,
        classList: { add: (...a) => a.forEach((v) => classes.add(v)), remove: (...a) => a.forEach((v) => classes.delete(v)), contains: (v) => classes.has(v), toggle: () => {} },
        setAttribute() {}, listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, focus() {}, click() { return this.onclick?.(); },
      });
    }
    return nodes.get(s);
  };
  let speech;
  class Speech {
    constructor() { speech = this; }
    start() {}
    stop() {}
    abort() {}
  }
  const timers = new Set();
  let timerId = 0;
  const setTimer = () => { timers.add(++timerId); return timerId; };
  const clearTimer = (id) => timers.delete(id);
  const ctx = vm.createContext({
    document: { visibilityState: 'visible', querySelector: node, querySelectorAll: () => [], addEventListener(name, fn) { documentEvents[name] = fn; }, documentElement: { style: { setProperty() {} } } },
    window: { SpeechRecognition: Speech, addEventListener() {} },
    navigator, matchMedia: query => ({ matches: coarsePointer && query === '(pointer: coarse)' }),
    db: { settings: { get: (_, d) => d } },
    MODELS: [{ id: 'test' }], DEFAULT_MODEL: 'test', OR_DEFAULT_MODEL: 'or:test/model', OR_AUDIO_MODEL: 'or:google/test',
    providerOf: (id) => String(id).startsWith('or:') ? 'openrouter' : 'kie',
    agentCredentials: () => ({ engine: 'off', provider: 'openrouter', key: '', model: '' }),
    localAgentOrigin: () => false,
    readPersonalization: () => ({ instructions: '', notes: '', enabled: true, rules: [] }),
    marked: { setOptions() {} },
    setTimeout: setTimer, setInterval: setTimer, clearTimeout: clearTimer, clearInterval: clearTimer,
    Date, Blob, AbortController, Uint8Array, innerHeight: 800,
  });
  const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/boot\(\)\.catch\([^\n]+/, '');
  vm.runInContext(source, ctx);
  return { ctx, node, timers, documentEvents, speech: () => speech, run: (s) => vm.runInContext(s, ctx) };
}

test('Enter sends regardless of browser device classification', () => {
  const a = app({ navigator: { userAgentData: { mobile: true } }, coarsePointer: true });
  const press = (event, expected) => {
    let sent = false;
    let prevented = false;
    a.ctx.recordSend = () => { sent = true; };
    a.run('send = recordSend');
    a.node('#input').listeners.keydown({ key: 'Enter', ...event, preventDefault: () => { prevented = true; } });
    assert.deepEqual({ sent, prevented }, expected);
  };
  press({}, { sent: true, prevented: true });
  press({ key: 'Unidentified', code: 'NumpadEnter' }, { sent: true, prevented: true });
  press({ shiftKey: true }, { sent: false, prevented: false });
  press({ isComposing: true }, { sent: false, prevented: false });
  press({ repeat: true }, { sent: false, prevented: true });
});

test('video model picker changes the media provider and model independently of chat', () => {
  const a = app();
  const prefs = new Map();
  a.ctx.db.settings.get = (key, fallback) => prefs.get(key) ?? fallback;
  a.ctx.db.settings.set = (key, value) => (prefs.set(key, value), true);
  a.ctx.modelById = () => ({ name: 'Chat model' });
  a.ctx.mediaProvider = () => prefs.get('mediaProvider') || 'piapi';
  a.node('#piapiVideoModel').options = [{ value: 'auto', textContent: 'تلقائي' }];
  a.node('#kieVideoModel').options = [{ value: 'seedance-2.5', textContent: 'Seedance 2.5' }];
  a.run("S.mode = 'video'; S.model = 'chat-model'");
  a.node('#modelBtn').click();
  a.node('#modelMediaProvider').onchange({ target: { value: 'kie' } });
  assert.match(a.node('#modelList').innerHTML, /Seedance 2\.5/);
  a.node('#modelList').listeners.click({ target: { closest: () => ({ dataset: { id: 'seedance-2.5' } }) } });
  assert.equal(prefs.get('mediaProvider'), 'kie');
  assert.equal(prefs.get('kieVideoModel'), 'seedance-2.5');
  assert.equal(a.node('#modelName').textContent, 'Seedance 2.5');
  assert.equal(a.node('#providerBadge').textContent, 'kie.ai');
  assert.equal(a.run('S.model'), 'chat-model');
});

test('applying a proposal in a linked project writes the file on disk immediately', async (t) => {
  const a = app();
  const directory = await mkdtemp(join(tmpdir(), 'sowalif-linked-project-'));
  const path = join(directory, 'app.js');
  await writeFile(path, 'before');
  t.after(async () => { await unlink(path); await rmdir(directory); });
  a.ctx.applyProjectProposal = applyProjectProposal;
  a.ctx.writeProjectDirectory = writeProjectDirectory;
  a.ctx.location = { pathname: '/' };
  a.ctx.history = { replaceState() {} };
  a.ctx.db.saveProject = async (chat, project) => { chat.project = project; };
  a.ctx.db.saveProjectFolder = async () => {};
  a.ctx.directory = {
    name: 'project',
    requestPermission: async () => 'granted',
    getFileHandle: async name => {
      assert.equal(name, 'app.js');
      return {
        getFile: async () => ({ text: () => readFile(path, 'utf8') }),
        createWritable: async () => ({ write: content => writeFile(path, content), close: async () => {} }),
      };
    },
  };
  a.run(`
    S.mode = 'work';
    S.chat = {
      id: 'work',
      project: { revision: 1, files: [{ path: 'app.js', content: 'before' }] },
      messages: [{ projectProposal: { revision: 1, changes: [{ path: 'app.js', content: 'after' }] } }],
    };
    linkedFolders.set('work', { directory, baseline: new Map([['app.js', 'before']]) });
    renderMessages = () => {};
    loadChats = async () => {};
  `);
  await a.node('#messages').listeners.click({
    target: { closest: selector => selector === '.msg[data-i]' ? { dataset: { i: '0' } }
      : selector === '[data-apply-project]' ? {} : null },
  });
  assert.equal(await readFile(path, 'utf8'), 'after');
  assert.match(a.node('#toast').textContent, /مجلد جهازك/);
});

test('live dictation keeps the draft, replaces interim text, and cleans up on stop', () => {
  const a = app();
  a.node('#input').value = 'مسودة';
  a.run('startDictation()');
  const speech = a.speech();
  assert.equal(speech.lang, 'ar-SA');
  const interim = [{ transcript: 'أهلا' }];
  interim.isFinal = false;
  speech.onresult({ results: [interim] });
  assert.equal(a.node('#input').value, 'مسودة أهلا');
  const final = [{ transcript: 'أهلاً وسهلاً' }];
  final.isFinal = true;
  speech.onresult({ results: [final] });
  assert.equal(a.node('#input').value, 'مسودة أهلاً وسهلاً');
  assert.equal(a.node('#input').readOnly, true);
  a.run('stopRec()');
  speech.onend();
  assert.equal(a.node('#input').readOnly, false);
  assert.equal(a.node('#micBtn').innerHTML, '<svg>mic</svg>');
  assert.equal(a.timers.size, 0);
});

test('permission or service failure restores controls and preserves existing draft', () => {
  for (const error of ['not-allowed', 'network']) {
    const a = app();
    a.node('#input').value = 'كلام مكتوب';
    a.run('startDictation()');
    a.speech().onerror({ error });
    a.speech().onend();
    assert.equal(a.node('#input').value, 'كلام مكتوب');
    assert.equal(a.node('#input').readOnly, false);
    assert.equal(a.run('rec'), null);
    assert.ok(a.node('#toast').textContent.length > 0);
  }
});

test('unsupported live dictation uses the recording path', () => {
  const a = app();
  a.run('window.SpeechRecognition = undefined; startDictation()');
  assert.match(a.node('#toast').textContent, /ما يدعم التسجيل/);
  assert.equal(a.run('rec'), null);
});

function recorder(a) {
  let stoppedTracks = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    mimeType = 'audio/mp4';
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  a.ctx.window.MediaRecorder = a.ctx.MediaRecorder = Recorder;
  a.ctx.db.settings.get = (key, fallback) => key === 'kieKey' ? 'test' : fallback;
  a.ctx.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() { stoppedTracks++; } }] }) };
  return { stopped: () => stoppedTracks };
}

test('recording cancellation drops audio without transcription and preserves the draft', async () => {
  const a = app();
  const r = recorder(a);
  let calls = 0;
  a.ctx.transcribe = async () => { calls++; return 'نص'; };
  a.node('#input').value = 'مسودة';
  await a.run('startRec()');
  assert.equal(a.node('#input').readOnly, true);
  a.node('#voiceCancel').onclick();
  assert.equal(a.run('rec'), null);
  assert.equal(a.node('#input').value, 'مسودة');
  assert.equal(a.node('#input').readOnly, false);
  assert.equal(calls, 0);
  assert.ok(r.stopped() > 0);
  assert.equal(a.timers.size, 0);
});

test('stopping a recording converts it directly into the draft', async () => {
  const a = app();
  recorder(a);
  a.ctx.transcribe = async () => 'النص';
  await a.node('#micBtn').click();
  assert.equal(a.node('#voiceAccept').textContent, '■');
  a.run('rec.started -= 2000; rec.mr.ondataavailable({ data: new Blob(["x".repeat(2000)]) })');
  a.node('#voiceAccept').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.node('#input').value, 'النص');
});

test('failed transcription retains audio for retry and inserts text only after success', async () => {
  const a = app();
  recorder(a);
  let calls = 0;
  a.ctx.transcribe = async () => { if (++calls === 1) throw new Error('provider failed'); return 'الكلام المحوّل'; };
  a.node('#input').value = 'مسودة';
  await a.run('startRec()');
  await a.run('rec.started -= 2000; finishRec(new Blob(["x".repeat(2000)], {type:"audio/mp4"}), rec)');
  assert.ok(a.run('voiceJob.blob.size') > 1500);
  assert.equal(a.node('#voiceAccept').disabled, false);
  assert.equal(a.node('#input').value, 'مسودة');
  await a.run('convertVoice(voiceJob)');
  assert.equal(a.node('#input').value, 'مسودة الكلام المحوّل');
  assert.equal(a.run('voiceJob'), null);
  assert.equal(a.node('#input').readOnly, false);
  assert.equal(calls, 2);
});

test('cancelled conversion cannot insert a late transcript', async () => {
  const a = app();
  recorder(a);
  let resolve;
  a.ctx.transcribe = () => new Promise((r) => { resolve = r; });
  a.node('#input').value = 'مسودة';
  await a.run('startRec()');
  const pending = a.run('rec.started -= 2000; finishRec(new Blob(["x".repeat(2000)]), rec)');
  a.node('#voiceCancel').onclick();
  resolve('نص وصل بعد الإلغاء');
  await pending;
  assert.equal(a.node('#input').value, 'مسودة');
  assert.equal(a.run('voiceJob'), null);
  assert.equal(a.node('#input').readOnly, false);
});

test('provider switching keeps keys and defaults independent in settings', async () => {
  const a = app();
  const saved = new Map([['kieKey', 'original-kie-key']]);
  a.ctx.db.settings = { get: (k, d) => saved.has(k) ? saved.get(k) : d, set: (k, v) => saved.set(k, v) };
  const catalog = [{ id: 'test', name: 'KIE model', tagline: 'KIE', features: [] }, { id: 'or:test/model', name: 'OR model', tagline: 'OR', features: [], provider: 'openrouter' }];
  a.ctx.modelsFor = (provider) => catalog.filter((m) => (m.provider || 'kie') === provider);
  a.ctx.modelById = (id) => catalog.find((m) => m.id === id) || catalog[0];
  a.ctx.checkOpenRouterKey = async () => ({ limit_remaining: null });
  a.ctx.credits = async () => { throw new Error('KIE check must not run'); };
  a.ctx.confirm = () => true;
  a.node('#providerSelect').value = 'openrouter';
  a.node('#providerSelect').onchange({ target: a.node('#providerSelect') });
  assert.equal(a.run('S.provider'), 'openrouter');
  assert.equal(a.run('S.model'), 'or:test/model');
  assert.equal(a.node('#imgBtn').disabled, false);
  a.node('#keyInput').value = 'new-openrouter-key';
  a.node('#saveKey').onclick();
  await new Promise(setImmediate);
  assert.equal(saved.get('openRouterKey'), 'new-openrouter-key');
  assert.equal(saved.get('kieKey'), 'original-kie-key');
  assert.equal(a.node('#keyInput').value, '');
  assert.match(a.node('#keyMsg').textContent, /OpenRouter صالح/);
  a.node('#forgetKey').onclick();
  assert.equal(saved.get('openRouterKey'), '');
  assert.equal(saved.get('kieKey'), 'original-kie-key');
});

test('microphone wake lock releases on stop and reacquires when visible again', async () => {
  const a = app();
  const locks = [];
  a.ctx.navigator.wakeLock = { request: async (type) => {
    assert.equal(type, 'screen');
    const lock = { released: false, addEventListener(_, fn) { this.onrelease = fn; }, async release() { this.released = true; this.onrelease?.(); } };
    locks.push(lock);
    return lock;
  } };
  a.run('startDictation()');
  await a.run('acquireMicWake()');
  assert.equal(locks.length, 1);
  assert.match(a.node('#wakeStatus').textContent, /تبقى شغالة/);
  await locks[0].release();
  a.documentEvents.visibilitychange();
  await a.run('acquireMicWake()');
  assert.equal(locks.length, 2);
  a.run('stopRec()');
  assert.equal(locks[1].released, true);
  assert.equal(a.run('micWakeOwner'), null);
});
test('late wake lock grant after cancellation is released, and rejection leaves dictation usable', async () => {
  const a = app();
  let grant;
  a.ctx.navigator.wakeLock = { request: () => new Promise(resolve => { grant = resolve; }) };
  a.run('startDictation()');
  a.run('stopRec()');
  const late = { released: false, async release() { this.released = true; } };
  grant(late);
  await new Promise(setImmediate);
  assert.equal(late.released, true);
  const b = app();
  b.ctx.navigator.wakeLock = { request: async () => { throw new Error('denied'); } };
  b.run('startDictation()');
  await b.run('acquireMicWake()');
  assert.match(b.node('#wakeStatus').textContent, /لم يسمح/);
  assert.ok(b.run('rec'));
});
