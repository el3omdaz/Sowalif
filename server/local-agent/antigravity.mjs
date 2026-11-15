import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

const defaultModel = 'gemini-4-carbon-high';
const maxMessage = 1024 * 1024;
const maxOutput = 100_000;
const stopped = () => new Error('تم إيقاف محرك Antigravity');

async function configure(home) {
  const settings = join(home, '.gemini', 'antigravity-cli');
  await mkdir(settings, { mode: 0o700, recursive: true });
  await writeFile(join(settings, 'settings.json'), JSON.stringify({
    modelProvider: 'gemini', agentMode: 'default', toolPermission: 'request-review',
    permissions: {
      ask: ['command(*)'],
      deny: ['read_url(*)', 'execute_url(*)', 'mcp(*)', 'read_file(/sessions)', 'write_file(/sessions)', 'read_file(/proc)'],
    },
  }), { mode: 0o600 });
}

function values(config) {
  return (config?.options || []).flatMap(option => Array.isArray(option.options) ? option.options : [option]);
}

function findConfig(configs, category) {
  return (configs || []).find(option => option.category === category || option.id === category);
}

async function selectModel(rpc, session, sessionId, model) {
  let option = findConfig(session.configOptions, 'model');
  if (!option && session.models) {
    if (session.models.currentModelId === model) return new Map();
    if (session.models.availableModels?.some(value => value.modelId === model)) {
      await rpc('session/set_model', { sessionId, modelId: model });
      return new Map();
    }
  }
  const effortSuffix = /-(low|medium|high|xhigh|max)$/.exec(model);
  const selected = option?.currentValue === model || values(option).some(entry => entry.value === model) ? model
    : effortSuffix && values(option).some(entry => entry.value === model.slice(0, effortSuffix.index)) ? model.slice(0, effortSuffix.index) : '';
  if (!option || !selected) throw new Error(`نموذج Antigravity غير متاح في هذا الربط: ${model}`);

  let configs = session.configOptions;
  if (option.currentValue !== selected) {
    configs = (await rpc('session/set_config_option', { sessionId, configId: option.id, value: selected })).configOptions;
    option = findConfig(configs, 'model');
    if (option?.currentValue !== selected) throw new Error('تعذر تأكيد اختيار نموذج Antigravity');
  }
  const selectedOptions = new Map([[option.id, selected]]);
  if (selected === model) return selectedOptions;
  const effort = findConfig(configs, 'thought_level') || findConfig(configs, 'effort') ||
    configs?.find(entry => /^thinking level$/i.test(entry.name));
  const wanted = effortSuffix[1];
  const value = values(effort).find(entry => String(entry.value).toLowerCase() === wanted)?.value;
  if (!value) throw new Error('مستوى تفكير Antigravity المطلوب غير متاح');
  if (effort.currentValue !== value) {
    const updated = await rpc('session/set_config_option', { sessionId, configId: effort.id, value });
    if (updated.configOptions?.find(entry => entry.id === effort.id)?.currentValue !== value) throw new Error('تعذر تأكيد مستوى تفكير Antigravity');
  }
  selectedOptions.set(effort.id, value);
  return selectedOptions;
}

function approvalInput(tool, workspace) {
  const raw = tool.rawInput;
  const withinWorkspace = path => {
    if (typeof path !== 'string' || path.includes('\0')) return false;
    const resolved = posix.resolve(workspace, path);
    return resolved === workspace || resolved.startsWith(`${workspace}/`);
  };
  const paths = Array.isArray(tool.locations) ? tool.locations.map(location => location.path) : [];
  if (paths.some(path => !withinWorkspace(path))) return null;
  if (['execute', undefined].includes(tool.kind)) {
    const command = typeof raw === 'string' ? raw : raw?.command ?? raw?.commandLine ?? raw?.CommandLine;
    const cwd = raw?.cwd ?? raw?.workdir ?? raw?.working_directory;
    if (typeof command !== 'string' || !command.trim() || command.length > 12_000 || (cwd && !withinWorkspace(cwd))) return null;
    return command;
  }
  if (['read', 'edit', 'delete', 'move', 'search'].includes(tool.kind) && paths.length) return paths.join('\n');
  return null;
}

