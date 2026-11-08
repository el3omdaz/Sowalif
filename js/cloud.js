import { createClient } from '../vendor/supabase.js?v=20';
import { CLOUD } from './cloud-config.js?v=20';
import * as db from './db.js?v=20';
import { readPersonalization } from './memory.js?v=20';
import { cloudChat, cloudMemory } from './cloud-payload.js?v=20';

export const cloud = createClient(CLOUD.url, CLOUD.publishableKey, { auth: { storageKey: 'sowalif-auth-v1', detectSessionInUrl: false }, global: {
  fetch: (url, options = {}) => fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }),
} });
let state = db.settings.get('cloudSyncState', { versions: {}, dirty: {} });
state.versions ||= {}; state.dirty ||= {};
let busy = false;
let timer;
let onStatus = () => {};
let onRefresh = () => {};
let canApply = () => true;
const persist = () => { if (!db.settings.set('cloudSyncState', state)) throw new Error('تعذّر حفظ حالة المزامنة على الجهاز'); };
const loadState = async () => { Object.assign(state, await db.readCloudState()); };
const mark = async ({ id }) => {
  if (!db.profileId) return;
  if (id === '@memory') await db.queueCloudMemory();
  await loadState(); persist();
  clearTimeout(timer); timer = setTimeout(() => void syncCloud(), 1800);
};
export async function cloudUser() {
  const { data, error } = await cloud.auth.getSession();
  if (error) throw error;
  return data.session?.user || null;
}
const checkedUser = async () => {
  const user = await cloudUser();
  if (!user || user.id !== db.profileId) throw new Error('سجّل الدخول إلى حساب سوالف لرفع الصور والمزامنة.');
  return user;
};
const storage = () => cloud.storage.from(CLOUD.bucket);
export async function signCloudFile(path) {
  const user = await checkedUser();
  if (!path?.startsWith(user.id + '/')) throw new Error('الصورة ليست من حسابك');
  const { data, error } = await storage().createSignedUrl(path, 24 * 3600);
  if (error) throw error;
  return { storagePath: path, url: data.signedUrl, urlAt: Date.now() };
}
export async function uploadCloudFile(file, blob, signal) {
  signal?.throwIfAborted();
  const user = await checkedUser();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type) || blob.size > 10 * 1024 * 1024) throw new Error('مراجع الصور: JPG أو PNG أو WebP، حتى 10 ميغابايت للصورة.');
  const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1];
  const id = /^[\w-]{1,100}$/.test(file.blob || '') ? file.blob : db.uid();
  const path = file.storagePath?.startsWith(user.id + '/') ? file.storagePath : `${user.id}/images/${id}.${extension}`;
  const { error } = await storage().upload(path, blob, { upsert: false, contentType: blob.type, cacheControl: '3600' });
  // Blob IDs are immutable. A retry can reuse an existing object, never overwrite it.
  if (error && String(error.statusCode) !== '409') throw error;
  signal?.throwIfAborted();
  return signCloudFile(path);
}
export async function hydrateCloudChat(chat) {
  if (!db.profileId) return chat;
  for (const message of chat.messages || []) for (const file of [...(message.files || []), ...(message.images || []), ...(message.videos || [])]) {
    if (file.storagePath && (!file.url || Date.now() - (file.urlAt || 0) > 20 * 3600_000)) Object.assign(file, await signCloudFile(file.storagePath));
  }
  return chat;
}
async function serializeChat(chat) {
  // Mutate only a private copy; uploading must not change a draft being edited in another tab.
  const copy = structuredClone(chat);
  for (const message of copy.messages || []) for (const file of [...(message.files || []), ...(message.images || [])]) {
    if (!file.blob || file.storagePath) continue;
    const blob = await db.getBlob(file.blob);
    if (blob instanceof Blob) Object.assign(file, await uploadCloudFile(file, blob));
    else if (!file.url) throw new Error('مرفق مفقود على الجهاز؛ أعد إرفاقه قبل مزامنته.');
  }
  return cloudChat(copy);
}
function applyMemory(value) {
  const data = cloudMemory(value);
  for (const [key, value] of Object.entries({ customInstructions: data.instructions, personalNotes: data.notes, memoryEnabled: data.enabled, sharedRules: data.rules })) {
    localStorage.setItem(`sc.user.${db.profileId}.${key}`, JSON.stringify(value));
  }
}
const table = () => cloud.from('sowalif_documents');
const check = result => { if (result.error) throw result.error; return result.data; };
async function metadata(user) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = check(await table().select('id,kind,revision,deleted').eq('user_id', user.id).order('id').range(offset, offset + 499));
    rows.push(...page); if (page.length < 500) return new Map(rows.map(row => [row.id, row]));
  }
}
const remoteId = id => id === '@memory' ? 'memory' : 'chat:' + id;
const localId = row => row.kind === 'memory' ? '@memory' : row.id.slice(5);
async function readRow(user, id) { return check(await table().select('*').eq('user_id', user.id).eq('id', id).single()); }

