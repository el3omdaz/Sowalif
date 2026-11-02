// التخزين على الجهاز: المحادثات والصور في IndexedDB، والإعدادات في localStorage
const DB_NAME = 'smart-chat';
let dbp = null;

function open() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('chats', { keyPath: 'id' });
      db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('تعذّر الحفظ — ممكن مساحة الجهاز ممتلئة'));
  });
}

// iOS يمسح بيانات المواقع غير المستخدمة، فنطلب تخزيناً دائماً (يتفعّل غالباً بعد إضافته للشاشة الرئيسية)
navigator.storage?.persist?.().catch(() => {});

export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---------- المحادثات ----------
export async function listChats() {
  const all = await tx('chats', 'readonly', (s) => s.getAll());
  return all
    .map(({ id, title, model, updatedAt, pinned }) => ({ id, title, model, updatedAt, pinned: !!pinned }))
    .sort((a, b) => b.pinned - a.pinned || b.updatedAt - a.updatedAt);
}

export const getChat = (id) => tx('chats', 'readonly', (s) => s.get(id));

export async function saveChat(chat, touch = true) {
  if (touch) chat.updatedAt = Date.now();
  // نخزن نسخة نظيفة بدون عناصر مؤقتة للواجهة
  await tx('chats', 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(chat))));
  return chat;
}

export function newChat(model) {
  return { id: uid(), title: 'محادثة جديدة', model, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

const blobIds = (chat) => chat.messages.flatMap((m) => [...(m.files || []), ...(m.images || [])]).map((f) => f.blob).filter(Boolean);

export async function deleteChat(id) {
  const chat = await getChat(id);
  if (!chat) return;
  for (const b of blobIds(chat)) await deleteBlob(b);
  await tx('chats', 'readwrite', (s) => s.delete(id));
}

// ---------- الملفات ----------
export async function putBlob(blob) {
  const id = uid();
  await tx('blobs', 'readwrite', (s) => s.put(blob, id));
  return id;
}
export const getBlob = (id) => tx('blobs', 'readonly', (s) => s.get(id));
export const deleteBlob = (id) => tx('blobs', 'readwrite', (s) => s.delete(id));

// روابط عرض الصور (تُنشأ مرة لكل ملف)
const urls = new Map();
export async function blobUrl(id) {
  if (urls.has(id)) return urls.get(id);
  const b = await getBlob(id);
  if (!b) return '';
  const u = URL.createObjectURL(b);
  urls.set(id, u);
  return u;
}

// ---------- الإعدادات ----------
export const settings = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`sc.${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`sc.${k}`, JSON.stringify(v));
    } catch {
      /* التخزين غير متاح */
    }
  },
};

// ---------- النسخ والنقل بين الأجهزة ----------
const toB64 = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

export async function exportAll() {
  const chats = await tx('chats', 'readonly', (s) => s.getAll());
  const blobs = {};
  for (const c of chats) for (const id of blobIds(c)) {
    const b = await getBlob(id);
    if (b) blobs[id] = await toB64(b);
  }
  return new Blob([JSON.stringify({ app: 'smart-chat', version: 1, exportedAt: Date.now(), chats, blobs })], { type: 'application/json' });
}

// الدمج: المحادثات الموجودة بنفس الرقم تُستبدل بالأحدث
export async function importAll(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'smart-chat') throw new Error('هذا الملف مو نسخة من المحادثة الذكية');
  for (const [id, dataUrl] of Object.entries(data.blobs || {})) {
    const blob = await (await fetch(dataUrl)).blob();
    await tx('blobs', 'readwrite', (s) => s.put(blob, id));
  }
  let n = 0;
  for (const c of data.chats || []) {
    const old = await getChat(c.id);
    if (!old || (old.updatedAt || 0) <= (c.updatedAt || 0)) {
      await saveChat(c, false);
      n++;
    }
  }
  return n;
}
