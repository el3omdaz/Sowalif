// دورة الرد: يرسل المحادثة للنموذج، ينفذ أدوات البحث والرسم إن طلبها، ويبث كل شيء للواجهة
import { saveChat, getBlob, putBlob } from './db.js?v=5';
import { modelById, SEARCH_MODEL, IMAGE_MODEL } from './models.js?v=5';
import { runModel, ask, uploadFile, generateImage, saveRemote } from './kie.js?v=5';

const ASPECTS = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

function systemPrompt(model, search) {
  const today = new Date().toLocaleDateString('ar', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return [
    `أنت مساعد ذكي داخل تطبيق «المحادثة الذكية». النموذج الحالي: ${model.name}. تاريخ اليوم: ${today}.`,
    'رد بنفس لغة ولهجة المستخدم (غالباً عربي خليجي). اكتب بوضوح، واستخدم Markdown عند الحاجة (عناوين، قوائم، جداول، كود).',
    model.tools
      ? `${search ? 'استخدم web_search للمعلومات الحديثة والأسعار والأخبار، واذكر مصادر البحث كروابط. ' : 'البحث غير مفعّل. لا تدّعِ الاطلاع على أسعار أو أخبار حديثة؛ اطلب تفعيل البحث عند الحاجة. '}استخدم generate_image فقط عندما يطلب المستخدم صراحةً إنشاء صورة أو تعديلها. اكتب برومبت الصورة بالإنجليزي بتفصيل.`
      : '',
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
      const note = (m.images || []).length ? `\n\n[ولّدتُ ${m.images.length} صورة بالبرومبت: ${m.imagePrompt || ''}]` : '';
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

async function refsFor(chat, which) {
  const files = [];
  if (which === 'attached') for (const m of chat.messages) if (m.role === 'user') files.push(...(m.files || []).filter((f) => f.kind === 'image'));
  if (which === 'last_generated') {
    const last = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.images?.length);
    if (last) files.push(last.images[last.images.length - 1]);
  }
  return Promise.all(files.slice(-4).map(publicUrl));
}

async function drawImage(chat, reply, { prompt, aspect_ratio, reference }, emit, signal) {
  emit('status', { text: '🎨 يرسم الصورة…' });
  const refs = await refsFor(chat, reference || 'none');
  const aspect = ASPECTS.includes(aspect_ratio) ? aspect_ratio : 'auto';
  const { urls } = await generateImage({ prompt, aspect, refs, model: IMAGE_MODEL, signal });
  const saved = [];
  for (const url of urls) {
    const img = { kind: 'image', ...(await saveRemote(url)) };
    saved.push(img);
    emit('image', img);
  }
  reply.images = [...(reply.images || []), ...saved];
  reply.imagePrompt = prompt;
  return saved;
}

// ---------- الرد ----------
// opts: { model, search, deep, imageMode, aspect } · emit(event, data) يحدّث الواجهة
export async function respond(chat, opts, emit, signal) {
  const model = modelById(opts.model);
  chat.model = model.id;
  const reply = { role: 'assistant', model: model.id, text: '', at: Date.now(), credits: 0 };
  const userMsg = chat.messages[chat.messages.length - 1];

  try {
    // وضع الرسم المباشر: نص المستخدم هو البرومبت، والصور المرفقة معه مرجع
    if (opts.imageMode) {
      const attached = (userMsg.files || []).some((f) => f.kind === 'image');
      await drawImage(chat, reply, { prompt: userMsg.text, aspect_ratio: opts.aspect, reference: attached ? 'attached' : 'none' }, emit, signal);
      return reply;
    }

    let system = systemPrompt(model, opts.search);
    const messages = await history(chat, model);

    // نماذج بدون أدوات: نبحث قبل السؤال ونعطيها النتائج
    if (opts.search && model.search === 'pre' && userMsg.text?.trim()) {
      emit('status', { text: '🔎 يبحث في الإنترنت…' });
      const found = await webSearch(userMsg.text, signal);
      system += `\n\nنتائج بحث حديثة في الإنترنت عن سؤال المستخدم (استخدمها واذكر المصادر):\n${found}`;
    }

    const tools = model.tools ? TOOLS.filter((t) => opts.search || t.name !== 'web_search') : [];
    for (let step = 0; step < 6; step++) {
      emit('status', { text: step ? '✍️ يكمل الرد…' : '' });
      const out = await runModel(model.id, {
        system,
        messages,
        tools,
        search: opts.search && model.search === 'native',
        deep: !!opts.deep,
        signal,
        onState: (state) => emit('status', { text: state.phase === 'connecting' ? 'بانتظار بدء استجابة kie.ai…' : state.phase === 'retry' ? 'الخدمة رفضت الطلب مؤقتاً؛ أعيد المحاولة مرة واحدة…' : state.streaming ? 'اتصلت الخدمة؛ بانتظار النص…' : 'الخدمة ترسل الرد دفعة واحدة؛ بانتظار اكتماله…' }),
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
    if (!reply.text.trim() && !reply.images?.length) reply.text = '…';
    return reply;
  } catch (e) {
    if (signal?.aborted) {
      reply.stopped = true;
      if (!reply.text && !reply.images?.length) reply.text = '⏹️ تم الإيقاف';
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
export async function transcribe(blob, externalSignal) {
  const timeout = AbortSignal.timeout(120000);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  try {
    const t = blob.type;
    const ext = /mp4|m4a|aac/.test(t) ? 'm4a' : /ogg/.test(t) ? 'ogg' : /wav/.test(t) ? 'wav' : /mpeg|mp3/.test(t) ? 'mp3' : 'webm';
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
