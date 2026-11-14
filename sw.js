// يحفظ واجهة التطبيق ليفتح بسرعة على الآيفون — الشبكة أولاً، والنسخة المحفوظة إن انقطع الاتصال
const CACHE = 'shell-v26';
const SHELL = ['./', 'index.html', 'style.css?v=26', 'js/app.js?v=26', 'js/image-plan.js?v=1', 'js/viewport.js?v=21', 'js/local-agent.js?v=22', 'js/media-references.js?v=25', 'js/prompt-studio.js?v=20', 'js/cloud.js?v=25', 'js/cloud-config.js?v=25', 'js/cloud-payload.js?v=20', 'js/media-push.js?v=20', 'js/project.js?v=20', 'js/project-github.js?v=20', 'js/project-folder.js?v=20', 'js/db.js?v=20', 'js/kie.js?v=20', 'js/chat.js?v=25', 'js/models.js?v=24', 'js/openrouter.js?v=20', 'js/memory.js?v=20', 'js/piapi.js?v=20', 'js/media.js?v=20', 'vendor/supabase.js?v=20', 'vendor/marked.js', 'vendor/purify.js', 'icon-192.png', 'icon-180.png', 'manifest.webmanifest'];

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
  // Local engine state and project previews must never enter the offline cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/preview/')) return;
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
