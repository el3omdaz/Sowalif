import { CONNECTED_SCOPES } from './connected-accounts.js?v=28';

const MICROSOFT = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const encodeBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const random = () => encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));

let googleScript;
export function prepareGoogleOAuth() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve(globalThis.google.accounts.oauth2);
  return googleScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      const identity = globalThis.google?.accounts?.oauth2;
      if (identity) resolve(identity);
      else reject(new Error('تعذّر تحميل تسجيل الدخول من Google.'));
    };
    script.onerror = () => reject(new Error('تعذّر الاتصال بتسجيل الدخول من Google.'));
    document.head.append(script);
  }).catch(error => { googleScript = null; throw error; });
}

export async function connectGoogle(clientId, scopes = CONNECTED_SCOPES.google) {
  const id = String(clientId || '').trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('أدخل معرّف OAuth Client ID لتطبيق الويب من Google.');
  const identity = globalThis.google?.accounts?.oauth2 || await prepareGoogleOAuth();
  return new Promise((resolve, reject) => {
    try {
      const client = identity.initTokenClient({
        client_id: id,
        scope: scopes.join(' '),
        callback(response) {
          if (!response.access_token) return reject(new Error('Google لم يمنح الوصول. راجع إعداد تطبيق OAuth والصلاحيات.'));
          if (!identity.hasGrantedAllScopes(response, ...scopes)) return reject(new Error('بعض صلاحيات Google المطلوبة لم تُمنح. أعد الربط واختر السماح بها.'));
          resolve(response.access_token);
        },
        error_callback(error) {
          reject(new Error(error.type === 'popup_failed_to_open'
            ? 'اسمح بالنوافذ المنبثقة ثم أعد الضغط على ربط Google.'
            : 'لم يكتمل ربط Google.'));
        },
      });
      client.requestAccessToken({ prompt: 'select_account' });
    } catch {
      reject(new Error('تعذّر بدء ربط Google. تحقّق من معرّف التطبيق وعنوانه.'));
    }
  });
}

export const microsoftRedirectUri = () => new URL('../oauth-microsoft.html', import.meta.url).href;

export async function connectMicrosoft(clientId, scopes = CONNECTED_SCOPES.microsoft) {
  const id = String(clientId || '').trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error('أدخل معرّف Application (client) ID من Microsoft.');
  if (!globalThis.crypto?.subtle || typeof BroadcastChannel !== 'function') throw new Error('افتح سوالف في متصفح حديث عبر HTTPS أو نسخة الكمبيوتر.');
  const state = random();
  const verifier = random();
  const channel = new BroadcastChannel(`sowalif-microsoft:${state}`);
  const popup = window.open('about:blank', `sowalif-microsoft-${state}`, 'popup,width=530,height=680');
  if (!popup) {
    channel.close();
    throw new Error('اسمح بالنوافذ المنبثقة ثم أعد الضغط على ربط Microsoft.');
  }
  const redirect = microsoftRedirectUri();
  const scope = scopes.join(' ');
  let timeout;
  try {
    const challenge = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const authorization = new URL(`${MICROSOFT}/authorize`);
    authorization.search = new URLSearchParams({ client_id: id, response_type: 'code', response_mode: 'query',
      redirect_uri: redirect, scope, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
    const code = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('انتهت مهلة ربط Microsoft.')), 180_000);
      channel.onmessage = event => {
        if (event.origin !== location.origin || event.data?.state !== state) return;
        if (typeof event.data.code === 'string' && event.data.code) resolve(event.data.code);
        else reject(new Error('Microsoft لم يمنح الوصول. راجع إعداد التطبيق والصلاحيات.'));
      };
      popup.location.href = authorization.href;
    });
    const response = await fetch(`${MICROSOFT}/token`, {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ client_id: id, scope, code, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
    });
    const token = await response.json();
    if (!response.ok || !token.access_token) throw new Error('تعذّر إكمال الربط. تحقّق من عنوان الرجوع المسجل كمنصة SPA.');
    if (token.scope) {
      const scopeName = value => value.toLowerCase().split('/').at(-1);
      const granted = new Set(token.scope.split(/\s+/).map(scopeName));
      if (!scopes.every(value => granted.has(scopeName(value)))) {
        throw new Error('بعض صلاحيات Microsoft المطلوبة لم تُمنح. أعد الربط واختر السماح بها.');
      }
    }
    return token.access_token;
  } finally {
    clearTimeout(timeout);
    channel.close();
    popup.close();
  }
}
