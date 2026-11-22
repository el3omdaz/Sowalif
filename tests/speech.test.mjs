import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { applyProjectProposal, readProjectFiles, mergeProjectFiles, projectFileBytes } from '../js/project.js?v=48';
import { writeProjectDirectory } from '../js/project-folder.js?v=48';
import { reasoningLevels } from '../js/reasoning.js?v=48';
import { CODING_ENGINES, CODING_PROVIDERS, codingEngineById, codingEngineName } from '../js/agent-engines.js?v=48';

function app({ navigator = {}, coarsePointer = false } = {}) {
  const nodes = new Map();
  const documentEvents = {};
  const node = (s) => {
    if (!nodes.has(s)) {
      const classes = new Set();
      nodes.set(s, { value: '', innerHTML: '<svg>mic</svg>', textContent: '', style: {}, scrollHeight: 48,
        classList: { add: (...a) => a.forEach((v) => classes.add(v)), remove: (...a) => a.forEach((v) => classes.delete(v)), contains: (v) => classes.has(v), toggle: () => {} },
        setAttribute() {}, replaceChildren() {}, listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, focus() {}, click() { return this.onclick?.(); },
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
    reasoningLevels,
    Option: class { constructor(text, value) { Object.assign(this, { text, value }); } },
    agentCredentials: () => ({ engine: 'off', provider: 'openrouter', key: '', model: '' }),
    CODING_ENGINES, CODING_PROVIDERS, codingEngineById, codingEngineName,
    localAgentOrigin: () => false,
    projectAutoApprove: () => false,
    setProjectAutoApprove: () => false,
    fitViewport: () => {},
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

test('project permission toggles immediately and restores its own state when changing projects', () => {
  const a = app();
  const saved = new Map();
  a.ctx.localAgentOrigin = () => true;
  a.ctx.window.confirm = () => assert.fail('The checkbox must not open a confirmation');
  a.ctx.projectAutoApprove = chat => saved.get(chat?.id) === true;
  a.ctx.setProjectAutoApprove = (chat, enabled) => { saved.set(chat.id, enabled); return true; };
  const toggle = a.node('#agentAutoApprove');
  const change = checked => { toggle.checked = checked; toggle.listeners.change({ target: toggle }); };
  a.run("S.chat={id:'project-a'}; renderModelName=()=>{}; syncToggles();");
  assert.equal(toggle.checked, false);
  change(true);
  assert.equal(toggle.checked, true);
  assert.equal(saved.get('project-a'), true);
  a.run('syncToggles();');
  assert.equal(toggle.checked, true);
  a.run("S.chat={id:'project-b'}; syncToggles();");
  assert.equal(toggle.checked, false);
  a.run("S.chat={id:'project-a'}; renderModelName=()=>{}; syncToggles();");
  assert.equal(toggle.checked, true);
  change(false);
  a.run('syncToggles();');
  assert.equal(toggle.checked, false);
  assert.equal(saved.get('project-a'), false);
});

test('a failed permission save restores the previous checkbox value and explains the failure', () => {
  const a = app();
  a.ctx.localAgentOrigin = () => true;
  a.ctx.projectAutoApprove = () => true;
  a.ctx.setProjectAutoApprove = () => false;
  a.run("S.chat={id:'project-a'}; renderModelName=()=>{}; syncToggles();");
  const toggle = a.node('#agentAutoApprove');
  toggle.checked = false;
  toggle.listeners.change({ target: toggle });
  assert.equal(toggle.checked, true);
  assert.match(a.node('#toast').textContent, /تعذّر حفظ اختيار الصلاحيات/);
});

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

function dropEvent(files, extra = {}) {
  const result = { prevented: 0, stopped: 0 };
  result.event = { dataTransfer: { types: files.length ? ['Files'] : ['text/plain'], files, ...extra },
    preventDefault() { result.prevented++; }, stopPropagation() { result.stopped++; } };
  return result;
}

test('dropping a large ZIP over an open project imports exact bytes once and never attaches it to chat', async () => {
  const a = app();
  const bytes = new Uint8Array(240_000).map((_, index) => index % 256);
  const file = new File([bytes], 'assets.zip', { type: 'application/zip' });
  let saves = 0, chatAdds = 0, saved;
  a.ctx.readProjectFiles = readProjectFiles;
  a.ctx.mergeProjectFiles = mergeProjectFiles;
  a.ctx.recordFiles = files => { saves++; saved = files; };
  a.ctx.recordChat = () => { chatAdds++; };
  a.run("S.mode='work'; S.chat={id:'drop-project',project:{files:[]}}; saveProjectFiles=async files=>{S.chat.project.files=files; recordFiles(files)}; renderProjectEditor=()=>{}; addFiles=recordChat;");
  const drop = dropEvent([file]);
  await a.documentEvents.drop(drop.event);
  assert.equal(drop.prevented, 1);
  assert.equal(drop.stopped, 1);
  assert.equal(saves, 1);
  assert.equal(chatAdds, 0);
  assert.equal(saved[0].path, 'assets.zip');
  assert.deepEqual(projectFileBytes(saved[0]), bytes);
  assert.equal(a.run('projectImporting'), false);
  assert.equal(a.node('#projectDropZone').disabled, false);
  assert.match(a.node('#projectStatus').textContent, /تم استيراد 1 ملف/);
});

test('chat file drops remain attachments while text dragging is not intercepted', async () => {
  const a = app();
  a.node('#projectSheet').classList.add('hidden');
  let added;
  a.ctx.recordChat = files => { added = files; };
  a.run('addFiles=recordChat;');
  const file = new File(['draft'], 'notes.txt');
  const drop = dropEvent([file]);
  await a.documentEvents.drop(drop.event);
  assert.equal(added[0], file);
  const text = dropEvent([]);
  a.documentEvents.dragover(text.event);
  await a.documentEvents.drop(text.event);
  assert.equal(text.prevented, 0);
  assert.equal(text.stopped, 0);
});

test('file drops during requests or imports are blocked without changing existing drafts', async () => {
  for (const setup of ['S.controller={}', 'projectSaving=true', 'projectImporting=true', 'rec={}', 'S.attachments=[{loading:true}]']) {
    const a = app();
    a.ctx.recordToast = () => {};
    a.run('toast=recordToast; ' + setup);
    a.node('#input').value = 'Keep this draft';
    await a.documentEvents.drop(dropEvent([new File(['x'], 'file.txt')]).event);
    assert.equal(a.node('#input').value, 'Keep this draft');
    assert.equal(a.node('#projectStatus').textContent, '');
  }
});

test('project drop cancellation preserves existing bytes and does not save an overwrite', async () => {
  const a = app();
  a.ctx.readProjectFiles = readProjectFiles;
  a.ctx.confirm = () => false;
  a.ctx.unexpectedSave = () => assert.fail('cancelled drop must not save');
  a.run("S.mode='work'; S.chat={id:'drop-project',project:{files:[{path:'notes.txt',content:'old'}]}}; saveProjectFiles=unexpectedSave;");
  await a.documentEvents.drop(dropEvent([new File(['new'], 'notes.txt')]).event);
  assert.equal(a.run('S.chat.project.files[0].content'), 'old');
  assert.equal(a.run('projectImporting'), false);
  assert.match(a.node('#projectStatus').textContent, /تم إلغاء الاستيراد/);
});

test('dropping a directory explains how to preserve its paths instead of flattening it', async () => {
  const a = app();
  let notice;
  a.ctx.recordToast = text => { notice = text; };
  a.run('toast=recordToast;');
  await a.documentEvents.drop(dropEvent([new File([], 'folder')], { items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] }).event);
  assert.match(notice, /استيراد نسخة من مجلد/);
});

test('email confirmation removes credentials from the URL and accepts the signup session', async () => {
  const a = app();
  a.ctx.URL = URL;
  a.ctx.URLSearchParams = URLSearchParams;
  a.ctx.location = { href: 'https://example.test/Sowalif/?confirm=1#access_token=test&refresh_token=refresh&type=signup' };
  let cleanUrl;
  a.ctx.history = { replaceState: (_, __, url) => { cleanUrl = url.href; } };
  a.ctx.cloud = { auth: { setSession: async tokens => {
    assert.equal(cleanUrl, 'https://example.test/Sowalif/');
    assert.equal(tokens.access_token, 'test');
    return { data: { session: { user: { id: 'confirmed' } } } };
  } } };
  assert.match(await a.run('confirmCloudEmail()'), /فتح بيانات حسابي/);
});

function accountApp(result) {
  const a = app();
  const profiles = new Map();
  let draft, reloads = 0, calls = 0;
  a.ctx.localStorage = { setItem: (key, value) => profiles.set(key, value), removeItem: key => profiles.delete(key) };
  a.ctx.location = { reload: () => reloads++ };
  a.ctx.document.activeElement = { matches: () => true }; // Focus stays in the login fields.
  a.node('#projectSheet').classList.add('hidden');
  a.node('#cloudEmail').value = 'test@example.test';
  a.node('#cloudPassword').value = 'fake-password';
  a.ctx.db.getChat = async () => undefined;
  a.ctx.db.saveSessionDraft = async value => { draft = structuredClone(value); };
  a.ctx.db.readSessionDraft = async () => draft;
  a.ctx.db.clearSessionDraft = async () => { draft = undefined; };
  a.run("S.chat = { id: 'device-draft', mode: 'chat', model: 'test', title: 'New chat', messages: [] };");
  const response = result || { data: { session: {}, user: { id: 'account-two', email: 'test@example.test' } } };
  const authenticate = async () => { calls++; return typeof response === 'function' ? response() : response; };
  a.ctx.cloud = { auth: { signInWithPassword: authenticate, signUp: authenticate } };
  a.ctx.cloudConfirmationUrl = () => 'https://example.test/?confirm=1';
  return { ...a, profiles, draft: () => draft, reloads: () => reloads, calls: () => calls };
}

test('login accepts focused credentials and preserves a ready text/attachment draft before switching', async () => {
  const a = accountApp();
  a.node('#input').value = 'Unsent private draft';
  a.run("S.attachments = [{ id: 'a', name: 'notes.txt', kind: 'doc', preview: 'blob:temporary', meta: {kind:'doc',blob:'private-blob'} }]");
  assert.equal(a.run('cloudIdle()'), false);
  await a.node('#cloudSignIn').click();
  assert.equal(a.calls(), 1);
  assert.equal(a.reloads(), 1);
  assert.equal(a.profiles.get('sc.cloudProfile'), 'account-two');
  assert.equal(a.draft().text, 'Unsent private draft');
  assert.equal(a.draft().attachments[0].meta.blob, 'private-blob');
  assert.equal(a.draft().attachments[0].preview, undefined);
  assert.equal(JSON.stringify(a.draft()).includes('fake-password'), false);
  assert.equal(a.node('#cloudPassword').value, '');
  assert.equal(a.node('#cloudSignIn').disabled, false);
});

test('failed login and signup awaiting confirmation keep the active draft without changing profiles', async () => {
  for (const [signup, response] of [[false, { error: { message: 'Invalid credentials' } }], [true, { data: { session: null } }]]) {
    const a = accountApp(response);
    a.node('#input').value = 'Keep this';
    await a.node(signup ? '#cloudSignUp' : '#cloudSignIn').click();
    assert.equal(a.calls(), 1);
    assert.equal(a.reloads(), 0);
    assert.equal(a.profiles.size, 0);
    assert.equal(a.node('#input').value, 'Keep this');
    assert.equal(a.run('cloudAuthBusy'), false);
  }
});

test('active requests, recordings, uploads and unsaved project edits still block account switching', async () => {
  for (const setup of ['S.controller = {}', 'rec = {}', 'voiceJob = {}', 'projectSaving = true', 'micStarting = true', 'S.attachments = [{ loading: true }]']) {
    const a = accountApp();
    a.run(setup);
    await a.node('#cloudSignIn').click();
    assert.equal(a.calls(), 0, setup);
    assert.equal(a.reloads(), 0);
  }
  const a = accountApp();
  a.node('#projectSheet').classList.remove('hidden');
  a.node('#projectCode').value = 'Unsaved edit';
  await a.node('#cloudSignIn').click();
  assert.equal(a.calls(), 0);
});

test('duplicate login is ignored and activity starting during authentication prevents a destructive reload', async () => {
  let resolve;
  const a = accountApp(() => new Promise(done => { resolve = done; }));
  const first = a.node('#cloudSignIn').click();
  await a.node('#cloudSignIn').click();
  assert.equal(a.calls(), 1);
  a.run('S.controller = {}');
  resolve({ data: { session: {}, user: { id: 'signed-in', email: 'test@example.test' } } });
  await first;
  assert.equal(a.reloads(), 0);
  assert.equal(a.profiles.size, 0);
  assert.match(a.node('#cloudStatus').textContent, /فتح بيانات حسابي/);
});

test('returning to the original profile restores its draft without persisting runtime objects', async () => {
  const a = accountApp();
  const link = { directory: { name: 'Project folder' }, baseline: new Map() };
  a.ctx.db.getProjectFolder = async () => link;
  a.node('#input').value = 'Return to this draft';
  a.run("S.chat.mode='work'; S.reasoning='high'; S.execute=true; S.attachments = [{id:'a', name:'notes.txt', kind:'doc',meta:{kind:'doc',text:'private'}}]; syncToggles=()=>{}; renderMessages=()=>{}; renderChatList=()=>{}; renderAttachments=()=>{}; applyWorkspace=mode=>{S.mode=mode};");
  await a.run('saveAccountDraft()');
  a.node('#input').value = '';
  a.run("S.attachments = []; S.reasoning='normal'; S.execute=false;");
  await a.run('restoreAccountDraft()');
  assert.equal(a.node('#input').value, 'Return to this draft');
  assert.equal(a.run('S.attachments[0].meta.text'), 'private');
  assert.equal(a.run("linkedFolders.get('device-draft')"), link);
  assert.equal(a.run('S.reasoning'), 'high');
  assert.equal(a.run('S.execute'), true);
  assert.equal(a.draft(), undefined);
});

test('chat model picker can hide and restore a model without changing the current selection', () => {
  const a = app();
  const settings = new Map();
  a.ctx.db.settings.get = (key, fallback) => settings.get(key) ?? fallback;
  a.ctx.db.settings.set = (key, value) => (settings.set(key, value), true);
  a.ctx.modelsFor = () => [
    { id: 'astra', name: 'GPT-6 Astra', maker: 'OpenAI', features: [] },
    { id: 'sol', name: 'GPT-6.1 Sol', maker: 'OpenAI', features: [] },
  ];
  a.run("S.model = 'astra'");
  a.node('#modelBtn').click();
  a.node('#modelVisibility').click();
  const toggle = checked => a.node('#modelList').listeners.change({ target: { dataset: { modelVisibility: 'astra' }, checked } });
  toggle(false);
  a.node('#modelVisibility').click();
  assert.doesNotMatch(a.node('#modelList').innerHTML, /GPT-6 Astra/);
  assert.equal(a.run('S.model'), 'astra');
  a.node('#modelVisibility').click();
  assert.match(a.node('#modelList').innerHTML, /GPT-6 Astra/);
  toggle(true);
  a.node('#modelVisibility').click();
  assert.match(a.node('#modelList').innerHTML, /GPT-6 Astra/);
  assert.doesNotMatch(a.node('#modelList').innerHTML, /GPT-6\.1 Sol/);
  a.node('#modelAll').click();
  assert.match(a.node('#modelList').innerHTML, /GPT-6\.1 Sol/);
  a.node('#modelList').listeners.click({ target: { closest: selector => selector === '[data-favorite]' ? { dataset: { favorite: 'sol' } } : null } });
  a.node('#modelBtn').click();
  assert.match(a.node('#modelList').innerHTML, /GPT-6\.1 Sol/);
  assert.doesNotMatch(a.node('#modelList').innerHTML, /GPT-6 Astra/);
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

test('default model search filters by name or ID without changing the saved choice', () => {
  const a = app();
  a.ctx.modelsFor = () => [{ id: 'test', name: 'Default model' }, { id: 'gpt-6-astra', name: 'GPT-6 Astra' }];
  const search = a.node('#defaultModelSearch');
  const select = a.node('#defaultModel');
  search.value = ' ASTRA ';
  search.listeners.input();
  assert.match(select.innerHTML, /GPT-6 Astra/);
  assert.doesNotMatch(select.innerHTML, /Default model/);
  assert.equal(select.value, '');
  assert.equal(a.run('S.defaultModel'), 'test');
  search.value = 'missing';
  search.listeners.input();
  assert.equal(select.disabled, true);
  search.value = '';
  search.listeners.input();
  assert.equal(select.value, 'test');
  assert.equal(select.disabled, false);
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
