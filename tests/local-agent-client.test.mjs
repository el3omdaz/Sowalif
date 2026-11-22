import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeProjectFiles, projectFileSignature, isBinaryProjectFile, validProjectPath } from '../js/project.js?v=40';
import { createLocalServer } from '../server/local-agent/server.mjs';

// Exercise the browser client against a strict in-memory implementation of the
// host protocol. No Docker process, provider request or paid API is involved.
function fixture({ stopTimeout = 200, direct = false, fetchOverride } = {}) {
  const settings = new Map([['codingEngine', 'codex'], ['codingProvider', 'openai'], ['codingOpenAIKey', 'fixture-key'],
    ...(direct ? [['agentDirectory.project', 'C:/linked/project']] : [])]);
  const chat = { id: 'project', mode: 'work', model: 'fixture', title: 'Project',
    project: { revision: 0, files: [{ path: 'index.html', content: 'before' }] }, messages: [{ role: 'user', text: 'Build the app' }] };
  const stored = new Map([[chat.id, structuredClone(chat)]]);
  const state = { revision: 0, files: [], ...(direct ? { directory: 'C:/linked/project' } : {}) };
  const runs = new Map(), submissions = [], events = [];
  const hooks = { stop() {}, submitted() {}, read() {} };
  let stopCalls = 0;
  const finish = (run, { files = state.files, stopped = false, error } = {}) => {
    state.revision++;
    if (!direct) { state.files = structuredClone(files); run.files = structuredClone(files); }
    Object.assign(run, { state: stopped ? 'stopped' : error ? 'failed' : 'completed', revision: state.revision, error });
    delete state.activeRun;
  };
  const fetch = async (path, options = {}) => {
    options.signal?.throwIfAborted();
    const url = new URL(path, 'http://127.0.0.1:4781');
    if (url.pathname === '/api/agent/status') return Response.json({ ready: true, csrf: 'csrf', engines: ['codex', 'claude'] });
    if (url.pathname === '/api/agent/project') return Response.json(state.activeRun
      ? { activeRun: state.activeRun, activeEngine: runs.get(state.activeRun).engine }
      : { ...state, lastEngine: state.lastRun ? runs.get(state.lastRun)?.engine : undefined });
    if (url.pathname === '/api/agent/runs' && options.method === 'POST') {
      const input = JSON.parse(options.body);
      if (state.activeRun) return Response.json({ error: 'يوجد تنفيذ جارٍ' }, { status: 409 });
      if (input.workspaceRevision !== state.revision) return Response.json({ error: 'يوجد عمل محفوظ في الكمبيوتر. استخدم استرجاع الملفات.' }, { status: 409 });
      submissions.push(input);
      const id = `run-${submissions.length}`;
      state.files = structuredClone(input.files);
      const run = { id, state: 'running', engine: input.engine, projectRevision: input.projectRevision, revision: state.revision,
        before: structuredClone(input.files), text: '', approvals: [], artifacts: [], createdAt: Date.now() };
      runs.set(id, run); state.activeRun = id; state.lastRun = id;
      await hooks.submitted(run, input);
      return Response.json({ id }, { status: 202 });
    }
    const match = /^\/api\/agent\/runs\/([^/]+)(?:\/(stop))?$/.exec(url.pathname);
    if (match) {
      const run = runs.get(match[1]);
      if (!run) return Response.json({ error: 'run not found after service restart' }, { status: 404 });
      if (match[2]) { stopCalls++; await hooks.stop(run, stopCalls); return Response.json({ ok: true }); }
      await hooks.read(run);
      return Response.json(run);
    }
    assert.fail(`Unexpected request: ${path}`);
  };
  const engine = { id: 'codex', providers: ['openai'], modelSetting: 'codingCodexModel' };
  const context = vm.createContext({
    profileId: '', location: { hostname: '127.0.0.1', port: '4781' },
    settings: { get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback, set: (key, value) => settings.set(key, value) },
    CODING_ENGINES: { claude: engine }, CODING_PROVIDERS: { openai: { key: 'codingOpenAIKey' } },
    codingEngineById: id => id === 'codex' || id === 'claude' ? engine : null, codingEngineName: id => id,
    mergeProjectFiles, projectFileSignature, isBinaryProjectFile, validProjectPath,
    preparePersonalContext: async (_chat, text) => ({ expanded: text, prompt: '' }),
    saveChat: async value => { stored.set(value.id, structuredClone(value)); return value; },
    saveProject: async (value, project) => {
      if ((stored.get(value.id)?.project?.revision || 0) !== project.revision - 1) throw new Error('تغيّرت ملفات المشروع في نافذة ثانية.');
      value.project = project;
      stored.set(value.id, structuredClone(value));
    },
    getBlob: async () => undefined,
    fetch: fetchOverride || fetch, Date, Blob, URLSearchParams,
    AbortSignal: { timeout: ms => AbortSignal.timeout(Math.min(ms, stopTimeout)) },
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 2)), clearTimeout,
  });
  const source = readFileSync(new URL('../js/local-agent.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  const client = vm.runInContext('({ respondLocal, collectAgentRun })', context);
  const emit = (type, data) => events.push({ type, data });
  const next = text => chat.messages.push({ role: 'user', text });
  return { ...client, chat, state, runs, settings, stored, submissions, hooks, finish, emit, next, events, get stopCalls() { return stopCalls; } };
}

test('stopping during thinking finalizes the workspace revision and typing continue starts the next engine session without recovery', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.hooks.stop = run => { f.finish(run, { stopped: true }); };
  const stopped = await f.respondLocal(f.chat, (type, data) => { f.emit(type, data); if (type === 'agent' && data.state === 'running') controller.abort(); }, controller.signal);
  assert.equal(stopped.error, undefined);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.agentCompleted, true);
  assert.equal(f.chat.project.agentWorkspaceRevision, 1);
  assert.equal(f.chat.project.files[0].content, 'before');
  f.next('كمل');
  f.hooks.submitted = run => { run.text = 'continued'; f.finish(run); };
  const continued = await f.respondLocal(f.chat, f.emit);
  assert.equal(continued.error, undefined);
  assert.equal(continued.text, 'continued');
  assert.equal(f.submissions.length, 2);
  assert.equal(f.submissions[1].workspaceRevision, 1);
  assert.equal(f.submissions[1].projectRevision, 1);
  assert.equal(f.submissions[1].projectId, f.submissions[0].projectId);
});

