// يحفظ واجهة التطبيق ليفتح بسرعة على الآيفون — الشبكة أولاً، والنسخة المحفوظة إن انقطع الاتصال
const CACHE = 'shell-v13';
const SHELL = ['./', 'index.html', 'style.css?v=13', 'js/app.js?v=13', 'js/media-push.js?v=13', 'js/project.js?v=13', 'js/db.js?v=13', 'js/kie.js?v=13', 'js/chat.js?v=13', 'js/models.js?v=13', 'js/openrouter.js?v=13', 'js/memory.js?v=13', 'js/piapi.js?v=13', 'js/media.js?v=13', 'vendor/marked.js', 'vendor/purify.js', 'icon-192.png', 'icon-180.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL('./', self.registration.scope);
  url.hash = encodeURIComponent(e.notification.data?.chatId || '');
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(async (windows) => {
    const client = windows.find(window => new URL(window.url).pathname === url.pathname);
    if (client?.url === url.href) return client.focus();
    const navigated = await client?.navigate(url.href);
    return navigated ? navigated.focus() : self.clients.openWindow(url.href);
  }));
});

self.addEventListener('push', (e) => {
  let payload;
  try { payload = e.data?.json(); } catch {}
  e.waitUntil(self.registration.showNotification('سوالف', {
    body: payload?.outcome === 'failed' ? 'تعذّر إكمال مهمة التوليد.' : 'اكتملت مهمة التوليد.',
    icon: new URL('icon-192.png', self.registration.scope).href,
    tag: payload?.tag,
    data: { chatId: payload?.chatId },
  }));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/media-push/')) return;
  // طلبات kie.ai وغيرها تمر مباشرة بدون حفظ
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
