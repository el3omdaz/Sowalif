import test from 'node:test';
import assert from 'node:assert/strict';
import { organizerIntent } from '../js/organizer-intent.js';

test('file commands retain the search phrase and recognize size and duplicate reports', () => {
  assert.deepEqual(organizerIntent('ابحثلي عن ملف اسمه «أعمال 2026.PDF»؟', 'files'), { action: 'find', query: 'أعمال 2026.PDF' });
  assert.deepEqual(organizerIntent('دور داخل الملفات عن "رقم العقد"', 'files'), { action: 'find', query: 'رقم العقد', searchContent: true });
  assert.deepEqual(organizerIntent('شوف لي الملفات المتكررة', 'files'), { action: 'duplicates' });
  assert.deepEqual(organizerIntent('شوف لي أكبر حجم من الملفات', 'files'), { action: 'largest' });
  assert.deepEqual(organizerIntent('شوف لي أكبر ٢٠ ملف بامتداد .zip', 'files'), { action: 'largest', limit: 20, query: '.zip' });
  assert.deepEqual(organizerIntent('اعرض الملفات', 'files'), { action: 'browse' });
});

test('mail commands recognize attachment, sender and unread filters without taking action', () => {
  assert.deepEqual(organizerIntent('شنو الإيميلات اللي فيها مرفقات؟', 'mail'), { action: 'search', query: '', attachmentsOnly: true });
  assert.deepEqual(organizerIntent('ابحث عن رسائل من sender@example.com فيها مرفقات', 'mail'), { action: 'search', query: '', from: 'sender@example.com', attachmentsOnly: true });
  assert.deepEqual(organizerIntent('show unread emails from sender@example.com with attachments', 'mail'), { action: 'search', query: '', from: 'sender@example.com', unreadOnly: true, attachmentsOnly: true });
  assert.deepEqual(organizerIntent('ابحث في البريد عن "فاتورة الكهرباء"', 'mail'), { action: 'search', query: 'فاتورة الكهرباء' });
  assert.deepEqual(organizerIntent('عطني تقرير عن الإيميلات اللي ما احتاجها', 'mail'), { action: 'search', query: '', review: true });
});

test('unsupported and destructive commands require more explicit controls', () => {
  for (const [source, command] of [
    ['mail', 'احذف الإيميلات اللي ما احتاجها'],
    ['mail', 'send an email to sender@example.com'],
    ['mail', 'اقرأ الرسالة وأرسل الرد'],
    ['files', 'امسح الملفات المتكررة'],
    ['files', 'show 999 largest files'],
    ['files', 'شوف لي أكبر ٠ ملف'],
    ['drive', 'show largest files'],
    ['drive', 'move file into backup'],
  ]) assert.equal(organizerIntent(command, source), null, command);
  assert.deepEqual(organizerIntent('ابحث عن ملف اسمه notes.txt', 'drive'), { action: 'search', query: 'notes.txt' });
});
