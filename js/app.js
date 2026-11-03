// واجهة «المحادثة الذكية» — كل شيء يشتغل في المتصفح، والمحادثات محفوظة على هذا الجهاز
import * as db from './db.js?v=4';
import { MODELS, DEFAULT_MODEL, modelById } from './models.js?v=4';
import { respond, transcribe, makeAttachment } from './chat.js?v=4';
import { credits, CREDIT_USD } from './kie.js?v=4';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const S = {
  model: '',
  defaultModel: db.settings.get('defaultModel', DEFAULT_MODEL),
  chat: null,
  chats: [],
  attachments: [], // { id, name, kind, preview, meta, loading }
  search: db.settings.get('search', false),
  deep: false,
  imageMode: false,
  controller: null,
};
if (!MODELS.some((m) => m.id === S.defaultModel)) S.defaultModel = DEFAULT_MODEL;

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- البداية ----------
async function boot() {
  syncToggles();
  S.chats = await db.listChats();
  const id = location.hash.slice(1);
  if (id && S.chats.some((c) => c.id === id)) await openChat(id);
  else newChat();
  if (!db.settings.get('kieKey', '')) {
    openSettings();
    toast('أضف مفتاح kie.ai عشان تبدأ', 4000);
  }
}

const modelOf = (id) => modelById(id);

function renderModelName() {
  const m = modelOf(S.model);
  $('#modelName').textContent = m.name;
  $('#emptyModel').textContent = `${m.name} — ${m.tagline}`;
}

// ---------- قائمة المحادثات ----------
async function loadChats() {
  S.chats = await db.listChats();
  renderChatList();
}

function groupOf(t) {
  const today = new Date().setHours(0, 0, 0, 0);
  const d = (Date.now() - t) / 864e5;
  if (t >= today) return 'اليوم';
  if (t >= today - 864e5) return 'أمس';
  if (d < 7) return 'آخر ٧ أيام';
  if (d < 30) return 'آخر ٣٠ يوم';
  return 'أقدم';
}

function renderChatList() {
  const q = $('#search').value.trim().toLowerCase();
  const list = S.chats.filter((c) => !q || c.title.toLowerCase().includes(q));
  let html = '';
  let last = '';
  for (const c of list) {
    const g = c.pinned ? '📌 مثبّتة' : groupOf(c.updatedAt);
    if (g !== last) html += `<div class="group-title">${g}</div>`;
    last = g;
    html += `<div class="chat-item${c.id === S.chat?.id ? ' active' : ''}" data-id="${c.id}"><a href="#${c.id}">${esc(c.title)}</a><button class="icon-btn more" data-more="${c.id}" aria-label="خيارات">⋯</button></div>`;
  }
  $('#chatList').innerHTML = html || '<p class="muted" style="padding:8px">لا توجد محادثات بعد</p>';
}

$('#search').addEventListener('input', renderChatList);
$('#chatList').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) {
    e.preventDefault();
    return chatMenu(more.dataset.more, more);
  }
  const item = e.target.closest('.chat-item');
  if (item) {
    e.preventDefault();
    openChat(item.dataset.id);
  }
});