test('stop waits for file snapshots, applies changes once, and continuing uploads the saved files', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.hooks.stop = run => { setTimeout(() => f.finish(run, { stopped: true, files: [{ path: 'index.html', content: 'saved partial work' }] }), 10); };
  const reply = await f.respondLocal(f.chat, (type, data) => { f.emit(type, data); if (type === 'agent' && data.state === 'running') controller.abort(); }, controller.signal);
  assert.equal(reply.error, undefined);
  assert.equal(f.chat.project.files[0].content, 'saved partial work');
  assert.equal(reply.agentChanges[0].before, 'before');
  assert.equal(reply.agentChanges[0].after, 'saved partial work');
  const revision = f.chat.project.revision;
  await f.collectAgentRun(f.chat, reply, f.emit);
  assert.equal(f.chat.project.revision, revision, 'recollecting a completed run must be idempotent');
  f.next('Continue');
  f.hooks.submitted = run => f.finish(run);
  const continued = await f.respondLocal(f.chat, f.emit);
  assert.equal(continued.error, undefined);
  assert.equal(f.submissions[1].files[0].content, 'saved partial work');
  assert.ok(f.events.some(event => event.type === 'status' && /يحفظ|أحفظ/.test(event.data.text)));
});

test('a still-stopping run is reconciled automatically before continue can create another job', async () => {
  const f = fixture({ stopTimeout: 25 });
  const controller = new AbortController();
  const stopped = await f.respondLocal(f.chat, (type, data) => { if (type === 'agent' && data.state === 'running') controller.abort(); }, controller.signal);
  assert.equal(stopped.agentCompleted, undefined);
  assert.equal(stopped.agentStopping, true);
  assert.match(stopped.error, /لم ينتهِ تأكيد الإيقاف/);
  assert.equal(f.submissions.length, 1);
  f.next('كمل');
  f.settings.set('codingEngine', 'claude');
  f.hooks.stop = run => { f.finish(run, { stopped: true, files: [{ path: 'index.html', content: 'last snapshot' }] }); };
  f.hooks.submitted = run => f.finish(run);
  const continued = await f.respondLocal(f.chat, f.emit);
  assert.equal(continued.error, undefined);
  assert.equal(f.submissions.length, 2);
  assert.equal(f.submissions[1].files[0].content, 'last snapshot');
  assert.equal(f.submissions[1].workspaceRevision, 1);
  assert.equal(f.submissions[0].engine, 'codex');
  assert.equal(f.submissions[1].engine, 'claude', 'finalize the old engine, then use the newly selected engine');
});

