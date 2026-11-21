// يحفظ واجهة التطبيق ليفتح بسرعة على الآيفون — الشبكة أولاً، والنسخة المحفوظة إن انقطع الاتصال
const CACHE = 'shell-v46';
const SHELL = ['js/text-dialog.js?v=40', 'js/document-tools.js?v=40', 'js/pdf-preview.js?v=40', 'js/nav-layout.js?v=44', 'js/cloud-attachments.js?v=40', './', 'index.html', 'style.css?v=44', 'js/app.js?v=46', 'js/agent-engines.js?v=40', 'js/model-recommendation.js?v=40', 'js/reasoning.js?v=40', 'js/docs-context.js?v=40', 'js/xlsx-text.js?v=40', 'js/market.js?v=40', 'js/image-plan.js?v=40', 'js/viewport.js?v=40', 'js/local-agent.js?v=46', 'js/media-references.js?v=40', 'js/prompt-studio.js?v=40', 'js/cloud.js?v=40', 'js/cloud-config.js?v=40', 'js/cloud-payload.js?v=40', 'js/media-push.js?v=40', 'js/project.js?v=40', 'js/project-github.js?v=40', 'js/project-folder.js?v=40', 'js/db.js?v=40', 'js/kie.js?v=40', 'js/chat.js?v=40', 'js/zip-text.js?v=40', 'js/organizer.js?v=40', 'js/organizer-intent.js?v=40', 'js/connected-accounts.js?v=40', 'js/account-oauth.js?v=40', 'js/oauth-microsoft-callback.js?v=40', 'js/models.js?v=40', 'js/openrouter.js?v=40', 'js/memory.js?v=40', 'js/piapi.js?v=40', 'js/media.js?v=40', 'vendor/supabase.js?v=20', 'vendor/marked.js', 'vendor/purify.js', 'icon-192.png', 'icon-180.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL('./', self.registration.scope);
  if (e.notification.data?.marketId) url.searchParams.set('market', e.notification.data.marketId);
  else url.hash = encodeURIComponent(e.notification.data?.chatId || '');
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
  if (payload?.type === 'market') {
    const marker = payload.direction === 'positive' ? '🟢' : payload.direction === 'negative' ? '🔴' : '⚪';
    e.waitUntil(self.registration.showNotification(`${marker} ${payload.asset || 'السوق'}`, {
      body: payload.title || 'افتح سوالف لعرض التفاصيل.', icon: new URL('icon-192.png', self.registration.scope).href,
      tag: payload.tag, data: { marketId: payload.id },
    }));
    return;
  }
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
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/preview/') || url.pathname.endsWith('/oauth-microsoft.html')) return;
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
