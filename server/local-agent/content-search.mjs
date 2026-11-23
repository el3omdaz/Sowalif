import { extname } from 'node:path';
import { readZipEntries } from '../../js/zip-text.js?v=40';

const DOCUMENT_BYTES = 64 * 1024 * 1024;
const EXPANDED_BYTES = 128 * 1024 * 1024;
const textExtensions = new Set('txt md csv tsv log json jsonl xml html htm css js mjs cjs ts tsx jsx py rb php cs cpp c h java go rs toml conf ini yaml yml sh bat ps1 sql svg mq4 mq5 mqh'.split(' '));
const packageExtensions = new Set(['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'odt', 'ods', 'odp']);
const legacy = new Set(['doc', 'xls', 'ppt', 'pages', 'numbers', 'key', 'zip', 'rar', '7z']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic']);

export const normalizeSearchText = value => String(value).normalize('NFKC').toLowerCase()
  .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
  .replace(/[\u064b-\u065f\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/\s+/g, ' ');
const escapePattern = text => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
function literalMatch(text, query) {
  const position = text.indexOf(query);
  if (position >= 0) return { position, length: query.length };
  // Separators may differ between Word paragraphs, PDF lines, and filenames.
  // Keep every word intact: a phrase must not match joined or omitted words.
  const words = query.split(/\s+/);
  if (words.length < 2) return null;
  const match = new RegExp(words.map(escapePattern).join('[\\s\\p{P}]+'), 'u').exec(text);
  return match ? { position: match.index, length: match[0].length } : null;
}
export const streamsSearchText = name => {
  const extension = extname(name).slice(1).toLowerCase();
  return textExtensions.has(extension) && !/^(?:html?|xml|svg)$/.test(extension);
};

export function fileNameMatches(name, query) {
  const needle = normalizeSearchText(query).trim();
  const haystack = normalizeSearchText(name);
  if (!needle) return true;
  if (!/[?*]/.test(needle)) return Boolean(literalMatch(haystack, needle));
  const expression = needle.split(/([?*])/).map(part => part === '*' ? '.*' : part === '?' ? '.' : part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('');
  return new RegExp('^' + expression + '$', 'u').test(haystack);
}

function entities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (!entity.startsWith('#')) return names[entity.toLowerCase()] || whole;
    const number = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : whole;
  });
}

export function markupText(text) {
  text = text.replace(/<!doctype\s+html\s*>/gi, '');
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new Error('تعريفات XML الخارجية غير مدعومة أثناء البحث.');
  return entities(text.replace(/<!--[\s\S]*?-->/g, '').replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, '')
    .replace(/<(?:[\w.-]+:)?(?:tab)\b[^>]*\/?\s*>/gi, '\t')
    .replace(/<\/(?:[\w.-]+:)?(?:p|tr|row|si|c|div|h[1-6]|li|table)\s*>|<(?:[\w.-]+:)?(?:br|cr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
}

export function rtfText(source) {
  const stack = [{ skip: false, uc: 1 }];
  let result = '', fallback = 0, decoder = new TextDecoder('windows-1252');
  const destinations = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'headerf', 'footerf', 'datastore', 'themedata']);
  const append = value => { if (fallback) fallback--; else if (!stack.at(-1).skip) result += value; };
  for (let i = 0; i < source.length;) {
    const char = source[i++];
    if (char === '{') { stack.push({ ...stack.at(-1) }); continue; }
    if (char === '}') { if (stack.length > 1) stack.pop(); continue; }
    if (char !== '\\') { if (char !== '\r' && char !== '\n') append(char); continue; }
    const symbol = source[i++];
    if (symbol === '*') { stack.at(-1).skip = true; continue; }
    if (symbol === "'") { append(decoder.decode(Uint8Array.of(parseInt(source.slice(i, i + 2), 16) || 0))); i += 2; continue; }
    if ('{}\\'.includes(symbol || '')) { append(symbol); continue; }
    if (symbol === '~') { append(' '); continue; }
    if (!/[a-z]/i.test(symbol || '')) continue;
    const control = /^[a-z]+(?:-?\d+)? ?/i.exec(source.slice(i - 1))[0];
    i += control.length - 1;
    const [, word, argument] = /^([a-z]+)(-?\d+)?/i.exec(control);
    const state = stack.at(-1);
    if (destinations.has(word)) state.skip = true;
    if (word === 'uc') state.uc = Math.max(0, Number(argument) || 0);
    if (word === 'ansicpg') { try { decoder = new TextDecoder(Number(argument) === 65001 ? 'utf-8' : 'windows-' + argument); } catch { /* Preserve Unicode escapes independently. */ } }
    if (word === 'u') { if (!state.skip) result += String.fromCharCode((Number(argument) + 65536) % 65536); fallback = state.uc; }
    if (word === 'par' || word === 'line') append('\n');
    if (word === 'tab') append('\t');
    if (word === 'bin' && Number(argument) > 0) i += Number(argument);
  }
  return result;
}

function decoderFor(bytes) {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le');
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); }
  catch { return new TextDecoder('windows-1256'); }
  return new TextDecoder('utf-8');
}