function chatMenu(id, anchor) {
  document.querySelector('.menu')?.remove();
  const c = S.chats.find((x) => x.id === id);
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = `<button data-a="rename">✏️ إعادة تسمية</button><button data-a="pin">${c.pinned ? '📌 إلغاء التثبيت' : '📌 تثبيت'}</button><button data-a="del" style="color:var(--danger)">🗑️ حذف</button>`;
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - 140)}px`;
  menu.style.left = `${Math.max(8, r.left)}px`;
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  menu.addEventListener('click', async (e) => {
    const a = e.target.dataset.a;
    const chat = await db.getChat(id);
    if (!chat) return;
    if (a === 'rename') {
      const title = prompt('اسم المحادثة', chat.title)?.trim();
      if (title) await db.saveChat(Object.assign(chat, { title: title.slice(0, 80) }), false);
    } else if (a === 'pin') await db.saveChat(Object.assign(chat, { pinned: !chat.pinned }), false);
    else if (a === 'del') {
      if (!confirm(`تحذف «${chat.title}»؟`)) return;
      await db.deleteChat(id);
      if (S.chat?.id === id) newChat();
    }
    if (S.chat?.id === id && a !== 'del') S.chat = await db.getChat(id);
    loadChats();
  });
}

const closeSide = () => $('#app').classList.remove('side-open');
$('#menuBtn').onclick = () => $('#app').classList.add('side-open');
$('#scrim').onclick = closeSide;

// ---------- المحادثة ----------
function newChat() {
  if (S.controller) return;
  S.chat = db.newChat(S.defaultModel);
  S.model = S.defaultModel;
  history.replaceState(null, '', location.pathname);
  renderModelName();
  renderMessages();
  renderChatList();
  closeSide();
  if (matchMedia('(min-width: 821px)').matches) $('#input').focus();
}
$('#newChat').onclick = newChat;
$('#newChatTop').onclick = newChat;

async function openChat(id) {
  if (S.controller) return toast('انتظر يخلص الرد');
  const chat = await db.getChat(id);
  if (!chat) return toast('المحادثة غير موجودة');
  S.chat = chat;
  S.model = chat.model || S.defaultModel;
  history.replaceState(null, '', `#${id}`);
  renderModelName();
  renderMessages();
  renderChatList();
  closeSide();
}

marked.setOptions({ gfm: true, breaks: true });
function md(text) {
  const div = document.createElement('div');
  div.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
  div.querySelectorAll('a').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener';
  });
  div.querySelectorAll('pre').forEach((pre) => {
    const b = document.createElement('button');
    b.className = 'copy';
    b.textContent = 'نسخ';
    pre.append(b);
  });
  // اتجاه تلقائي للفقرات الإنجليزية داخل الرد العربي
  div.querySelectorAll('p, li, h1, h2, h3, h4, td, th, blockquote').forEach((el) => el.setAttribute('dir', 'auto'));
  return div.innerHTML;
}

// الصور تُعرض من الجهاز (blob) أو من الرابط إن لم تُحفظ
const imgAttrs = (f) => (f.blob ? `data-blob="${f.blob}"` : f.preview ? `src="${f.preview}"` : `src="${esc(f.url || '')}"`);
const genFigure = (f) => `<figure><img ${imgAttrs(f)} alt="" data-zoom><a ${f.blob ? `data-blob-href="${f.blob}"` : `href="${esc(f.url)}"`} download="image.png">⬇️ حفظ</a></figure>`;

async function hydrate(root) {
  for (const el of root.querySelectorAll('[data-blob]')) {
    el.src = await db.blobUrl(el.dataset.blob);
    el.removeAttribute('data-blob');
  }
  for (const el of root.querySelectorAll('[data-blob-href]')) {
    el.href = await db.blobUrl(el.dataset.blobHref);
    el.removeAttribute('data-blob-href');
  }
}

function messageHTML(m, i) {
  if (m.role === 'user') {
    const files = (m.files || []).map((f) => (f.kind === 'image' ? `<img ${imgAttrs(f)} alt="" data-zoom>` : `<span class="doc-chip">📄 ${esc(f.name)}</span>`)).join('');
    return `<div class="msg user">${files ? `<div class="files">${files}</div>` : ''}${m.text ? `<div class="bubble" dir="auto">${esc(m.text)}</div>` : ''}</div>`;
  }
  const imgs = (m.images || []).map(genFigure).join('');
  const isLast = i === S.chat.messages.length - 1;
  return `<div class="msg assistant" data-i="${i}">
    ${imgs ? `<div class="gen">${imgs}</div>` : ''}
    ${m.text ? `<div class="bubble md">${md(m.text)}</div>` : ''}
    ${m.error ? `<div class="err-box">⚠️ ${esc(m.error)}</div>` : ''}
    <div class="meta"><span>${esc(modelOf(m.model).name)}${m.searches?.length ? ' · 🔎 بحث' : ''}</span>
      ${m.text ? '<button data-copy>📋 نسخ</button>' : ''}
      ${isLast ? '<button data-retry>🔄 أعد</button>' : ''}
    </div></div>`;
}