export async function syncCloud() {
  if (busy || !db.profileId || !canApply()) return;
  busy = true;
  let refreshed = false;
  let conflict = false;
  try {
    const user = await checkedUser();
    await loadState();
    onStatus('جاري المزامنة…');
    const rows = await metadata(user);
    for (const [id, dirty] of Object.entries({ ...state.dirty })) {
      if (!canApply()) break;
      if (id === '@memory' && state.memoryConflict) { conflict = true; continue; }
      const rowId = remoteId(id), row = rows.get(rowId);
      const version = state.versions[id] || 0;
      if (row && row.revision !== version) {
        if (id === '@memory') {
          const remote = await readRow(user, rowId);
          state.memoryConflict = { local: cloudMemory(readPersonalization()), remote: remote.payload, revision: remote.revision };
          conflict = true; persist(); continue;
        }
        // Keep the remote record and preserve local concurrent work as a separate conversation.
        const chat = !dirty.deleted && await db.getChat(id);
        if (chat) { const copy = { ...chat, id: db.uid(), title: `${chat.title || 'محادثة'} · نسخة من هذا الجهاز` }; await db.saveChat(copy); }
        await db.clearCloudDirty(id, dirty.generation);
        await loadState();
        persist(); conflict = true;
        continue;
      }
      const chat = id === '@memory' ? null : await db.getChat(id);
      const deleted = dirty.deleted || (id !== '@memory' && !chat);
      const payload = deleted ? {} : id === '@memory' ? cloudMemory(readPersonalization()) : await serializeChat(chat);
      const value = { kind: id === '@memory' ? 'memory' : 'chat', payload, deleted };
      const result = version ? await table().update(value).eq('user_id', user.id).eq('id', rowId).eq('revision', version).select('id,kind,revision,deleted')
        : await table().insert({ ...value, user_id: user.id, id: rowId }).select('id,kind,revision,deleted');
      if (result.error?.code === '23505' || (!result.error && !result.data.length)) { conflict = true; continue; }
      const saved = check(result)[0]; rows.set(rowId, saved);
      await db.recordCloudVersion(id, saved.revision, dirty.generation, id === '@memory' ? JSON.stringify(payload) : undefined);
      await loadState();
      persist();
    }
    for (const meta of rows.values()) {
      if (!canApply()) break;
      const id = localId(meta);
      if (state.dirty[id] || meta.revision === state.versions[id]) continue;
      const old = id === '@memory' ? null : await db.getChat(id);
      const expected = old?.updatedAt || 0;
      const row = await readRow(user, meta.id);
      await loadState();
      if (state.dirty[id] || !canApply()) continue;
      if (id === '@memory') applyMemory(row.payload);
      else {
        const chat = row.deleted ? { id } : cloudChat(row.payload);
        if (chat.id !== id) throw new Error('محادثة سحابية غير صالحة');
        await hydrateCloudChat(chat);
        await loadState();
        if (state.dirty[id] || !canApply() || !await db.applyCloudChat(chat, expected, row.deleted)) continue;
      }
      await db.recordCloudVersion(id, row.revision, undefined, id === '@memory' ? JSON.stringify(cloudMemory(row.payload)) : undefined);
      await loadState(); persist(); refreshed = true;
    }
    onStatus(state.memoryConflict ? 'يوجد تعارض في التعليمات؛ اختر النسخة المطلوبة أدناه.' : conflict ? 'حُفظت النسخ المتعارضة دون فقدان التعديلات. جاري استكمال المزامنة.' : Object.keys(state.dirty).length ? 'بعض التغييرات بانتظار المزامنة.' : '✓ تمت المزامنة · الصور خاصة والمفاتيح تبقى على جهازك');
    if (refreshed) await onRefresh();
  } catch (error) { onStatus('المزامنة متوقفة؛ بيانات الجهاز محفوظة. ' + (error.message || 'تحقق من الاتصال')); }
  finally { busy = false; }
}
export const memoryConflict = () => !!state.memoryConflict;
export async function resolveMemoryConflict(choice) {
  if (busy || !state.memoryConflict) return;
  const conflict = state.memoryConflict;
  if (choice === 'remote') {
    applyMemory(conflict.remote);
    await loadState(); await db.clearCloudDirty('@memory', state.dirty['@memory']?.generation);
    await db.recordCloudVersion('@memory', conflict.revision, undefined, JSON.stringify(cloudMemory(conflict.remote)));
  } else {
    applyMemory(conflict.local); await db.queueCloudMemory();
    await db.recordCloudVersion('@memory', conflict.revision, undefined);
  }
  await loadState();
  delete state.memoryConflict; persist(); await syncCloud(); await onRefresh();
}
export async function initCloud({ status, refresh, idle } = {}) {
  onStatus = status || onStatus; onRefresh = refresh || onRefresh; canApply = idle || canApply;
  db.onLocalChange(mark);
  const user = await cloudUser();
  if (!user || db.profileId !== user.id) return user;
  await loadState();
  // Recover a lost queue without treating unknown versions as permission to overwrite remote data.
  // Chat changes and their outbox entries share one IndexedDB transaction.
  // Importing old device data uses saveChat and creates the same durable entries.
  if (!state.versions['@memory'] && !state.dirty['@memory']) {
    const memory = readPersonalization();
    if (memory.instructions || memory.notes || memory.rules.length) await mark({ id: '@memory' });
  }
  else if (!state.dirty['@memory'] && state.memorySignature !== JSON.stringify(cloudMemory(readPersonalization()))) await mark({ id: '@memory' });
  setInterval(() => { if (document.visibilityState === 'visible') void syncCloud(); }, 60_000);
  window.addEventListener('online', () => void syncCloud());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncCloud(); });
  await syncCloud();
  return user;
}
