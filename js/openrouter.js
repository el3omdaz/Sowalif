import { settings } from './db.js?v=50';
import { readSSE } from './kie.js?v=51';
import { registerOpenRouterModels } from './models.js?v=51';
import { reasoningEffort } from './reasoning.js?v=50';

const BASE = 'https://openrouter.ai/api/v1';
export const openRouterKey = () => {
  const value = settings.get('openRouterKey', '');
  if (!value) throw new Error('أضف مفتاح OpenRouter من الإعدادات');
  return value;
};
function errorFor(code, message = '') {
  let text = 'تعذّر إكمال طلب OpenRouter. جرّب مرة ثانية أو اختر نموذجاً آخر.';
  if (code === 401 || code === 403) text = 'مفتاح OpenRouter غير صالح أو لا يملك صلاحية هذا الطلب.';
  else if (code === 402) text = 'رصيد OpenRouter غير كافٍ، أو حد إنفاق المفتاح لا يسمح بالطلب.';
  else if (code === 429) text = 'طلبات كثيرة على OpenRouter. انتظر قليلاً وجرب مجدداً.';
  else if ([400, 404, 422].includes(code)) text = `OpenRouter (${code}): ${String(message).slice(0, 220)}`;
  else if (code >= 500) text = `خدمة OpenRouter أو مزوّد النموذج غير متاح مؤقتاً (${code}).`;
  return Object.assign(new Error(text), { status: code });
}
const networkError = (e) => e.name === 'AbortError' || e.name === 'TimeoutError' ? e : new Error('تعذّر الاتصال بـ OpenRouter. تحقق من الشبكة ثم أعد المحاولة.');
async function request(path, { body, signal, onTransport, authenticated = true } = {}) {
  const token = authenticated ? openRouterKey() : null;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 60000);
  try {
    onTransport?.({ phase: 'connecting', path });
    const response = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
    });
    const streaming = (response.headers.get('content-type') || '').includes('text/event-stream');
    onTransport?.({ phase: 'headers', path, status: response.status, streaming });
    if (response.ok && streaming) return { stream: response };
    let data;
    try { data = await response.json(); } catch (e) { if (timeout.signal.aborted || signal?.aborted) throw e; throw errorFor(response.status, 'رد غير صالح من الخدمة'); }
    if (!response.ok || data.error) throw errorFor(Number(data.error?.code) || response.status, data.error?.message);
    return { json: data };
  } catch (e) {
    if (timeout.signal.aborted && !signal?.aborted) throw new Error('لم يصل الرد من OpenRouter خلال دقيقة. أعد المحاولة أو اختر نموذجاً آخر.');
    throw e instanceof TypeError ? networkError(e) : e;
  } finally { clearTimeout(timer); }
}

export async function checkOpenRouterKey(signal) {
  const { json } = await request('/key', { signal });
  if (!json.data || typeof json.data !== 'object') throw new Error('لم تصل معلومات مفتاح صالحة من OpenRouter');
  return json.data;
}
export async function refreshOpenRouterModels(signal) {
  const { json } = await request('/models', { signal, authenticated: false });
  const clean = (json.data || []).map((m) => ({ id: m.id, name: m.name, architecture: m.architecture, supported_parameters: m.supported_parameters, reasoning: m.reasoning }));
  const count = registerOpenRouterModels(clean);
  if (!count) throw new Error('لم يصل كتالوج نماذج صالح من OpenRouter');
  settings.set('orCatalog', clean);
  return count;
}

function messagesFor(messages, model) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.id, content: m.output };
    if (m.role === 'assistant') return {
      role: 'assistant', content: m.text || (m.calls?.length ? null : ''),
      ...(m.calls?.length ? { tool_calls: m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) } : {}),
      ...(m.reasoningDetails?.length ? { reasoning_details: m.reasoningDetails } : {}),
    };
    const parts = [];
    for (const f of m.files || []) {
      if (f.kind === 'image') {
        if (model.vision === false) throw new Error('النموذج المحدد في OpenRouter لا يدعم الصور. اختر نموذجاً يدعم الصور.');
        parts.push({ type: 'image_url', image_url: { url: f.dataUrl || f.url } });
      } else if (f.kind === 'audio') {
        if (!f.data || !f.format) throw new Error('يلزم إرسال الصوت مباشرة بصيغة مدعومة إلى OpenRouter');
        parts.push({ type: 'input_audio', input_audio: { data: f.data, format: f.format } });
      }
    }
    const docs = (m.files || []).filter((f) => f.kind === 'doc').map((f) => `\n\nالملف «${f.name}»:\n${f.text}`).join('');
    parts.push({ type: 'text', text: (m.text || '') + docs || '…' });
    return { role: 'user', content: parts };
  });
}

