import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function app() {
  const nodes = new Map();
  const node = (s) => {
    if (!nodes.has(s)) {
      const classes = new Set();
      nodes.set(s, { value: '', innerHTML: '<svg>mic</svg>', textContent: '', style: {}, scrollHeight: 48,
        classList: { add: (...a) => a.forEach((v) => classes.add(v)), remove: (...a) => a.forEach((v) => classes.delete(v)), contains: (v) => classes.has(v), toggle: () => {} },
        setAttribute() {}, addEventListener() {}, focus() {}, click() { return this.onclick?.(); },
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
    document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    window: { SpeechRecognition: Speech, addEventListener() {} },
    navigator: {}, matchMedia: () => ({ matches: false }),
    db: { settings: { get: (_, d) => d } },
    MODELS: [{ id: 'test' }], DEFAULT_MODEL: 'test', OR_DEFAULT_MODEL: 'or:test/model', OR_AUDIO_MODEL: 'or:google/test',
    providerOf: (id) => String(id).startsWith('or:') ? 'openrouter' : 'kie',
    marked: { setOptions() {} },
    setTimeout: setTimer, setInterval: setTimer, clearTimeout: clearTimer, clearInterval: clearTimer,
    Date, Blob, AbortController, Uint8Array, innerHeight: 800,
  });
  const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/boot\(\)\.catch\([^\n]+/, '');
  vm.runInContext(source, ctx);
  return { ctx, node, timers, speech: () => speech, run: (s) => vm.runInContext(s, ctx) };
}

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
  assert.equal(a.node('#imgBtn').disabled, true);
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
