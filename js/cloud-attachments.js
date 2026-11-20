// Original files live in a private bucket, outside the conversation JSON.
export const ATTACHMENT_CHUNK_SIZE = 6 * 1024 * 1024;
const validPath = (path, owner) => typeof path === 'string' && Boolean(owner) && path.startsWith(owner + '/files/') && /^[\w-]{1,100}\.bin$/.test(path.slice((owner + '/files/').length));
const errorFor = status => Object.assign(new Error(status === 413
  ? 'حجم الملف يتجاوز حد التخزين السحابي في حسابك. الأصل محفوظ على جهازك.'
  : status === 401 || status === 403 ? 'أعد تسجيل الدخول لمزامنة الملفات الخاصة.'
    : `تعذّرت مزامنة الملف الأصلي (${status}). الأصل محفوظ على جهازك.`), { status });
const encodeMetadata = value => btoa(String.fromCharCode(...new TextEncoder().encode(value)));

export function createAttachmentStorage({ cloud, db, config, fetchImpl = (...args) => fetch(...args), now = () => Date.now() }) {
  const bucket = config.filesBucket || 'sowalif-files';
  const storageUrl = new URL(config.url);
  if (/^[^.]+\.supabase\.co$/.test(storageUrl.hostname)) storageUrl.hostname = storageUrl.hostname.replace('.supabase.co', '.storage.supabase.co');
  const endpoint = new URL('/storage/v1/upload/resumable', storageUrl).href;
  const pendingUploads = new Map();
  const pendingDownloads = new Map();
  const records = () => db.settings.get('attachmentUploadState', {});
  const remember = (key, value) => { const current = records(); if (value) current[key] = value; else delete current[key]; db.settings.set('attachmentUploadState', current); };
  async function session(owner = db.profileId) {
    const { data, error } = await cloud.auth.getSession();
    if (error) throw error;
    const value = data.session;
    if (!owner || owner !== db.profileId || value?.user?.id !== owner || !value.access_token) throw new Error('سجّل الدخول إلى حساب سوالف لمزامنة الملفات الخاصة.');
    return value;
  }
  async function request(url, options, owner, signal) {
    signal?.throwIfAborted();
    const auth = await session(owner);
    const response = await fetchImpl(url, { ...options, headers: { apikey: config.publishableKey, Authorization: `Bearer ${auth.access_token}`, ...options.headers },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
    signal?.throwIfAborted();
    if (owner !== db.profileId) throw new Error('تغيّر الحساب أثناء مزامنة الملف. أعد المحاولة.');
    return response;
  }
  const uploadUrl = value => {
    try { const url = new URL(value); return url.origin === storageUrl.origin && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith('/storage/v1/upload/resumable/') ? url.href : null; } catch { return null; }
  };
  const offsetOf = (response, size) => {
    const raw = response.headers.get('upload-offset');
    const value = raw === null ? NaN : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > size) throw new Error('وصل موضع رفع غير صالح. الأصل محفوظ؛ أعد المزامنة.');
    return value;
  };
  async function exists(path, blob, owner) {
    await session(owner);
    const { data, error } = await cloud.storage.from(bucket).info(path);
    return !error && Number(data?.size) === blob.size;
  }
  async function resumable(blob, path, key, owner, { signal, onProgress }) {
    const headers = { 'Tus-Resumable': '1.0.0', 'x-upsert': 'false' };
    const previous = records()[key];
    let url = previous?.path === path && previous?.size === blob.size && now() - previous.at < 23 * 3600_000 ? uploadUrl(previous.url) : null;
    let offset = 0;
    if (url) {
      const head = await request(url, { method: 'HEAD', headers }, owner, signal);
      if ([404, 410].includes(head.status)) url = null;
      else { if (!head.ok) throw errorFor(head.status); offset = offsetOf(head, blob.size); }
    }
    if (!url) {
      const metadata = { bucketName: bucket, objectName: path, contentType: blob.type || 'application/octet-stream', cacheControl: '3600' };
      const response = await request(endpoint, { method: 'POST', headers: { ...headers, 'Upload-Length': String(blob.size),
        'Upload-Metadata': Object.entries(metadata).map(([name, value]) => `${name} ${encodeMetadata(value)}`).join(',') } }, owner, signal);
      if (!response.ok) throw errorFor(response.status);
      const location = response.headers.get('location');
      url = location && uploadUrl(new URL(location, endpoint).href);
      if (!url) throw new Error('لم يصل عنوان رفع صالح. الأصل محفوظ على جهازك.');
      remember(key, { path, url, size: blob.size, at: now() });
    }
    onProgress?.(offset, blob.size);
    let failures = 0;
    while (offset < blob.size) {
      signal?.throwIfAborted();
      const end = Math.min(offset + ATTACHMENT_CHUNK_SIZE, blob.size);
      try {
        const response = await request(url, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) }, body: blob.slice(offset, end) }, owner, signal);
        if (!response.ok) throw errorFor(response.status);
        const next = offsetOf(response, blob.size);
        if (next !== end) throw new Error('لم يؤكد الخادم حفظ جزء الملف كاملًا. أعد المزامنة.');
        offset = next; failures = 0;
      } catch (error) {
        signal?.throwIfAborted();
        if (++failures > 2 || (error.status && error.status !== 409 && error.status < 500)) throw error;
        // A failed response may follow a successful write. Ask before resending bytes.
        const head = await request(url, { method: 'HEAD', headers }, owner, signal);
        if (!head.ok) throw errorFor(head.status);
        offset = offsetOf(head, blob.size);
      }
      onProgress?.(offset, blob.size);
    }
  }
  async function uploadOriginal(file, { signal, onProgress } = {}) {
    signal?.throwIfAborted();
    const owner = db.profileId;
    if (file.originalStoragePath) {
      await session(owner);
      if (!validPath(file.originalStoragePath, owner)) throw new Error('الملف الأصلي ليس من حسابك.');
      return { originalStoragePath: file.originalStoragePath };
    }
    // Old localText records point at an extracted text cache, never an original.
    if (!file.localFile || file.localText) return {};
    const key = owner + ':' + file.localFile;
    if (pendingUploads.has(key)) return pendingUploads.get(key);
    const work = (async () => {
      await session(owner);
      const blob = await db.getBlob(file.localFile);
      signal?.throwIfAborted();
      if (!(blob instanceof Blob)) throw new Error('الملف الأصلي مفقود على هذا الجهاز؛ أعد إرفاقه قبل مزامنته.');
      const cached = records()[key];
      if (cached?.complete && cached.size === blob.size && validPath(cached.path, owner)) return { originalStoragePath: cached.path };
      const id = /^[\w-]{1,100}$/.test(file.localFile) ? file.localFile : db.uid();
      const path = `${owner}/files/${id}.bin`;
      try {
        if (blob.size > ATTACHMENT_CHUNK_SIZE) await resumable(blob, path, key, owner, { signal, onProgress });
        else {
          const url = new URL(`/storage/v1/object/${bucket}/${path}`, config.url).href;
          const response = await request(url, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': 'false', 'cache-control': 'max-age=3600' }, body: blob }, owner, signal);
          if (!response.ok) throw errorFor(response.status);
          onProgress?.(blob.size, blob.size);
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (![400, 409].includes(error.status) || !await exists(path, blob, owner)) throw error;
      }
      remember(key, { path, size: blob.size, complete: true, at: now() });
      return { originalStoragePath: path, originalName: file.originalName || file.name || 'file', size: blob.size, type: file.type || blob.type || 'application/octet-stream' };
    })();
    pendingUploads.set(key, work);
    try { return await work; } finally { pendingUploads.delete(key); }
  }
  async function resolveAttachmentOriginal(file, { signal, onProgress } = {}) {
    signal?.throwIfAborted();
    if (file.localFile && !file.localText) {
      const local = await db.getBlob(file.localFile);
      signal?.throwIfAborted();
      if (local instanceof Blob) return local;
    }
    const owner = db.profileId, path = file.originalStoragePath;
    if (!path) throw new Error('الأصل غير موجود على هذا الجهاز. أعد إرفاق الملف أو انتظر مزامنته من جهاز الرفع.');
    if (!validPath(path, owner)) throw new Error('الملف الأصلي ليس من حسابك.');
    const key = owner + ':' + path;
    let work = pendingDownloads.get(key);
    if (!work) {
      work = (async () => {
        onProgress?.(`أنزّل أصل «${file.originalName || file.name || 'الملف'}»…`);
        // Match storage-js download(): the Authorization header selects the
        // private object route; "authenticated" is only used for image renders.
        const url = new URL(`/storage/v1/object/${bucket}/${path}`, config.url).href;
        const response = await request(url, { method: 'GET' }, owner, signal);
        if (!response.ok) throw errorFor(response.status);
        const blob = await response.blob();
        signal?.throwIfAborted();
        if (Number.isSafeInteger(file.size) && blob.size !== file.size) throw new Error('لم يكتمل تنزيل الملف الأصلي. أعد المحاولة.');
        if (owner !== db.profileId) throw new Error('تغيّر الحساب أثناء تنزيل الملف. أعد المحاولة.');
        const localFile = await db.putBlob(blob);
        if (signal?.aborted) { await db.deleteBlob(localFile).catch(() => {}); signal.throwIfAborted(); }
        return { blob, localFile };
      })();
      pendingDownloads.set(key, work);
    }
    try {
      const result = await work;
      signal?.throwIfAborted();
      if (Number.isSafeInteger(file.size) && result.blob.size !== file.size) throw new Error('لم يكتمل تنزيل الملف الأصلي. أعد المحاولة.');
      file.localFile = result.localFile; delete file.localText; return result.blob;
    }
    finally { if (pendingDownloads.get(key) === work) pendingDownloads.delete(key); }
  }
  return { uploadOriginal, resolveAttachmentOriginal };
}
