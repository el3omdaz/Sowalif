import { readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const extensions = /\.(pdf|docx|xlsx|pptx|csv|txt|md|json|zip|png|jpe?g|webp)$/i;
export const ARTIFACT_LIMIT = 50 * 1024 * 1024;
export function validArtifactPath(path) {
  return typeof path === 'string' && path.length <= 200 && path.startsWith('outputs/') && extensions.test(path) &&
    path.split('/').every(part => part && !part.startsWith('.') && !/[\\:*?"<>|\u0000-\u001f]/.test(part) && !/^[ ]|[ .]$/.test(part));
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
  if (!stat.isFile() || stat.size > ARTIFACT_LIMIT) throw new Error('الملف غير متاح أو أكبر من 50 ميغابايت');
  return { target, size: stat.size };
}
export async function listArtifacts(workspace) {
  const files = [];
  let visited = 0;
  async function walk(path, depth) {
    if (depth > 5) return;
    for (const item of await readdir(resolve(workspace, path), { withFileTypes: true })) {
      if (++visited > 500 || files.length >= 30) return;
      if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
      const name = `${path}/${item.name}`;
      if (item.isDirectory()) await walk(name, depth + 1);
      else if (validArtifactPath(name)) {
        try { const file = await artifactFile(workspace, name); files.push({ path: name, name: item.name, size: file.size }); } catch {}
      }
    }
  }
  try {
    if (!(await lstat(resolve(workspace, 'outputs'))).isSymbolicLink()) await walk('outputs', 0);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return files;
}
