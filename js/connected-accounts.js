const GOOGLE_MAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_DRIVE = 'https://www.googleapis.com/drive/v3/files';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';

export const CONNECTED_SCOPES = Object.freeze({
  google: Object.freeze(['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/drive']),
  microsoft: Object.freeze(['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/Files.ReadWrite']),
});

function part(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..') throw new Error('معرّف العنصر غير صالح.');
  return encodeURIComponent(value);
}

function withParams(url, params) {
  const output = new URL(url);
  for (const [key, value] of Object.entries(params)) if (value !== '' && value !== undefined) output.searchParams.set(key, value);
  return output.href;
}

const pageSize = value => Math.min(Math.max(Math.trunc(Number(value)) || 20, 1), 50);
const odataString = value => value.replaceAll("'", "''");
const driveString = value => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
const serviceName = provider => provider === 'google' ? 'Google' : 'Microsoft';

function toBase64(bytes) {
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 8192) pieces.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(pieces.join(''));
}

function fromBase64(text) {
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

function textFromHtml(html) {
  // A template is inert, so mail markup never runs or loads remote resources.
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll('script,style,iframe,object,svg')) element.remove();
  for (const element of template.content.querySelectorAll('br,p,div,li,tr,blockquote,pre')) element.after(document.createTextNode('\n'));
  return template.content.textContent.trim();
}

function gmailItem(message, full = false) {
  const payload = message.payload || {};
  const headers = new Map((payload.headers || []).map(header => [header.name.toLowerCase(), header.value]));
  const attachments = [];
  const plain = [];
  const html = [];
  const remoteBody = [];
  function inspect(node) {
    if (node.filename || (node.body?.attachmentId && !node.mimeType?.startsWith('text/'))) {
      attachments.push({ id: node.body?.attachmentId || node.partId || '0', name: node.filename || 'مرفق', type: node.mimeType, size: node.body?.size || 0,
        ...(full && !node.body?.attachmentId && node.body?.data ? { inline: node.body.data } : {}) });
      return;
    }
    if (full && ['text/plain', 'text/html'].includes(node.mimeType)) {
      if (node.body?.data) (node.mimeType === 'text/plain' ? plain : html).push(new TextDecoder().decode(fromBase64(node.body.data)));
      else if (node.body?.attachmentId) remoteBody.push({ id: node.body.attachmentId, type: node.mimeType });
    }
    for (const child of node.parts || []) inspect(child);
  }
  inspect(payload);
  const sent = Number(message.internalDate) || Date.parse(headers.get('date'));
  return {
    id: message.id, subject: headers.get('subject') || '', from: headers.get('from') || '',
    date: Number.isFinite(sent) ? new Date(sent).toISOString() : '', snippet: message.snippet || '', attachmentCount: attachments.length,
    unread: Boolean(message.labelIds?.includes('UNREAD')), flagged: Boolean(message.labelIds?.includes('STARRED')),
    ...(full ? { attachments, plain, html, remoteBody } : {}),
  };
}

function outlookItem(message) {
  return { id: message.id, subject: message.subject || '', from: message.from?.emailAddress?.address || '',
    date: message.receivedDateTime || '', snippet: message.bodyPreview || '',
    attachmentCount: message.hasAttachments ? 1 : 0, unread: message.isRead === false,
    flagged: message.flag?.flagStatus === 'flagged' };
}

function safeCursor(cursor, path) {
  if (!cursor) return null;
  const url = new URL(cursor);
  if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.pathname !== path) {
    throw new Error('رابط متابعة النتائج غير صالح.');
  }
  return url.href;
}

function recipients(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,;]/);
  const addresses = list.map(address => String(address).trim()).filter(Boolean);
  if (!addresses.length || addresses.some(address => !/^[^\s@<>,";:()[\]\\]+@[^\s@<>,";:()[\]\\]+\.[^\s@<>,";:()[\]\\]+$/.test(address)
      || /[\u0000-\u001f\u007f-\uffff]/.test(address))) throw new Error('أدخل عنوان بريد صالح للمستلم.');
  return addresses;
}

