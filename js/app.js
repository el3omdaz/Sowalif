// واجهة «المحادثة الذكية» — كل شيء يشتغل في المتصفح، والمحادثات محفوظة على هذا الجهاز
import * as db from './db.js?v=8';
import { MODELS, DEFAULT_MODEL, modelById, OR_DEFAULT_MODEL, OR_AUDIO_MODEL, modelsFor, providerOf } from './models.js?v=8';
import { checkOpenRouterKey, refreshOpenRouterModels } from './openrouter.js?v=8';
import { respond, resumeMedia, transcribe, makeAttachment } from './chat.js?v=8';
import { mediaIntent } from './piapi.js?v=8';
import { mediaProvider } from './media.js?v=8';
import { credits, CREDIT_USD, diagnoseModels } from './kie.js?v=8';
import { readPersonalization, savePersonalization, saveRule, removeRule, clearSavedMemory } from './memory.js?v=8';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const initialProvider = db.settings.get('provider', 'kie') === 'openrouter' ? 'openrouter' : 'kie';
const keySetting = (provider) => provider === 'openrouter' ? 'openRouterKey' : 'kieKey';
const defaultFor = (provider) => {
  const fallback = provider === 'openrouter' ? OR_DEFAULT_MODEL : DEFAULT_MODEL;
  const saved = db.settings.get(provider === 'openrouter' ? 'orDefaultModel' : 'defaultModel', fallback);
  return providerOf(saved) === provider && MODELS.some((m) => m.id === saved) ? saved : fallback;
};
const S = {
  provider: initialProvider,
  model: '',
  defaultModel: defaultFor(initialProvider),
  chat: null,
  chats: [],
  attachments: [], // { id, name, kind, preview, meta, loading }
  search: db.settings.get('search', false),
  deep: false,
  imageMode: false,
  videoMode: false,
  controller: null,
};

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- البداية ----------
async function boot() {
  applyTypography();
  syncToggles();
  S.chats = await db.listChats();
  const id = location.hash.slice(1);
  if (id && S.chats.some((c) => c.id === id)) await openChat(id);
  else newChat();
  if (!db.settings.get(keySetting(S.provider), '')) {
    openSettings();
    toast(`أضف مفتاح ${S.provider === 'openrouter' ? 'OpenRouter' : 'kie.ai'} عشان تبدأ`, 4000);
  }
}

const modelOf = (id) => modelById(id);

