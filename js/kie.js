// الاتصال بـ kie.ai من المتصفح مباشرة: ثلاث صيغ للمحادثة (Anthropic · Responses · Chat Completions) + الرفع + توليد الصور
import { settings, putBlob } from './db.js';
import { modelById } from './models.js';

// sc.base / sc.upload لتجربة التطبيق على خادم وهمي فقط
const BASE = () => settings.get('base', 'https://api.kie.ai');
const UPLOAD = () => settings.get('upload', 'https://kieai.redpandaai.co/api/file-stream-upload');
export const CREDIT_USD = 0.005;

const key = () => {
  const k = settings.get('kieKey', '');
  if (!k) throw new Error('أضف مفتاح kie.ai من الإعدادات ⚙️');
  return k;
};

function friendly(code, msg = '') {
  if (code === 401) return 'مفتاح kie.ai غير صالح — غيّره من الإعدادات';
  if (code === 402 || /insufficient|credit|balance/i.test(msg)) return 'رصيدك في kie.ai خلص — اشحن الرصيد وجرب مرة ثانية';
  if (code === 429) return 'طلبات كثيرة على kie.ai — انتظر شوي وجرب';
  if (code === 422) return `طلب غير مقبول من kie.ai: ${String(msg).slice(0, 200)}`;
  return `kie.ai (${code}): ${String(msg).slice(0, 300)}`;
}

const netError = (e) => (e.name === 'AbortError' ? e : new Error(navigator.onLine === false ? 'ما فيه إنترنت' : `تعذّر الاتصال بـ kie.ai (${e.message})`));

