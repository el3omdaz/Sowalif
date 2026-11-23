import { readZipEntries } from './zip-text.js?v=50';

const relevantPart = /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/u;
const spreadsheetBase = new URL('https://xlsx.invalid/xl/workbook.xml');

const elements = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];
const child = (node, tag) => [...node.children].find(element => element.localName === tag);
const plain = node => node ? elements(node, 't').filter(element => element.parentElement?.localName !== 'rPh').map(element => element.textContent).join('') : '';

function xml(parser, source) {
  if (!source || /<!DOCTYPE|<!ENTITY/iu.test(source)) throw new Error('بيانات Excel الداخلية غير متاحة أو غير صالحة.');
  const tree = parser.parseFromString(source, 'application/xml');
  if (elements(tree, 'parsererror').length) throw new Error('تعذّر قراءة XML داخل ملف Excel.');
  return tree;
}

function readCell(cell, strings) {
  const raw = child(cell, 'v')?.textContent || '';
  const type = cell.getAttribute('t');
  let value = raw;
  if (type === 's') value = /^\d+$/u.test(raw) ? strings[Number(raw)] ?? '' : '';
  if (type === 'inlineStr') value = plain(child(cell, 'is'));
  if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
  const formula = child(cell, 'f')?.textContent?.trim();
  return [value, formula && 'الصيغة: =' + formula].filter(Boolean).join(' | ');
}

export async function xlsxText(file, { signal, parser = new DOMParser(), onProgress } = {}) {
  const { entries, inventory } = await readZipEntries(file, path => relevantPart.test(path), signal);
  if (inventory.some(part => relevantPart.test(part.name) && !part.readable)) throw new Error('لم تُقرأ أجزاء Excel كاملة في المتصفح. الملف الأصلي محفوظ؛ استخدم أدوات ملفات الكمبيوتر لقراءته كاملًا.');
  const parts = new Map(entries);
  const workbook = xml(parser, parts.get('xl/workbook.xml'));
  const relationships = xml(parser, parts.get('xl/_rels/workbook.xml.rels'));
  const sheets = new Map();
  for (const link of elements(relationships, 'Relationship')) {
    if (!link.getAttribute('Type')?.endsWith('/worksheet') || link.getAttribute('TargetMode') === 'External') continue;
    try {
      const path = new URL(link.getAttribute('Target'), spreadsheetBase);
      if (path.origin === spreadsheetBase.origin && path.pathname.startsWith('/xl/worksheets/')) {
        sheets.set(link.getAttribute('Id'), decodeURIComponent(path.pathname.slice(1)));
      }
    } catch { /* Malformed workbook links cannot identify a sheet. */ }
  }
  const strings = parts.has('xl/sharedStrings.xml')
    ? elements(xml(parser, parts.get('xl/sharedStrings.xml')), 'si').map(plain)
    : [];
  const out = [];
  let count = 0;
  for (const sheet of elements(workbook, 'sheet')) {
    signal?.throwIfAborted();
    const name = (sheet.getAttribute('name') || 'ورقة').replace(/[\]\r\n]/gu, ' ');
    const id = [...sheet.attributes].find(attribute => attribute.localName === 'id')?.value;
    const source = parts.get(sheets.get(id));
    const lines = ['[ورقة ' + name.slice(0, 200) + ']'];
    if (!source) lines.push('تعذّر استخراج محتوى هذه الورقة.');
    else for (const cell of xml(parser, source).getElementsByTagNameNS('*', 'c')) {
      signal?.throwIfAborted();
      if (++count % 1000 === 0) {
        onProgress?.(`أقرأ Excel… ${count} خلية`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const value = readCell(cell, strings);
      if (!value) continue;
      const line = (cell.getAttribute('r') || 'خلية').slice(0, 20) + ': ' + value;
      lines.push(line);
    }
    out.push(lines.join('\n'));
  }
  if (!out.length) throw new Error('ملف Excel لا يحتوي على أوراق قابلة للقراءة.');
  return out.join('\n\n');
}