function renderMessages() {
  const box = $('#messages');
  const msgs = S.chat?.messages || [];
  $('#empty').classList.toggle('hidden', msgs.length > 0);
  box.querySelectorAll('.msg').forEach((n) => n.remove());
  box.insertAdjacentHTML('beforeend', msgs.map(messageHTML).join(''));
  hydrate(box);
  box.scrollTop = box.scrollHeight;
}

$('#messages').addEventListener('click', async (e) => {
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${zoom.src}" alt="">`;
    lb.onclick = () => lb.remove();
    return document.body.append(lb);
  }
  const copyCode = e.target.closest('pre .copy');
  if (copyCode) {
    await copy(copyCode.parentElement.querySelector('code')?.innerText || '');
    copyCode.textContent = '✓';
    return setTimeout(() => (copyCode.textContent = 'نسخ'), 1200);
  }
  const msgEl = e.target.closest('.msg.assistant');
  if (!msgEl || !msgEl.dataset.i) return;
  const m = S.chat.messages[Number(msgEl.dataset.i)];
  if (e.target.closest('[data-copy]')) {
    await copy(m.text);
    toast('تم النسخ');
  } else if (e.target.closest('[data-retry]')) retry();
});

$('#empty').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  input.value = c.dataset.p;
  if (c.dataset.img && !S.imageMode) $('#imgBtn').click();
  autosize();
  input.focus();
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
}

// ---------- اختيار النموذج ----------
function openModels() {
  const groups = {};
  for (const m of MODELS) (groups[m.maker] ||= []).push(m);
  $('#modelList').innerHTML = Object.entries(groups)
    .map(
      ([maker, list]) =>
        `<div class="maker">${maker}</div>` +
        list
          .map(
            (m) => `<button class="model${m.id === S.model ? ' active' : ''}" data-id="${m.id}">
      <div class="model-title">${esc(m.name)}${m.badge ? `<span class="badge">${m.badge}</span>` : ''}${m.id === S.defaultModel ? '<span class="badge soft">التلقائي</span>' : ''}${m.search === 'native' ? '<span class="badge soft">بحث Google</span>' : ''}</div>
      <div class="model-tag">${esc(m.tagline)}</div>
      <ul>${m.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></button>`,
          )
          .join(''),
    )
    .join('');
  $('#modelSheet').classList.remove('hidden');
}
$('#modelBtn').onclick = openModels;
$('#modelList').addEventListener('click', (e) => {
  const b = e.target.closest('.model');
  if (!b) return;
  S.model = b.dataset.id;
  renderModelName();
  $('#modelSheet').classList.add('hidden');
});
document.querySelectorAll('.sheet').forEach((s) =>
  s.addEventListener('click', (e) => {
    if (e.target === s || e.target.closest('[data-close]')) s.classList.add('hidden');
  }),
);

// ---------- الأزرار ----------
function syncToggles() {
  for (const [id, active] of [['searchBtn', S.search && !S.imageMode], ['deepBtn', S.deep && !S.imageMode], ['imgBtn', S.imageMode]]) {
    $(`#${id}`).setAttribute('aria-pressed', String(active));
  }
  $('#searchBtn').classList.toggle('on', S.search && !S.imageMode);
  $('#searchBtn').disabled = S.imageMode;
  $('#deepBtn').classList.toggle('on', S.deep && !S.imageMode);
  $('#deepBtn').disabled = S.imageMode;
  $('#imgBtn').classList.toggle('on', S.imageMode);
  $('#aspect').classList.toggle('hidden', !S.imageMode);
  input.placeholder = S.imageMode ? 'صف الصورة اللي تبيها… (أرفق صورة لتعديلها)' : 'اكتب رسالتك…';
}
$('#searchBtn').onclick = () => {
  S.search = !S.search;
  db.settings.set('search', S.search);
  syncToggles();
};
$('#deepBtn').onclick = () => {
  S.deep = !S.deep;
  syncToggles();
};
$('#imgBtn').onclick = () => {
  S.imageMode = !S.imageMode;
  syncToggles();
};