function renderModelName() {
  const m = modelOf(S.model);
  $('#modelName').textContent = m.name;
  $('#providerBadge').textContent = m.provider === 'openrouter' ? 'OpenRouter' : 'kie.ai';
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
  if (rec || voiceJob || micStarting) return toast('اعتمد التسجيل أو ألغِه قبل فتح محادثة جديدة');
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
  if (rec || voiceJob || micStarting) return toast('اعتمد التسجيل أو ألغِه قبل تغيير المحادثة');
  const chat = await db.getChat(id);
  if (!chat) return toast('المحادثة غير موجودة');
  S.chat = chat;
  S.model = chat.model || S.defaultModel;
  S.provider = providerOf(S.model);
  S.defaultModel = defaultFor(S.provider);
  db.settings.set('provider', S.provider);
  S.imageMode = false;
  S.videoMode = false;
  syncToggles();
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
const videoFigure = (f) => `<figure><video ${imgAttrs(f)} controls playsinline preload="metadata" aria-label="الفيديو المُنشأ"></video><a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" download="video.mp4">فتح وحفظ الفيديو ↗</a></figure>`;

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
  const imgs = (m.images || []).map(genFigure).join('') + (m.videos || []).map(videoFigure).join('');
  const isLast = i === S.chat.messages.length - 1;
  return `<div class="msg assistant" data-i="${i}">
    ${imgs ? `<div class="gen">${imgs}</div>` : ''}
    ${m.text ? `<div class="bubble md">${md(m.text)}</div>` : ''}
    ${m.error ? `<div class="err-box">⚠️ ${esc(m.error)}</div>` : ''}
    ${m.memoryAction ? `<div class="memory-notice">✓ ${esc(m.memoryAction)}</div>` : ''}
    ${m.recallUnavailable ? '<div class="memory-notice">تعذّر استرجاع المحادثات السابقة في هذا الرد.</div>' : ''}
    ${m.contextSources?.length ? `<details class="context-sources"><summary>سياق من ${m.contextSources.length} محادثة سابقة</summary>${m.contextSources.map((c) => `<a href="#${encodeURIComponent(c.id)}">${esc(c.title)}</a>`).join('')}</details>` : ''}
    ${m.mediaTask ? `<div class="memory-notice">${m.mediaTask.provider === 'kie' ? 'kie.ai' : 'PiAPI'} · ${esc(m.mediaTask.name)}${m.mediaTask.id ? ` · المهمة: ${esc(m.mediaTask.id)}` : ' · لم يتأكد إنشاء المهمة؛ افحص سجل المزوّد قبل إعادة الطلب.'}</div>` : ''}
    <div class="meta"><span>${esc(m.mediaTask?.name || modelOf(m.model).name)}${m.searches?.length ? ' · 🔎 بحث' : ''}</span>
      ${m.text ? '<button data-copy>📋 نسخ</button>' : ''}
      ${m.mediaTask?.id && !m.mediaTask.done ? '<button data-resume-media>متابعة المهمة</button>' : ''}
      ${isLast && !m.mediaTask ? '<button data-retry>🔄 أعد</button>' : ''}
      ${isLast && m.error && !m.mediaTask && !['gemini-3-8-flash', OR_AUDIO_MODEL].includes(m.model) ? '<button data-fast-retry>جرّب Gemini Flash</button>' : ''}
      ${m.error && m.connection ? `<span>مدة الانتظار: ${Math.round(m.connection.totalMs / 1000)} ث · ${m.connection.headersMs == null ? 'بدون بدء استجابة' : 'وصلت استجابة من الخدمة'}</span>` : ''}
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
  const sourceLink = e.target.closest('.context-sources a');
  if (sourceLink) {
    e.preventDefault();
    return openChat(decodeURIComponent(sourceLink.hash.slice(1)));
  }
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
  } else if (e.target.closest('[data-resume-media]')) {
    if (S.controller) return;
    const message = S.chat.messages[Number(e.target.closest('[data-i]').dataset.i)];
    if (!message?.mediaTask?.id) return;
    const ctrl = new AbortController();
    S.controller = ctrl;
    updateSend();
    try { await resumeMedia(S.chat, message, (event, data) => { if (event === 'status') setStatus(data.text); }, ctrl.signal); }
    finally { S.controller = null; setStatus(''); renderMessages(); updateSend(); }
  } else if (e.target.closest('[data-fast-retry]')) {
    if (S.controller) return;
    S.provider = providerOf(m.model);
    S.model = S.provider === 'openrouter' ? OR_AUDIO_MODEL : 'gemini-3-8-flash';
    renderModelName();
    retry();
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
  const query = $('#modelSearch').value.trim().toLowerCase();
  for (const m of modelsFor(S.provider).filter((m) => !query || `${m.name} ${m.remoteId || m.id}`.toLowerCase().includes(query))) (groups[m.maker] ||= []).push(m);
  $('#modelList').innerHTML = Object.entries(groups)
    .map(
      ([maker, list]) =>
        `<div class="maker">${esc(maker)}</div>` +
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
$('#modelBtn').onclick = () => { $('#modelSearch').value = ''; openModels(); };
$('#modelSearch').addEventListener('input', openModels);
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
  const media = S.imageMode || S.videoMode;
  for (const [id, active] of [['searchBtn', S.search && !S.imageMode], ['deepBtn', S.deep && !S.imageMode], ['imgBtn', S.imageMode]]) {
    $(`#${id}`).setAttribute('aria-pressed', String(active));
  }
  $('#searchBtn').classList.toggle('on', S.search && !S.imageMode);
  $('#searchBtn').disabled = S.imageMode;
  $('#deepBtn').classList.toggle('on', S.deep && !S.imageMode);
  $('#deepBtn').disabled = S.imageMode;
  $('#imgBtn').classList.toggle('on', S.imageMode);
  $('#imgBtn').disabled = false;
  $('#imgBtn').title = 'توليد صورة من الوصف';
  $('#videoBtn').classList.toggle('on', S.videoMode);
  $('#videoBtn').setAttribute('aria-pressed', String(S.videoMode));
  $('#searchBtn').disabled = media;
  $('#deepBtn').disabled = media;
  $('#aspect').classList.toggle('hidden', !media);
  $('#mediaReference').classList.toggle('hidden', !media);
  input.placeholder = S.videoMode ? 'صف الفيديو… أو أرفق صورة وصف حركتها' : S.imageMode ? 'صف الصورة اللي تبيها… (أرفق صورة لتعديلها)' : 'اكتب رسالتك…';
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
  S.videoMode = false;
  syncToggles();
};
$('#videoBtn').onclick = () => { S.videoMode = !S.videoMode; S.imageMode = false; syncToggles(); };

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
    else if (ev === 'image' || ev === 'video') {
      gen.classList.remove('hidden');
      gen.insertAdjacentHTML('beforeend', ev === 'video' ? videoFigure(d) : genFigure(d));
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
  if (diagnosisController) return toast('انتظر انتهاء فحص الاتصال أو ألغِ الفحص');
  if (rec || voiceJob || mic.classList.contains('busy')) return toast('أوقف الإملاء وانتظر اكتمال النص أولاً');
  const text = input.value.trim();
  if ((!text && !S.attachments.length) || S.attachments.some((a) => a.loading)) return;
  if ((S.imageMode || S.videoMode) && !text) return toast('اكتب وصف الصورة أو الفيديو');
  const mediaKind = S.videoMode ? 'video' : S.imageMode ? 'image' : mediaIntent(text);
  const mediaKey = mediaProvider() === 'kie' ? 'kieKey' : 'piapiKey';
  if (mediaKind && !db.settings.get(mediaKey, '')) {
    openSettings();
    return toast('أضف مفتاح مزوّد الصور والفيديو المحدد في الإعدادات');
  }
  if (!mediaKind && !db.settings.get(keySetting(S.provider), '')) {
    openSettings();
    return toast(`أضف مفتاح ${S.provider === 'openrouter' ? 'OpenRouter' : 'kie.ai'} أول`);
  }
  const files = S.attachments.map((a) => a.meta);
  const mediaReferenceUrl = (S.imageMode || S.videoMode) ? $('#mediaReference').value.trim() : '';
  if (mediaReferenceUrl && !/^https?:\/\//i.test(mediaReferenceUrl)) return toast('استخدم رابط صورة يبدأ بـ https://');
  S.chat.messages.push({ role: 'user', text, files, ...(mediaReferenceUrl ? { mediaReferenceUrl } : {}), at: Date.now() });
  $('#mediaReference').value = '';
  history.replaceState(null, '', `#${S.chat.id}`);
  input.value = '';
  S.attachments = [];
  renderAttachments();
  autosize();
  const imageMode = S.imageMode;
  const videoMode = S.videoMode;
  if (imageMode || videoMode) {
    S.imageMode = false;
    S.videoMode = false;
    syncToggles();
  }
  await run({ imageMode, videoMode });
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
let voiceJob = null;
let micWakeOwner = null;
let micWakeLock = null;
let micWakePending = null;

async function acquireMicWake() {
  const owner = micWakeOwner;
  if (!owner || owner !== rec || document.visibilityState === 'hidden' || micWakeLock || micWakePending === owner) return;
  $('#wakeStatus').classList.remove('hidden');
  if (!navigator.wakeLock?.request) {
    $('#wakeStatus').textContent = 'هذا المتصفح لا يدعم منع قفل الشاشة أثناء التسجيل.';
    return;
  }
  micWakePending = owner;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (owner !== micWakeOwner || owner !== rec) { await lock.release(); return; }
    micWakeLock = lock;
    $('#wakeStatus').textContent = 'الشاشة تبقى شغالة أثناء استخدام المايك';
    lock.addEventListener('release', () => {
      if (micWakeLock !== lock) return;
      micWakeLock = null;
      if (micWakeOwner) $('#wakeStatus').textContent = 'النظام أوقف منع القفل؛ قد تقفل الشاشة تلقائياً.';
    });
  } catch {
    if (micWakeOwner === owner) $('#wakeStatus').textContent = 'النظام لم يسمح بمنع قفل الشاشة؛ جرّب إيقاف وضع توفير الطاقة.';
  } finally { if (micWakePending === owner) micWakePending = null; }
}
function startMicWake(state) { micWakeOwner = state; acquireMicWake(); }
function releaseMicWake() {
  micWakeOwner = null;
  const lock = micWakeLock;
  micWakeLock = null;
  lock?.release().catch(() => {});
  $('#wakeStatus').classList.add('hidden');
  $('#wakeStatus').textContent = '';
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (micWakeLock?.released) micWakeLock = null;
    acquireMicWake();
  }
});
window.addEventListener('pagehide', releaseMicWake);

