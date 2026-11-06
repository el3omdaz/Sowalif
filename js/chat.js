// دورة الرد: يرسل المحادثة للنموذج، ينفذ أدوات البحث والرسم إن طلبها، ويبث كل شيء للواجهة
import { saveChat, getBlob, putBlob, settings } from './db.js?v=15';
import { modelById, SEARCH_MODEL, OR_AUDIO_MODEL } from './models.js?v=15';
import { runModel, ask, uploadFile, saveRemote, createKieMediaTask, readKieMediaTask } from './kie.js?v=15';
import { preparePersonalContext } from './memory.js?v=15';
import { mediaIntent, mediaSpec, createMedia, waitMedia } from './piapi.js?v=15';
import { mediaProvider, kieMediaSpec } from './media.js?v=15';
import { withMediaCallback } from './media-push.js?v=15';
import { PROJECT_PROMPT, extractProjectProposal } from './project.js?v=15';

const ASPECTS = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

function systemPrompt(model, search) {
  const today = new Date().toLocaleDateString('ar', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return [
    `أنت مساعد ذكي داخل تطبيق «المحادثة الذكية». النموذج الحالي: ${model.name}. تاريخ اليوم: ${today}.`,
    'رد بنفس لغة ولهجة المستخدم (غالباً عربي خليجي). اكتب بوضوح، واستخدم Markdown عند الحاجة (عناوين، قوائم، جداول، كود).',
    model.tools
      ? `${search ? 'استخدم web_search للمعلومات الحديثة والأسعار والأخبار، واذكر مصادر البحث كروابط. ' : 'البحث غير مفعّل. لا تدّعِ الاطلاع على أسعار أو أخبار حديثة؛ اطلب تفعيل البحث عند الحاجة. '}استخدم generate_image فقط عندما يطلب المستخدم صراحةً إنشاء صورة أو تعديلها. اكتب برومبت الصورة بالإنجليزي بتفصيل.`
      : model.provider === 'openrouter' ? (search ? 'البحث متاح عبر أداة OpenRouter. استخدمه للأخبار والأسعار والمعلومات الحديثة، وأدرج روابط المصادر.' : 'البحث غير مفعّل. لا تدّعِ الاطلاع على أسعار أو أخبار حديثة؛ اطلب تفعيل البحث عند الحاجة.') : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the internet (Google) for up-to-date information. Returns a summary with source links.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query, in the best language for results' } }, required: ['query'] },
  },
  {
    name: 'generate_image',
    description: "Generate or edit an image. Use reference images to edit/transform the user's attached photos or the last generated image.",
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed English prompt. For edits, describe the change.' },
        aspect_ratio: { type: 'string', enum: ASPECTS },
        reference: { type: 'string', enum: ['none', 'attached', 'last_generated'], description: 'attached = the images the user attached in this conversation; last_generated = the latest image you generated' },
      },
      required: ['prompt'],
    },
  },
];

// ---------- الملفات ----------
const toDataUrl = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

// روابط kie.ai تنتهي بعد أيام، فنعيد الرفع إن كان الرابط قديماً
const URL_TTL = 2 * 24 * 3600 * 1000;
async function publicUrl(f) {
  if (f.url && (Date.now() - (f.urlAt || 0) < URL_TTL || !f.blob)) return f.url;
  const blob = await getBlob(f.blob);
  if (!blob) throw new Error('الصورة غير موجودة على هذا الجهاز');
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  f.url = await uploadFile(blob, `${f.blob}.${ext}`);
  f.urlAt = Date.now();
  return f.url;
}

async function imagePart(f, needUrl) {
  if (needUrl || !f.blob) return { kind: 'image', url: await publicUrl(f) };
  const blob = await getBlob(f.blob);
  return blob ? { kind: 'image', dataUrl: await toDataUrl(blob) } : null;
}

