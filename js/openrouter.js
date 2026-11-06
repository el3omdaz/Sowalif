import { settings } from './db.js?v=16';
import { readSSE } from './kie.js?v=16';
import { registerOpenRouterModels } from './models.js?v=16';

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
  const clean = (json.data || []).map((m) => ({ id: m.id, name: m.name, architecture: m.architecture, supported_parameters: m.supported_parameters }));
  const count = registerOpenRouterModels(clean);
  if (!count) throw new Error('لم يصل كتالوج نماذج صالح من OpenRouter');
  settings.set('orCatalog', clean);
  return count;
}

function messagesFor(messages, model) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.id, content: m.output };
    if (m.role === 'assistant') return { role: 'assistant', content: m.text || '' };
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

export async function runOpenRouter(model, { system, messages, search, deep, maxOutputTokens, signal, onDelta, onThinking, onTransport }) {
  const body = { model: model.remoteId, messages: [{ role: 'system', content: system }, ...messagesFor(messages, model)], stream: true };
  if (model.reasoning) body.reasoning = { effort: deep ? 'high' : 'low' };
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;
  if (search) body.tools = [{ type: 'openrouter:web_search' }];
  const r = await request('/chat/completions', { body, signal, onTransport });
  if (r.json) {
    const choice = r.json.choices?.[0];
    const text = choice?.message?.content || '';
    if (text) onDelta(text);
    if (choice?.finish_reason === 'length') throw new Error('بلغ رد OpenRouter الحد المتاح قبل اكتماله.');
    return { text, calls: [], credits: 0 };
  }
  let text = '';
  let finishReason = null;
  await readSSE(r.stream, (ev) => {
    const choice = ev.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (typeof delta?.reasoning === 'string') onThinking?.(delta.reasoning);
    if (typeof delta?.content === 'string') { text += delta.content; onDelta(delta.content); }
  }, { errorFor, networkError });
  if (!finishReason) throw new Error('انقطع بث OpenRouter قبل اكتماله. النص الذي وصل محفوظ؛ أعد المحاولة.');
  if (finishReason === 'length') throw new Error('بلغ رد OpenRouter الحد المتاح قبل اكتماله. النص الذي وصل محفوظ.');
  if (finishReason !== 'stop') throw new Error(`لم يكتمل رد OpenRouter (${finishReason}). النص الذي وصل محفوظ.`);
  return { text, calls: [], credits: 0 };
}
