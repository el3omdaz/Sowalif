import { readProjectFiles, validProjectPath } from './project.js?v=16';

export async function readProjectDirectory(root) {
  const items = [];
  async function scan(directory, prefix) {
    for await (const entry of directory.values()) {
      const path = prefix + entry.name;
      if (entry.kind === 'directory' && validProjectPath(path + '/file.txt')) await scan(entry, path + '/');
      if (entry.kind === 'file' && validProjectPath(path)) {
        const file = await entry.getFile();
        items.push({ projectPath: path, size: file.size, text: () => file.text() });
        if (items.length > 40) throw new Error('المجلد فيه أكثر من 40 ملف مصدر. اختر مجلدًا أصغر.');
      }
    }
  }
  await scan(root, '');
  return items.length ? (await readProjectFiles(items)).changes : [];
}

async function location(root, path, create = false) {
  const parts = path.split('/');
  const name = parts.pop();
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name };
}

async function readCurrent(root, path) {
  try {
    const { directory, name } = await location(root, path);
    const handle = await directory.getFileHandle(name);
    return (await handle.getFile()).text();
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
    return undefined;
  }
}

export async function writeProjectDirectory(root, baseline, files, removed, beforeWrite = async () => {}) {
  if (root.requestPermission && await root.requestPermission({ mode: 'readwrite' }) !== 'granted') {
    throw new Error('اسمح لسوالف بالكتابة على المجلد، ثم حاول مرة ثانية.');
  }
  const edits = files.filter(file => baseline.get(file.path) !== file.content);
  const deletions = removed.filter(path => baseline.has(path)).map(path => ({ path }));
  const changes = [...edits, ...deletions];
  async function check({ path, content }) {
    if (!validProjectPath(path)) throw new Error('مسار الملف غير مدعوم.');
    const actual = await readCurrent(root, path);
    if (actual !== baseline.get(path) && actual !== content) {
      throw new Error(`تغيّر الملف خارج سوالف: ${path}. أعد ربط المجلد لمراجعته قبل الحفظ.`);
    }
    return actual;
  }
  for (const change of changes) await check(change);
  await beforeWrite();
  for (const change of changes) {
    const { path, content } = change;
    const actual = await check(change);
    try {
      if (actual === content) {
        if (content === undefined) baseline.delete(path);
        else baseline.set(path, content);
        continue;
      }
      const { directory, name } = await location(root, path, content !== undefined);
      if (content === undefined) {
        await directory.removeEntry(name);
        baseline.delete(path);
      } else {
        const file = await directory.getFileHandle(name, { create: true });
        const writer = await file.createWritable();
        try {
          await writer.write(content);
          await writer.close();
        } catch (error) {
          await writer.abort().catch(() => {});
          throw error;
        }
        baseline.set(path, content);
      }
    } catch {
      throw new Error(`تعذّر حفظ «${path}». الملفات التي حُفظت قبله تبقى محفوظة.`);
    }
  }
  return changes.length;
}