// الرسائل كما يفهمها kie.js: الصور كـ data URL أو رابط عام (Gemini يحتاج روابط)
async function history(chat, model) {
  const needUrl = model.api === 'chat';
  const out = [];
  for (const m of chat.messages) {
    if (m.role === 'user') {
      const files = [];
      for (const f of m.files || []) {
        if (f.kind === 'doc') files.push({ kind: 'doc', name: f.name, text: f.text });
        else if (f.kind === 'image') {
          const p = await imagePart(f, needUrl).catch(() => null);
          if (p) files.push(p);
        }
      }
      out.push({ role: 'user', text: m.text, files });
    } else if (m.role === 'assistant' && !m.error) {
      const note = ((m.images || []).length ? `\n\n[ولّدتُ ${m.images.length} صورة بالبرومبت: ${m.imagePrompt || ''}]` : '') + (m.videos?.length ? `\n\n[أنشأت فيديو: ${m.mediaTask?.prompt || ''}]` : '');
      out.push({ role: 'assistant', text: `${m.text || ''}${note}` });
    }
  }
  return out;
}

async function webSearch(query, signal) {
  const { text } = await ask(
    SEARCH_MODEL,
    'You are a research assistant. Search Google and answer with the key facts, numbers and dates, then list the source URLs. Be concise and factual. Answer in the language of the query.',
    { role: 'user', text: query },
    { search: true, signal },
  );
  return text || 'لا توجد نتائج';
}

async function drawImage(chat, reply, { prompt, aspect_ratio, reference }, emit, signal) {
  return drawMedia(chat, reply, { kind: 'image', prompt, aspect: aspect_ratio, useLast: reference === 'last_generated' || undefined }, emit, signal);
}

async function drawMedia(chat, reply, { kind, prompt, aspect, useLast, resume, referenceUrl, videoReference, once }, emit, signal) {
  if (!resume) {
    const provider = mediaProvider();
    if (!settings.get(provider === 'kie' ? 'kieKey' : 'piapiKey', '')) throw new Error(`أضف مفتاح ${provider === 'kie' ? 'kie.ai' : 'PiAPI'} للصور والفيديو من الإعدادات`);
    const current = chat.messages.at(-1);
    let file = current?.files?.filter(f => f.kind === 'image').at(-1);
    if (!file && !referenceUrl && !videoReference && (useLast ?? /(?:هذي|هذه|الصورة|صورتك|حرك|حرّك|animate|this image)/i.test(prompt))) {
      for (const message of [...chat.messages].reverse()) {
        if (chat.mode === 'video' && message.videos?.at(-1)?.url) {
          videoReference = message.videos.at(-1).url;
          break;
        }
        if (chat.mode === 'video' && message.videoReferenceUrl) {
          videoReference = message.videoReferenceUrl;
          break;
        }
        file = [...(message.files || []), ...(message.images || [])].filter(f => f.kind === 'image').at(-1);
        if (file) break;
        if (message.mediaReferenceUrl) {
          referenceUrl = message.mediaReferenceUrl;
          break;
        }
      }
    }
    if (videoReference && provider === 'kie') throw new Error('لتعديل الفيديو اختر PiAPI في إعدادات الوسائط. لإنشاء فيديو جديد ألغِ استخدام آخر مرجع.');
    let reference = referenceUrl;
    if (!reference && file) {
      reference = file.url && (!file.blob || Date.now() - (file.urlAt || 0) < URL_TTL) ? file.url : null;
      if (!reference && file.blob) {
        const blob = await getBlob(file.blob);
        if (!blob) throw new Error('الصورة غير موجودة على هذا الجهاز؛ أرفقها مرة ثانية');
        const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1] || 'png';
        reference = provider === 'kie' ? await uploadFile(blob, `reference.${ext}`, signal) : await toDataUrl(blob);
      }
    }
    const spec = (provider === 'kie' ? kieMediaSpec : mediaSpec)(kind, prompt, { aspect, reference, videoReference });
    emit('status', { text: `ينشئ المهمة عبر ${provider === 'kie' ? 'kie.ai' : 'PiAPI'} · ${spec.name}…` });
    reply.mediaTask = { provider, kind, name: spec.name, prompt, submitting: true };
    const submission = await withMediaCallback(spec, chat, reply, signal);
    signal?.throwIfAborted();
    // Persist submission state, including uncertain network outcomes, before the paid POST.
    await saveChat({ ...chat, messages: [...chat.messages, reply] });
    reply.mediaTask.id = await (provider === 'kie' ? createKieMediaTask : createMedia)(submission, signal);
    reply.mediaTask.submitting = false;
    await saveChat({ ...chat, messages: [...chat.messages, reply] });
  }
  const task = reply.mediaTask;
  const url = await waitMedia(task, { signal, once, ...(task.provider === 'kie' ? { readTask: readKieMediaTask } : {}), onStatus: text => emit('status', { text }) });
  if (!url) return [];
  const media = { kind: task.kind, url, model: task.name };
  // Images are small enough to keep offline; videos retain the provider download URL.
  if (task.kind === 'image') Object.assign(media, await saveRemote(url));
  if (task.kind === 'video') reply.videos = [media];
  else { reply.images = [media]; reply.imagePrompt = task.prompt; }
  task.done = true;
  reply.text = `تم الإنشاء باستخدام ${task.name}.`;
  emit(task.kind, media);
  return [media];
}