const input = $('#input');
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, innerHeight * 0.4)}px`;
  updateSend();
}
input.addEventListener('input', autosize);
const isTouch = matchMedia('(pointer: coarse)').matches;
input.addEventListener('keydown', (e) => {
  // على الكمبيوتر Enter يرسل و Shift+Enter سطر جديد، وعلى الجوال Enter سطر جديد
  if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

function updateSend() {
  const b = $('#sendBtn');
  if (S.controller) {
    b.disabled = false;
    b.classList.add('stop');
    b.setAttribute('aria-label', 'إيقاف الرد');
    b.textContent = '■';
    return;
  }
  b.classList.remove('stop');
  b.setAttribute('aria-label', 'إرسال');
  b.textContent = '↑';
  b.disabled = S.attachments.some((a) => a.loading) || (!input.value.trim() && !S.attachments.length);
}
$('#sendBtn').onclick = () => (S.controller ? S.controller.abort() : send());

// ---------- المرفقات ----------
// صور الآيفون كبيرة: نصغرها لـ 2048 بكسل قبل الحفظ والإرسال
async function shrinkImage(file) {
  if (file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return await new Promise((res) => c.toBlob((b) => res(b || file), type, 0.9));
  } catch {
    return file;
  }
}

async function addFiles(files) {
  for (const file of files) {
    if (file.size > 40 * 1024 * 1024) {
      toast(`«${file.name}» أكبر من 40MB`);
      continue;
    }
    const isImg = file.type.startsWith('image/');
    const a = { id: db.uid(), name: file.name || 'صورة', kind: isImg ? 'image' : 'doc', loading: true };
    S.attachments.push(a);
    renderAttachments();
    try {
      const blob = isImg ? await shrinkImage(file) : null;
      if (blob) a.preview = URL.createObjectURL(blob);
      renderAttachments();
      a.meta = await makeAttachment(file, blob);
      a.loading = false;
      if (a.meta.cut) toast(`«${a.name}» طويل — تم أخذ أول جزء منه`);
    } catch (e) {
      S.attachments = S.attachments.filter((x) => x !== a);
      toast(e.message, 4000);
    }
    renderAttachments();
  }
}

function renderAttachments() {
  $('#attachRow').innerHTML = S.attachments
    .map((a) => `<div class="att${a.loading ? ' loading' : ''}">${a.preview ? `<img src="${a.preview}" alt="">` : '📄'}<span>${esc(a.name)}</span><button data-rm="${a.id}" aria-label="إزالة">✕</button></div>`)
    .join('');
  updateSend();
}
$('#attachRow').addEventListener('click', (e) => {
  const id = e.target.dataset.rm;
  if (!id) return;
  const a = S.attachments.find((x) => x.id === id);
  if (a?.meta?.blob) db.deleteBlob(a.meta.blob);
  S.attachments = S.attachments.filter((x) => x.id !== id);
  renderAttachments();
});
$('#fileInput').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
// السحب والإفلات واللصق على الكمبيوتر
$('#attachBtn').onclick = () => $('#fileInput').click();
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

// ---------- الإرسال والبث ----------
function setStatus(text) {
  $('#status').textContent = text;
  $('#status').classList.toggle('hidden', !text);
}

async function run(opts) {
  const ctrl = new AbortController();
  S.controller = ctrl;
  updateSend();
  const chat = S.chat;
  renderMessages();
  const box = $('#messages');
  box.insertAdjacentHTML('beforeend', '<div class="msg assistant live"><div class="thinking hidden"></div><div class="gen hidden"></div><div class="bubble md cursor"><span class="dots"><span></span><span></span><span></span></span></div></div>');
  const el = box.lastElementChild;
  const bubble = el.querySelector('.bubble');
  const gen = el.querySelector('.gen');
  const think = el.querySelector('.thinking');
  box.scrollTop = box.scrollHeight;
  let text = '';
  let frame = 0;
  const paint = () => {
    frame = 0;
    if (!el.isConnected) return;
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    bubble.innerHTML = md(text);
    if (stick) box.scrollTop = box.scrollHeight;
  };
  const emit = (ev, d) => {
    if (S.chat !== chat) return;
    if (ev === 'delta') {
      text += d.text;
      setStatus('');
      frame ||= requestAnimationFrame(paint);
    } else if (ev === 'thinking') {
      think.classList.remove('hidden');
      think.textContent = (think.textContent + d.text).slice(-600);
    } else if (ev === 'status') setStatus(d.text);
    else if (ev === 'image') {
      gen.classList.remove('hidden');
      gen.insertAdjacentHTML('beforeend', genFigure(d));
      hydrate(gen);
      box.scrollTop = box.scrollHeight;
    }
  };
  try {
    await respond(chat, { model: S.model, search: S.search, deep: S.deep, aspect: $('#aspect').value, ...opts }, emit, ctrl.signal);
  } finally {
    if (frame) cancelAnimationFrame(frame);
    S.controller = null;
    setStatus('');
    if (S.chat === chat) renderMessages();
    updateSend();
    loadChats();
  }
}

async function send() {
  if (S.controller) return;
  if (rec || mic.classList.contains('busy')) return toast('أوقف الإملاء وانتظر اكتمال النص أولاً');
  const text = input.value.trim();
  if ((!text && !S.attachments.length) || S.attachments.some((a) => a.loading)) return;
  if (S.imageMode && !text) return toast('اكتب وصف الصورة');
  if (!db.settings.get('kieKey', '')) {
    openSettings();
    return toast('أضف مفتاح kie.ai أول');
  }
  const files = S.attachments.map((a) => a.meta);
  S.chat.messages.push({ role: 'user', text, files, at: Date.now() });
  history.replaceState(null, '', `#${S.chat.id}`);
  input.value = '';
  S.attachments = [];
  renderAttachments();
  autosize();
  const imageMode = S.imageMode;
  if (imageMode) {
    S.imageMode = false;
    syncToggles();
  }
  await run({ imageMode });
}

