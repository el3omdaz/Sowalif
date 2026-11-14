const pushHosts = /^(?:[\w-]+\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com)$/;

export function validSubscription(subscription) {
  const { endpoint, keys } = subscription || {};
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  const url = URL.parse(endpoint);
  return url?.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
    pushHosts.test(url.hostname) && typeof keys?.p256dh === 'string' && typeof keys.auth === 'string' &&
    /^[\w-]{87}$/.test(keys.p256dh) && /^[\w-]{22}$/.test(keys.auth);
}
