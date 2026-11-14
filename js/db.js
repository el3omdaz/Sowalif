// التخزين على الجهاز: المحادثات والصور في IndexedDB، والإعدادات في localStorage
export const profileId = (() => { try { return localStorage.getItem('sc.cloudProfile') || ''; } catch { return ''; } })();
const DB_NAME = profileId ? `smart-chat-cloud-${profileId}` : 'smart-chat';
const personalKeys = new Set(['customInstructions', 'personalNotes', 'memoryEnabled', 'sharedRules', 'cloudSyncState']);
const accountKeys = new Set([...personalKeys, 'kieKey', 'openRouterKey', 'piapiKey', 'codingOpenAIKey', 'codingAnthropicKey']);
let changeListener = () => {};
export const onLocalChange = listener => { changeListener = listener; };
const changed = async (id, deleted = false) => { try { await changeListener({ id, deleted }); } catch { /* Local saving remains available offline. */ } };
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
    const t = db.transaction(profileId && store === 'chats' && mode === 'readwrite' ? ['chats', 'blobs'] : store, mode);
    const out = fn(t.objectStore(store), t);
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
    .map(({ id, title, model, updatedAt, pinned, mode }) => ({ id, title, model, updatedAt, pinned: !!pinned, mode }))
    .sort((a, b) => b.pinned - a.pinned || b.updatedAt - a.updatedAt);
}

export const getChat = (id) => tx('chats', 'readonly', (s) => s.get(id));
// النصوص فقط للاسترجاع المحلي؛ لا نعيد المرفقات أو مفاتيح المزوّدين.
export async function recallChats() {
  const all = await tx('chats', 'readonly', (s) => s.getAll());
  return all.filter(c => !['image', 'video', 'work'].includes(c.mode)).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messages: (c.messages || []).filter((m) => !m.error && ['user', 'assistant'].includes(m.role)).map((m) => ({ role: m.role, text: String(m.text || ''), at: m.at })) }));
}

export async function saveChat(chat, touch = true, preserveProject = chat.mode === 'work') {
  if (touch) chat.updatedAt = Date.now();
  // نخزن نسخة نظيفة بدون عناصر مؤقتة للواجهة
  const snapshot = JSON.parse(JSON.stringify(chat));
  await tx('chats', 'readwrite', (s, transaction) => {
    if (profileId) queueInTransaction(transaction, chat.id);
    if (!preserveProject) return s.put(snapshot);
    const current = s.get(chat.id);
    current.onsuccess = () => {
      if ((current.result?.project?.revision || 0) > (snapshot.project?.revision || 0)) {
        snapshot.project = current.result.project;
      }
      s.put(snapshot);
    };
  });
  if (snapshot.project) chat.project = snapshot.project;
  await changed(chat.id);
  return chat;
}

export async function saveProject(chat, project) {
  const updatedAt = Date.now();
  let saved = false;
  await tx('chats', 'readwrite', (s, transaction) => {
    const current = s.get(chat.id);
    current.onsuccess = () => {
      if ((current.result?.project?.revision || 0) !== project.revision - 1) return;
      s.put({ ...(current.result || chat), project, updatedAt });
      if (profileId) queueInTransaction(transaction, chat.id);
      saved = true;
    };
  });
  if (!saved) throw new Error('تغيّرت ملفات المشروع في نافذة ثانية. افتح المشروع من جديد.');
  Object.assign(chat, { project, updatedAt });
  await changed(chat.id);
}

