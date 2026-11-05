// Independent media provider: never uses or forwards chat-provider credentials.
import { settings } from './db.js?v=8';

export const IMAGE_MODELS = [
  { id: 'auto', name: 'تلقائي — Flux Schnell / Kontext' },
  { id: 'schnell', name: 'Flux Schnell — رسم سريع' },
  { id: 'dev', name: 'Flux Dev — رسم' },
  { id: 'kontext', name: 'Flux Kontext — تعديل صورة' },
];
export const VIDEO_MODELS = [
  { id: 'auto', name: 'تلقائي — Kling / Framepack' },
  { id: 'framepack', name: 'Framepack — تحريك صورة · 10 ثوانٍ' },
  { id: '2.6', name: 'Kling 2.6' },
  { id: '3.0', name: 'Kling 3.0' },
  { id: '4.0-flash', name: 'Kling 4.0 Flash' },
  { id: '4.0', name: 'Kling 4.0' },
];

// Only explicit creation requests trigger a paid job. The buttons cover ambiguous prompts.
export function mediaIntent(text = '') {
  const s = text.trim().replace(/[أإآ]/g, 'ا');
  if (/^(?:كيف|شلون|اشرح|هل|ما |لا |لات|ابي اعرف|اريد ان اعرف)/i.test(s)) return null;
  const verb = /^(?:(?:ممكن|لو سمحت|تكفى)\s+)?(?:ارسم|ارسملي|ارسم لي|صمم|صمملي|صمم لي|انشئ|انشيء|انشئلي|ولد|ولّد|سو|سوي|سولي|سو لي|سويلي|اعمل|اعمللي|اصنع|حرك|حرّك|حول|حوّل|ابي|ابغى|اريد|create|generate|draw|animate|make)\b/i;
  // Arabic has no JS word boundary; use a whitespace/end boundary instead.
  const direct = new RegExp(verb.source.replace('\\b', '(?=\\s|$)'), 'i').test(s);
  if (!direct) return null;
  if (/(?:فيديو|فديو|مقطع|video|animate|حرك|حرّك)/i.test(s)) return 'video';
  if (/^(?:ارسم|ارسملي|draw)(?=\s|$)/i.test(s)) return 'image';
  if (/(?:صور[ةه]|رسم[ةه]?|شعار|image|picture|logo)/i.test(s)) return 'image';
  return null;
}