test('connection loss resumes an existing running job rather than submitting a duplicate', async () => {
  const f = fixture();
  let reads = 0;
  f.hooks.read = run => {
    if (++reads === 1) throw new TypeError('connection lost');
    if (reads === 3) { run.text = 'original job finished'; f.finish(run); }
  };
  const interrupted = await f.respondLocal(f.chat, f.emit);
  assert.match(interrupted.error, /انقطع الاتصال/);
  f.next('كمل');
  const resumed = await f.respondLocal(f.chat, f.emit);
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.agentRunId, interrupted.agentRunId);
  assert.equal(resumed.text, 'original job finished');
  assert.equal(f.submissions.length, 1);
});

test('a lost POST response is discovered even when the accepted run already finished', async () => {
  const f = fixture();
  f.hooks.submitted = run => { run.text = 'accepted once'; f.finish(run, { files: [{ path: 'index.html', content: 'complete result' }] }); throw new TypeError('POST response lost'); };
  const reply = await f.respondLocal(f.chat, f.emit);
  assert.equal(reply.error, undefined);
  assert.equal(reply.text, 'accepted once');
  assert.equal(reply.agentRunId, 'run-1');
  assert.equal(f.submissions.length, 1);
  assert.equal(f.chat.project.files[0].content, 'complete result');
});

test('newer browser edits are preserved and block a stale continuation instead of being overwritten', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.hooks.stop = run => {
    f.chat.project = { ...f.chat.project, revision: 1, files: [{ path: 'index.html', content: 'new browser edit' }] };
    f.stored.set(f.chat.id, structuredClone(f.chat));
    f.finish(run, { stopped: true, files: [{ path: 'index.html', content: 'engine edit' }] });
  };
  const reply = await f.respondLocal(f.chat, (type, data) => { if (type === 'agent' && data.state === 'running') controller.abort(); }, controller.signal);
  assert.equal(reply.agentNeedsReconcile, true);
  assert.match(reply.error, /تعديلاتك الأحدث/);
  assert.equal(f.chat.project.files[0].content, 'new browser edit');
  assert.equal(f.state.files[0].content, 'engine edit');
  f.next('كمل');
  const blocked = await f.respondLocal(f.chat, f.emit);
  assert.match(blocked.error, /تعديلاتك الأحدث/);
  assert.equal(f.submissions.length, 1);
});

test('linked-folder runs update the workspace revision even though no files are returned to the browser', async () => {
  const f = fixture({ direct: true });
  f.hooks.submitted = run => f.finish(run);
  const first = await f.respondLocal(f.chat, f.emit);
  assert.equal(first.error, undefined);
  assert.equal(f.chat.project.agentWorkspaceRevision, 1);
  assert.equal(f.chat.project.files[0].content, 'before');
  f.next('Continue');
  const second = await f.respondLocal(f.chat, f.emit);
  assert.equal(second.error, undefined);
  assert.equal(f.submissions[1].direct, true);
  assert.equal(f.submissions[1].workspaceRevision, 1);
});

test('service restart recovers a stopped snapshot against the saved unchanged browser baseline', async () => {
  const f = fixture();
  f.state.revision = 1;
  f.state.files = [{ path: 'index.html', content: 'survived service restart' }];
  f.chat.messages.push({ role: 'assistant', text: '', stopped: true, agentRunId: 'removed-after-restart', agentBaseRevision: 0 });
  f.next('كمل');
  f.hooks.submitted = run => f.finish(run);
  const reply = await f.respondLocal(f.chat, f.emit);
  assert.equal(reply.error, undefined);
  assert.equal(f.submissions[0].workspaceRevision, 1);
  assert.equal(f.submissions[0].files[0].content, 'survived service restart');
});