export async function resumeMedia(chat, reply, emit, signal, { once = false } = {}) {
  try {
    await drawMedia(chat, reply, { resume: true, once }, emit, signal);
  } catch (e) {
    if (once) return;
    reply.stopped = !!signal?.aborted;
    reply.error = signal?.aborted ? 'توقف الانتظار؛ المهمة قد تستمر لدى المزوّد. تابعها لاحقاً بنفس الرقم.' : e.message;
    await saveChat(chat);
    return;
  }
  if (reply.mediaTask.done) {
    delete reply.error;
    delete reply.stopped;
    try {
      await saveChat(chat);
    } catch (error) {
      delete reply.mediaTask.done;
      throw error;
    }
  }
}

// ---------- الرد ----------
// opts: { model, search, deep, imageMode, aspect } · emit(event, data) يحدّث الواجهة
export async function respond(chat, opts, emit, signal) {
  const model = modelById(opts.model);
  chat.model = model.id;
  const reply = { role: 'assistant', model: model.id, text: '', at: Date.now(), credits: 0 };
  const userMsg = chat.messages[chat.messages.length - 1];

  try {
    const work = chat.mode === 'work';
    const workspaceKind = ['image', 'video'].includes(chat.mode) ? chat.mode : null;
    const personal = workspaceKind || work ? { expanded: userMsg.text || '' } : await preparePersonalContext(chat, userMsg.text || '');
    reply.contextSources = personal.sources;
    if (personal.action) reply.memoryAction = personal.action.text;
    if (personal.recallUnavailable) reply.recallUnavailable = true;
    const search = !!opts.search || personal.search;
    // وضع الرسم المباشر: نص المستخدم هو البرومبت، والصور المرفقة معه مرجع
    const kind = workspaceKind || (!work && (opts.videoMode ? 'video' : opts.imageMode ? 'image' : mediaIntent(personal.expanded)));
    if (kind) {
      await drawMedia(chat, reply, {
        kind, prompt: personal.expanded, aspect: opts.aspect, referenceUrl: userMsg.mediaReferenceUrl,
        videoReference: userMsg.videoReferenceUrl, useLast: workspaceKind ? userMsg.reuseMedia !== false : undefined,
      }, emit, signal);
      return reply;
    }

    let system = [systemPrompt(model, search), work && PROJECT_PROMPT, personal.prompt].filter(Boolean).join('\n\n');
    const messages = await history(chat, model);
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      lastUser.text = personal.expanded;
      if (work) lastUser.text += '\n\nCurrent project files (JSON snapshot):\n' + JSON.stringify(chat.project?.files || []);
    }

    // نماذج بدون أدوات: نبحث قبل السؤال ونعطيها النتائج
    if (search && model.search === 'pre' && userMsg.text?.trim()) {
      emit('status', { text: '🔎 يبحث في الإنترنت…' });
      const found = await webSearch(personal.expanded, signal);
      system += `\n\nنتائج بحث حديثة في الإنترنت عن سؤال المستخدم (استخدمها واذكر المصادر):\n${found}`;
    }

    const tools = model.tools ? TOOLS.filter(t => t.name === 'web_search' ? search : !work) : [];
    for (let step = 0; step < 6; step++) {
      emit('status', { text: step ? '✍️ يكمل الرد…' : '' });
      const out = await runModel(model.id, {
        system,
        messages,
        tools,
        search: search && (model.search === 'native' || model.search === 'openrouter'),
        deep: !!opts.deep,
        ...(work ? { maxOutputTokens: 12000 } : {}),
        signal,
        onState: (state) => emit('status', { text: state.phase === 'connecting' ? `بانتظار بدء استجابة ${model.provider === 'openrouter' ? 'OpenRouter' : 'kie.ai'}…` : state.phase === 'retry' ? 'الخدمة رفضت الطلب مؤقتاً؛ أعيد المحاولة مرة واحدة…' : state.streaming ? 'اتصلت الخدمة؛ بانتظار النص…' : 'الخدمة ترسل الرد دفعة واحدة؛ بانتظار اكتماله…' }),
        onDelta: (t) => {
          reply.text += t;
          emit('delta', { text: t });
        },
        onThinking: (t) => emit('thinking', { text: t }),
      });
      reply.credits += out.credits || 0;
      reply.connection = out.connection;
      const calls = out.calls.filter((c) => tools.some((t) => t.name === c.name));
      if (!calls.length) break;

      messages.push({ role: 'assistant', text: out.text, calls });
      for (const c of calls) {
        let output;
        try {
          if (c.name === 'web_search') {
            emit('status', { text: `🔎 يبحث: ${String(c.args.query || '').slice(0, 60)}` });
            output = await webSearch(String(c.args.query || userMsg.text), signal);
            reply.searches = [...(reply.searches || []), String(c.args.query || '')];
          } else {
            const saved = await drawImage(chat, reply, c.args, emit, signal);
            output = `Done: ${saved.length} image(s) generated and already shown to the user. Do not include links; just briefly describe what you made in the user's language.`;
          }
        } catch (e) {
          if (signal?.aborted) throw e;
          output = `Error: ${e.message}`;
        }
        messages.push({ role: 'tool', id: c.id, name: c.name, output });
      }
      if (reply.text && !reply.text.endsWith('\n')) {
        reply.text += '\n\n';
        emit('delta', { text: '\n\n' });
      }
    }
    if (work) {
      const proposed = extractProjectProposal(reply.text, chat.project);
      if (proposed) {
        reply.text = proposed.text;
        reply.projectProposal = proposed.proposal;
      }
    }
    if (!reply.text.trim() && !reply.images?.length) reply.text = '…';
    return reply;
  } catch (e) {
    if (signal?.aborted) {
      reply.stopped = true;
      if (!reply.text && !reply.images?.length) reply.text = reply.mediaTask ? 'توقف الانتظار؛ مهمة التوليد قد تستمر. تابع نفس المهمة من الزر أدناه.' : '⏹️ تم الإيقاف';
    } else {
      reply.error = e.message;
      reply.connection = e.connection;
    }
    return reply;
  } finally {
    chat.messages.push(reply);
    if (chat.title === 'محادثة جديدة') chat.title = (userMsg.text || 'صورة').replace(/\s+/g, ' ').trim().slice(0, 50) || 'محادثة';
    await saveChat(chat);
  }
}

