import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';

export function validArtifactPath(path) {
  return typeof path === 'string' && path.startsWith('outputs/') &&
    path.split('/').every(part => part && !part.startsWith('.') && !/[\\:*?"<>|\u0000-\u001f]/.test(part) && !/^[ ]|[ .]$/.test(part) &&
      !/^(?:credentials|secrets|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !/\.env$/i.test(part));
}
export async function artifactFile(workspace, path) {
  if (!validArtifactPath(path)) throw new Error('مسار ملف غير مسموح');
  let current = workspace;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('الروابط الرمزية غير مسموحة');
  }
  const root = await realpath(workspace);
  const target = await realpath(current);
  if (!target.startsWith(root + sep)) throw new Error('الملف خارج مساحة المشروع');
  const stat = await lstat(target);
  if (!stat.isFile()) throw new Error('الملف غير متاح');
  return { target, size: stat.size, stat };
}

export async function openArtifact(workspace, path) {
  const { target, stat } = await artifactFile(workspace, path);
  const handle = await open(target, process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('تغيّر الملف؛ أعد المحاولة.');
    return { handle, size: opened.size };
  } catch (error) { await handle.close(); throw error; }
}
export async function listArtifacts(workspace) {
  const files = [];
  async function walk(path) {
    for (const item of await readdir(resolve(workspace, path), { withFileTypes: true })) {
      if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
      const name = `${path}/${item.name}`;
      if (!validArtifactPath(name)) continue;
      if (item.isDirectory()) await walk(name);
      else if (validArtifactPath(name)) {
        try { const file = await artifactFile(workspace, name); files.push({ path: name, name: item.name, size: file.size }); } catch {}
      }
    }
  }
  try {
    if (!(await lstat(resolve(workspace, 'outputs'))).isSymbolicLink()) await walk('outputs');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return files;
}