function showVoice() {
  $('.composer').classList.add('voice-active');
  $('#voiceCapture').classList.remove('hidden');
  $('#voiceAccept').disabled = false;
  $('#voiceAccept').textContent = '✓';
  $('#voiceAccept').setAttribute('aria-label', 'اعتماد التسجيل وتحويله لنص');
  input.readOnly = true;
}

function stopMeter(state) {
  if (state.meterFrame) cancelAnimationFrame(state.meterFrame);
  state.audioContext?.close().catch(() => {});
}

function startMeter(state) {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  try {
    const ctx = state.audioContext = new Audio();
    const source = ctx.createMediaStreamSource(state.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    ctx.resume().catch(() => {});
    const values = new Uint8Array(analyser.fftSize);
    const bars = document.querySelectorAll('#voiceWave span');
    const draw = () => {
      if (rec !== state) return;
      analyser.getByteTimeDomainData(values);
      bars.forEach((bar, i) => {
        let energy = 0;
        for (let n = i * 10; n < i * 10 + 10; n++) energy += ((values[n] - 128) / 128) ** 2;
        bar.style.height = `${Math.min(30, 3 + Math.sqrt(energy / 10) * 110)}px`;
      });
      state.meterFrame = requestAnimationFrame(draw);
    };
    draw();
  } catch { /* يبقى التسجيل متاحاً حتى لو تعذّر قياس الصوت */ }
}

function resetMic() {
  releaseMicWake();
  $('.composer').classList.remove('voice-active');
  $('#voiceCapture').classList.add('hidden');
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
  try { speech.start(); startMicWake(state); } catch {
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
  if (!db.settings.get(keySetting(S.provider), '')) return toast(`أضف مفتاح ${S.provider === 'openrouter' ? 'OpenRouter' : 'kie.ai'} أول`);
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
  const state = rec;
  mr.onstop = () => finishRec(new Blob(chunks, { type: (mr.mimeType || mime || 'audio/webm').split(';')[0] }), state);
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
    stopMeter(rec);
    rec = null;
    mr.onstop = null;
    stream.getTracks().forEach((t) => t.stop());
    resetMic();
    toast('توقف تسجيل الصوت. جرب مرة ثانية.');
  };
  showVoice();
  startMicWake(state);
  startMeter(state);
  setStatus('اضغط ✓ لاعتماد التسجيل وتحويله إلى نص، أو × للإلغاء');
  mic.classList.add('rec');
  tick();
  // حد أقصى 5 دقائق
  rec.limit = setTimeout(stopRec, 5 * 60 * 1000);
}

function tick() {
  if (!rec) return;
  const s = Math.floor((Date.now() - rec.started) / 1000);
  mic.textContent = `■ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (rec.mr) $('#voiceLabel').textContent = `تكلم… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function stopRec() {
  if (!rec) return;
  releaseMicWake();
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
  stopMeter(rec);
  rec.mr.stop();
  rec.stream.getTracks().forEach((t) => t.stop());
}

async function finishRec(blob, state) {
  if (rec !== state) return;
  releaseMicWake();
  clearInterval(state.timer);
  clearTimeout(state.limit);
  stopMeter(state);
  state.stream.getTracks().forEach((t) => t.stop());
  const dur = Date.now() - state.started;
  rec = null;
  if (dur < 700 || blob.size < 1500) {
    resetMic();
    return toast('التسجيل قصير — تكلم ثم اضغط ✓');
  }
  voiceJob = { blob, controller: null };
  await convertVoice(voiceJob);
}

async function convertVoice(job) {
  const ctrl = job.controller = new AbortController();
  mic.classList.remove('rec');
  mic.textContent = '⏳';
  mic.classList.add('busy');
  $('#voiceAccept').disabled = true;
  $('#voiceLabel').textContent = 'أحوّل الصوت إلى نص…';
  setStatus('أحوّل التسجيل إلى نص…');
  try {
    const text = await transcribe(job.blob, ctrl.signal, S.provider);
    if (voiceJob !== job || ctrl.signal.aborted) return;
    if (!text) throw new Error('ما سمعت كلام واضح — جرب مرة ثانية');
    const v = input.value;
    input.value = v && !/\s$/.test(v) ? `${v} ${text}` : v + text;
    autosize();
    voiceJob = null;
    resetMic();
    input.focus();
  } catch (e) {
    if (voiceJob !== job || ctrl.signal.aborted) return;
    job.controller = null;
    mic.classList.remove('busy');
    $('#voiceLabel').textContent = 'تعذّر التحويل. تسجيلك موجود؛ اضغط ↻ لإعادة التحويل أو × للإلغاء.';
    $('#voiceAccept').disabled = false;
    $('#voiceAccept').textContent = '↻';
    $('#voiceAccept').setAttribute('aria-label', 'إعادة تحويل التسجيل');
    setStatus(e.message);
  }
}

$('#voiceAccept').onclick = () => {
  if (rec?.mr) stopRec();
  else if (voiceJob && !voiceJob.controller) convertVoice(voiceJob);
};
$('#voiceCancel').onclick = () => {
  if (rec?.mr) {
    const state = rec;
    rec = null;
    clearInterval(state.timer);
    clearTimeout(state.limit);
    stopMeter(state);
    state.mr.onstop = null;
    if (state.mr.state !== 'inactive') state.mr.stop();
    state.stream.getTracks().forEach((t) => t.stop());
  }
  voiceJob?.controller?.abort();
  voiceJob = null;
  resetMic();
};

mic.onclick = async () => {
  if (mic.classList.contains('busy') || micStarting || S.controller || diagnosisController || voiceJob) return;
  if (rec) stopRec();
  else {
    micStarting = true;
    try {
      if (db.settings.get('speechMode', 'record') === 'record') await startRec();
      else await startDictation();
    } finally { micStarting = false; }
  }
};

// ---------- الإعدادات ----------
const mask = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '');

let personalizationDirty = false;
let editingRuleId = null;
function applyTypography() {
  const stored = Number(db.settings.get('chatFontSize', 17));
  const size = [16, 17, 18, 20].includes(stored) ? stored : 17;
  document.documentElement.style.setProperty('--chat-font-size', `${size}px`);
  $('#chatFontSize').value = String(size);
}
$('#chatFontSize').onchange = (e) => {
  const size = Number(e.target.value);
  if (![16, 17, 18, 20].includes(size)) return;
  db.settings.set('chatFontSize', size);
  applyTypography();
};
function renderMemoryRules() {
  const rules = readPersonalization().rules;
  $('#memoryRules').innerHTML = rules.length ? rules.map((r) => `<div class="memory-rule"><strong>${esc(r.trigger)}</strong>${r.search ? '<span class="muted"> · بحث</span>' : ''}<p>${esc(r.action)}</p><div class="row"><button class="btn ghost" data-edit-rule="${esc(r.id)}">تعديل</button><button class="btn danger" data-delete-rule="${esc(r.id)}">حذف</button></div></div>`).join('') : '<p class="muted">ما عندك اختصارات محفوظة بعد.</p>';
}
function loadPersonalSettings() {
  const config = readPersonalization();
  if (!personalizationDirty) {
    $('#customInstructions').value = config.instructions;
    $('#personalNotes').value = config.notes;
    $('#memoryEnabled').checked = config.enabled;
  }
  applyTypography();
  renderMemoryRules();
}
for (const id of ['customInstructions', 'personalNotes', 'memoryEnabled']) {
  $(`#${id}`).addEventListener('input', () => { personalizationDirty = true; $('#personalizationMsg').textContent = 'تغييرات غير محفوظة'; });
}
$('#savePersonalization').onclick = () => {
  try {
    savePersonalization({ instructions: $('#customInstructions').value, notes: $('#personalNotes').value, enabled: $('#memoryEnabled').checked });
    personalizationDirty = false;
    $('#personalizationMsg').textContent = '✓ محفوظة على هذا الجهاز، وتطبّق من الرسالة القادمة مع كل النماذج.';
  } catch (e) { $('#personalizationMsg').textContent = e.message; }
};
function resetRuleEditor() {
  editingRuleId = null;
  $('#memoryTrigger').value = '';
  $('#memoryAction').value = '';
  $('#memorySearch').checked = true;
  $('#saveMemoryRule').textContent = 'حفظ الاختصار';
  $('#cancelMemoryEdit').classList.add('hidden');
}
$('#saveMemoryRule').onclick = () => {
  try {
    saveRule({ ...(editingRuleId ? { id: editingRuleId } : {}), trigger: $('#memoryTrigger').value, action: $('#memoryAction').value, search: $('#memorySearch').checked });
    resetRuleEditor();
    renderMemoryRules();
    $('#memoryRuleMsg').textContent = '✓ حُفظ الاختصار لكل المحادثات والنماذج. يعمل عند إرسال الكلمة وحدها والذاكرة مفعّلة.';
  } catch (e) { $('#memoryRuleMsg').textContent = e.message; }
};
$('#cancelMemoryEdit').onclick = resetRuleEditor;
$('#memoryRules').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit-rule]');
  const del = e.target.closest('[data-delete-rule]');
  if (edit) {
    const rule = readPersonalization().rules.find((r) => r.id === edit.dataset.editRule);
    if (!rule) return;
    editingRuleId = rule.id;
    $('#memoryTrigger').value = rule.trigger;
    $('#memoryAction').value = rule.action;
    $('#memorySearch').checked = rule.search;
    $('#saveMemoryRule').textContent = 'حفظ التعديل';
    $('#cancelMemoryEdit').classList.remove('hidden');
    $('#memoryAction').focus();
  } else if (del) {
    try { removeRule(del.dataset.deleteRule); resetRuleEditor(); renderMemoryRules(); }
    catch (err) { $('#memoryRuleMsg').textContent = err.message; }
  }
});
$('#clearSavedMemory').onclick = () => {
  if (!confirm('تمسح الملاحظات والاختصارات المحفوظة؟ التعليمات الخاصة والمحادثات تبقى. يمكنك إيقاف استرجاع المحادثات من خيار الربط.')) return;
  try {
    clearSavedMemory();
    $('#personalNotes').value = '';
    resetRuleEditor();
    renderMemoryRules();
    $('#personalizationMsg').textContent = 'مُسحت الملاحظات والاختصارات. استرجاع المحادثات السابقة يبقى حسب خيار الربط.';
  } catch (e) { $('#personalizationMsg').textContent = e.message; }
};

