// يحفظ واجهة التطبيق ليفتح بسرعة على الآيفون — الشبكة أولاً، والنسخة المحفوظة إن انقطع الاتصال
const CACHE = 'shell-v2';
const SHELL = ['./', 'index.html', 'style.css', 'js/app.js', 'js/db.js', 'js/kie.js', 'js/chat.js', 'js/models.js', 'vendor/marked.js', 'vendor/purify.js', 'icon-192.png', 'icon-180.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // طلبات kie.ai وغيرها تمر مباشرة بدون حفظ
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
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