export function connectedAccounts({ googleToken, microsoftToken } = {}, request = fetch) {
  const tokens = { google: googleToken, microsoft: microsoftToken };

  async function api(provider, url, { method = 'GET', body, headers = {}, binary = false } = {}) {
    const token = tokens[provider];
    if (!token) throw new Error(`اربط حساب ${serviceName(provider)} أولاً.`);
    const response = await request(url, {
      method, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000),
      headers: { ...headers, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) throw new Error(`انتهت جلسة ${serviceName(provider)}. أعد ربط الحساب.`);
    if (response.status === 403) throw new Error(`الحساب لا يسمح بهذه العملية. راجع الصلاحيات الممنوحة في ${serviceName(provider)}.`);
    if (response.status === 429) throw new Error('المزوّد يحدّ الطلبات الآن. حاول بعد قليل.');
    if (!response.ok) throw new Error(`تعذّرت العملية لدى ${serviceName(provider)} (HTTP ${response.status}).`);
    if (response.status === 202 || response.status === 204) return;
    return binary ? response.blob() : response.json();
  }

  function account(provider) {
    if (provider !== 'google' && provider !== 'microsoft') throw new Error('اختر Google أو Microsoft.');
    return provider === 'google';
  }

  return {
    async searchMail(provider, query = '', { limit, cursor, unreadOnly, attachmentsOnly, from, review } = {}) {
      const count = pageSize(limit);
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const matchesReview = item => !item.unread && !item.flagged && !item.attachmentCount &&
        Number.isFinite(Date.parse(item.date)) && Date.parse(item.date) < Date.parse(cutoff);
      if (account(provider)) {
        const q = [query.trim(), from && 'from:' + from.trim().replace(/\s+/g, ''), unreadOnly && 'is:unread', attachmentsOnly && 'has:attachment',
          review && 'older_than:90d is:read -is:starred -has:attachment'].filter(Boolean).join(' ');
        const page = await api(provider, withParams(`${GOOGLE_MAIL}/messages`, { maxResults: count, pageToken: cursor, q }));
        const items = [];
        const messages = page.messages || [];
        for (let i = 0; i < messages.length; i += 5) {
          const details = await Promise.all(messages.slice(i, i + 5).map(({ id }) =>
            api(provider, withParams(`${GOOGLE_MAIL}/messages/${part(id)}`, { format: 'full',
              fields: 'id,labelIds,snippet,internalDate,payload' }))));
          items.push(...details.map(message => gmailItem(message)));
        }
        return { items: review ? items.filter(matchesReview) : items, cursor: page.nextPageToken };
      }
      const mailPath = '/v1.0/me/messages';
      const search = [query.trim().replaceAll('"', ''), from && 'from:' + from.trim().replace(/[\s"]/g, '')].filter(Boolean).join(' ');
      const filter = [unreadOnly && 'isRead eq false', attachmentsOnly && 'hasAttachments eq true',
        review && `receivedDateTime lt ${cutoff} and isRead eq true and hasAttachments eq false`].filter(Boolean).join(' and ');
      const params = {
        $top: count, $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,flag',
        $search: search ? `"${search}"` : '',
        ...(!search && filter ? { $filter: filter } : {}),
      };
      const page = await api(provider, safeCursor(cursor, mailPath) || withParams(`${GRAPH}/messages`, params));
      const items = (page.value || []).map(outlookItem);
      return { items: items.filter(item => (!unreadOnly || item.unread) && (!attachmentsOnly || item.attachmentCount)
        && (!review || matchesReview(item))), cursor: page['@odata.nextLink'] };
    },
    async readMail(provider, id) {
      if (account(provider)) {
        const url = `${GOOGLE_MAIL}/messages/${part(id)}`;
        const { plain, html, remoteBody, ...item } = gmailItem(await api(provider, withParams(url, { format: 'full' })), true);
        for (const body of remoteBody) {
          if (body.type === 'text/html' && plain.length) continue;
          const { data } = await api(provider, `${url}/attachments/${part(body.id)}`);
          if (data) (body.type === 'text/plain' ? plain : html).push(new TextDecoder().decode(fromBase64(data)));
        }
        return { ...item, body: plain.length ? plain.join('\n\n') : html.length ? textFromHtml(html.join('\n')) : item.snippet };
      }
      const url = `${GRAPH}/messages/${part(id)}`;
      const item = await api(provider, url, { headers: { Prefer: 'outlook.body-content-type="text"' } });
      const attachments = [];
      let next = withParams(`${url}/attachments`, { $select: 'id,name,size,contentType,isInline' });
      const path = new URL(next).pathname;
      while (next) {
        const page = await api(provider, next);
        for (const attachment of page.value || []) attachments.push({
          id: attachment.id, name: attachment.name || 'مرفق', size: attachment.size || 0, type: attachment.contentType,
        });
        next = safeCursor(page['@odata.nextLink'], path);
      }
      const body = item.body?.content || item.bodyPreview || '';
      return { ...outlookItem(item), body: item.body?.contentType === 'html' ? textFromHtml(body) : body, attachments, attachmentCount: attachments.length };
    },
    async mailAttachment(provider, id, attachment) {
      if (account(provider)) {
        const data = attachment.inline || (await api(provider, `${GOOGLE_MAIL}/messages/${part(id)}/attachments/${part(attachment.id)}`)).data;
        return new Blob([fromBase64(data)], { type: attachment.type || 'application/octet-stream' });
      }
      return api(provider, `${GRAPH}/messages/${part(id)}/attachments/${part(attachment.id)}/$value`, { binary: true });
    },
    async updateMail(provider, id, action) {
      if (!['read', 'unread', 'archive', 'trash'].includes(action)) throw new Error('إجراء البريد غير مدعوم.');
      if (account(provider)) {
        const url = `${GOOGLE_MAIL}/messages/${part(id)}`;
        if (action === 'trash') return api(provider, `${url}/trash`, { method: 'POST' });
        const body = action === 'unread' ? { addLabelIds: ['UNREAD'] } : { removeLabelIds: [action === 'archive' ? 'INBOX' : 'UNREAD'] };
        return api(provider, `${url}/modify`, { method: 'POST', body });
      }
      const url = `${GRAPH}/messages/${part(id)}`;
      if (action === 'archive' || action === 'trash') {
        return api(provider, `${url}/move`, { method: 'POST', body: { destinationId: action === 'archive' ? 'archive' : 'deleteditems' } });
      }
      return api(provider, url, { method: 'PATCH', body: { isRead: action === 'read' } });
    },
    trashMail(provider, id) { return this.updateMail(provider, id, 'trash'); },
    async sendMail(provider, { to, subject = '', body = '' }) {
      const addresses = recipients(to);
      if (typeof subject !== 'string' || typeof body !== 'string' || /[\u0000-\u001f\u007f]/.test(subject)) throw new Error('عنوان الرسالة غير صالح.');
      if (account(provider)) {
        const encoder = new TextEncoder();
        // Fold the UTF-8 subject into RFC 2047 encoded words without splitting Unicode characters.
        const encodedWords = [];
        let line = '';
        for (const char of subject) {
          if (encoder.encode(line + char).length > 42) {
            encodedWords.push(`=?UTF-8?B?${toBase64(encoder.encode(line))}?=`);
            line = '';
          }
          line += char;
        }
        if (line) encodedWords.push(`=?UTF-8?B?${toBase64(encoder.encode(line))}?=`);
        const encodedBody = toBase64(encoder.encode(body.replace(/\r\n|\r|\n/g, '\r\n'))).match(/.{1,76}/g)?.join('\r\n') || '';
        const mime = `To: ${addresses.join(', ')}\r\nSubject: ${encodedWords.join('\r\n ')}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodedBody}\r\n`;
        const raw = toBase64(encoder.encode(mime)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        return api(provider, `${GOOGLE_MAIL}/messages/send`, { method: 'POST', body: { raw } });
      }
      return api(provider, `${GRAPH}/sendMail`, { method: 'POST', body: {
        message: { subject, body: { contentType: 'Text', content: body }, toRecipients: addresses.map(address => ({ emailAddress: { address } })) },
      } });
    },
    async searchDrive(provider, query = '', { limit, cursor, parentId, foldersOnly } = {}) {
      const count = pageSize(limit);
      if (account(provider)) {
        const q = ['trashed = false', query.trim() && `fullText contains '${driveString(query.trim())}'`,
          parentId && `'${driveString(parentId)}' in parents`, foldersOnly && "mimeType = 'application/vnd.google-apps.folder'"].filter(Boolean).join(' and ');
        const page = await api(provider, withParams(GOOGLE_DRIVE, { q, pageSize: count, pageToken: cursor,
          fields: 'nextPageToken,files(id,name,size,mimeType,webViewLink,modifiedTime,parents)' }));
        return { items: (page.files || []).map(file => ({ id: file.id, name: file.name, size: file.size === undefined ? null : Number(file.size),
          folder: file.mimeType === 'application/vnd.google-apps.folder', url: file.webViewLink, modified: file.modifiedTime, parentId: file.parents?.[0] })),
        cursor: page.nextPageToken };
      }
      const folder = parentId && parentId !== 'root' ? `items/${part(parentId)}` : 'root';
      const endpoint = `${GRAPH}/drive/${folder}/${query.trim() ? `search(q='${encodeURIComponent(odataString(query.trim()))}')` : 'children'}`;
      const page = await api(provider, safeCursor(cursor, new URL(endpoint).pathname) || withParams(endpoint, { $top: count,
        $select: 'id,name,size,folder,webUrl,lastModifiedDateTime,parentReference' }));
      return { items: (page.value || []).map(file => ({ id: file.id, name: file.name, size: file.size ?? null,
        folder: Boolean(file.folder), url: file.webUrl, modified: file.lastModifiedDateTime, parentId: file.parentReference?.id }))
        .filter(file => !foldersOnly || file.folder), cursor: page['@odata.nextLink'] };
    },
    async moveDrive(provider, id, parentId) {
      if (account(provider)) {
        part(parentId);
        const url = `${GOOGLE_DRIVE}/${part(id)}`;
        const { parents = [] } = await api(provider, withParams(url, { fields: 'parents', supportsAllDrives: true }));
        if (parents.includes(parentId)) return;
        return api(provider, withParams(url, { addParents: parentId, removeParents: parents.join(','), supportsAllDrives: true }), { method: 'PATCH', body: {} });
      }
      const destination = parentId === 'root' ? (await api(provider, `${GRAPH}/drive/root?$select=id`)).id : parentId;
      part(destination);
      return api(provider, `${GRAPH}/drive/items/${part(id)}`, { method: 'PATCH', body: { parentReference: { id: destination } } });
    },
    async driveDownload(provider, id) {
      if (account(provider)) {
        const url = `${GOOGLE_DRIVE}/${part(id)}`;
        const { name, mimeType } = await api(provider, withParams(url, { fields: 'name,mimeType', supportsAllDrives: true }));
        const fileType = mimeType?.match(/^application\/vnd\.google-apps\.(.+)$/)?.[1];
        if (!fileType) return { name, blob: await api(provider, withParams(url, { alt: 'media', supportsAllDrives: true }), { binary: true }) };
        const output = {
          document: ['text/plain', 'txt'],
          spreadsheet: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
          presentation: ['application/pdf', 'pdf'],
          drawing: ['application/pdf', 'pdf'],
        }[fileType];
        if (!output) throw new Error('هذا النوع لا يدعم التنزيل المباشر من سوالف. افتحه في Google Drive.');
        const [format, extension] = output;
        return { name: `${name}.${extension}`, blob: await api(provider, withParams(`${url}/export`, { mimeType: format }), { binary: true }) };
      }
      const item = await api(provider, withParams(`${GRAPH}/drive/items/${part(id)}`, { $select: 'name,@microsoft.graph.downloadUrl' }));
      const url = new URL(item['@microsoft.graph.downloadUrl']);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !/(?:^|\.)(?:sharepoint\.com|1drv\.com|onedrive\.live\.com)$/i.test(url.hostname)) {
        throw new Error('رابط تنزيل OneDrive غير متاح.');
      }
      const response = await request(url.href, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error('تعذّر تنزيل الملف من OneDrive.');
      return { name: item.name, blob: await response.blob() };
    },
    async trashDrive(provider, id) {
      if (account(provider)) return api(provider, withParams(`${GOOGLE_DRIVE}/${part(id)}`, { supportsAllDrives: true }), { method: 'PATCH', body: { trashed: true } });
      return api(provider, `${GRAPH}/drive/items/${part(id)}`, { method: 'DELETE' });
    },
  };
}