function openSettings() {
  $('#mediaProvider').value = db.settings.get('mediaProvider', 'auto');
  $('#mediaKieKeyState').textContent = db.settings.get('kieKey', '') ? '✓ مفتاح kie.ai محفوظ' : 'لا يوجد مفتاح kie.ai';
  for (const id of ['kieImageModel', 'kieVideoModel']) $(`#${id}`).value = db.settings.get(id, 'auto');
  $('#piapiKeyState').textContent = db.settings.get('piapiKey', '') ? '✓ مفتاح PiAPI محفوظ؛ يُستخدم للصور والفيديو مع أي مزوّد محادثة' : 'لم يُحفظ مفتاح PiAPI بعد';
  for (const [id, key, fallback] of [['piapiImageModel', 'piapiImageModel', 'auto'], ['piapiVideoModel', 'piapiVideoModel', 'auto'], ['piapiDuration', 'piapiDuration', 5]]) $(`#${id}`).value = db.settings.get(key, fallback);
  loadPersonalSettings();
  closeSide();
  $('#settingsSheet').classList.remove('hidden');
  const isOR = S.provider === 'openrouter';
  const k = db.settings.get(keySetting(S.provider), '');
  $('#providerSelect').value = S.provider;
  $('#keyTitle').textContent = `مفتاح ${isOR ? 'OpenRouter' : 'kie.ai'}`;
  $('#keyHelp').innerHTML = isOR ? 'أضف مفتاحك من <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer">OpenRouter ← Keys</a>. تُحسب المحادثة والبحث والصوت على رصيد OpenRouter. الصور والفيديو تستخدم مزوّد الوسائط المختار أدناه.' : 'أضف مفتاحك من kie.ai ← API Key. الصور والفيديو تستخدم مزوّد الوسائط المختار أدناه بشكل مستقل.';
  $('#keyInput').placeholder = isOR ? 'sk-or-v1-…' : 'الصق مفتاح kie.ai هنا';
  $('#checkKey').textContent = isOR ? 'فحص المفتاح' : '💰 الرصيد';
  $('#forgetKey').textContent = `مسح مفتاح ${isOR ? 'OpenRouter' : 'kie.ai'} من هذا الجهاز`;
  $('#refreshModels').classList.toggle('hidden', !isOR);
  $('#keyNow').textContent = k ? `المفتاح الحالي: ${mask(k)}` : 'لا يوجد مفتاح';
  $('#speechMode').value = db.settings.get('speechMode', 'record');
  $('#defaultModel').innerHTML = modelsFor(S.provider).map((m) => `<option value="${esc(m.id)}"${m.id === S.defaultModel ? ' selected' : ''}>${esc(m.name)}${m.badge ? ` — ${m.badge}` : ''}</option>`).join('');
}
$('#openSettings').onclick = openSettings;
$('#mediaProvider').onchange = (e) => db.settings.set('mediaProvider', e.target.value);
$('#saveMediaKie').onclick = () => {
  const key = $('#mediaKieKey').value.trim();
  if (!key) return toast('الصق مفتاح kie.ai أولاً');
  if (!db.settings.set('kieKey', key)) return toast('تعذّر حفظ المفتاح');
  $('#mediaKieKey').value = '';
  openSettings();
};
$('#forgetMediaKie').onclick = () => { db.settings.set('kieKey', ''); $('#mediaKieKey').value = ''; openSettings(); };
for (const id of ['kieImageModel', 'kieVideoModel']) $(`#${id}`).onchange = (e) => db.settings.set(id, e.target.value);
$('#savePiapi').onclick = () => {
  const key = $('#piapiKey').value.trim();
  if (!key) return toast('الصق مفتاح PiAPI أولاً');
  if (!db.settings.set('piapiKey', key)) return toast('تعذّر حفظ المفتاح على هذا الجهاز');
  $('#piapiKey').value = '';
  openSettings();
  toast('تم حفظ مفتاح PiAPI');
};
$('#forgetPiapi').onclick = () => { db.settings.set('piapiKey', ''); $('#piapiKey').value = ''; openSettings(); };
for (const id of ['piapiImageModel', 'piapiVideoModel', 'piapiDuration']) $(`#${id}`).onchange = (e) => db.settings.set(id, e.target.value);
$('#providerSelect').onchange = (e) => {
  if (S.controller || rec || voiceJob || micStarting || diagnosisController) {
    e.target.value = S.provider;
    return toast('انتظر انتهاء الرد أو التسجيل أو الفحص قبل تغيير المزوّد');
  }
  S.provider = e.target.value === 'openrouter' ? 'openrouter' : 'kie';
  db.settings.set('provider', S.provider);
  S.defaultModel = defaultFor(S.provider);
  S.model = S.defaultModel;
  S.imageMode = false;
  S.videoMode = false;
  $('#keyInput').value = '';
  $('#keyMsg').textContent = '';
  $('#catalogMsg').textContent = '';
  $('#diagnosisReport').textContent = '';
  $('#copyDiagnosis').classList.add('hidden');
  syncToggles();
  renderModelName();
  openSettings();
};
$('#refreshModels').onclick = async () => {
  const button = $('#refreshModels');
  button.disabled = true;
  $('#catalogMsg').textContent = 'أحدّث قائمة OpenRouter…';
  try {
    const count = await refreshOpenRouterModels();
    $('#catalogMsg').textContent = `تم تحميل ${count} نموذج محادثة. ابحث عنها من قائمة النماذج أعلى الصفحة.`;
    if (S.provider === 'openrouter') openSettings();
  } catch (e) { $('#catalogMsg').textContent = e.message; }
  finally { button.disabled = false; }
};
$('#speechMode').onchange = (e) => db.settings.set('speechMode', e.target.value);