// الأخطاء تصل أحياناً بحالة 200 ورمز داخل الجسم، فنفحص الرد قبل قراءته كبث
async function post(url, body, signal, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(`${BASE()}${url}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw netError(e);
  }
  if (res.ok && (res.headers.get('content-type') || '').includes('text/event-stream')) return { stream: res };
  const text = await res.text();
  const json = safeJSON(text);
  const code = Number(json?.code) || res.status;
  if (!res.ok || !json || json.type === 'error' || json.error || (json.code && code !== 200)) {
    throw new Error(friendly(code, json?.error?.message || json?.msg || json?.message || text.slice(0, 300)));
  }
  return { json };
}

function safeJSON(s) {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// يقرأ أحداث SSE سطراً سطراً ويمرر كل حدث JSON
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const ev = safeJSON(data);
      if (!ev) continue;
      if (ev.code && Number(ev.code) !== 200 && !ev.type) throw new Error(friendly(Number(ev.code), ev.msg));
      onEvent(ev);
    }
  }
}

const creditsOf = (o) => Number(o?.credits_consumed ?? o?.message?.credits_consumed ?? o?.response?.credits_consumed ?? o?.usage?.credits_consumed) || 0;

// ---------- تحويل المحادثة ----------
// الرسالة: { role, text, files: [{kind:'image', dataUrl | url} | {kind:'doc', name, text} | {kind:'audio', url}] }
// والأدوات: { role:'assistant', calls:[{id,name,args}] } ثم { role:'tool', id, name, output }

const docText = (f) => `\n\n📄 الملف «${f.name}»:\n${f.text}`;
const userText = (m) => `${m.text || ''}${(m.files || []).filter((f) => f.kind === 'doc').map(docText).join('')}`;
const images = (m) => (m.files || []).filter((f) => f.kind === 'image');

function toAnthropic(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      const imgs = images(m).map((f) => {
        const d = /^data:([^;,]+);base64,(.*)$/s.exec(f.dataUrl || '');
        return d ? { type: 'image', source: { type: 'base64', media_type: d[1], data: d[2] } } : { type: 'image', source: { type: 'url', url: f.url } };
      });
      const t = userText(m);
      push('user', [...imgs, ...(t.trim() ? [{ type: 'text', text: t }] : [])]);
    } else if (m.role === 'assistant') {
      push('assistant', [...(m.text?.trim() ? [{ type: 'text', text: m.text }] : []), ...(m.calls || []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }))]);
    } else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.id, content: m.output }]);
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '…' }] });
  return out;
}

function toResponses(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const parts = images(m).map((f) => ({ type: 'input_image', image_url: f.dataUrl || f.url }));
      const t = userText(m);
      if (t.trim() || !parts.length) parts.push({ type: 'input_text', text: t || '…' });
      out.push({ role: 'user', content: parts });
    } else if (m.role === 'assistant') {
      if (m.text?.trim()) out.push({ role: 'assistant', content: m.text });
      for (const c of m.calls || []) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args || {}) });
    } else if (m.role === 'tool') out.push({ type: 'function_call_output', call_id: m.id, output: m.output });
  }
  return out;
}

function toChat(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const parts = (m.files || []).filter((f) => (f.kind === 'image' || f.kind === 'audio') && (f.url || f.dataUrl)).map((f) => ({ type: 'image_url', image_url: { url: f.url || f.dataUrl } }));
      parts.push({ type: 'text', text: userText(m) || '…' });
      out.push({ role: 'user', content: parts });
    } else if (m.role === 'assistant' && m.text?.trim()) out.push({ role: 'assistant', content: m.text });
  }
  return out;
}

// ---------- البث ----------
// يعيد { text, calls, credits } ويمرر النص أولاً بأول عبر onDelta، والتفكير عبر onThinking
async function runAnthropic(model, { system, messages, tools, deep, signal, onDelta, onThinking }) {
  const body = { model: model.id, max_tokens: 16000, system, messages: toAnthropic(messages), stream: true };
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (deep) body.thinkingFlag = true;
  const r = await post('/claude/v1/messages', body, signal, { 'anthropic-version': '2023-06-01' });
  if (r.json) {
    const content = r.json.content || [];
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) onDelta(text);
    return { text, calls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })), credits: creditsOf(r.json) };
  }
  const blocks = [];
  let text = '';
  let credits = 0;
  await readSSE(r.stream, (ev) => {
    if (ev.type === 'error') throw new Error(friendly(500, ev.error?.message));
    credits = creditsOf(ev) || credits;
    if (ev.type === 'content_block_start') {
      blocks[ev.index] = { ...ev.content_block, json: '' };
      if (ev.content_block?.type === 'text' && ev.content_block.text) {
        text += ev.content_block.text;
        onDelta(ev.content_block.text);
      }
    } else if (ev.type === 'content_block_delta') {
      const b = (blocks[ev.index] ||= { type: 'text', json: '' });
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) {
        text += d.text;
        onDelta(d.text);
      } else if (d.type === 'input_json_delta') b.json += d.partial_json || '';
      else if (d.type === 'thinking_delta' && d.thinking) onThinking?.(d.thinking);
    }
  });
  const calls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: safeJSON(b.json) || b.input || {} }));
  return { text, calls, credits };
}

const callsFromOutput = (output = []) => output.filter((o) => o.type === 'function_call').map((o) => ({ id: o.call_id || o.id, name: o.name, args: safeJSON(o.arguments) || {} }));

const textFromOutput = (output = []) =>
  output
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');

async function runResponses(model, { system, messages, tools, deep, signal, onDelta, onThinking }) {
  const body = { model: model.id, instructions: system, input: toResponses(messages), stream: true };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
    body.tool_choice = 'auto';
  }
  if (model.effort) body.reasoning = { effort: deep ? model.effort[1] : model.effort[0] };
  const r = await post(model.url, body, signal);
  if (r.json) {
    const resp = r.json.response || r.json;
    const text = textFromOutput(resp.output);
    if (text) onDelta(text);
    return { text, calls: callsFromOutput(resp.output), credits: creditsOf(r.json) };
  }
  let text = '';
  let final = null;
  let credits = 0;
  await readSSE(r.stream, (ev) => {
    const d = ev.data || ev;
    const type = ev.type || ev.event || d.type;
    credits = creditsOf(ev) || creditsOf(d) || credits;
    if (type === 'response.output_text.delta') {
      text += d.delta || '';
      onDelta(d.delta || '');
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') onThinking?.(d.delta || '');
    else if (type === 'response.completed') final = d.response || d;
    else if (type === 'response.failed' || type === 'response.incomplete') {
      const resp = d.response || d;
      throw new Error(friendly(500, resp.error?.message || resp.incomplete_details?.reason || 'لم يكتمل الرد'));
    }
  });
  if (!text && final) {
    text = textFromOutput(final.output);
    if (text) onDelta(text);
  }
  return { text, calls: callsFromOutput(final?.output), credits };
}

async function runChat(model, { system, messages, search, deep, signal, onDelta, onThinking }) {
  const body = { messages: [{ role: 'system', content: system }, ...toChat(messages)], stream: true, reasoning_effort: deep ? 'high' : 'low' };
  if (search) body.tools = [{ type: 'function', function: { name: 'googleSearch' } }];
  const r = await post(model.url, body, signal);
  if (r.json) {
    const text = r.json.choices?.[0]?.message?.content || '';
    if (text) onDelta(text);
    return { text, calls: [], credits: creditsOf(r.json) };
  }
  let text = '';
  let credits = 0;
  await readSSE(r.stream, (ev) => {
    credits = creditsOf(ev) || credits;
    const d = ev.choices?.[0]?.delta || {};
    if (d.reasoning_content) onThinking?.(d.reasoning_content);
    if (typeof d.content === 'string' && d.content) {
      text += d.content;
      onDelta(d.content);
    }
  });
  return { text, calls: [], credits };
}

export function runModel(modelId, opts) {
  const model = modelById(modelId);
  const fn = model.api === 'anthropic' ? runAnthropic : model.api === 'responses' ? runResponses : runChat;
  return fn(model, { onDelta: () => {}, ...opts });
}

// طلب واحد بدون عرض متدفق (البحث وتحويل الصوت)
export async function ask(modelId, system, user, { search = false, signal } = {}) {
  const out = await runModel(modelId, { system, messages: [user], search, signal });
  return { text: out.text, credits: out.credits };
}

// ---------- الرفع: رابط عام مؤقت من kie.ai (مجاني، يُحذف بعد أيام) ----------
export async function uploadFile(blob, fileName) {
  const form = new FormData();
  form.append('file', blob, fileName);
  form.append('uploadPath', 'smart-chat');
  form.append('fileName', fileName);
  let res;
  try {
    res = await fetch(UPLOAD(), { method: 'POST', headers: { Authorization: `Bearer ${key()}` }, body: form });
  } catch (e) {
    throw netError(e);
  }
  const text = await res.text();
  const json = safeJSON(text) || {};
  const url = json.data?.downloadUrl || json.data?.fileUrl || json.data?.url;
  if (!res.ok || !url || json.success === false || (json.code && json.code !== 200)) throw new Error(`فشل رفع الملف إلى kie.ai: ${json.msg || text.slice(0, 200)}`);
  return url;
}

// ---------- توليد الصور (مهمة ثم استعلام حتى تنتهي) ----------
async function taskCall(method, p, body, signal) {
  let res;
  try {
    res = await fetch(`${BASE()}${p}`, { method, headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    throw netError(e);
  }
  const text = await res.text();
  const json = safeJSON(text);
  if (!json) throw new Error(`kie.ai (${res.status}): ${text.slice(0, 200)}`);
  const code = Number(json.code ?? res.status);
  if (!res.ok || code !== 200) throw new Error(friendly(code, json.msg || json.message));
  return json.data;
}

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('أُلغي', 'AbortError'))), { once: true });
  });

export async function generateImage({ prompt, aspect = 'auto', refs = [], model, signal }) {
  const input = { prompt: String(prompt).slice(0, 20000), aspect_ratio: aspect, resolution: '2K', output_format: 'png' };
  if (refs.length) input.image_input = refs.slice(0, 10);
  const data = await taskCall('POST', '/api/v1/jobs/createTask', { model, input }, signal);
  const taskId = data?.taskId;
  if (!taskId) throw new Error('kie.ai لم يرجع رقم المهمة');
  const started = Date.now();
  while (Date.now() - started < 5 * 60 * 1000) {
    await wait(3000, signal);
    const d = await taskCall('GET', `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, null, signal);
    const state = String(d?.state || '').toLowerCase();
    if (state === 'success') {
      const urls = safeJSON(d.resultJson)?.resultUrls || [];
      if (!urls.length) throw new Error('اكتمل التوليد بدون صورة');
      return { urls, credits: Number(d.creditsConsumed) || 0 };
    }
    if (state === 'fail') throw new Error(`فشل توليد الصورة: ${d.failMsg || d.failCode || ''}`);
  }
  throw new Error('توليد الصورة أخذ وقت طويل — جرب مرة ثانية');
}

// نحفظ الصورة على الجهاز لأن روابط kie.ai تنتهي بعد أيام (وإن تعذّر نكتفي بالرابط)
export async function saveRemote(url) {
  try {
    const res = await fetch(url);
    const blob = res.ok ? await res.blob() : null;
    if (!blob || !/^image\//.test(blob.type)) throw new Error();
    return { blob: await putBlob(blob), url, urlAt: Date.now() };
  } catch {
    return { url, urlAt: Date.now() };
  }
}

export async function credits() {
  const d = await taskCall('GET', '/api/v1/chat/credit');
  const n = Number(typeof d === 'object' && d ? d.credits ?? d.balance : d);
  if (!Number.isFinite(n)) throw new Error('تعذّر قراءة الرصيد');
  return n;
}