export function mediaSpec(kind, prompt, { aspect = 'auto', reference, imageModel, videoModel, duration } = {}) {
  if (!prompt?.trim()) throw new Error('اكتب وصفاً لما تريد إنشاءه');
  if (kind === 'video') {
    const chosen = videoModel ?? settings.get('piapiVideoModel', 'auto');
    const version = chosen === 'auto' ? (reference ? 'framepack' : '2.6') : chosen;
    if (!VIDEO_MODELS.some(m => m.id === version)) throw new Error('اختر نموذج فيديو صالحاً من الإعدادات');
    if (version === 'framepack') {
      if (!reference) throw new Error('أرفق صورة لاستخدام Framepack أو اختر تلقائي للفيديو من النص');
      return { name: 'Framepack · 10 ثوانٍ', body: { model: 'Qubico/framepack', task_type: 'img2video', input: { prompt, start_image: reference.startsWith('data:') ? reference.slice(reference.indexOf(',') + 1) : reference, duration: 10 } } };
    }
    if (reference && !/^https?:\/\//i.test(reference)) throw new Error('Kling يحتاج رابط صورة عام. اختر تلقائي أو Framepack لتحريك صورة مرفقة من جهازك.');
    const seconds = Number(duration ?? settings.get('piapiDuration', 5));
    const input = { prompt, version, mode: 'std', duration: seconds === 10 ? 10 : 5, aspect_ratio: ['16:9', '9:16', '1:1'].includes(aspect) ? aspect : '16:9' };
    if (reference) input.image_url = reference;
    return { name: `Kling ${version}`, body: { model: 'kling', task_type: 'video_generation', input, config: { service_mode: 'public' } } };
  }
  const chosen = imageModel ?? settings.get('piapiImageModel', 'auto');
  const selected = chosen === 'auto' ? (reference ? 'kontext' : 'schnell') : chosen;
  if (!IMAGE_MODELS.some(m => m.id === selected)) throw new Error('اختر نموذج صور صالحاً من الإعدادات');
  if (reference && selected !== 'kontext') throw new Error('لتعديل الصورة اختر تلقائي أو Flux Kontext؛ نموذج الرسم المحدد لا يقبل صورة مرجعية');
  if (!reference && selected === 'kontext') throw new Error('أرفق صورة لاستخدام Flux Kontext، أو اختر نموذج رسم آخر');
  if (reference && !/^https?:\/\//i.test(reference)) throw new Error('Flux Kontext يحتاج رابط صورة عام في نسخة الويب. ضع رابط الصورة في خانة المرجع أو استخدم kie.ai لتعديل الصور المحلية بدون مفتاح PiAPI.');
  const [w, h] = (aspect === 'auto' ? '1:1' : aspect).split(':').map(Number);
  const ratio = Number.isFinite(w / h) && w > 0 && h > 0 ? Math.min(2, Math.max(.5, w / h)) : 1;
  const input = { prompt, width: Math.round((ratio >= 1 ? 1024 : 1024 * ratio) / 64) * 64, height: Math.round((ratio >= 1 ? 1024 / ratio : 1024) / 64) * 64 };
  if (reference) input.image = reference;
  return { name: selected === 'kontext' ? 'Flux Kontext' : selected === 'dev' ? 'Flux Dev' : 'Flux Schnell', body: { model: selected === 'kontext' ? 'Qubico/flux1-dev-advanced' : `Qubico/flux1-${selected}`, task_type: selected === 'kontext' ? 'kontext' : 'txt2img', input } };
}

async function request(url, body, signal) {
  const key = settings.get('piapiKey', '').trim();
  if (!key) throw new Error('أضف مفتاح PiAPI في الإعدادات لتوليد الصور والفيديو');
  let res;
  try {
    res = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'X-API-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(body ? 'لم يتأكد وصول الطلب إلى PiAPI. لا تعِد إنشاءه قبل فحص سجل المهام في حسابك لتجنب تكرار التكلفة.' : 'تعذّر الاتصال بـ PiAPI. يمكنك متابعة فحص نفس المهمة لاحقاً.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code != null && ![0, 200].includes(json.code))) throw new Error(`PiAPI (${res.status}): ${String(json.message || 'تعذّر تنفيذ الطلب').slice(0, 300)}`);
  return json.data || json;
}

export async function createMedia(spec, signal) {
  const out = await request('https://api.piapi.ai/api/v1/task', spec.body, signal);
  if (!out.task_id) throw new Error('لم يصل رقم المهمة من PiAPI؛ افحص سجل المهام قبل إعادة الطلب');
  return out.task_id;
}
export async function readMediaTask(id, signal) {
  const out = await request(`https://api.piapi.ai/api/v1/task/${encodeURIComponent(id)}`, null, signal);
  if (['failed', 'error', 'cancelled', 'canceled'].includes(out.status) || Number(out.error?.code)) throw new Error(`PiAPI: ${out.error?.message || out.error?.raw_message || out.status}`);
  return out;
}
export function taskResult(task, kind) {
  if (!['completed', 'success', 'succeeded'].includes(task.status)) return null;
  const url = kind === 'video' ? (task.output?.video || task.output?.video_url) : task.output?.image_url;
  if (!/^https?:\/\//i.test(url || '')) throw new Error('اكتملت المهمة بدون رابط ملف صالح؛ راجع سجل المزوّد');
  return url;
}
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('إلغاء', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});
export async function waitMedia(task, { signal, onStatus = () => {}, interval = 4000, timeout = 20 * 60000, readTask = readMediaTask } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await readTask(task.id, signal);
    const url = taskResult(result, task.kind);
    if (url) return url;
    onStatus(`${task.name} · ${result.status === 'pending' ? 'في قائمة الانتظار' : 'جاري التوليد'}${result.progress != null ? ` · ${result.progress}%` : ''}`);
    await pause(interval, signal);
  }
  throw new Error('التوليد ما زال مستمراً. اضغط «متابعة المهمة» لاحقاً لفحص نفس الطلب.');
}