let diagnosisController = null;
$('#diagnoseBtn').onclick = async () => {
  if (diagnosisController || S.controller || rec || voiceJob) return toast('انتظر انتهاء الرد أو التسجيل أولاً');
  if (!db.settings.get(keySetting(S.provider), '')) return toast('أضف مفتاح المزوّد المختار أول');
  diagnosisController = new AbortController();
  const ctrl = diagnosisController;
  $('#diagnoseBtn').disabled = true;
  $('#cancelDiagnosis').classList.remove('hidden');
  $('#copyDiagnosis').classList.add('hidden');
  try {
    const results = await diagnoseModels([S.model, S.provider === 'openrouter' ? OR_AUDIO_MODEL : 'gemini-3-8-flash'], { signal: ctrl.signal, onProgress: (name) => { $('#diagnosisReport').textContent = `أفحص ${name} عبر ${S.provider === 'openrouter' ? 'OpenRouter' : 'kie.ai'}… (حتى 25 ثانية لكل نموذج)`; } });
    $('#diagnosisReport').textContent = (ctrl.signal.aborted ? 'أُلغي الفحص.\n' : '') + results.map((r) => [
      `${modelOf(r.model).name} · ${r.provider === 'openrouter' ? 'OpenRouter' : 'kie.ai'}: ${r.ok ? 'نجح' : r.error}`,
      `بدء الاستجابة: ${r.headersMs == null ? 'لم تصل' : (r.headersMs / 1000).toFixed(1) + ' ث'} · أول نص: ${r.firstTextMs == null ? 'لم يصل' : (r.firstTextMs / 1000).toFixed(1) + ' ث'}`,
      `المدة: ${(r.totalMs / 1000).toFixed(1)} ث · ${r.path || ''}${r.status ? ' · HTTP ' + r.status : ''}${r.apiStatus ? ' · API ' + r.apiStatus : ''}`,
    ].join('\n')).join('\n\n');
    $('#copyDiagnosis').classList.toggle('hidden', !results.length);
  } catch (e) {
    $('#diagnosisReport').textContent = e.message;
  } finally {
    diagnosisController = null;
    $('#diagnoseBtn').disabled = false;
    $('#cancelDiagnosis').classList.add('hidden');
  }
};
$('#cancelDiagnosis').onclick = () => diagnosisController?.abort();
$('#copyDiagnosis').onclick = async () => { await copy($('#diagnosisReport').textContent); toast('تم نسخ نتيجة الفحص'); };

