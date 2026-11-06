import { settings } from './db.js?v=14';

let pushSetup;
const api = '/api/media-push/';

export async function prepareMediaPush(registration) {
  if (!registration?.pushManager) return;
  try {
    const res = await fetch(api + 'key', { signal: AbortSignal.timeout(4000) });
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return;
    const { key } = await res.json();
    if (key) pushSetup = { registration, key, subscription: await registration.pushManager.getSubscription() };
  } catch { /* Static hosting keeps local notifications available. */ }
}

export async function enableCompletionNotifications() {
  if (!pushSetup) return globalThis.Notification?.requestPermission();
  const { registration, key } = pushSetup;
  pushSetup.subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return globalThis.Notification?.permission;
}

export async function disableMediaPush() {
  const registration = await navigator.serviceWorker?.getRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  await subscription?.unsubscribe();
  if (pushSetup) pushSetup.subscription = null;
}

export async function withMediaCallback(spec, chat, reply, signal) {
  if (!settings.get('completionNotifications', false) || globalThis.Notification?.permission !== 'granted') return spec;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    if (!subscription) return spec;
    const timeout = AbortSignal.timeout(4000);
    const res = await fetch(api + 'ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, provider: reply.mediaTask.provider, chatId: chat.id, at: reply.at }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) return spec;
    const { endpoint, secret } = await res.json();
    if (new URL(endpoint).origin !== location.origin) return spec;
    reply.mediaTask.push = true;
    const body = spec.body;
    return { ...spec, body: reply.mediaTask.provider === 'kie'
      ? { ...body, callBackUrl: endpoint }
      : { ...body, config: { ...body.config, webhook_config: { endpoint, secret } } } };
  } catch {
    return spec;
  }
}