async function retry() {
  if (S.controller) return;
  while (S.chat.messages.at(-1)?.role === 'assistant') S.chat.messages.pop();
  if (!S.chat.messages.length) return;
  await run({ imageMode: false });
}

// ---------- المايكروفون: تسجيل ثم تحويله لنص ----------
let rec = null;
const mic = $('#micBtn');
const micIcon = mic.innerHTML;
let micStarting = false;

function resetMic() {
  mic.classList.remove('rec', 'busy');
  mic.innerHTML = micIcon;
  mic.setAttribute('aria-label', 'إملاء صوتي');
  input.readOnly = false;
  setStatus('');
  autosize();
}

// يظهر النص أثناء الكلام، بدون انتظار رفع التسجيل وطلب نموذج.
function startDictation() {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) return startRec();
  const speech = new Speech();
  speech.lang = 'ar-SA';
  speech.continuous = true;
  speech.interimResults = true;
  const base = input.value;
  let finalText = '';
  let failure = '';
  let heard = false;
  rec = { speech, started: Date.now() };
  const state = rec;
  rec.timer = setInterval(tick, 500);
  rec.limit = setTimeout(stopRec, 5 * 60 * 1000);
  input.readOnly = true;
  mic.classList.add('rec');
  mic.setAttribute('aria-label', 'إيقاف الإملاء');
  setStatus('أتسمعك… النص يظهر وأنت تتكلم');
  tick();
  speech.onresult = (e) => {
    let interim = '';
    finalText = '';
    for (const result of e.results) {
      if (result.isFinal) finalText += result[0].transcript + ' ';
      else interim += result[0].transcript;
    }
    const text = (finalText + interim).trim();
    heard ||= !!text;
    input.value = base + (base && !/\s$/.test(base) && text ? ' ' : '') + text;
    autosize();
  };
  speech.onerror = (e) => { failure = e.error; };
  speech.onend = () => {
    if (rec !== state) return;
    clearInterval(state.timer);
    clearTimeout(state.limit);
    clearTimeout(state.endTimer);
    rec = null;
    resetMic();
    if (failure === 'not-allowed' || failure === 'service-not-allowed') toast('اسمح بالإملاء والمايكروفون من إعدادات المتصفح، أو اختر «تسجيل ثم تحويل» من الإعدادات.', 6000);
    else if (failure && failure !== 'aborted') toast(heard ? 'توقف الإملاء؛ النص الذي وصل موجود في مربع الكتابة.' : 'تعذّر الإملاء المباشر. اختر «تسجيل ثم تحويل» من الإعدادات وجرب مجدداً.', 5000);
    else if (!heard) toast('ما سمعت كلام واضح — جرب مرة ثانية');
  };
  try { speech.start(); } catch {
    clearInterval(state.timer);
    clearTimeout(state.limit);
    rec = null;
    resetMic();
    return startRec();
  }
}

