import { settings, getBlob, profileId } from './db.js?v=20';
import { uploadFile } from './kie.js?v=20';
import { uploadCloudFile, signCloudFile } from './cloud.js?v=20';

const dataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

export async function resolveReferences(files, { provider, inline = false, signal, onStatus = () => {} } = {}) {
  const localPiapi = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname) && globalThis.location?.port === '4781';
  const useCloud = !!profileId;
  const uploadToKie = provider === 'kie' || settings.get('referenceUploadProvider', 'piapi') === 'kie';
  // Check all files before starting any upload. Cross-provider hosting requires an explicit setting.
  if (files.some(file => file.blob && (!file.url || Date.now() - (file.urlAt || 0) >= 20 * 3600_000)) && !inline) {
    if (!useCloud && !uploadToKie && !localPiapi) throw new Error('سجّل الدخول من الإعدادات ← الحساب والمزامنة لرفع الصور المرجعية. أو اختر رفع المراجع عبر kie.ai من إعدادات الوسائط.');
    if (!useCloud && uploadToKie && !settings.get('kieKey', '')) throw new Error('رفع المراجع عبر kie.ai يحتاج مفتاحه من إعدادات الوسائط. التوليد يبقى على PiAPI.');
  }
  const urls = [];
  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted();
    if (useCloud && file.storagePath) { const signed = await signCloudFile(file.storagePath); Object.assign(file, signed); urls.push(signed.url); continue; }
    if (/^https?:\/\//i.test(file.url || '') && (!file.blob || Date.now() - (file.urlAt || 0) < 20 * 3600_000)) { urls.push(file.url); continue; }
    const blob = file.blob && await getBlob(file.blob);
    if (!blob) throw new Error('الصورة غير موجودة على هذا الجهاز؛ أرفقها مرة ثانية.');
    if (inline) { urls.push(await dataUrl(blob)); continue; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) throw new Error('استخدم صور JPG أو PNG أو WebP للمراجع.');
    if (blob.size > 10 * 1024 * 1024) throw new Error('حجم الصورة المرجعية يجب ألا يتجاوز 10 ميغابايت.');
    onStatus(`يرفع الصورة ${index + 1} من ${files.length} عبر ${useCloud ? 'تخزين سوالف الخاص' : uploadToKie ? 'kie.ai' : 'PiAPI'}…`);
    const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1];
    let url;
    if (useCloud) { const uploaded = await uploadCloudFile(file, blob, signal); Object.assign(file, uploaded); url = uploaded.url; }
    else if (uploadToKie) url = await uploadFile(blob, `reference-${index + 1}.${extension}`, signal);
    else {
      const status = await fetch('/api/agent/status', { signal, cache: 'no-store' }).then(r => r.json());
      const response = await fetch('/api/media/upload', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Sowalif-CSRF': status.csrf },
        body: JSON.stringify({ key: settings.get('piapiKey', ''), fileName: `reference-${index + 1}.${extension}`, data: await dataUrl(blob) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'تعذّر رفع الصورة إلى PiAPI');
      url = result.url;
    }
    if (!/^https?:\/\//i.test(url || '')) throw new Error('خدمة الرفع لم ترجع رابط صورة صالحاً.');
    file.url = url; file.urlAt = Date.now(); urls.push(url);
  }
  return urls;
}
