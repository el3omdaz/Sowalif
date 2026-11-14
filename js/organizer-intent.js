const AR_SEARCH = /^(?:[اأإ]بحث|دوّ?ر|فتّ?ش|لقّ?ي)(?:\s*لي)?\s+/i;
const EN_SEARCH = /^(?:search|find|look for)\s+/i;
const AR_SHOW = /^(?:[اأإ]عرض|ورّ?ني|شوف(?:\s*لي)?|طلّ?ع(?:\s*لي)?|عط(?:ني|نيّ))\s+/i;
const EN_SHOW = /^(?:show(?: me)?|list|report(?: on)?|review)\s+/i;
const AR_FILE = '(?:ال)?(?:ملفات|ملف)';
const AR_MAIL = '(?:ال)?(?:[إا]يميل(?:ات)?|رسائل(?: البريد)?|بريد)';

// Match commands separately from user-supplied search text so filenames and
// phrases keep their spelling and punctuation.
function commandText(text) {
  return text.replace(/[\u064b-\u065f\u0670]/g, '').replace(/[أإآ]/g, 'ا').replace(/[؟?!،。]+$/, '').trim().toLowerCase();
}

function searchText(text) {
  const value = text.trim().replace(/[؟?]$/, '').trim();
  const quoted = /^(?:"([^"]+)"|'([^']+)'|«([^»]+)»|“([^”]+)”)$/u.exec(value);
  return quoted ? (quoted[1] || quoted[2] || quoted[3] || quoted[4]).trim() : value;
}

function stripPrefix(text, ...prefixes) {
  for (const pattern of prefixes) {
    if (pattern.test(text)) return text.replace(pattern, '');
  }
  return text;
}

function fileQuery(text) {
  return stripPrefix(text, new RegExp(`^(?:عن\\s+)?${AR_FILE}\\s+(?:(?:اسمه|باسم|بعنوان)\\s+)?`, 'i'),
    /^(?:for\s+)?(?:the\s+)?files?\s+(?:(?:named|called)\s+)?/i, /^(?:عن|for)\s+/i);
}

