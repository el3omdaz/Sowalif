import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedAccounts } from '../js/connected-accounts.js';
import { connectGoogle } from '../js/account-oauth.js';

const old = Date.parse('2020-01-01T00:00:00Z');
const utf8 = value => Buffer.from(value).toString('base64url');
const gmailMessage = {
  id: 'm1', labelIds: [], internalDate: String(old), snippet: 'تحية',
  payload: {
    mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'ملف مهم' }, { name: 'From', value: 'example@example.com' }],
    parts: [
      { mimeType: 'text/plain', body: { data: utf8('أهلاً') } },
      { filename: 'example.txt', mimeType: 'text/plain', body: { attachmentId: 'att1', size: 7 } },
    ],
  },
};

test('Gmail searches, reads plain text, downloads a requested attachment and trashes the selected message', async () => {
  const calls = [];
  const client = connectedAccounts({ googleToken: 'test-google' }, async (url, options) => {
    calls.push([new URL(url), options]);
    if (url.endsWith('/trash')) return Response.json({});
    if (url.includes('/attachments/')) return Response.json({ data: utf8('content') });
    if (url.includes('/messages/m1')) return Response.json(gmailMessage);
    return Response.json({ messages: [{ id: 'm1' }], nextPageToken: 'next' });
  });
  const page = await client.searchMail('google', 'important', { from: 'example@example.com', attachmentsOnly: true });
  assert.equal(calls[0][0].searchParams.get('q'), 'important from:example@example.com has:attachment');
  assert.equal(page.cursor, 'next');
  assert.equal(page.items[0].attachmentCount, 1);
  const message = await client.readMail('google', 'm1');
  assert.equal(message.body, 'أهلاً');
  assert.equal(await (await client.mailAttachment('google', 'm1', message.attachments[0])).text(), 'content');
  await client.trashMail('google', 'm1');
  assert.equal(calls.at(-1)[0].pathname, '/gmail/v1/users/me/messages/m1/trash');
  assert.equal(calls.at(-1)[1].method, 'POST');
  assert.ok(calls.every(([url, options]) => url.hostname === 'gmail.googleapis.com' && options.headers.Authorization === 'Bearer test-google' && options.redirect === 'error'));
});

test('Gmail plain-text sending preserves Arabic and rejects header injection', async () => {
  let sent;
  const client = connectedAccounts({ googleToken: 'test-google' }, async (url, options) => {
    assert.ok(url.endsWith('/messages/send'));
    assert.equal(options.method, 'POST');
    sent = Buffer.from(JSON.parse(options.body).raw, 'base64url').toString();
    return Response.json({ id: 'sent' });
  });
  await assert.rejects(client.sendMail('google', { to: 'to@example.com', subject: 'مرحبًا\nBcc: other@example.com', body: 'رسالة' }), /صالح/);
  assert.equal(sent, undefined);
  await client.sendMail('google', { to: 'to@example.com', subject: 'مرحبًا', body: 'رسالة' });
  assert.match(sent, /To: to@example\.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.equal(Buffer.from(sent.split('\r\n\r\n')[1], 'base64').toString(), 'رسالة');
});

test('Outlook review only identifies old, read, unflagged mail without attachments', async () => {
  const base = { receivedDateTime: new Date(old).toISOString(), isRead: true };
  const client = connectedAccounts({ microsoftToken: 'test-ms' }, async url => {
    const search = new URL(url);
    assert.match(search.searchParams.get('$filter'), /isRead eq true and hasAttachments eq false/);
    return Response.json({ value: [{ ...base, id: 'candidate' }, { ...base, id: 'flagged', flag: { flagStatus: 'flagged' } },
      { ...base, id: 'unread', isRead: false }, { ...base, id: 'file', hasAttachments: true },
      { ...base, id: 'new', receivedDateTime: new Date().toISOString() }] });
  });
  assert.deepEqual((await client.searchMail('microsoft', '', { review: true })).items.map(item => item.id), ['candidate']);
  await assert.rejects(client.searchMail('microsoft', '', { cursor: 'https://example.com/v1.0/me/messages' }), /غير صالح/);
});

test('Graph moves Outlook messages to Deleted Items and downloads OneDrive files without an auth header', async () => {
  const calls = [];
  const client = connectedAccounts({ microsoftToken: 'test-ms' }, async (url, options) => {
    calls.push([url, options]);
    if (url.includes('graph.microsoft.com')) {
      assert.equal(options.headers.Authorization, 'Bearer test-ms');
      if (url.endsWith('/move')) return Response.json({});
      return Response.json({ name: 'one.txt', '@microsoft.graph.downloadUrl': 'https://files.1drv.com/file' });
    }
    assert.equal(url, 'https://files.1drv.com/file');
    assert.equal(options.headers, undefined);
    assert.equal(options.credentials, 'omit');
    return new Response('downloaded');
  });
  await client.trashMail('microsoft', '123');
  assert.deepEqual(JSON.parse(calls[0][1].body), { destinationId: 'deleteditems' });
  const file = await client.driveDownload('microsoft', '123');
  assert.equal(file.name, 'one.txt');
  assert.equal(await file.blob.text(), 'downloaded');
});

test('Google Drive search escapes quotes and an export downloads a native document as text', async () => {
  const client = connectedAccounts({ googleToken: 'test-google' }, async url => {
    const link = new URL(url);
    if (link.pathname.endsWith('/export')) {
      assert.equal(link.searchParams.get('mimeType'), 'text/plain');
      return new Response('مستند');
    }
    if (link.pathname.endsWith('/file')) return Response.json({ name: 'اسم', mimeType: 'application/vnd.google-apps.document' });
    assert.equal(link.searchParams.get('q'), "trashed = false and fullText contains 'a\\'b'");
    return Response.json({ files: [{ id: 'file', name: 'اسم' }] });
  });
  assert.equal((await client.searchDrive('google', "a'b")).items[0].id, 'file');
  const file = await client.driveDownload('google', 'file');
  assert.equal(file.name, 'اسم.txt');
  assert.equal(await file.blob.text(), 'مستند');
});

test('Google consent must grant all requested scopes', async t => {
  t.after(() => { delete globalThis.google; });
  const id = 'test.apps.googleusercontent.com';
  globalThis.google = { accounts: { oauth2: {
    initTokenClient: options => ({ requestAccessToken: () => options.callback({ access_token: 'fake' }) }),
    hasGrantedAllScopes: () => false,
  } } };
  await assert.rejects(connectGoogle(id), /لم تُمنح/);
  globalThis.google.accounts.oauth2.hasGrantedAllScopes = () => true;
  assert.equal(await connectGoogle(id), 'fake');
});
