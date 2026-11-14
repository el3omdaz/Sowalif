const url = new URL(location.href);
const state = url.searchParams.get('state');
const code = url.searchParams.get('code');
const returned = Boolean(url.searchParams.get('error') || code);
history.replaceState(null, '', url.pathname);
if (/^[\w-]{43}$/.test(state || '') && returned && typeof BroadcastChannel === 'function') {
  const channel = new BroadcastChannel(`sowalif-microsoft:${state}`);
  channel.postMessage({ state, code });
  setTimeout(() => { channel.close(); window.close(); }, 250);
}
document.querySelector('#oauth-status').textContent = 'تقدر تسكر هالنافذة وترجع لسوالف.';