const fileReports = [
  ['duplicates', /^(?:الملفات المكرر[ةه]|الملفات المتكرر[ةه]|تكرار الملفات|[اأ]ي ملفات مكرر[ةه]|ملفات مكرر[ةه]|duplicates|duplicate files|duplicated files)$/i],
  ['largest', /^(?:اكبر(?:\s+حجم(?:\s+من)?)?\s+(?:ال)?ملف(?:ات)?|(?:ال)?ملفات(?:\s+ذات)?\s+(?:ال)?(?:اكبر|اضخم)\s+حجم|(?:the\s+)?(?:largest|biggest) files)$/i],
  ['browse', /^(?:الملفات|ملفات(?: الكمبيوتر| الجهاز)?|files|computer files)$/i],
];
const fileReportLimit = /^(?:اكبر\s+(\d{1,3})\s+ملف(?:ات)?|(?:largest|biggest)\s+(\d{1,3})\s+files|top\s+(\d{1,3})\s+(?:largest|biggest)\s+files)$/i;
const arabicDigits = digit => String('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) % 10);

function localFiles(text, source) {
  const requested = commandText(stripPrefix(text, AR_SHOW, EN_SHOW, AR_SEARCH, EN_SEARCH)).replace(/^(?:لي|عن|for)\s+/i, '');
  const extension = /(?:\s+(?:من نوع|بامتداد|of type|with extension)\s+)(\.[a-z0-9]{1,12})$/i.exec(requested);
  const report = extension ? requested.slice(0, extension.index) : requested;
  const count = fileReportLimit.exec(report.replace(/[٠-٩۰-۹]/g, arabicDigits));
  if (count) {
    const limit = Number(count[1] || count[2] || count[3]);
    if (source !== 'files' || limit < 1 || limit > 200) return null;
    return { action: 'largest', limit, ...(extension ? { query: extension[1] } : {}) };
  }
  for (const [action, pattern] of fileReports) {
    if (!pattern.test(report)) continue;
    if (source === 'drive') return action === 'browse' && !extension ? { action: 'search', query: '' } : null;
    if (!extension) return { action };
    return action === 'browse' ? { action: 'find', query: extension[1] } : { action, query: extension[1] };
  }

  const search = stripPrefix(text, AR_SEARCH, EN_SEARCH);
  if (source === 'files' && search !== text) {
    const contentMatch = /^(?:(?:في|داخل) (?:محتوى )?الملفات (?:عن )?(.+)|عن (?:نص |كلمة )?(.+) (?:داخل|في) (?:محتوى )?الملفات|(?:in|inside) (?:the )?files for (.+)|(?:for )?files containing (.+))$/i.exec(search);
    if (contentMatch) {
      const query = searchText(contentMatch.slice(1).find(Boolean));
      if (query) return { action: 'find', query, searchContent: true };
      return null;
    }
  }

  const target = search !== text ? search : stripPrefix(text, /^(?:وين|اين|أين|وينه|where is)\s+/i);
  const name = searchText(target);
  const query = target !== text ? searchText(fileQuery(target))
    : /^[^\s:"<>|?*@]+\.[a-z0-9]{1,12}$/i.test(name) ? name : '';
  if (!query || /^(?:عن|ملف(?:ات)?|for|files?)$/i.test(query)) return null;
  return { action: source === 'files' ? 'find' : 'search', query };
}

function mailIntent(text) {
  const requested = stripPrefix(text, /^(?:(?:سو|سوي|سوّي)\s+لي|عطني)\s+تقرير(?:\s+عن)?\s+/i, AR_SHOW, EN_SHOW, AR_SEARCH, EN_SEARCH,
    /^(?:شنو|وش|ايش)\s+/i);
  const control = commandText(requested).replace(/^(?:عن|for)\s+/i, '');
  // Review results are candidates for the user to assess, never deletion rules.
  const review = /^(?:(?:ال)?(?:ايميل(?:ات)?|رسائل(?: البريد)?) (?:اللي |التي )?(?:ما احتاجها|غير الضرورية|قديمة|مزعجة)|(?:unneeded|unnecessary|old|low-priority|potentially unwanted) (?:emails|messages)|(?:emails|messages) (?:i (?:don't|do not) need|to review))$/i;
  if (review.test(control)) return { action: 'search', query: '', review: true };

  const sender = /\s+(?:من|from)\s+([\w.!#$%&'*+/=?^_`{|}~-]+@[\w.-]+\.[a-z]{2,})(?=\s|$)/i.exec(control);
  const criteria = sender ? control.slice(0, sender.index) + control.slice(sender.index + sender[0].length) : control;
  const mailOnly = /^(?:(?:ال)?(?:ايميل(?:ات)?|رسائل(?: البريد)?|بريد)(?: (?:اللي|التي))?(?: (?:فيها|مع|تحتوي على) مرفقات?| (?:غير (?:المقروءة|مقروءة)|ما قريتها))*|(?:my |the )?(?:unread )?(?:e-?mails?|messages?)(?: with attachments?)?)$/i;
  if (mailOnly.test(criteria)) {
    return {
      action: 'search', query: '',
      ...(sender ? { from: sender[1] } : {}),
      ...(/مرفق|attachments?/i.test(criteria) ? { attachmentsOnly: true } : {}),
      ...(/غير (?:المقروءة|مقروءة)|ما قريتها|\bunread\b/i.test(criteria) ? { unreadOnly: true } : {}),
    };
  }

  const search = stripPrefix(text, AR_SEARCH, EN_SEARCH);
  if (search === text) return null;
  const target = stripPrefix(search, /^(?:في|داخل)\s+(?:البريد|[اإ]يميلي|الإيميل)\s+عن\s+/i,
    /^(?:in )?(?:my |the )?(?:mail|e-?mails?|messages?)\s+for\s+/i,
    new RegExp(`^(?:عن\\s+)?${AR_MAIL}\\s+(?:(?:بعنوان|باسم|عن)\\s+)?`, 'i'),
    /^(?:for )?(?:an? )?(?:the )?(?:e-?mails?|messages?)\s+(?:(?:about|titled)\s+)?/i, /^(?:عن|for)\s+/i);
  const query = searchText(target);
  if (!query || /^(?:عن|for|in(?: the)? mail|(?:ال)?[إا]يميل(?:ات)?|(?:ال)?بريد|e-?mails?)$/i.test(query)) return null;
  return { action: 'search', query };
}

export function organizerIntent(text, source) {
  if (typeof text !== 'string') return null;
  const request = text.trim().replace(/^(?:ممكن|لو سمحت|تكفى|please)\s+/i, '');
  if (!request || /[\r\n]/.test(request)) return null;
  if (source === 'files' || source === 'drive') return localFiles(request, source);
  if (source === 'mail') return mailIntent(request);
  return null;
}
