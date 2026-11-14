import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, opendir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const WINDOWS = process.platform === 'win32';
const TRASH = '.sowalif-trash';
const TEXT_LIMIT = 1024 * 1024;
const SEARCH_BYTES = 32 * TEXT_LIMIT;
const DUPLICATE_BYTES = 2 * 1024 * TEXT_LIMIT;
const SCAN_MS = 45_000;
const SCAN_ENTRIES = 250_000;
const textFile = /(?:\.(?:txt|md|rtf|csv|tsv|log|jsonl?|xml|html?|css|[cm]?js|tsx?|jsx|py|rb|php|cs|cpp?|h|java|go|rs|toml|conf|ini|ya?ml|sh|bat|ps1|sql|svg)|(?:^|[\\/])(?:readme|makefile|dockerfile))$/i;
const folded = value => value.normalize('NFC').toLowerCase();
const pathKey = value => WINDOWS ? value.toLowerCase() : value;
const samePath = (left, right) => pathKey(left) === pathKey(right);
const fail = (message, code = 400) => Object.assign(new Error(message), { code });

function absolutePath(path) {
  if (typeof path !== 'string' || !path || path.length > 8192 || !isAbsolute(path) || /[\u0000-\u001f]/.test(path)) {
    throw fail('اكتب المسار الكامل من مستكشف الملفات.');
  }
  const parts = path.split(WINDOWS ? /[\\/]/ : '/');
  if (parts.some(part => part === '..' || part === '.')) throw fail('استخدم المسار الكامل بدون مقاطع نسبية.');
  if (WINDOWS && (!/^[a-z]:[\\/]/i.test(path) || parts.slice(1).some(part =>
    /[:*?"<>|]|[ .]$|^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))) {
    throw fail('اختر مسارًا صالحًا على قرص ويندوز.');
  }
  return resolve(path);
}

function inside(root, path) {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
}

function segments(path) {
  return path.split(sep).filter(Boolean);
}

async function directory(path) {
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(canonical, path)) {
    throw fail('اختر مجلدًا فعليًا. الروابط والمجلدات المختصرة خارج نطاق إدارة الملفات.');
  }
  return canonical;
}

function resultFile(path, stat, kind = 'file') {
  return { path, name: basename(path), size: stat.size, modifiedAt: stat.mtime.toISOString(), kind };
}

function unchanged(current, stat) {
  return current.isFile() && current.ino === stat.ino && current.dev === stat.dev &&
    current.size === stat.size && current.mtimeMs === stat.mtimeMs;
}

async function openKnownFile(path, stat) {
  if (!samePath(await realpath(path), path)) throw fail('تغيّر مسار الملف أثناء الفحص.');
  const file = await open(path, WINDOWS ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!unchanged(await file.stat(), stat)) throw fail('تغيّر الملف أثناء الفحص.');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

function decodeText(bytes) {
  const enc = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  return new TextDecoder(enc).decode(bytes);
}

async function digest(path, stat, signal) {
  const file = await openKnownFile(path, stat);
  const hash = createHash('sha256');
  let count = 0;
  try {
    for await (const chunk of file.createReadStream({ signal, autoClose: false })) {
      count += chunk.length;
      if (count > stat.size) throw fail('تغيّر حجم الملف أثناء الفحص.');
      hash.update(chunk);
    }
    if (count !== stat.size || !unchanged(await file.stat(), stat) || !unchanged(await lstat(path), stat)) {
      throw fail('تغيّر الملف أثناء الفحص.');
    }
    return hash.digest('hex');
  } finally { await file.close(); }
}

async function transfer(source, destination, stat, copyOnly = false) {
  if (copyOnly) return copyFile(source, destination, constants.COPYFILE_EXCL);
  try {
    await link(source, destination);
  } catch (error) {
    if (!['EXDEV', 'ENOSYS', 'ENOTSUP', 'EPERM', 'EOPNOTSUPP'].includes(error.code)) throw error;
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
  try {
    const current = await lstat(source);
    if (!unchanged(current, stat)) {
      throw fail('تغيّر الملف أثناء نقله.');
    }
    await unlink(source);
  } catch {
    throw fail('النسخة موجودة في الوجهة وتعذّر حذف الأصل. راجع الموقعين.');
  }
}

export function createFileService(dataDir) {
  const statePath = join(dataDir, 'file-roots.json');
  let changing = false;
  let scanning = false;

  const authorized = async () => {
    try { return JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
  };
  const readRoots = async () => ({ roots: (await authorized()).map(path => ({ path })) });

  async function exclusive(work) {
    if (changing) throw fail('انتظر اكتمال تعديل الملفات الجاري.', 409);
    changing = true;
    try { return await work(); }
    finally { changing = false; }
  }

  const controlFile = path => samePath(path, dataDir) || inside(dataDir, path);
  const excluded = path => controlFile(path) || segments(path).some(part => folded(part) === TRASH);

  function changeRoots({ path, remove }) {
    return exclusive(async () => {
      if (scanning) throw fail('انتظر انتهاء الفحص قبل تعديل المجلدات المضافة.', 409);
      const requested = absolutePath(path);
      const roots = await authorized();
      const canonical = remove ? requested : await directory(requested);
      if (excluded(canonical)) throw fail('هذا المجلد خاص بملفات خدمة سوالف.');
      if (remove) {
        return saveRoots(roots.filter(root => !samePath(root, canonical)));
      }
      if (roots.some(root => samePath(root, canonical))) return readRoots();
      return saveRoots([...roots, canonical]);
    });
  }

  async function saveRoots(roots) {
    await mkdir(dataDir, { recursive: true });
    const temporary = join(dataDir, 'file-roots-' + randomUUID() + '.tmp');
    try {
      await writeFile(temporary, JSON.stringify(roots), { flag: 'wx', mode: 0o600 });
      await rename(temporary, statePath);
    } finally { await unlink(temporary).catch(() => {}); }
    return { roots: roots.map(path => ({ path })) };
  }

  async function scan({ root, directory: subdirectory, action, query, limit, searchContent }, disconnected) {
    if (!['browse', 'find', 'largest', 'duplicates'].includes(action)) throw fail('اختر نوع فحص الملفات.');
    const needle = typeof query === 'string' ? folded(query.trim()).slice(0, 300) : '';
    if (action === 'find' && !needle) throw fail('اكتب اسم الملف أو عبارة تبحث عنها.');
    if (scanning) throw fail('انتظر الفحص الجاري أو أوقفه قبل فحص مجلد آخر.', 409);
    scanning = true;
    try {
      const roots = await authorized();
      if (root === '*' && action !== 'browse' && !subdirectory) {
        if (!roots.length) throw fail('أضف مجلدًا أو قرصًا أولاً.', 403);
        const parents = roots.filter(path => !roots.some(other => !samePath(path, other) && inside(other, path)));
        return await scanTree(parents, action, needle, limit, searchContent, disconnected);
      }
      const requested = absolutePath(root);
      const approved = roots.find(path => samePath(path, requested));
      if (!approved) throw fail('أضف المجلد أو القرص إلى النطاق أولاً.', 403);
      await directory(approved);
      const entry = subdirectory ? absolutePath(subdirectory) : approved;
      if (!inside(approved, entry) || excluded(entry)) throw fail('المجلد خارج النطاق.', 403);
      await directory(entry);
      return await scanTree([entry], action, needle, limit, searchContent, disconnected);
    } finally { scanning = false; }
  }

  async function scanTree(roots, action, needle, limit, searchContent, disconnected) {
    const controller = AbortSignal.timeout(SCAN_MS);
    const signal = disconnected ? AbortSignal.any([controller, disconnected]) : controller;
    const cap = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
    const files = [], groups = [];
    const sizes = new Map();
    let visited = 0, scanned = 0, skipped = 0, contentSkipped = 0, contentBytes = 0;
    let partial = false, more = false;

    async function matches(path, stat) {
      if (folded(basename(path)).includes(needle)) return true;
      if (!searchContent || !textFile.test(path)) return false;
      if (stat.size > TEXT_LIMIT || contentBytes + stat.size > SEARCH_BYTES) {
        contentSkipped++;
        return false;
      }
      contentBytes += stat.size;
      const file = await openKnownFile(path, stat);
      try {
        const bytes = Buffer.alloc(stat.size);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (!unchanged(await file.stat(), stat) || bytesRead !== stat.size) return false;
        return folded(decodeText(bytes.subarray(0, bytesRead))).includes(needle);
      } finally { await file.close(); }
    }

    async function walk(parent) {
      try {
        for await (const item of await opendir(parent)) {
          if (signal.aborted || visited++ >= SCAN_ENTRIES) { partial = true; break; }
          const path = join(parent, item.name);
          if (excluded(path)) continue;
          if (item.isSymbolicLink()) { skipped++; continue; }
          if (item.isDirectory() && action !== 'browse') {
            try { await directory(path); await walk(path); } catch { skipped++; }
            if (partial) break;
            continue;
          }
          if (!item.isFile() && !item.isDirectory()) { skipped++; continue; }
          try {
            const stat = await lstat(path);
            if (stat.isSymbolicLink()) { skipped++; continue; }
            if (stat.isFile()) scanned++;
            const candidate = resultFile(path, stat, stat.isDirectory() ? 'directory' : 'file');
            if ((action === 'duplicates' || action === 'largest') && needle && !folded(candidate.name).includes(needle)) continue;
            if (action === 'duplicates') {
              if (!stat.size) continue;
              if (!sizes.has(stat.size)) sizes.set(stat.size, []);
              sizes.get(stat.size).push({ candidate, stat });
            } else if (action === 'largest') {
              if (files.length < cap) files.push(candidate);
              else {
                more = true;
                let smallest = 0;
                for (let i = 1; i < files.length; i++) if (files[i].size < files[smallest].size) smallest = i;
                if (candidate.size > files[smallest].size) files[smallest] = candidate;
              }
            } else if (action === 'browse' || await matches(path, stat)) {
              if (files.length < cap) files.push(candidate);
              else more = true;
            }
          } catch { skipped++; }
        }
      } catch { skipped++; }
    }
    for (const root of roots) {
      try { await directory(root); await walk(root); } catch { skipped++; }
      if (partial) break;
    }

    if (action === 'duplicates') {
      let bytesRead = 0;
      let returned = 0;
      outer: for (const [size, candidates] of sizes) {
        if (candidates.length < 2) continue;
        const digests = new Map();
        for (const { candidate, stat } of candidates) {
          if (signal.aborted || bytesRead + size > DUPLICATE_BYTES) { partial = true; break outer; }
          try {
            bytesRead += size;
            const checksum = await digest(candidate.path, stat, signal);
            if (!digests.has(checksum)) digests.set(checksum, []);
            digests.get(checksum).push(candidate);
          } catch { skipped++; if (signal.aborted) { partial = true; break outer; } }
        }
        for (const matches of digests.values()) {
          if (matches.length < 2) continue;
          if (returned >= cap || (returned > 0 && cap - returned < 2)) { more = true; continue; }
          const shown = matches.slice(0, Math.max(2, cap - returned));
          groups.push({ size, files: shown, count: matches.length });
          if (shown.length < matches.length) more = true;
          returned += shown.length;
        }
      }
    }
    if (action === 'largest') files.sort((a, b) => b.size - a.size);
    if (action === 'browse') files.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1);
    return { files, groups, scanned, skipped, partial, more, contentSkipped };
  }

  async function read({ root, path }) {
    const target = absolutePath(path);
    const approved = (await authorized()).find(allowed => root === '*' ? inside(allowed, target) : samePath(allowed, absolutePath(root)));
    if (!approved || !inside(approved, target) || excluded(target)) throw fail('الملف خارج النطاق.', 403);
    if (!textFile.test(target)) throw fail('المعاينة متاحة للملفات النصية فقط.');
    await directory(approved);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('اختر ملفًا نصيًا عاديًا.');
    const file = await openKnownFile(target, stat);
    try {
      const bytes = Buffer.alloc(Math.min(stat.size, TEXT_LIMIT));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (!unchanged(await file.stat(), stat)) throw fail('تغيّر الملف أثناء قراءته.');
      return { text: decodeText(bytes.subarray(0, bytesRead)), partial: bytesRead < stat.size };
    } finally { await file.close(); }
  }

  function change({ action, path, destination, content }) {
    if (!['move', 'copy', 'trash', 'restore', 'mkdir', 'create'].includes(action)) throw fail('عملية الملفات غير معروفة.');
    return exclusive(async () => {
      const roots = await authorized();
      const approved = async (raw, allowTrash = false) => {
        const path = absolutePath(raw);
        const candidates = roots.filter(root => inside(root, path)).sort((a, b) => b.length - a.length);
        const root = candidates[0];
        if (!root || samePath(root, path) || controlFile(path) || (!allowTrash && excluded(path))) {
          throw fail('المسار خارج المجلدات المضافة أو خاص بخدمة سوالف.', 403);
        }
        await directory(root);
        await directory(dirname(path));
        return path;
      };
      const source = await approved(path, action === 'restore');
      if (action === 'mkdir') { await mkdir(source); return { path: source }; }
      if (action === 'create') {
        if (typeof content !== 'string' || Buffer.byteLength(content) > TEXT_LIMIT) throw fail('النص يتجاوز حجم الملف المسموح.');
        await writeFile(source, content, { flag: 'wx' });
        return { path: source };
      }
      const stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(source), source)) throw fail('اختر ملفًا عاديًا.');
      let target;
      if (action === 'trash') {
        const trash = join(dirname(source), TRASH);
        await mkdir(trash).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await directory(trash);
        const slot = join(trash, randomUUID());
        await mkdir(slot);
        target = join(slot, basename(source));
      } else {
        target = await approved(destination);
      }
      if (action === 'restore' && (folded(basename(dirname(dirname(source)))) !== TRASH ||
        !/^[\da-f-]{36}$/i.test(basename(dirname(source))) ||
        !samePath(target, join(dirname(dirname(dirname(source))), basename(source))))) {
        throw fail('اختر مسار الاسترجاع الأصلي لهذا الملف.');
      }
      try {
        await transfer(source, target, stat, action === 'copy');
      } catch (error) {
        if (action === 'trash') await rmdir(dirname(target)).catch(() => {});
        if (error.code === 'EEXIST') throw fail('فيه ملف بنفس الاسم في الوجهة.', 409);
        throw error;
      }
      if (action === 'restore') await rmdir(dirname(source)).catch(() => {});
      return { path: source, destination: target };
    });
  }

  return { readRoots, changeRoots, scan, change, read };
}
