import test from 'node:test';
import assert from 'node:assert/strict';
import { projectZip } from '../js/project.js?v=40';
import { xlsxText } from '../js/xlsx-text.js?v=40';

function element(localName, attrs = {}, children = [], textContent = '') {
  const node = {
    localName, children, textContent,
    attributes: Object.entries(attrs).map(([name, value]) => ({ localName: name.split(':').at(-1), value })),
    getAttribute: name => attrs[name] ?? null,
    getElementsByTagNameNS: (namespace, name) => children.flatMap(child => [
      ...(child.localName === name ? [child] : []), ...child.getElementsByTagNameNS(namespace, name),
    ]),
  };
  for (const child of children) child.parentElement = node;
  return node;
}

test('XLSX extracts labelled cells, formula and cached value; external and macro parts remain unparsed', async () => {
  const roots = new Map([
    ['workbook', element('document', {}, [
      element('sheet', { name: 'الأسعار', 'r:id': '1' }), element('sheet', { name: 'خارجي', 'r:id': '2' }),
    ])],
    ['relations', element('document', {}, [
      element('Relationship', { Id: '1', Type: 'namespace/worksheet', Target: 'worksheets/sheet1.xml' }),
      element('Relationship', { Id: '2', Type: 'namespace/worksheet', TargetMode: 'External', Target: 'https://example.test/workbook' }),
    ])],
    ['strings', element('document', {}, [element('si', {}, [element('t', {}, [], 'ذهب')])])],
    ['cells', element('document', {}, [
      element('c', { r: 'A1', t: 's' }, [element('v', {}, [], '0')]),
      element('c', { r: 'B1' }, [element('v', {}, [], '3900'), element('f', {}, [], 'SUM(B2:B3)')]),
      element('c', { r: 'C1', t: 'inlineStr' }, [element('is', {}, [element('t', {}, [], 'سعر')])]),
    ])],
  ]);
  const archive = projectZip([
    { path: 'xl/workbook.xml', content: 'workbook' },
    { path: 'xl/_rels/workbook.xml.rels', content: 'relations' },
    { path: 'xl/sharedStrings.xml', content: 'strings' },
    { path: 'xl/worksheets/sheet1.xml', content: 'cells' },
    { path: 'xl/vbaProject.bin', content: 'not processed' },
  ]);
  const text = await xlsxText(archive, { parser: { parseFromString: source => {
    assert.ok(roots.has(source));
    return roots.get(source);
  } } });
  assert.match(text, /\[ورقة الأسعار\]\nA1: ذهب\nB1: 3900 \| الصيغة: =SUM\(B2:B3\)\nC1: سعر/);
  assert.match(text, /\[ورقة خارجي\]\nتعذّر استخراج/);
});

test('XLSX rejects unsafe DTD markup before parsing XML', async () => {
  const archive = projectZip([{ path: 'xl/workbook.xml', content: '<!DOCTYPE root><root />' }]);
  await assert.rejects(xlsxText(archive, { parser: { parseFromString: () => assert.fail('DTD reached parser') } }), /غير صالحة/);
});