// المسار الاحتياطي: رفع التسجيل وتحويله إلى نص عبر Gemini Flash
export async function transcribe(blob, externalSignal, provider = settings.get('provider', 'kie')) {
  const timeout = AbortSignal.timeout(120000);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  try {
    const t = blob.type;
    const ext = /mp4|m4a|aac/.test(t) ? 'm4a' : /ogg/.test(t) ? 'ogg' : /wav/.test(t) ? 'wav' : /mpeg|mp3/.test(t) ? 'mp3' : 'webm';
    if (provider === 'openrouter') {
      const dataUrl = await toDataUrl(blob);
      if (signal.aborted) throw new DOMException('أُلغي التحويل', 'AbortError');
      const { text } = await ask(OR_AUDIO_MODEL,
        'Transcribe the audio exactly as spoken, in the original language and dialect (often Gulf Arabic). Output ONLY the transcript, nothing else. If there is no speech, output nothing.',
        { role: 'user', text: 'Transcribe this audio.', files: [{ kind: 'audio', data: dataUrl.slice(dataUrl.indexOf(',') + 1), format: ext }] }, { signal });
      return (text || '').trim();
    }
    const url = await uploadFile(blob, `voice-${Date.now()}.${ext}`, signal);
    const { text } = await ask(
      SEARCH_MODEL,
      'You are a precise speech-to-text transcriber. Transcribe the audio exactly as spoken, in the original language and dialect (often Gulf Arabic, sometimes mixed with English). Add natural punctuation. Output ONLY the transcript, nothing else. If there is no speech, output nothing.',
      { role: 'user', text: 'Transcribe this audio.', files: [{ kind: 'audio', url }] },
      { signal },
    );
    return (text || '').trim();
  } catch (e) {
    if (externalSignal?.aborted) throw new DOMException('أُلغي التحويل', 'AbortError');
    if (timeout.aborted) throw new Error('تحويل التسجيل أخذ وقتاً طويلاً. يمكنك إعادة التحويل أو تجربة إملاء المتصفح من الإعدادات.');
    throw e;
  }
}