function sampleResult(text, query, format, extra = {}, alternatives = []) {
  const normalized = normalizeSearchText(text);
  const found = [query, ...alternatives].map(value => normalizeSearchText(value).trim()).filter(Boolean)
    .map(value => { const match = literalMatch(normalized, value); return match && { value, ...match }; }).filter(Boolean).sort((a, b) => a.position - b.position)[0];
  if (!found) return { matched: false, format, ...extra };
  // Map only a found range, without retaining a per-character index for huge
  // documents. The snippet and offsets refer to the original extracted text.
  const [offset, endOffset] = sourceBoundaries(text, found.position, found.position + found.length);
  return { matched: true, matchedQuery: found.value, offset, endOffset,
    snippet: text.slice(Math.max(0, offset - 90), endOffset + 140).trim(), format, ...extra };
}

function sourceBoundaries(text, start, end) {
  let source = 0, normalized = 0, previousSpace = false, from, to;
  while (source < text.length && to === undefined) {
    let next = Math.min(source + 4096, text.length);
    // Keep combining sequences together across coarse block boundaries.
    while (next < text.length && /[\p{M}\u1100-\u11ff\uff9e\uff9f\udc00-\udfff]/u.test(text[next])) next++;
    const raw = text.slice(source, next), folded = normalizeSearchText(raw);
    const duplicateSpace = previousSpace && folded.startsWith(' ');
    const length = folded.length - Number(duplicateSpace);
    const boundary = (position, after) => {
      let low = 0, high = raw.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const prefix = normalizeSearchText(raw.slice(0, middle));
        const size = prefix.length - Number(duplicateSpace && prefix.startsWith(' '));
        if (after ? size < position : size <= position) low = middle + 1;
        else high = middle;
      }
      return source + (after ? low : Math.max(0, low - 1));
    };
    if (from === undefined && start < normalized + length) from = boundary(start - normalized, false);
    if (end <= normalized + length) to = boundary(end - normalized, true);
    normalized += length;
    if (folded) previousSpace = folded.endsWith(' ');
    source = next;
  }
  return [from ?? text.length, to ?? text.length];
}

export function pdfItemsText(items) {
  let text = '', previous;
  for (const item of items || []) {
    if (typeof item?.str !== 'string') continue;
    if (previous && text && item.str && !/\s$/u.test(text) && !/^\s/u.test(item.str)) {
      let separator = ' ';
      const before = previous.transform, current = item.transform;
      if (Array.isArray(before) && Array.isArray(current) && before.length >= 6 && current.length >= 6) {
        const scale = Math.hypot(before[0], before[1]);
        if (scale > 0 && Number.isFinite(previous.width) && Number.isFinite(item.width)) {
          const x = before[0] / scale, y = before[1] / scale;
          const fontSize = Math.max(scale, Math.hypot(current[0], current[1]), 1);
          const lineDistance = Math.abs((current[4] - before[4]) * -y + (current[5] - before[5]) * x);
          const start = before[4] * x + before[5] * y;
          const next = current[4] * x + current[5] * y;
          const gap = Math.max(next - (start + previous.width), start - (next + item.width));
          separator = lineDistance > fontSize * .5 ? '\n' : gap > fontSize * .15 ? ' ' : '';
        }
      }
      text += separator;
    }
    text += item.str;
    if (item.hasEOL && !text.endsWith('\n')) text += '\n';
    previous = item;
  }
  return text.trim();
}