export async function runAntigravity(config, { send, approve, signal }, {
  spawnAgent = spawn, binary = 'agy', workspace = '/workspace', home = '/sessions/antigravity', timeout = 60_000,
} = {}) {
  const key = String(config.key || '');
  const model = String(config.model || defaultModel);
  if (!key) throw new Error('أدخل مفتاح Gemini API قبل تشغيل Antigravity');
  if (!/^[a-z0-9][a-z0-9._-]{0,149}$/i.test(model)) throw new Error('معرّف نموذج Antigravity غير صالح');
  if (signal?.aborted) throw stopped();
  await configure(home);
  if (signal?.aborted) throw stopped();

  const child = spawnAgent(binary, ['acp', '--disable-telemetry', '--log-file', '/tmp/sowalif-antigravity.log'], {
    cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: '/tmp', LANG: 'C.UTF-8', GEMINI_API_KEY: key },
  });
  const pending = new Map();
  const awaitingApproval = new Set();
  const toolCalls = new Map();
  const redact = value => String(value ?? '').replaceAll(key, '[key]').slice(0, 12_000);
  let sequence = 0;
  let fatal;
  let sessionId;
  let selectedOptions;
  let active = false;
  let buffered = '';
  let outputTail = '';
  let outputLength = 0;
  let deniedPermission = false;

  function write(message) {
    if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  function fail(error) {
    fatal ||= error;
    for (const waiter of pending.values()) waiter.reject(fatal);
    pending.clear();
  }

  function rpc(method, params, duration = timeout) {
    if (fatal) return Promise.reject(fatal);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`تجاوز Antigravity مهلة ${method}`));
      }, duration);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      write({ id, method, params });
    });
  }

  function emitOutput(value, final = false) {
    const text = (outputTail + value).replaceAll(key, '[key]');
    const boundary = final ? text.length : Math.max(0, text.length - key.length + 1);
    outputTail = text.slice(boundary);
    const safe = text.slice(0, Math.min(boundary, maxOutput - outputLength));
    for (let start = 0; start < safe.length; start += 12_000) send('delta', { text: safe.slice(start, start + 12_000) });
    outputLength += safe.length;
  }

  function update({ sessionId: id, update: item } = {}) {
    if (!active || id !== sessionId || !item) return;
    if (item.sessionUpdate === 'config_option_update' && item.configOptions?.some(option => selectedOptions.has(option.id) && selectedOptions.get(option.id) !== option.currentValue)) {
      fail(new Error('تغيّر نموذج Antigravity أو مستوى التفكير أثناء التنفيذ. اختر نموذجًا متاحًا وأعد المحاولة.'));
      return;
    }
    if (item.sessionUpdate === 'agent_message_chunk' && item.content?.type === 'text' && typeof item.content.text === 'string') emitOutput(item.content.text);
    if (['tool_call', 'tool_call_update'].includes(item.sessionUpdate) && typeof item.toolCallId === 'string') {
      const details = { ...toolCalls.get(item.toolCallId) };
      for (const field of ['kind', 'rawInput', 'locations', 'title']) if (Object.hasOwn(item, field)) details[field] = item[field];
      toolCalls.set(item.toolCallId, details);
      if (toolCalls.size > 64) toolCalls.delete(toolCalls.keys().next().value);
    }
    if (item.sessionUpdate === 'tool_call') {
      send('tool', { name: redact(item.kind || 'Antigravity'), input: redact(item.title) });
    }
    if (item.sessionUpdate === 'tool_call_update' && item.status === 'failed') {
      const detail = item.content?.find(block => block.type === 'content' && block.content?.type === 'text')?.content?.text;
      send('tool-result', { error: true, text: redact(detail || item.title || 'تعذّر تنفيذ إحدى أدوات Antigravity.') });
    }
  }

  async function permission({ id, params } = {}) {
    const patch = params?.toolCall || {};
    const tool = { ...toolCalls.get(patch.toolCallId), ...patch };
    const options = Array.isArray(params?.options) ? params.options : [];
    const once = options.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string');
    const decline = options.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string');
    const command = approvalInput(tool, workspace);
    let allowed = false;
    awaitingApproval.add(id);
    if (active && sessionId === params?.sessionId && once && command && !command.includes(key) && !fatal && !signal?.aborted) {
      try { allowed = await approve('Antigravity', { command: redact(command), description: redact(tool.title) }); } catch { /* Decline if the approval channel is unavailable. */ }
    }
    if (!awaitingApproval.delete(id)) return;
    const selected = allowed ? once : decline;
    if (!allowed && active && !signal?.aborted) {
      deniedPermission = true;
      send('tool-result', { error: true, text: redact(`تم رفض إجراء Antigravity: ${tool.title || tool.kind || 'أداة غير معروفة'}`) });
    }
    write({ id, result: { outcome: selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } } });
  }

  function receive(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
    if (message.id == null) {
      if (message.method === 'session/update') update(message.params);
      return;
    }
    if (!message.method) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(Object.assign(new Error(redact(message.error.message || 'تعذّر تنفيذ طلب Antigravity')), { code: message.error.code }));
      else waiter?.resolve(message.result || {});
      return;
    }
    if (message.method === 'session/request_permission') void permission(message).catch(fail);
    else write({ id: message.id, error: { code: -32601, message: 'Unsupported client method' } });
  }

  function cancel() {
    if (sessionId) write({ method: 'session/cancel', params: { sessionId } });
    for (const id of awaitingApproval) write({ id, result: { outcome: { outcome: 'cancelled' } } });
    awaitingApproval.clear();
    fail(stopped());
  }

  child.stdin.on('error', () => fail(new Error('انقطع الاتصال بمحرك Antigravity')));
  child.stdout.on('error', () => fail(new Error('تعذّرت قراءة رد Antigravity')));
  child.stderr.resume(); // Startup diagnostics may contain provider or credential data.
  child.on('error', error => fail(new Error(error.code === 'ENOENT' ? 'محرك Antigravity غير مثبت. أعد إعداد محرك الشغل.' : 'تعذّر تشغيل Antigravity')));
  child.on('close', () => fail(new Error('توقّف Antigravity قبل إرسال النتيجة. تحقق من مفتاح Gemini وإعداد المحرك.')));
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      if (newline > maxMessage) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); } catch { fail(new Error('أرسل Antigravity ردًا غير صالح')); return; }
    }
    if (buffered.length > maxMessage) fail(new Error('تجاوز رد Antigravity الحجم المدعوم'));
  });
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();

  try {
    const initialized = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'sowalif', version: '1.0.0' } });
    if (initialized.protocolVersion !== 1) throw new Error('إصدار بروتوكول Antigravity غير مدعوم');
    const params = { cwd: workspace, mcpServers: [] };
    const capabilities = initialized.agentCapabilities || {};
    const openSession = async (method, params) => {
      try { return await rpc(method, params); }
      catch (error) {
        if (error.code !== -32000 || !initialized.authMethods?.some(auth => auth.id === 'gemini-api-key')) throw error;
        await rpc('authenticate', { methodId: 'gemini-api-key' });
        return rpc(method, params);
      }
    };
    let session;
    if (config.sessionId) {
      const method = capabilities.sessionCapabilities?.resume ? 'session/resume' : capabilities.loadSession ? 'session/load' : '';
      if (!method) throw new Error('إصدار Antigravity الحالي لا يدعم استكمال الجلسات');
      sessionId = config.sessionId;
      session = await openSession(method, { ...params, sessionId });
    } else {
      session = await openSession('session/new', params);
      sessionId = session.sessionId;
    }
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 300 || /[\0\r\n]/.test(sessionId)) throw new Error('تعذّر فتح جلسة Antigravity');
    selectedOptions = await selectModel(rpc, session, sessionId, model);
    send('session', { id: sessionId, model });
    active = true;
    const result = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: config.prompt }] }, 20 * 60_000);
    if (signal?.aborted || result.stopReason === 'cancelled') throw stopped();
    emitOutput(deniedPermission ? '\n\nتوقّف تنفيذ بعض الإجراءات بسبب الصلاحيات. راجع سجل الأدوات.' : '', true);
    if (result.stopReason !== 'end_turn') throw new Error(redact(`لم يُكمل Antigravity المهمة: ${result.stopReason || 'انتهت الجلسة من دون حالة إكمال'}`));
    send('result', { sessionId });
  } finally {
    active = false;
    signal?.removeEventListener('abort', cancel);
    fail(new Error('انتهت جلسة Antigravity'));
    child.kill('SIGTERM');
  }
}
