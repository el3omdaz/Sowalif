import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, unlink, realpath } from 'node:fs/promises';
import { resolve, join, dirname, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validProjectPath, mergeProjectFiles } from '../../js/project.js?v=20';
import { artifactFile, listArtifacts } from './artifacts.mjs';
import { createFileService } from './files.mjs';

export const IMAGE = 'sowalif-coding-agent:1';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
const hash = id => createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
const failure = (message, code = 400) => Object.assign(new Error(message), { code });
async function body(req, limit = 700_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw failure('الطلب أكبر من الحد المسموح', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('طلب JSON غير صالح'); }
}
async function command(binary, args) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => { out = (out + c).slice(-3000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveCommand(out) : reject(new Error(`${binary} exit ${code}`)));
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Docker timeout')); }, 15000);
    child.on('close', () => clearTimeout(timeout));
  });
}
export async function dockerReady() {
  try { await command('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}']); return true; } catch { return false; }
}
export function launchDocker({ workspace, sessions, config, emit, done }) {
  const name = `sowalif-agent-${randomUUID()}`;
  const child = spawn('docker', ['run', '--rm', '-i', '--name', name, '--init', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=3g', '--cpus=2',
    '--tmpfs', '/tmp:rw,nosuid,size=256m', '--tmpfs', '/home/node:rw,nosuid,uid=1000,gid=1000,size=256m',
    '--mount', `type=bind,source=${workspace},target=/workspace`, '--mount', `type=bind,source=${sessions},target=/sessions`, IMAGE],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  let finished = false;
  const end = error => { if (finished) return; finished = true; clearTimeout(timer); lines.close(); done(error); };
  lines.on('line', line => { try { const event = JSON.parse(line); emit(event); } catch { /* ignore non-protocol output */ } });
  child.stderr.on('data', () => {});
  child.on('error', () => end(new Error('تعذّر تشغيل Docker')));
  child.on('close', code => end(code ? new Error('توقّف محرك البرمجة؛ تحقق من Docker والمفتاح') : null));
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ type: 'start', config }) + '\n');
  const stop = () => {
    child.stdin.write(JSON.stringify({ type: 'cancel' }) + '\n');
    // Kill only this named container, never the user's other containers.
    void command('docker', ['stop', '-t', '2', name]).catch(() => {});
  };
  const timer = setTimeout(stop, 20 * 60_000);
  return { send: data => child.stdin.write(JSON.stringify(data) + '\n'), stop };
}
async function safeFile(root, path, create = false) {
  if (!validProjectPath(path)) throw failure(`مسار غير مسموح: ${path}`);
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw failure('مسار خارج المشروع');
  let current = root;
  for (const piece of path.split('/')) {
    current = join(current, piece);
    try { if ((await lstat(current)).isSymbolicLink()) throw failure('الروابط الرمزية غير مسموحة في ملفات المشروع'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (create) await mkdir(dirname(target), { recursive: true });
  return target;
}
export async function snapshot(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isSymbolicLink() || item.name.startsWith('.') || ['node_modules', 'vendor', 'dist', 'build', 'coverage', 'outputs'].includes(item.name)) continue;
      if (item.isDirectory()) await walk(join(directory, item.name), name + '/');
      else if (item.isFile() && validProjectPath(name)) {
        const target = await safeFile(root, name);
        if ((await lstat(target)).size > 300_000) throw failure(`الملف ${name} أكبر من حد الاستيراد`);
        files.push({ path: name, content: await readFile(target, 'utf8') });
      }
      if (files.length > 40) throw failure('المشروع يتجاوز حد 40 ملف مصدر؛ الملفات الكاملة باقية في مساحة الكمبيوتر');
    }
  }
  await walk(root);
  return mergeProjectFiles([], files);
}