async function bytesOf(file, size, signal, onBytes) {
  if (size > DOCUMENT_BYTES) return null;
  const chunks = [];
  for await (const chunk of file.createReadStream({ autoClose: false, start: 0, signal })) {
    signal?.throwIfAborted();
    onBytes?.(chunk.length);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function packageText(bytes, extension, signal) {
  const readable = name => /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/i.test(name)
    || /^xl\/(?:sharedStrings|worksheets\/[^/]+)\.xml$/i.test(name)
    || /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i.test(name)
    || /^(?:content|meta)\.xml$/i.test(name);
  const { entries, inventory } = await readZipEntries(new Blob([bytes]), readable, signal, { maxExpandedBytes: EXPANDED_BYTES, tolerateErrors: true });
  const failed = inventory.filter(entry => readable(entry.name) && !entry.readable);
  const embeddedImages = inventory.some(entry => /^(?:word|xl|ppt)\/media\//i.test(entry.name) || /^Pictures\//i.test(entry.name));
  const sections = [];
  for (const [name, xml] of entries) {
    try { sections.push(`[${name}]\n` + markupText(xml)); }
    catch (error) { failed.push({ name, error: error.message }); }
  }
  if (!sections.length) throw new Error('لم تُقرأ أجزاء المستند النصية؛ قد يكون مشفرًا أو غير صالح.');
  return { text: sections.join('\n\n'), format: extension, incomplete: failed.length > 0 || embeddedImages,
    reason: failed.length ? 'تعذّر قراءة بعض أجزاء المستند.' : embeddedImages ? 'المستند يحتوي صورًا؛ النص داخلها يحتاج OCR ولا يشمله البحث الحالي.' : undefined };
}

let pdfModule;
async function pdfText(bytes, signal) {
  pdfModule ||= import('../../vendor/pdf.mjs').then(pdf => {
    pdf.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.mjs', import.meta.url).href;
    return pdf;
  });
  const pdf = await pdfModule;
  const loading = pdf.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, disableFontFace: true });
  const abort = () => { void loading.destroy().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const document = await loading.promise;
    const out = [], unreadablePages = [];
    for (let number = 1; number <= document.numPages; number++) {
      signal?.throwIfAborted();
      let page;
      try {
        page = await document.getPage(number);
        const content = await page.getTextContent();
        const text = pdfItemsText(content.items);
        out.push(`[صفحة ${number}]\n${text}`);
        const operators = await page.getOperatorList();
        const containsImage = operators.fnArray.some(operator => [pdf.OPS.paintImageXObject, pdf.OPS.paintInlineImageXObject, pdf.OPS.paintImageMaskXObject].includes(operator));
        if (!text || containsImage) unreadablePages.push(number);
      } catch (error) { signal?.throwIfAborted(); unreadablePages.push(number); }
      finally { page?.cleanup(); }
    }
    return { text: out.join('\n\n'), format: 'pdf', pages: document.numPages, incomplete: unreadablePages.length > 0,
      reason: unreadablePages.length ? 'صفحات PDF فارغة نصيًا أو تتضمن صورًا؛ نص الصور يحتاج OCR ولا يشمله البحث الحالي.' : undefined, unreadablePages };
  } finally { signal?.removeEventListener('abort', abort); await loading.destroy().catch(() => {}); }
}

export async function extractKnownFileText(file, { name, size, signal, onBytes } = {}) {
  const extension = extname(name).slice(1).toLowerCase();
  if (legacy.has(extension) || imageExtensions.has(extension)) return { text: '', format: extension, unsupported: true, reason: imageExtensions.has(extension) ? 'الصور تحتاج OCR؛ البحث الحالي لا يقرأ النص داخلها.' : 'هذا التنسيق يحتاج أداة إضافية لاستخراج نصه.' };
  const bytes = await bytesOf(file, size, signal, onBytes);
  if (!bytes) return { text: '', format: extension, incomplete: true, reason: 'المستند أكبر من 64 ميجابايت؛ ضيّق البحث أو افتحه مباشرة.' };
  if (packageExtensions.has(extension)) return packageText(bytes, extension, signal);
  if (extension === 'pdf') return pdfText(bytes, signal);
  const text = decoderFor(bytes).decode(bytes);
  if (extension === 'rtf') return { text: rtfText(text), format: extension };
  if (/^(?:html?|xml|svg)$/.test(extension)) return { text: markupText(text), format: extension };
  if (!textExtensions.has(extension) && !/^(?:readme|makefile|dockerfile)$/i.test(name) && /\0/.test(text.slice(0, 4096))) return { text: '', format: extension, unsupported: true, reason: 'ملف ثنائي لا يتوفر له قارئ نصي.' };
  return { text, format: extension || 'text' };
}

export async function searchKnownFile(file, options) {
  const extension = extname(options.name).slice(1).toLowerCase();
  // Plain text is streamed, so late matches do not disappear behind a 1MB cap.
  if (streamsSearchText(options.name)) {
    let decoder = options.resume?.decoder, tail = options.resume?.tail || '', result;
    let offset = options.resume?.offset || 0;
    let characters = options.resume?.characters || 0;
    const query = normalizeSearchText(options.query).trim();
    const longest = Math.max(query.length, ...(options.queries || []).map(value => normalizeSearchText(value).length));
    for await (const chunk of file.createReadStream({ autoClose: false, start: offset, signal: options.signal })) {
      options.signal?.throwIfAborted();
      options.onBytes?.(chunk.length);
      decoder ||= decoderFor(chunk);
      const decoded = decoder.decode(chunk, { stream: true });
      const textStart = characters - tail.length;
      const text = tail + decoded;
      result = sampleResult(text, query, extension, {}, options.queries);
      if (result.matched) return { ...result, offset: result.offset + textStart, endOffset: result.endOffset + textStart };
      characters += decoded.length;
      tail = text.slice(-Math.max(4096, longest * 8));
      offset += chunk.length;
      options.onProgress?.({ offset, tail, decoder, characters });
    }
    result = sampleResult(tail + (decoder?.decode() || ''), query, extension, {}, options.queries);
    return result.matched ? { ...result, offset: result.offset + characters - tail.length, endOffset: result.endOffset + characters - tail.length } : result;
  }
  const extracted = await extractKnownFileText(file, options);
  const { text, ...metadata } = extracted;
  return { ...sampleResult(text, options.query, metadata.format, {}, options.queries), ...metadata };
}