function functionCalls(calls = []) {
  return calls.filter(call => call?.type === 'function' || (!call?.type && call?.function)).map(call => {
    const fn = call.function;
    if (!call.id || typeof call.id !== 'string' || !fn?.name || typeof fn.name !== 'string') throw new Error('وصل طلب أداة غير مكتمل من OpenRouter. أعد المحاولة.');
    let args;
    try { args = JSON.parse(fn.arguments || '{}'); } catch { throw new Error('وصلت معاملات أداة غير صالحة من OpenRouter. أعد المحاولة.'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('وصلت معاملات أداة غير صالحة من OpenRouter. أعد المحاولة.');
    return { id: call.id, name: fn.name, args };
  });
}

function checkFinish(reason, calls, streamed = false) {
  if (streamed && !reason) throw new Error('انقطع بث OpenRouter قبل اكتماله. النص الذي وصل محفوظ؛ أعد المحاولة.');
  if (reason === 'length') throw new Error('بلغ رد OpenRouter الحد المتاح قبل اكتماله. النص الذي وصل محفوظ.');
  if (reason && reason !== 'stop' && reason !== 'tool_calls') throw new Error(`لم يكتمل رد OpenRouter (${reason}). النص الذي وصل محفوظ.`);
  if (reason === 'tool_calls' && !calls.length) throw new Error('وصل طلب أداة غير مكتمل من OpenRouter. أعد المحاولة.');
}

export async function runOpenRouter(model, { system, messages, tools, search, webFetch, deep, reasoningLevel, maxOutputTokens, signal, onDelta, onThinking, onTransport }) {
  const body = { model: model.remoteId, messages: [{ role: 'system', content: system }, ...messagesFor(messages, model)], stream: true };
  const effort = reasoningEffort(model, reasoningLevel, deep);
  if (effort) body.reasoning = { effort };
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;
  const availableTools = model.tools ? (tools || []).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) : [];
  if (search) availableTools.push({ type: 'openrouter:web_search' });
  if (search && webFetch) availableTools.push({ type: 'openrouter:web_fetch' });
  if (availableTools.length) { body.tools = availableTools; body.tool_choice = 'auto'; }
  const r = await request('/chat/completions', { body, signal, onTransport });
  if (r.json) {
    const choice = r.json.choices?.[0];
    const text = choice?.message?.content || '';
    if (text) onDelta?.(text);
    const calls = functionCalls(choice?.message?.tool_calls);
    checkFinish(choice?.finish_reason, calls);
    return { text, calls, credits: 0, ...(choice?.message?.reasoning_details?.length ? { reasoningDetails: choice.message.reasoning_details } : {}) };
  }
  let text = '';
  let finishReason = null;
  const pendingCalls = new Map();
  const reasoningDetails = new Map();
  await readSSE(r.stream, (ev) => {
    const choice = ev.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (typeof delta?.reasoning === 'string') onThinking?.(delta.reasoning);
    if (typeof delta?.content === 'string') { text += delta.content; onDelta?.(delta.content); }
    for (const part of delta?.tool_calls || []) {
      if (!Number.isInteger(part.index) || part.index < 0) throw new Error('وصل طلب أداة غير مكتمل من OpenRouter. أعد المحاولة.');
      const call = pendingCalls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) call.id = part.id;
      if (part.type) call.type = part.type;
      if (part.function?.name) call.function.name += part.function.name;
      if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments;
      pendingCalls.set(part.index, call);
    }
    for (const part of delta?.reasoning_details || []) {
      const index = Number.isInteger(part.index) ? part.index : 0;
      const previous = reasoningDetails.get(index) || {};
      const next = { ...previous, ...part };
      for (const key of ['text', 'data', 'signature']) if (typeof previous[key] === 'string' && typeof part[key] === 'string') next[key] = previous[key] + part[key];
      reasoningDetails.set(index, next);
    }
  }, { errorFor, networkError });
  // Never execute arguments from an interrupted or token-limited response.
  checkFinish(finishReason, [...pendingCalls.values()], true);
  const calls = functionCalls([...pendingCalls].sort(([a], [b]) => a - b).map(([, call]) => call));
  checkFinish(finishReason, calls, true);
  return { text, calls, credits: 0, ...(reasoningDetails.size ? { reasoningDetails: [...reasoningDetails].sort(([a], [b]) => a - b).map(([, detail]) => detail) } : {}) };
}
