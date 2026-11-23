import test from 'node:test';
import assert from 'node:assert/strict';
import { organizerIntent } from '../js/organizer-intent.js?v=50';

test('file commands retain the search phrase and recognize size and duplicate reports', () => {
  assert.deepEqual(organizerIntent('ابحثلي عن ملف اسمه «أعمال 2026.PDF»؟', 'files'), { action: 'find', query: 'أعمال 2026.PDF' });
  assert.deepEqual(organizerIntent('دور داخل الملفات عن "رقم العقد"', 'files'), { action: 'find', query: 'رقم العقد', searchContent: true, searchIn: 'content' });
  assert.deepEqual(organizerIntent('شوف لي الملفات المتكررة', 'files'), { action: 'duplicates' });
  assert.deepEqual(organizerIntent('شوف لي أكبر حجم من الملفات', 'files'), { action: 'largest' });
  assert.deepEqual(organizerIntent('شوف لي أكبر ٢٠ ملف بامتداد .zip', 'files'), { action: 'largest', limit: 20, query: '.zip' });
  assert.deepEqual(organizerIntent('اعرض الملفات', 'files'), { action: 'browse' });
});

test('content searches separate the exact phrase from a named file, document type or whole-disk scope', () => {
  const content = { action: 'find', searchContent: true, searchIn: 'content' };
  for (const request of ['ابحث لي عن كلمة مطار داخل ملف وورد', 'find word مطار in Word files']) {
    assert.deepEqual(organizerIntent(request, 'files'), { ...content, query: 'مطار', fileTypes: ['docx', 'doc'] });
  }
  for (const request of ['ابحث عن كلمة مطار داخل أي ملف موجود على القرص', 'ابحث في محتوى الملفات عن «مطار»', 'ابحث عن ملفات تحتوي على كلمة مطار', 'search for files containing مطار']) {
    assert.deepEqual(organizerIntent(request, 'files'), { ...content, query: 'مطار' }, request);
  }
  assert.deepEqual(organizerIntent('دور لي على كلمة «مطار الكويت» في ملف اسمه «خطة السفر.docx»', 'files'), { ...content, query: 'مطار الكويت', fileQuery: 'خطة السفر.docx' });
  assert.deepEqual(organizerIntent('ابحث عن ملف «التقرير.docx» يحتوي على عبارة «بوابة المطار»', 'files'), { ...content, query: 'بوابة المطار', fileQuery: 'التقرير.docx' });
  assert.deepEqual(organizerIntent('find airport inside report.docx', 'files'), { ...content, query: 'airport', fileQuery: 'report.docx' });
  assert.deepEqual(organizerIntent('ابحث عن كلمة مطار داخل ملف PDF', 'files'), { ...content, query: 'مطار', fileTypes: ['pdf'] });
});

test('filename commands do not search for command prose or confuse a preposition inside the filename', () => {
  for (const request of ['دور لي على ملف اسمه «دراسة في المطار.docx»', 'شوف لي ملف اسمه «دراسة في المطار.docx»', 'ابحث عن «دراسة في المطار.docx»']) {
    assert.deepEqual(organizerIntent(request, 'files'), { action: 'find', query: 'دراسة في المطار.docx' }, request);
  }
  assert.deepEqual(organizerIntent('ابحث عن ملف اسمه «تقرير يحتوي على مطار.docx»', 'files'), { action: 'find', query: 'تقرير يحتوي على مطار.docx' });
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
