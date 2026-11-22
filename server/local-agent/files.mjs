import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, opendir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { extractKnownFileText, fileNameMatches, normalizeSearchText, searchKnownFile, streamsSearchText } from './content-search.mjs';

const WINDOWS = process.platform === 'win32';
const TRASH = '.sowalif-trash';
const TEXT_LIMIT = 1024 * 1024;
const SEARCH_BYTES = 256 * TEXT_LIMIT;
const DUPLICATE_BYTES = 2 * 1024 * TEXT_LIMIT;
const SCAN_MS = 45_000;
const SCAN_ENTRIES = 250_000;
const textFile = /(?:\.(?:txt|md|rtf|csv|tsv|log|jsonl?|xml|html?|css|[cm]?js|tsx?|jsx|py|rb|php|cs|cpp?|h|java|go|rs|toml|conf|ini|ya?ml|sh|bat|ps1|sql|svg)|(?:^|[\\/])(?:readme|makefile|dockerfile))$/i;
const folded = normalizeSearchText;
const pathKey = value => WINDOWS ? value.toLowerCase() : value;
const samePath = (left, right) => pathKey(left) === pathKey(right);
const fail = (message, code = 400) => Object.assign(new Error(message), { code });

function searchFilters(fileQuery, fileTypes) {
  if (fileQuery !== undefined && (typeof fileQuery !== 'string' || fileQuery.length > 1000)) throw fail('اسم الملف المحدد للبحث غير صالح.');
  if (fileTypes !== undefined && (!Array.isArray(fileTypes) || fileTypes.length > 30 || fileTypes.some(type => typeof type !== 'string' || !/^\.?[a-z0-9]{1,16}$/i.test(type)))) throw fail('أنواع الملفات المحددة غير صالحة.');
  return { fileQuery: fileQuery || '', fileTypes: (fileTypes || []).map(type => type.replace(/^\./, '').toLowerCase()) };
}

function matchesFilters(name, { fileQuery, fileTypes }) {
  return (!fileQuery || fileNameMatches(name, fileQuery)) && (!fileTypes.length || fileTypes.includes(extname(name).slice(1).toLowerCase()));
}

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

