// Offline protocol check against the real Codex binary; never starts a model turn.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
import { codexProviderArgs } from './codex.mjs';

const binary = process.env.SOWALIF_CODEX_BINARY || '/opt/sowalif-agent/node_modules/.bin/codex';
const workspace = process.env.SOWALIF_CODEX_SMOKE_WORKSPACE || '/workspace';
const root = await mkdtemp(join(tmpdir(), 'sowalif-codex-smoke-'));
const schemaDirectory = join(root, 'schema');

async function checkProvider(provider) {
  const home = join(root, provider);
  await mkdir(home);
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  if (provider === 'openrouter') env.OPENROUTER_API_KEY = 'sk-or-offline-smoke-not-real';
  const child = spawn(binary, ['app-server', ...codexProviderArgs(provider)], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.id == null) return;
    const callback = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callback?.reject(new Error(message.error.message));
    else callback?.resolve(message.result);
  });
  const fail = error => { for (const callback of pending.values()) callback.reject(error); pending.clear(); };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Codex exited before protocol check completed')));
  child.stderr.resume();
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(new Error('Protocol timeout: ' + method)); }, 20_000);
      pending.set(next, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ id: next, method, params }) + '\n');
    });
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'sowalif', version: '1.0.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    if (provider === 'openai') await rpc('account/login/start', { type: 'apiKey', apiKey: 'sk-offline-smoke-not-real' });
    const options = { cwd: workspace, approvalPolicy: 'on-request', modelProvider: provider,
      ...(provider === 'openrouter' ? { model: 'openai/gpt-5.3-codex' } : {}) };
    const result = await rpc('thread/start', options);
    assert.ok(result.thread.id);
    assert.equal(result.modelProvider, provider);
    assert.equal(result.thread.modelProvider, provider);
    const loaded = await rpc('config/read', {});
    assert.equal(loaded.config.model_provider, provider);
    if (provider === 'openrouter') {
      const configured = loaded.config.model_providers.openrouter;
      assert.equal(configured.base_url, 'https://openrouter.ai/api/v1');
      assert.equal(configured.wire_api, 'responses');
      assert.equal(configured.env_key, 'OPENROUTER_API_KEY');
      await assert.rejects(readFile(join(home, 'auth.json')), { code: 'ENOENT' });
    }
  } finally {
    child.kill();
    lines.close();
    fail(new Error('Protocol check closed'));
  }
}

try {
  execFileSync(binary, ['app-server', 'generate-json-schema', '--out', schemaDirectory]);
  const names = await readdir(schemaDirectory);
  assert.ok(names.length);
  const schemas = (await Promise.all(names.filter(name => name.endsWith('.json')).map(name => readFile(join(schemaDirectory, name), 'utf8')))).join('\n');
  assert.match(schemas, /externalSandbox/);
  assert.match(schemas, /networkAccess/);
  assert.match(schemas, /modelProvider/);
  const resumeSchema = JSON.parse(await readFile(join(schemaDirectory, 'v2', 'ThreadResumeParams.json'), 'utf8'));
  assert.ok(resumeSchema.properties.modelProvider);
  await checkProvider('openai');
  await checkProvider('openrouter');
  console.log('CODEX_PROTOCOL_SMOKE_OK: OpenAI login, OpenRouter Responses config, thread/start and resume/sandbox schema verified; no model turn.');
} finally {
  const safeRelative = relative(tmpdir(), root);
  assert.equal(isAbsolute(safeRelative), false);
  assert.match(safeRelative, /^sowalif-codex-smoke-[a-zA-Z0-9]+$/);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