export async function uploadPiapi(input, request = fetch) {
  if (typeof input.key !== 'string' || input.key.length < 8 || input.key.length > 512) throw failure('أدخل مفتاح PiAPI');
  if (!/^reference-\d+\.(jpg|png|webp)$/.test(input.fileName || '') || typeof input.data !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(input.data)) throw failure('صورة مرجعية غير صالحة');
  if (Buffer.from(input.data.split(',')[1], 'base64').length > 10 * 1024 * 1024) throw failure('الصورة تتجاوز 10 ميغابايت', 413);
  const response = await request('https://upload.theapi.app/api/ephemeral_resource', { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { 'Content-Type': 'application/json', 'x-api-key': input.key }, body: JSON.stringify({ file_name: input.fileName, file_data: input.data }) });
  const result = await response.json();
  if (!response.ok || result.code !== 200 || !/^https:\/\//i.test(result.data?.url || '')) throw failure('تعذّر رفع الصورة إلى PiAPI. رفع الملفات يتطلب خطة Creator أو أعلى.', 502);
  return { url: result.data.url };
}

export function createLocalServer({ root = ROOT, dataDir = join(ROOT, '.local-agent'), launch = launchDocker, ready = dockerReady, upload = uploadPiapi } = {}) {
  const csrf = randomBytes(32).toString('hex');
  const files = createFileService(resolve(dataDir));
  const runs = new Map();
  const active = new Map();
  let starting = false;
  const project = async id => {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw failure('معرّف مشروع غير صالح');
    const base = join(dataDir, hash(id));
    const workspace = join(base, 'workspace');
    const sessions = join(base, 'sessions');
    await mkdir(workspace, { recursive: true });
    await mkdir(sessions, { recursive: true });
    const statePath = join(base, 'state.json');
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = { revision: 0, files: [], sessions: {} }; }
    return { workspace: state.directory || workspace, sessions, statePath, state };
  };
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      const port = server.address()?.port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return json(res, 403, { error: 'Local access only' });
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        if (req.method !== 'GET' && (req.headers.origin !== `http://${host}` || req.headers['x-sowalif-csrf'] !== csrf || !req.headers['content-type']?.startsWith('application/json'))) return json(res, 403, { error: 'افتح الخدمة من واجهة سوالف المحلية' });
        if (url.pathname.startsWith('/api/files/')) {
          if ((req.headers.origin && req.headers.origin !== `http://${host}`) ||
              ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
            return json(res, 403, { error: 'افتح الخدمة من واجهة سوالف المحلية' });
          }
          const action = url.pathname.slice('/api/files/'.length);
          if (action === 'roots' && req.method === 'GET') return json(res, 200, await files.readRoots());
          if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
          const input = await body(req, action === 'change' ? 7 * 1024 * 1024 : 32 * 1024);
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('الطلب غير صالح.');
          if (action === 'roots') return json(res, 200, await files.changeRoots(input));
          if (action === 'change') return json(res, 200, await files.change(input));
          if (action === 'read') return json(res, 200, await files.read(input));
          if (action === 'scan') {
            const disconnected = new AbortController();
            res.once('close', () => disconnected.abort());
            const result = await files.scan(input, disconnected.signal);
            if (!res.destroyed) return json(res, 200, result);
            return;
          }
          return json(res, 404, { error: 'Not found' });
        }
        if (url.pathname === '/api/agent/status' && req.method === 'GET') return json(res, 200, { local: true, ready: await ready(), csrf, engines: ['claude', 'codex'] });
        if (url.pathname === '/api/agent/link' && req.method === 'POST') {
          const { projectId, directory } = await body(req);
          if (active.size || starting) throw failure('انتظر انتهاء التنفيذ أولاً', 409);
          if (typeof directory !== 'string' || resolve(directory) !== directory || directory.includes(',') || /[\r\n\0]/.test(directory)) throw failure('الصق المسار الكامل لمجلد المشروع');
          const canonical = await realpath(directory);
          if (!(await lstat(canonical)).isDirectory() || dirname(canonical) === canonical) throw failure('اختر مجلد المشروع نفسه');
          const p = await project(projectId);
          if (active.size || starting) throw failure('انتظر انتهاء التنفيذ أولاً', 409);
          p.state.directory = canonical;
          p.state.sessions = {};
          await writeFile(p.statePath, JSON.stringify(p.state));
          return json(res, 200, { directory: canonical });
        }
        if (url.pathname === '/api/agent/git' && req.method === 'POST') {
          const { projectId, action, message } = await body(req);
          if (active.size || starting) throw failure('انتظر انتهاء التنفيذ أولاً', 409);
          starting = true;
          try {
            const { state } = await project(projectId);
            if (!state.directory || await realpath(state.directory) !== state.directory) throw failure('اربط مجلد المشروع أولاً');
            const git = (...args) => command('git', ['-C', state.directory, '-c', 'core.hooksPath=/dev/null', ...args]);
            const top = await git('rev-parse', '--show-toplevel');
            if (await realpath(top.trim()) !== state.directory) throw failure('اختر جذر مستودع Git');
            if (action === 'status') return json(res, 200, { text: await git('status', '--short', '--untracked-files=all') });
            if (action === 'commit') {
              if (typeof message !== 'string' || !message.trim() || message.length > 160 || /[\r\n\0]/.test(message)) throw failure('اكتب وصفًا للتعديل');
              const status = await git('status', '--porcelain', '--untracked-files=all');
              if (!status.trim()) throw failure('لا توجد تغييرات للحفظ');
              await git('add', '-A', '--', '.');
              return json(res, 200, { text: await git('commit', '-m', message.trim()) });
            }
            if (action === 'push') {
              const remote = (await git('remote', 'get-url', '--push', 'origin')).trim();
              if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[\w-]+\/[\w.-]+$/i.test(remote)) throw failure('اضبط origin على مستودع GitHub');
              const branch = (await git('symbolic-ref', 'HEAD')).trim();
              await git('push', '--', 'origin', `HEAD:${branch}`);
              return json(res, 200, { text: `تم الرفع إلى ${branch.slice('refs/heads/'.length)}.` });
            }
            throw failure('عملية Git غير مدعومة');
          } finally { starting = false; }
        }
        if (url.pathname === '/api/media/upload' && req.method === 'POST') return json(res, 200, await upload(await body(req, 15 * 1024 * 1024)));
        if (url.pathname === '/api/agent/artifact' && req.method === 'GET') {
          const p = await project(url.searchParams.get('project'));
          const path = url.searchParams.get('path');
          const { target } = await artifactFile(p.workspace, path);
          res.setHeader('Content-Disposition', `attachment; filename="download.${path.split('.').at(-1)}"; filename*=UTF-8''${encodeURIComponent(path.split('/').at(-1))}`);
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
          return await serve(res, target);
        }
        if (url.pathname === '/api/agent/project' && req.method === 'GET') {
          const id = url.searchParams.get('id');
          const p = await project(id);
          if (active.has(id)) return json(res, 200, { activeRun: active.get(id) });
          if (p.state.directory) return json(res, 200, { directory: p.state.directory, revision: p.state.revision, artifacts: await listArtifacts(p.workspace) });
          return json(res, 200, { revision: p.state.revision, files: await snapshot(p.workspace), artifacts: await listArtifacts(p.workspace) });
        }
        if (url.pathname === '/api/agent/recover' && req.method === 'POST') {
          const input = await body(req);
          if (active.has(input.projectId) || starting) throw failure('يوجد تنفيذ جارٍ؛ تابعه أولاً', 409);
          const p = await project(input.projectId);
          if (p.state.directory) return json(res, 200, { directory: p.state.directory, revision: p.state.revision, artifacts: await listArtifacts(p.workspace) });
          p.state.files = await snapshot(p.workspace);
          p.state.revision++;
          await writeFile(p.statePath, JSON.stringify(p.state));
          return json(res, 200, { files: p.state.files, revision: p.state.revision, artifacts: await listArtifacts(p.workspace) });
        }
        if (url.pathname === '/api/agent/runs' && req.method === 'POST') {
          const input = await body(req);
          if (active.size || starting) throw failure('يوجد تنفيذ جارٍ؛ انتظر أو أوقفه أولاً', 409);
          if (!['claude', 'codex'].includes(input.engine) || !['openrouter', 'anthropic', 'openai'].includes(input.provider)) throw failure('اختر المحرك ومزوّده');
          if (input.engine === 'codex' && input.provider !== 'openai') throw failure('Codex يستخدم مفتاح OpenAI في هذا الربط');
          if (input.engine === 'claude' && input.provider === 'openai') throw failure('Claude يحتاج OpenRouter أو Anthropic');
          if (typeof input.key !== 'string' || input.key.length < 8 || input.key.length > 512) throw failure('أدخل مفتاح المزوّد');
          if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20_000) throw failure('اكتب طلباً ضمن 20 ألف حرف');
          if (input.model && (typeof input.model !== 'string' || input.model.length > 150 || /[\r\n\0]/.test(input.model))) throw failure('معرّف نموذج غير صالح');
          if (!Array.isArray(input.files)) throw failure('ملفات غير صالحة');
          let files = [];
          starting = true;
          let p;
          try {
            if (!await ready()) throw failure('بيئة Docker غير جاهزة؛ شغّل إعداد المحرك أولاً', 503);
            p = await project(input.projectId);
            if (Boolean(input.direct) !== Boolean(p.state.directory)) throw failure('أعد ربط مجلد المشروع من قسم الشغل.', 409);
            if (p.state.directory && await realpath(p.state.directory) !== p.state.directory) throw failure('تغيّر مسار المجلد. اربطه من جديد.');
            if (!p.state.directory) {
            files = mergeProjectFiles([], input.files);
            if ((input.workspaceRevision || 0) !== p.state.revision) throw failure('يوجد عمل محفوظ في الكمبيوتر. استخدم «استرجاع ملفات الكمبيوتر» قبل بدء طلب جديد.', 409);
            // Never overwrite a changed workspace from an old browser snapshot.
            const current = await snapshot(p.workspace);
            if (p.state.revision && JSON.stringify(current) !== JSON.stringify(p.state.files)) throw failure('تغيّرت ملفات الكمبيوتر خارج سوالف؛ استرجعها أولاً.', 409);
            for (const file of p.state.files) if (!files.some(f => f.path === file.path)) await unlink(await safeFile(p.workspace, file.path)).catch(e => { if (e.code !== 'ENOENT') throw e; });
            for (const file of files) await writeFile(await safeFile(p.workspace, file.path, true), file.content);
            p.state.files = files;
            await writeFile(p.statePath, JSON.stringify(p.state));
            }
          } finally { starting = false; }
          const id = randomUUID();
          const sessionKey = `${input.engine}:${input.provider}:${input.model || 'default'}`;
          const run = { id, projectId: input.projectId, engine: input.engine, state: 'running', text: '', events: [], approvals: [], before: files, revision: p.state.revision, sessionKey, createdAt: Date.now() };
          runs.set(id, run); active.set(input.projectId, id);
          const clean = value => String(value || '').replaceAll(input.key, '[key]').slice(0, 12000);
          const emit = event => {
            if (event.type === 'session') { run.sessionId = event.id; return; }
            if (event.type === 'delta') { run.text = (run.text + clean(event.text)).slice(0, 100_000); return; }
            if (event.type === 'approval') { run.approvals.push({ id: event.id, tool: clean(event.tool), input: { command: clean(event.input?.command), description: clean(event.input?.description) } }); return; }
            if (event.type === 'error') run.error = clean(event.message);
            if (event.type === 'result') { run.result = event; run.completed = true; return; }
            run.events.push({ ...event, text: clean(event.text), input: clean(event.input) });
            run.events = run.events.slice(-80);
          };
          let settled = false;
          const done = async error => {
            if (settled) return;
            settled = true;
            try {
              run.artifacts = await listArtifacts(p.workspace);
              if (p.state.directory) run.directory = p.state.directory;
              else p.state.files = run.files = await snapshot(p.workspace);
              p.state.revision++;
              if (run.sessionId) p.state.sessions[sessionKey] = run.sessionId;
              await writeFile(p.statePath, JSON.stringify(p.state));
              run.revision = p.state.revision;
              for (const preview of ['dist/index.html', 'index.html']) {
                try { if ((await lstat(join(p.workspace, preview))).isFile()) { run.previewPath = preview; break; } } catch {}
              }
            } catch (e) { run.error ||= clean(e.message); }
            run.error ||= error ? clean(error.message) : !run.completed ? 'انتهى المحرك بدون نتيجة مكتملة' : undefined;
            run.state = run.stopped ? 'stopped' : run.error ? 'failed' : 'completed';
            run.approvals = [];
            active.delete(input.projectId);
            delete run.handle;
            // Bound memory without discarding the newest job or its workspace.
            for (const [key, old] of runs) if (key !== id && old.state !== 'running' && Date.now() - old.createdAt > 3600_000) runs.delete(key);
          };
          const context = 'You are working in Sowalif. Work only in /workspace. Do not deploy or publish. Implement the requested task and run relevant tests, reporting actual results. For web projects provide a runnable preview: use standalone HTML when appropriate, or build the requested framework into dist/index.html with relative asset URLs (for Vite use base ./). You can also create real downloadable PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV, ZIP and image files whenever the user asks, without requiring a special mode or toggle. Save final deliverables in /workspace/outputs/ with descriptive filenames; put generation scripts outside outputs. Python packages reportlab, docx, openpyxl, pptx, arabic_reshaper and bidi plus Noto Arabic fonts are preinstalled. Use proper RTL and Arabic shaping/fonts for Arabic documents. Verify generated files open correctly; never merely rename plain text to a binary extension. Excel formulas must be real formulas; clearly distinguish calculated/cached values if no calculation engine is available. The app automatically exposes outputs as download links; do not invent public URLs. Reply in the user language.\n\n' + input.prompt;
          try {
            run.handle = launch({ workspace: p.workspace, sessions: p.sessions,
              config: { engine: input.engine, provider: input.provider, key: input.key, model: input.model || undefined, prompt: context, budget: Math.max(.1, Math.min(10, Number(input.budget) || 2)), sessionId: p.state.sessions[sessionKey] }, emit, done });
          } catch (e) { await done(e); }
          return json(res, 202, { id });
        }
        const match = /^\/api\/agent\/runs\/([\w-]+)(?:\/(approval|stop))?$/.exec(url.pathname);
        const run = match && runs.get(match[1]);
        if (!run) return json(res, 404, { error: 'المهمة غير موجودة؛ استرجع ملفات الكمبيوتر إن أُعيد تشغيل الخدمة' });
        if (req.method === 'GET' && !match[2]) {
          const { handle, sessionKey, sessionId, ...publicRun } = run;
          return json(res, 200, publicRun);
        }
        if (req.method === 'POST' && match[2] === 'approval') {
          const answer = await body(req);
          if (!run.approvals.some(a => a.id === answer.id) || run.state !== 'running') throw failure('انتهت صلاحية الطلب');
          run.handle.send({ type: 'approval', id: answer.id, allow: answer.allow === true });
          run.approvals = run.approvals.filter(a => a.id !== answer.id);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && match[2] === 'stop') {
          if (run.handle) { run.stopped = true; run.handle.stop(); }
          return json(res, 200, { ok: true });
        }
        return json(res, 405, { error: 'Method not allowed' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      if (url.pathname.startsWith('/preview/')) {
        const [, , projectId, ...parts] = url.pathname.split('/');
        const p = await project(projectId);
        const target = resolve(p.workspace, decodeURIComponent(parts.join('/')) || 'index.html');
        const real = await realpath(target);
        const canonicalRoot = await realpath(p.workspace);
        if (!real.startsWith(canonicalRoot + sep) || !/\.(html?|css|m?js|json|png|jpe?g|svg|webp|woff2?)$/i.test(real)) throw failure('معاينة غير متاحة', 404);
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'");
        res.setHeader('Access-Control-Allow-Origin', '*');
        return await serve(res, real);
      }
      const path = decodeURIComponent(url.pathname);
      if (!/^\/(?:index.html|oauth-microsoft.html|style.css|sw.js|manifest.webmanifest|icon-[\w.-]+\.png|(?:js|vendor)\/[\w.-]+\.(?:js|mjs))?$/.test(path)) throw failure('Not found', 404);
      return await serve(res, join(root, path === '/' ? 'index.html' : path));
    } catch (error) { if (!res.headersSent) json(res, typeof error.code === 'number' ? error.code : error.code === 'ENOENT' ? 404 : 400, { error: error.message }); else res.end(); }
  });
  server.on('close', () => { for (const run of runs.values()) run.handle?.stop(); });
  return server;
}
async function serve(res, path) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
  const contents = await readFile(path);
  res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(contents);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createLocalServer();
  server.listen(4781, '127.0.0.1', () => console.log('Sowalif local: http://127.0.0.1:4781'));
  process.on('SIGINT', () => { server.close(); setTimeout(() => process.exit(0), 3000).unref(); });
}