// ---------- المرفقات ----------
const TEXT_EXT = /\.(txt|md|csv|json|js|ts|py|html|css|xml|ya?ml|srt|log|sql|java|c|cpp|cs|php|rb|go|rs|sh|bat|ini)$/i;
const MAX_DOC_CHARS = 400000;

async function pdfText(file) {
  const pdfjs = await import('../vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    pages.push(c.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join(''));
  }
  return pages.join('\n\n');
}

async function docxText(file) {
  if (!window.mammoth) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/mammoth.js';
      s.onload = res;
      s.onerror = () => rej(new Error('تعذّر تحميل قارئ Word'));
      document.head.append(s);
    });
  }
  return (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
}

// صورة (Blob مصغّر) أو مستند ← وصف المرفق المحفوظ في الرسالة
export async function makeAttachment(file, imageBlob) {
  if (imageBlob) return { kind: 'image', blob: await putBlob(imageBlob), name: file.name || 'صورة' };
  const name = file.name || 'ملف';
  let text;
  if (/\.pdf$/i.test(name) || file.type === 'application/pdf') text = await pdfText(file);
  else if (/\.docx$/i.test(name)) text = await docxText(file);
  else if (TEXT_EXT.test(name) || file.type.startsWith('text/')) text = await file.text();
  else throw new Error(`نوع الملف «${name}» غير مدعوم — الصور وPDF وWord والملفات النصية فقط`);
  text = text.replace(/\u0000/g, '').trim();
  if (!text) throw new Error(`ما قدرت أقرأ نص من «${name}» (ممكن يكون PDF مصوّر — أرسله كصور)`);
  const cut = text.length > MAX_DOC_CHARS;
  if (cut) text = `${text.slice(0, MAX_DOC_CHARS)}\n\n[… الملف طويل وتم قص الباقي]`;
  return { kind: 'doc', name, text, cut };
}
