import { readZipEntries } from './zip-text.js?v=28';

const relevantPart = /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/u;
const spreadsheetBase = new URL('https://xlsx.invalid/xl/workbook.xml');
const CELL_LIMIT = 75_000;
const CELL_TEXT_LIMIT = 20_000;
const WORKBOOK_TEXT_LIMIT = 8_000_000;

const elements = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];
const child = (node, tag) => [...node.children].find(element => element.localName === tag);
const plain = node => node ? elements(node, 't').filter(element => element.parentElement?.localName !== 'rPh').map(element => element.textContent).join('') : '';
const bounded = text => text.length > CELL_TEXT_LIMIT ? text.slice(0, CELL_TEXT_LIMIT) + '…' : text;

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
  return [value && bounded(value), formula && 'الصيغة: =' + bounded(formula)].filter(Boolean).join(' | ');
}

export async function xlsxText(file, { signal, parser = new DOMParser() } = {}) {
  const { entries } = await readZipEntries(file, path => relevantPart.test(path), signal);
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
  let textSize = 0;
  let truncated = false;
  for (const sheet of elements(workbook, 'sheet')) {
    signal?.throwIfAborted();
    const name = (sheet.getAttribute('name') || 'ورقة').replace(/[\]\r\n]/gu, ' ');
    const id = [...sheet.attributes].find(attribute => attribute.localName === 'id')?.value;
    const source = parts.get(sheets.get(id));
    const lines = ['[ورقة ' + name.slice(0, 200) + ']'];
    textSize += lines[0].length + 65;
    if (!source) lines.push('تعذّر استخراج محتوى هذه الورقة.');
    else for (const cell of xml(parser, source).getElementsByTagNameNS('*', 'c')) {
      if (++count > CELL_LIMIT) { truncated = true; break; }
      const value = readCell(cell, strings);
      if (!value) continue;
      const line = (cell.getAttribute('r') || 'خلية').slice(0, 20) + ': ' + value;
      textSize += line.length + 1;
      if (textSize > WORKBOOK_TEXT_LIMIT) { truncated = true; break; }
      lines.push(line);
    }
    out.push(lines.join('\n'));
    if (truncated || textSize > WORKBOOK_TEXT_LIMIT) {
      out.push('تم بلوغ حد قراءة المصنف؛ لم تُقرأ الخلايا المتبقية.');
      break;
    }
  }
  if (!out.length) throw new Error('ملف Excel لا يحتوي على أوراق قابلة للقراءة.');
  return out.join('\n\n');
}