test('concurrent requests for one project cannot launch duplicate jobs', async () => {
  const f = fixture();
  const controller = new AbortController();
  let submitted;
  const ready = new Promise(resolve => submitted = resolve);
  f.hooks.submitted = () => submitted();
  f.hooks.stop = run => f.finish(run, { stopped: true });
  const first = f.respondLocal(f.chat, f.emit, controller.signal);
  await ready;
  f.next('Another request');
  const second = await f.respondLocal(f.chat, f.emit);
  assert.match(second.error, /الطلب الحالي/);
  assert.equal(f.submissions.length, 1);
  controller.abort();
  await first;
});

test('legacy stopped jobs use the saved before-files baseline when projectRevision was not recorded', async () => {
  for (const changed of [false, true]) {
    const f = fixture();
    const run = { id: 'legacy', state: 'stopped', revision: 1, text: '', artifacts: [],
      before: [{ path: 'index.html', content: changed ? 'different baseline' : 'before' }],
      files: [{ path: 'index.html', content: 'legacy partial work' }] };
    f.runs.set(run.id, run);
    const reply = { role: 'assistant', text: '', agentRunId: run.id, stopped: true };
    await f.collectAgentRun(f.chat, reply, f.emit);
    if (changed) {
      assert.equal(f.chat.project.files[0].content, 'before');
      assert.equal(reply.agentNeedsReconcile, true);
    } else {
      assert.equal(reply.error, undefined);
      assert.equal(f.chat.project.files[0].content, 'legacy partial work');
      assert.equal(f.chat.project.agentWorkspaceRevision, 1);
    }
  }
});

test('a pending POST cannot be associated with another tab job that has a different browser baseline', async () => {
  const f = fixture();
  const pending = { role: 'assistant', text: '', agentSubmissionPending: true, agentStopping: true,
    agentBaseRevision: 0, agentSubmittedAt: Date.now() - 1 };
  f.chat.messages.push(pending);
  f.next('Continue');
  const foreign = { id: 'other-tab', state: 'running', engine: 'codex', projectRevision: 1, revision: 0,
    before: structuredClone(f.chat.project.files), text: '', approvals: [], createdAt: Date.now() };
  f.runs.set(foreign.id, foreign);
  f.state.activeRun = foreign.id;
  let reads = 0;
  f.hooks.read = run => { if (++reads === 2) f.finish(run, { files: [{ path: 'index.html', content: 'other tab output' }] }); };
  const reply = await f.respondLocal(f.chat, f.emit);
  assert.equal(pending.agentRunId, undefined);
  assert.equal(f.stopCalls, 0, 'an unrelated active run must not inherit the pending request stop flag');
  assert.equal(f.submissions.length, 0);
  assert.equal(f.chat.project.files[0].content, 'before');
  assert.equal(reply.agentNeedsReconcile, true);
});

test('real host stop snapshots files and reuses the saved Codex session on continue', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sowalif-client-resume-'));
  const jobs = [];
  const server = createLocalServer({ dataDir, ready: async () => true, launch(job) {
    jobs.push(job);
    if (jobs.length === 1) job.emit({ type: 'session', id: 'codex-session-preserved' });
    else {
      assert.equal(job.config.sessionId, 'codex-session-preserved');
      void (async () => {
        assert.equal(await readFile(join(job.workspace, 'index.html'), 'utf8'), 'partial work saved by stop');
        job.emit({ type: 'delta', text: 'Continued existing session' });
        job.emit({ type: 'result' });
        await job.done(null);
      })();
    }
    return { stop() { void (async () => {
      await writeFile(join(job.workspace, 'index.html'), 'partial work saved by stop');
      await job.done(new Error('intentional stop'));
    })(); } };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const f = fixture({ stopTimeout: 5000, fetchOverride: (path, options) => fetch(origin + path, {
    ...options, headers: { ...options?.headers, Origin: origin },
  }) });
  const controller = new AbortController();
  const first = await f.respondLocal(f.chat, (type, data) => { if (type === 'agent' && data.state === 'running') controller.abort(); }, controller.signal);
  assert.equal(first.error, undefined);
  assert.equal(first.agentCompleted, true);
  assert.equal(f.chat.project.files[0].content, 'partial work saved by stop');
  assert.equal(f.chat.project.agentWorkspaceRevision, 1);
  f.next('كمل');
  const continued = await f.respondLocal(f.chat, f.emit);
  assert.equal(continued.error, undefined);
  assert.equal(continued.text, 'Continued existing session');
  assert.equal(jobs.length, 2);
  assert.equal(f.chat.project.agentWorkspaceRevision, 2);
});