export function createFileService(dataDir, { scanMs = SCAN_MS, scanEntries = SCAN_ENTRIES, searchBytes = SEARCH_BYTES } = {}) {
  const statePath = join(dataDir, 'file-roots.json');
  let changing = false;
  let scanning = false;
  const findSessions = new Map();

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

  async function scan({ root, directory: subdirectory, action, query, queries, limit, searchContent, searchIn, fileQuery, fileTypes, cursor }, disconnected) {
    if (!['browse', 'find', 'largest', 'duplicates'].includes(action)) throw fail('اختر نوع فحص الملفات.');
    if (typeof query === 'string' && query.length > 1000) throw fail('عبارة البحث أطول من 1000 حرف.');
    const needle = typeof query === 'string' ? folded(query.trim()).trim() : '';
    if (action === 'find' && !needle) throw fail('اكتب اسم الملف أو عبارة تبحث عنها.');
    const filters = searchFilters(fileQuery, fileTypes);
    if (scanning) throw fail('انتظر الفحص الجاري أو أوقفه قبل فحص مجلد آخر.', 409);
    scanning = true;
    try {
      const roots = await authorized();
      const findOptions = { needle, queries, limit, searchContent, searchIn, ...filters, cursor };
      if (root === '*' && action !== 'browse' && !subdirectory) {
        if (!roots.length) throw fail('أضف مجلدًا أو قرصًا أولاً.', 403);
        const parents = roots.filter(path => !roots.some(other => !samePath(path, other) && inside(other, path)));
        return action === 'find' ? await findPage(parents, findOptions, disconnected) : await scanTree(parents, action, needle, limit, filters, disconnected);
      }
      const requested = absolutePath(root);
      const approved = roots.find(path => samePath(path, requested));
      if (!approved) throw fail('أضف المجلد أو القرص إلى النطاق أولاً.', 403);
      await directory(approved);
      const entry = subdirectory ? absolutePath(subdirectory) : approved;
      if (!inside(approved, entry) || excluded(entry)) throw fail('المجلد خارج النطاق.', 403);
      await directory(entry);
      return action === 'find' ? await findPage([entry], findOptions, disconnected) : await scanTree([entry], action, needle, limit, filters, disconnected);
    } finally { scanning = false; }
  }

  // A search page keeps its breadth-first iterator for continuation. Filename
  // discovery happens before document extraction, so a large early document
  // cannot hide later filenames. No cursor contains a filesystem path.
  async function* findCandidates(roots) {
    const pending = [...roots];
    for (let index = 0; index < pending.length; index++) {
      const parent = pending[index];
      try {
        await directory(parent);
        for await (const item of await opendir(parent)) {
          const path = join(parent, item.name);
          if (excluded(path)) continue;
          if (item.isSymbolicLink()) { yield { path, error: 'تم تجاوز رابط رمزي.' }; continue; }
          try {
            const stat = await lstat(path);
            if (stat.isSymbolicLink()) { yield { path, error: 'تم تجاوز رابط رمزي.' }; continue; }
            if (!stat.isFile() && !stat.isDirectory()) continue;
            if (stat.isDirectory()) pending.push(path);
            yield { path, stat };
          } catch { yield { path, error: 'تعذّر الوصول إلى الملف أو المجلد.' }; }
        }
      } catch { yield { path: parent, error: 'تعذّر قراءة المجلد؛ راجع صلاحيات ويندوز.' }; }
      pending[index] = '';
    }
  }

  async function findPage(roots, options, disconnected) {
    const { needle, limit, cursor } = options;
    if (options.queries !== undefined && (!Array.isArray(options.queries) || options.queries.length > 5 || options.queries.some(value => typeof value !== 'string' || !value.trim() || value.length > 300))) throw fail('عبارات البحث البديلة غير صالحة.');
    const needles = [...new Set([needle, ...(options.queries || []).map(value => folded(value).trim())])];
    const nameMatch = name => needles.find(value => fileNameMatches(name, value));
    const searchIn = options.searchIn || (options.searchContent === true ? 'both' : 'name');
    if (!['name', 'content', 'both'].includes(searchIn)) throw fail('اختر البحث بالاسم أو داخل الملفات أو كليهما.');
    const { fileTypes, fileQuery } = options;
    const signature = JSON.stringify({ roots, needles, searchIn, fileQuery, fileTypes });
    const now = Date.now();
    for (const [id, old] of findSessions) if (now - old.at > 10 * 60_000) { findSessions.delete(id); await old.iterator.return(); }
    let state;
    if (cursor) {
      state = typeof cursor === 'string' && findSessions.get(cursor);
      if (!state || state.signature !== signature) throw fail('انتهت جلسة البحث أو تغيّر النطاق. ابدأ بحثًا جديدًا.', 409);
    } else {
      while (findSessions.size >= 8) {
        const [id, old] = findSessions.entries().next().value;
        findSessions.delete(id); await old.iterator.return();
      }
      state = { id: randomUUID(), signature, phase: searchIn === 'content' ? 'content' : 'name', iterator: findCandidates(roots), at: now };
      findSessions.set(state.id, state);
    }
    state.at = now;
    const cap = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
    const timeout = AbortSignal.timeout(scanMs);
    const signal = disconnected ? AbortSignal.any([timeout, disconnected]) : timeout;
    const files = [], issues = [];
    let scanned = 0, skipped = 0, contentScanned = 0, contentSkipped = 0, contentUnsupported = 0, contentErrors = 0, contentBytes = 0, visited = 0;
    let exhausted = false, partialReason = '';
    const issue = (path, reason) => { state.incomplete = true; if (issues.length < 25) issues.push({ path, reason }); };
    while (!signal.aborted && visited < scanEntries && files.length < cap) {
      const item = state.pending || (await state.iterator.next()).value;
      state.pending = null;
      if (!item) {
        if (state.phase === 'name' && searchIn === 'both') { state.phase = 'content'; state.iterator = findCandidates(roots); continue; }
        exhausted = true; break;
      }
      visited++;
      if (item.error) { skipped++; issue(item.path, item.error); continue; }
      const { path, stat } = item;
      if (state.phase === 'name' || searchIn === 'content') { if (stat.isFile()) scanned++; }
      const name = basename(path);
      if (!matchesFilters(name, options)) continue;
      if (state.phase === 'name') {
        const matchedQuery = nameMatch(name);
        if (matchedQuery) files.push({ ...resultFile(path, stat, stat.isDirectory() ? 'directory' : 'file'), match: { type: 'name', matchedQuery } });
        continue;
      }
      if (!stat.isFile() || (searchIn === 'both' && nameMatch(name))) continue;
      let file;
      const streamed = streamsSearchText(name);
      const singleDocument = !streamed && contentBytes === 0;
      try {
        file = await openKnownFile(path, stat);
        const result = await searchKnownFile(file, { name, size: stat.size, query: needle, queries: needles.slice(1), signal, resume: item.resume,
          onProgress: resume => { item.resume = resume; },
          onBytes: count => {
            // A bounded packaged document is indivisible. Let the first one
            // finish; streaming text instead resumes at its last decoded chunk.
            if (contentBytes > 0 && !singleDocument && contentBytes + count > searchBytes) throw fail('SEARCH_BUDGET');
            contentBytes += count;
          } });
        if (!unchanged(await file.stat(), stat) || !unchanged(await lstat(path), stat)) throw fail('تغيّر الملف أثناء قراءته؛ أعد البحث.');
        contentScanned++;
        if (result.unsupported) { contentUnsupported++; contentSkipped++; issue(path, result.reason); }
        else if (result.incomplete) { contentErrors++; contentSkipped++; issue(path, result.reason); }
        if (result.matched) files.push({ ...resultFile(path, stat), match: { type: 'content', snippet: result.snippet, matchedQuery: result.matchedQuery, format: result.format, incomplete: Boolean(result.incomplete) } });
      } catch (error) {
        if (error.message === 'SEARCH_BUDGET' || signal.aborted) {
          if (error.message === 'SEARCH_BUDGET' || streamed) state.pending = item;
          else { contentErrors++; contentSkipped++; issue(path, 'انتهت مهلة قراءة المستند قبل اكتماله. ابحث في هذا الملف وحده أو افتحه مباشرة.'); }
          partialReason = disconnected?.aborted ? 'cancelled' : 'budget';
          break;
        }
        contentErrors++; contentSkipped++; issue(path, String(error.message || 'تعذّر استخراج نص الملف.').slice(0, 300));
      } finally { await file?.close().catch(() => {}); }
      if (contentBytes >= searchBytes) { partialReason = 'budget'; break; }
    }
    if (exhausted) { findSessions.delete(state.id); await state.iterator.return(); }
    else partialReason ||= signal.aborted ? disconnected?.aborted ? 'cancelled' : 'budget' : files.length >= cap ? 'limit' : 'budget';
    return { files, groups: [], scanned, skipped, contentScanned, contentSkipped, contentUnsupported, contentErrors, issues,
      partial: !exhausted || Boolean(state.incomplete), partialReason: partialReason || (state.incomplete ? 'unreadable' : ''),
      more: !exhausted, exhausted, ...(!exhausted ? { nextCursor: state.id } : {}) };
  }

  async function scanTree(roots, action, needle, limit, filters, disconnected) {
    const controller = AbortSignal.timeout(SCAN_MS);
    const signal = disconnected ? AbortSignal.any([controller, disconnected]) : controller;
    const cap = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
    const files = [], groups = [];
    const sizes = new Map();
    let visited = 0, scanned = 0, skipped = 0, contentSkipped = 0;
    let partial = false, more = false;

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
            if (!matchesFilters(candidate.name, filters)) continue;
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
            } else if (action === 'browse') {
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
    await directory(approved);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('اختر ملفًا عاديًا.');
    const file = await openKnownFile(target, stat);
    try {
      if (!textFile.test(target) || /\.(?:rtf|html?|xml|svg)$/i.test(target)) {
        const result = await extractKnownFileText(file, { name: basename(target), size: stat.size, signal: AbortSignal.timeout(30_000) });
        if (result.unsupported) throw fail(result.reason);
        if (!unchanged(await file.stat(), stat) || !unchanged(await lstat(target), stat)) throw fail('تغيّر الملف أثناء قراءته.');
        return { text: result.text.slice(0, TEXT_LIMIT), partial: Boolean(result.incomplete || result.text.length > TEXT_LIMIT), format: result.format, ...(result.reason ? { reason: result.reason } : {}) };
      }
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

  async function close() {
    for (const state of findSessions.values()) await state.iterator.return();
    findSessions.clear();
  }
  return { readRoots, changeRoots, scan, change, read, close };
}