export function newChat(model) {
  return { id: uid(), title: 'محادثة جديدة', model, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

const blobIds = (chat) => chat.messages.flatMap((m) => [...(m.files || []), ...(m.images || []), ...(m.videos || [])]).map((f) => f.blob || f.localFile).filter(Boolean);

export async function deleteChat(id) {
  const chat = await getChat(id);
  if (!chat) return;
  for (const b of blobIds(chat)) await deleteBlob(b);
  if (chat.mode === 'work') await deleteBlob(`project-folder:${id}`);
  await tx('chats', 'readwrite', (s, transaction) => { s.delete(id); if (profileId) queueInTransaction(transaction, id, true); });
  await changed(id, true);
}

// ---------- الملفات ----------
export async function putBlob(blob) {
  const id = uid();
  await tx('blobs', 'readwrite', (s) => s.put(blob, id));
  return id;
}
export const getBlob = (id) => tx('blobs', 'readonly', (s) => s.get(id));
export const deleteBlob = (id) => tx('blobs', 'readwrite', (s) => s.delete(id));

const syncKey = id => `cloud-sync:${id}`;
function queueInTransaction(transaction, id, deleted = false) {
  const store = transaction.objectStore('blobs');
  const request = store.get(syncKey(id));
  request.onsuccess = () => store.put({ ...request.result, id, generation: uid(), deleted }, syncKey(id));
}
export async function queueCloudMemory() {
  await tx('blobs', 'readwrite', (_, transaction) => queueInTransaction(transaction, '@memory'));
}
export async function readCloudState() {
  const records = [];
  await tx('blobs', 'readonly', store => {
    const cursor = store.openCursor(IDBKeyRange.bound('cloud-sync:', 'cloud-sync:\uffff'));
    cursor.onsuccess = () => { if (cursor.result) { records.push(cursor.result.value); cursor.result.continue(); } };
  });
  return { versions: Object.fromEntries(records.map(row => [row.id, row.revision || 0])),
    dirty: Object.fromEntries(records.filter(row => row.generation).map(row => [row.id, { generation: row.generation, deleted: row.deleted }])),
    memorySignature: records.find(row => row.id === '@memory')?.signature };
}
export async function recordCloudVersion(id, revision, generation, signature) {
  await tx('blobs', 'readwrite', store => {
    const request = store.get(syncKey(id));
    request.onsuccess = () => {
      const row = { ...request.result, id, revision, ...(signature !== undefined ? { signature } : {}) };
      if (row.generation === generation) { delete row.generation; delete row.deleted; }
      store.put(row, syncKey(id));
    };
  });
}
export async function clearCloudDirty(id, generation) {
  await tx('blobs', 'readwrite', store => {
    const request = store.get(syncKey(id));
    request.onsuccess = () => {
      const row = request.result;
      if (row?.generation !== generation) return;
      delete row.generation; delete row.deleted; store.put(row, syncKey(id));
    };
  });
}

export const getProjectFolder = (id) => getBlob(`project-folder:${id}`);
export const saveProjectFolder = (id, link) => tx('blobs', 'readwrite', (s) => s.put(link, `project-folder:${id}`));

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
      const v = localStorage.getItem(profileId && accountKeys.has(k) ? `sc.user.${profileId}.${k}` : `sc.${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(profileId && accountKeys.has(k) ? `sc.user.${profileId}.${k}` : `sc.${k}`, JSON.stringify(v));
      if (personalKeys.has(k) && k !== 'cloudSyncState') changed('@memory');
      return true;
    } catch {
      return false;
    }
  },
};

// Apply a cloud version only if the local record has not changed while downloading.
export async function applyCloudChat(chat, expectedUpdatedAt, deleted = false) {
  let applied = false;
  await tx('chats', 'readwrite', (store, transaction) => {
    const pending = transaction.objectStore('blobs').get(syncKey(chat.id));
    pending.onsuccess = () => {
      if (pending.result?.generation) return;
      const current = store.get(chat.id);
      current.onsuccess = () => {
        if ((current.result?.updatedAt || 0) !== expectedUpdatedAt) return;
        if (deleted) store.delete(chat.id); else store.put(chat);
        applied = true;
      };
    };
  });
  return applied;
}

export async function importDeviceData() {
  if (!profileId) throw new Error('سجّل الدخول أولاً');
  const base = await new Promise((resolve, reject) => {
    const request = indexedDB.open('smart-chat', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('chats', { keyPath: 'id' }); request.result.createObjectStore('blobs'); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const read = (store, id) => new Promise((resolve, reject) => {
    const transaction = base.transaction(store, 'readonly');
    const request = id === undefined ? transaction.objectStore(store).getAll() : transaction.objectStore(store).get(id);
    transaction.oncomplete = () => resolve(request.result); transaction.onerror = () => reject(transaction.error);
  });
  let count = 0;
  try {
    for (const chat of await read('chats')) {
      // Existing account copies stay intact; import is additive.
      if (await getChat(chat.id)) continue;
      for (const id of blobIds(chat)) { const blob = await read('blobs', id); if (blob instanceof Blob) await tx('blobs', 'readwrite', store => store.put(blob, id)); }
      await saveChat(chat, false, false); count++;
    }
    const { mergePersonalization } = await import('./memory.js?v=20');
    const readOld = (key, fallback) => { try { return JSON.parse(localStorage.getItem('sc.' + key)) ?? fallback; } catch { return fallback; } };
    mergePersonalization({ instructions: readOld('customInstructions', ''), notes: readOld('personalNotes', ''), enabled: readOld('memoryEnabled', true), rules: readOld('sharedRules', []) });
    return count;
  } finally { base.close(); }
}

// ---------- النسخ والنقل بين الأجهزة ----------
const toB64 = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

export async function exportAll() {
  const { readPersonalization } = await import('./memory.js?v=20');
  const chats = await tx('chats', 'readonly', (s) => s.getAll());
  const blobs = {};
  for (const c of chats) for (const id of blobIds(c)) {
    const b = await getBlob(id);
    if (b) blobs[id] = await toB64(b);
  }
  return new Blob([JSON.stringify({ app: 'smart-chat', version: 2, exportedAt: Date.now(), chats, blobs, personalization: readPersonalization() })], { type: 'application/json' });
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
      await saveChat(c, false, false);
      n++;
    }
  }
  if (data.personalization) {
    const { mergePersonalization } = await import('./memory.js?v=20');
    mergePersonalization(data.personalization);
  }
  return n;
}