function pickMime() {
  for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  return '';
}

async function startRec() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('المتصفح ما يدعم التسجيل');
  if (!db.settings.get('kieKey', '')) return toast('أضف مفتاح kie.ai أول');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return toast('اسمح للتطبيق باستخدام المايكروفون من إعدادات المتصفح', 4000);
  }
  const mime = pickMime();
  let mr;
  try { mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 64000 }); }
  catch {
    stream.getTracks().forEach((t) => t.stop());
    return toast('تعذّر بدء التسجيل في هذا المتصفح');
  }
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec = { mr, stream, started: Date.now(), timer: setInterval(tick, 500) };
  mr.onstop = () => finishRec(new Blob(chunks, { type: (mr.mimeType || mime || 'audio/webm').split(';')[0] }));
  try { mr.start(250); } catch {
    clearInterval(rec.timer);
    rec = null;
    stream.getTracks().forEach((t) => t.stop());
    resetMic();
    return toast('تعذّر بدء التسجيل في هذا المتصفح');
  }
  mr.onerror = () => {
    if (!rec || rec.mr !== mr) return;
    clearInterval(rec.timer);
    clearTimeout(rec.limit);
    rec = null;
    mr.onstop = null;
    stream.getTracks().forEach((t) => t.stop());
    resetMic();
    toast('توقف تسجيل الصوت. جرب مرة ثانية.');
  };
  setStatus('أسجّل صوتك… اضغط المايك لإيقاف التسجيل');
  mic.classList.add('rec');
  tick();
  // حد أقصى 5 دقائق
  rec.limit = setTimeout(stopRec, 5 * 60 * 1000);
}

