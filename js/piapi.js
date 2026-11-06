// Independent media provider: never uses or forwards chat-provider credentials.
import { settings } from './db.js?v=14';

export const IMAGE_MODELS = [
  { id: 'auto', name: 'تلقائي — Flux Schnell / Kontext' },
  { id: 'schnell', name: 'Flux Schnell — رسم سريع' },
  { id: 'dev', name: 'Flux Dev — رسم' },
  { id: 'kontext', name: 'Flux Kontext — تعديل صورة' },
  { id: 'nano-banana-2', name: 'Nano Banana 2', family: 'gemini' },
  { id: 'nano-banana-2.1', name: 'Nano Banana 2.1', family: 'gemini' },
  { id: 'nano-banana-pro', name: 'Nano Banana Pro', family: 'gemini' },
  { id: 'seedream-5-lite', name: 'Seedream 5 Lite', family: 'seedream' },
  { id: 'seedream-5-pro', name: 'Seedream 5 Pro', family: 'seedream' },
];
export const VIDEO_MODELS = [
  { id: 'auto', name: 'تلقائي — Kling / Framepack / Seedance' },
  { id: 'framepack', name: 'Framepack — تحريك صورة · 10 ثوانٍ' },
  { id: '2.6', name: 'Kling 2.6' },
  { id: '3.0', name: 'Kling 3.0' },
  { id: '3.0-turbo', name: 'Kling 3.0 Turbo' },
  { id: '2.5', name: 'Kling 2.5' },
  { id: '4.0-flash', name: 'Kling 4.0 Flash' },
  { id: '4.0', name: 'Kling 4.0' },
  { id: 'v2.3', name: 'Hailuo 2.3', family: 'hailuo' },
  { id: 'v2.3-fast', name: 'Hailuo 2.3 Fast', family: 'hailuo' },
  { id: 'veo3.1-video', name: 'Veo 3.1 · 8 ثوانٍ', family: 'veo3.1' },
  { id: 'veo3.1-video-fast', name: 'Veo 3.1 Fast · 8 ثوانٍ', family: 'veo3.1' },
  { id: 'seedance-2.5', name: 'Seedance 2.5', family: 'seedance' },
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

export function mediaSpec(kind, prompt, { aspect = 'auto', reference, videoReference, imageModel, videoModel, duration } = {}) {
  if (!prompt?.trim()) throw new Error('اكتب وصفاً لما تريد إنشاءه');
  if (kind === 'video') {
    const chosen = videoModel ?? settings.get('piapiVideoModel', 'auto');
    const version = chosen === 'auto' ? (videoReference ? 'seedance-2.5' : reference ? 'framepack' : '2.6') : chosen;
    const model = VIDEO_MODELS.find(m => m.id === version);
    if (!model) throw new Error('اختر نموذج فيديو صالحاً من الإعدادات');
    if (videoReference && model.family !== 'seedance') throw new Error('لتعديل فيديو، اختر Seedance 2.5 أو تلقائي من إعدادات PiAPI.');
    if (videoReference && !/^https?:\/\//i.test(videoReference)) throw new Error('Seedance 2.5 يحتاج رابط فيديو عام.');
    if (version === 'framepack') {
      if (!reference) throw new Error('أرفق صورة لاستخدام Framepack أو اختر تلقائي للفيديو من النص');
      return { name: 'Framepack · 10 ثوانٍ', body: { model: 'Qubico/framepack', task_type: 'img2video', input: { prompt, start_image: reference.startsWith('data:') ? reference.slice(reference.indexOf(',') + 1) : reference, duration: 10 } } };
    }
    if (reference && !/^https?:\/\//i.test(reference)) {
      if (model.family === 'seedance') throw new Error('Seedance 2.5 عبر PiAPI يحتاج رابط صورة عام. لاستخدام الصورة المرفقة مباشرة، اختر مزوّد الوسائط kie.ai ثم Seedance 2.5 من إعدادات الصور والفيديو.');
      throw new Error(`${model.name} يحتاج رابط صورة عام. اختر تلقائي أو Framepack لتحريك صورة مرفقة من جهازك.`);
    }
    const seconds = Number(duration ?? settings.get('piapiDuration', 5));
    if (model.family === 'seedance') {
      const input = { prompt, duration: seconds === 10 ? 10 : 5, resolution: '480p', aspect_ratio: aspect === 'auto' ? '16:9' : aspect, mode: reference || videoReference ? 'omni_reference' : 'text_to_video' };
      if (reference) input.image_urls = [reference];
      if (videoReference) {
        input.prompt = `@video1: ${prompt}`;
        input.video_urls = [videoReference];
        input.aspect_ratio = 'adaptive';
        // Editing keeps the source length. Extension takes the selected duration.
        if (!/(?:مدد|تمديد|اطل|كمل|كمّل|extend|continue)/i.test(prompt)) {
          input.omni_reference_task_type = 'edit';
          input.duration = -1;
        } else input.omni_reference_task_type = 'extend';
      }
      return { name: model.name, body: { model: model.family, task_type: version, input } };
    }
    if (model.family === 'hailuo') {
      if (version === 'v2.3-fast' && !reference) throw new Error('Hailuo 2.3 Fast يحتاج صورة مرجعية.');
      const input = { prompt, model: version, duration: seconds === 10 ? 10 : 6, resolution: 768 };
      if (reference) input.image_url = reference;
      return { name: model.name, body: { model: model.family, task_type: 'video_generation', input, config: { service_mode: 'public' } } };
    }
    if (model.family === 'veo3.1') {
      const input = { prompt, duration: '8s', resolution: '720p', aspect_ratio: aspect === '9:16' ? '9:16' : '16:9', generate_audio: false };
      if (reference) input.image_url = reference;
      return { name: model.name, body: { model: model.family, task_type: version, input } };
    }
    const input = { prompt, version, mode: 'std', duration: seconds === 10 ? 10 : 5, aspect_ratio: ['16:9', '9:16', '1:1'].includes(aspect) ? aspect : '16:9' };
    if (reference) input.image_url = reference;
    return { name: `Kling ${version}`, body: { model: 'kling', task_type: 'video_generation', input, config: { service_mode: 'public' } } };
  }
  const chosen = imageModel ?? settings.get('piapiImageModel', 'auto');
  const selected = chosen === 'auto' ? (reference ? 'kontext' : 'schnell') : chosen;
  const model = IMAGE_MODELS.find(m => m.id === selected);
  if (!model) throw new Error('اختر نموذج صور صالحاً من الإعدادات');
  if (model.family) {
    if (reference && !/^https?:\/\//i.test(reference)) throw new Error(`${model.name} يحتاج رابط صورة عام. لتعديل صورة من الجهاز اختر kie.ai للوسائط.`);
    const input = { prompt, aspect_ratio: aspect === 'auto' ? '1:1' : aspect, output_format: 'png' };
    if (model.family === 'seedream') input.size = '2K';
    else input.resolution = '1K';
    if (reference) input.image_urls = [reference];
    return { name: model.name, body: { model: model.family, task_type: selected, input } };
  }
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
    throw new Error(body ? 'لم يتأكد وصول الطلب إلى PiAPI. لا تعِد إنشاءه قبل فحص سجل المهام في حسابك لتجنب تكرار التكلفة.' : 'تعذّر الاتصال بـ PiAPI. يمكنك متابعة فحص نفس المهمة لاحقاً.', { cause: e });
  }
  const json = await res.json().catch(error => {
    if (error instanceof SyntaxError) return {};
    throw error;
  });
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
  const url = kind === 'video' ? (task.output?.video || task.output?.video_url) : (task.output?.image_url || task.output?.image_urls?.[0]);
  if (!/^https?:\/\//i.test(url || '')) throw new Error('اكتملت المهمة بدون رابط ملف صالح؛ راجع سجل المزوّد');
  return url;
}
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('إلغاء', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});
export async function waitMedia(task, { signal, onStatus = () => {}, interval = 4000, timeout = 20 * 60000, readTask = readMediaTask, once = false } = {}) {
  const start = Date.now();
  let interruptedReads = 0;
  while (Date.now() - start < timeout) {
    let result;
    try {
      signal?.throwIfAborted();
      result = await readTask(task.id, signal);
      interruptedReads = 0;
    } catch (error) {
      const cause = error.cause || error;
      const interrupted = cause instanceof TypeError || ['AbortError', 'TimeoutError'].includes(cause.name);
      if (once || signal?.aborted || !interrupted || ++interruptedReads > 3) throw error;
      onStatus(`${task.name} · انقطع الاتصال، جاري التحقق من نفس المهمة…`);
      await pause(interval, signal);
      continue;
    }
    const url = taskResult(result, task.kind);
    if (url) return url;
    if (once) return null;
    onStatus(`${task.name} · ${result.status === 'pending' ? 'في قائمة الانتظار' : 'جاري التوليد'}${result.progress != null ? ` · ${result.progress}%` : ''}`);
    await pause(interval, signal);
  }
  throw new Error('التوليد ما زال مستمراً. اضغط «متابعة المهمة» لاحقاً لفحص نفس الطلب.');
}