$('#saveKey').onclick = () => {
  const k = $('#keyInput').value.trim();
  if (!k) return;
  db.settings.set(keySetting(S.provider), k);
  $('#keyInput').value = '';
  openSettings();
  $('#checkKey').click();
};
$('#checkKey').onclick = async () => {
  const provider = S.provider;
  $('#keyMsg').textContent = '…';
  try {
    if (provider === 'openrouter') {
      const data = await checkOpenRouterKey();
      if (S.provider !== provider) return;
      const remaining = data?.limit_remaining;
      $('#keyMsg').textContent = `✓ مفتاح OpenRouter صالح${typeof remaining === 'number' ? ` — المتبقي من حد المفتاح $${remaining.toFixed(2)}` : ' — رصيد الحساب متاح في لوحة OpenRouter'}`;
      return;
    }
    const c = await credits();
    if (S.provider !== provider) return;
    $('#keyMsg').textContent = `✓ المفتاح شغال — الرصيد ${Math.round(c).toLocaleString('en')} نقطة (≈ $${(c * CREDIT_USD).toFixed(2)})`;
  } catch (e) {
    if (S.provider !== provider) return;
    $('#keyMsg').textContent = `⚠️ ${e.message}`;
  }
};
$('#defaultModel').onchange = (e) => {
  S.defaultModel = e.target.value;
  db.settings.set(S.provider === 'openrouter' ? 'orDefaultModel' : 'defaultModel', S.defaultModel);
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
  db.settings.set(keySetting(S.provider), '');
  openSettings();
};

// ---------- التطبيق على الآيفون ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== S.chat?.id) openChat(id);
});

boot().catch((e) => toast(`خطأ: ${e.message}`, 6000));