function tick() {
  if (!rec) return;
  const s = Math.floor((Date.now() - rec.started) / 1000);
  mic.textContent = `■ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function stopRec() {
  if (!rec) return;
  clearInterval(rec.timer);
  clearTimeout(rec.limit);
  if (rec.speech) {
    const state = rec;
    state.speech.stop();
    mic.classList.remove('rec');
    mic.classList.add('busy');
    mic.textContent = '…';
    state.endTimer = setTimeout(() => { state.speech.abort(); state.speech.onend(); }, 5000);
    return;
  }
  if (rec.mr.state === 'inactive') return;
  rec.mr.stop();
  rec.stream.getTracks().forEach((t) => t.stop());
}

async function finishRec(blob) {
  const dur = Date.now() - rec.started;
  rec = null;
  mic.classList.remove('rec');
  mic.textContent = '⏳';
  mic.classList.add('busy');
  setStatus('أحوّل التسجيل إلى نص…');
  try {
    if (dur < 700 || blob.size < 1500) throw new Error('التسجيل قصير — اضغط وتكلم ثم اضغط مرة ثانية للإيقاف');
    const text = await transcribe(blob);
    if (!text) throw new Error('ما سمعت كلام واضح — جرب مرة ثانية');
    const v = input.value;
    input.value = v && !/\s$/.test(v) ? `${v} ${text}` : v + text;
    autosize();
    input.focus();
  } catch (e) {
    toast(e.message, 3500);
  } finally {
    resetMic();
  }
}

mic.onclick = async () => {
  if (mic.classList.contains('busy') || micStarting || S.controller) return;
  if (rec) stopRec();
  else {
    micStarting = true;
    try {
      if (db.settings.get('speechMode', 'live') === 'record') await startRec();
      else await startDictation();
    } finally { micStarting = false; }
  }
};

// ---------- الإعدادات ----------
const mask = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '');

function openSettings() {
  closeSide();
  $('#settingsSheet').classList.remove('hidden');
  const k = db.settings.get('kieKey', '');
  $('#keyNow').textContent = k ? `المفتاح الحالي: ${mask(k)}` : 'لا يوجد مفتاح';
  $('#speechMode').value = db.settings.get('speechMode', 'live');
  $('#defaultModel').innerHTML = MODELS.map((m) => `<option value="${m.id}"${m.id === S.defaultModel ? ' selected' : ''}>${esc(m.name)}${m.badge ? ` — ${m.badge}` : ''}</option>`).join('');
}
$('#openSettings').onclick = openSettings;
$('#speechMode').onchange = (e) => db.settings.set('speechMode', e.target.value);

$('#saveKey').onclick = () => {
  const k = $('#keyInput').value.trim();
  if (!k) return;
  db.settings.set('kieKey', k);
  $('#keyInput').value = '';
  openSettings();
  $('#checkKey').click();
};
$('#checkKey').onclick = async () => {
  $('#keyMsg').textContent = '…';
  try {
    const c = await credits();
    $('#keyMsg').textContent = `✓ المفتاح شغال — الرصيد ${Math.round(c).toLocaleString('en')} نقطة (≈ $${(c * CREDIT_USD).toFixed(2)})`;
  } catch (e) {
    $('#keyMsg').textContent = `⚠️ ${e.message}`;
  }
};
$('#defaultModel').onchange = (e) => {
  S.defaultModel = e.target.value;
  db.settings.set('defaultModel', S.defaultModel);
  if (!S.chat?.messages.length) {
    S.model = S.defaultModel;
    renderModelName();
  }
  toast('تم تغيير النموذج التلقائي');
};

$('#exportBtn').onclick = async () => {
  $('#backupMsg').textContent = '…';
  try {
    const blob = await db.exportAll();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `محادثات-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    $('#backupMsg').textContent = `✓ جهّزت النسخة (${(blob.size / 1048576).toFixed(1)}MB)`;
  } catch (e) {
    $('#backupMsg').textContent = `⚠️ ${e.message}`;
  }
};
$('#importInput').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  $('#backupMsg').textContent = '…';
  try {
    const n = await db.importAll(f);
    $('#backupMsg').textContent = `✓ تمت إضافة ${n} محادثة`;
    loadChats();
  } catch (err) {
    $('#backupMsg').textContent = `⚠️ ${err.message}`;
  }
};
$('#forgetKey').onclick = () => {
  if (!confirm('تمسح المفتاح من هذا الجهاز؟ المحادثات تبقى.')) return;
  db.settings.set('kieKey', '');
  openSettings();
};

// ---------- التطبيق على الآيفون ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== S.chat?.id) openChat(id);
});

boot().catch((e) => toast(`خطأ: ${e.message}`, 6000));
