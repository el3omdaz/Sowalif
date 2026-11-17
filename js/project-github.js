import { validProjectPath, projectFileBytes, isBinaryProjectFile } from './project.js?v=36';

const shaPattern = /^[a-f0-9]{40}$/i;
const refPath = branch => branch.split('/').map(encodeURIComponent).join('/');
const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;

function validBranch(branch) {
  return typeof branch === 'string' && branch.length > 0 && branch.length <= 255 && branch !== '@' &&
    !branch.startsWith('-') && !branch.includes('..') && !branch.includes('@{') &&
    !/[~^:?*\[\\\x00-\x20\x7f]/.test(branch) &&
    branch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}

function repoName(value) {
  const match = /^(?:https:\/\/github\.com\/)?([\w-]+)\/([\w.-]+?)\/?$/i.exec(value.trim());
  const repo = match?.[2].replace(/\.git$/i, '');
  if (!repo || ['.', '..'].includes(repo)) throw new Error('اكتب المستودع بصيغة owner/repo أو الصق رابط GitHub.');
  return `${match[1]}/${repo}`;
}

async function github(repo, token, path = '', body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const messages = {
      401: 'رمز GitHub غير صالح أو انتهت صلاحيته.',
      403: 'GitHub رفض الطلب. تحقّق من صلاحية Contents: Read and write ومن قيود المستودع.',
      404: 'المستودع أو الفرع غير متاح. تحقّق من الرابط وصلاحية الرمز.',
      409: 'المستودع فارغ أو تغيّر أثناء الرفع. إذا كان جديدًا، أضف README في GitHub ثم أعد المراجعة.',
      413: 'GitHub رفض حجم الطلب. الملفات الأكبر من 100 MiB تحتاج Git LFS أو GitHub Releases.',
      422: 'GitHub رفض الفرع أو التعديل. قد يكون الفرع تغيّر أو محميًا؛ أعد المراجعة أو ارفع على فرع جديد.',
    };
    throw Object.assign(new Error(messages[response.status] || `تعذّر الاتصال بـ GitHub (${response.status}).`), { status: response.status });
  }
  return response.json();
}

function requireSha(value) {
  if (!shaPattern.test(value)) throw new Error('لم يرجع GitHub معرّفًا صالحًا للتعديل.');
  return value;
}

async function blobSha(bytes) {
  const encoder = new TextEncoder();
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const payload = new Uint8Array(header.length + bytes.length);
  payload.set(header);
  payload.set(bytes, header.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', payload))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareProjectPush({ repository, token, files, removed = [], baseBranch = '', pushMode = 'new', branch: requestedBranch = '' }) {
  if (!token) throw new Error('أدخل رمز الوصول إلى GitHub أولاً.');
  if (!files.length && !removed.length) throw new Error('أضف ملفات للمشروع أولاً.');
  const repo = repoName(repository);
  if (!['new', 'current'].includes(pushMode)) throw new Error('اختر رفعًا على فرع جديد أو على الفرع المحدد.');
  if ((baseBranch && !validBranch(baseBranch)) || (requestedBranch && !validBranch(requestedBranch))) throw new Error('اسم فرع GitHub غير صالح.');
  const paths = [...files.map(file => file.path), ...removed];
  if (paths.some(path => !validProjectPath(path))) throw new Error('المشروع يحتوي على مسار غير مدعوم.');
  const bytesByFile = new Map(files.map(file => {
    const bytes = projectFileBytes(file);
    if (bytes.byteLength > GITHUB_FILE_LIMIT) throw new Error(`الملف ${file.path} أكبر من حد GitHub البالغ 100 MiB. استخدم Git LFS أو Releases لهذا الملف.`);
    return [file, bytes];
  }));
  const metadata = await github(repo, token);
  const base = baseBranch || metadata.default_branch;
  if (!validBranch(base)) throw new Error('تعذّر تحديد فرع GitHub. أدخل اسم الفرع الأساسي.');
  const branch = pushMode === 'current' ? base : requestedBranch || `sowalif/project-${crypto.randomUUID().slice(0, 12)}`;
  if (pushMode === 'new' && branch === base) throw new Error('الفرع الجديد يجب أن يختلف عن الفرع الأساسي.');
  const ref = await github(repo, token, `/git/ref/heads/${refPath(base)}`);
  const parent = requireSha(ref.object?.sha);
  const commit = await github(repo, token, `/git/commits/${parent}`);
  const baseTree = requireSha(commit.tree?.sha);
  const { tree, truncated } = await github(repo, token, `/git/trees/${baseTree}?recursive=1`);
  if (truncated) throw new Error('المستودع كبير جدًا لمراجعة الملفات بأمان من سوالف.');
  const entries = new Map(tree.map(item => [item.path.toLowerCase(), item]));
  const changes = [];
  function remoteFile(path) {
    const found = entries.get(path.toLowerCase());
    if (found && (found.path !== path || !['100644', '100755'].includes(found.mode))) {
      throw new Error(`مسار الملف يتعارض مع عنصر في GitHub: ${path}`);
    }
    return found;
  }
  for (const file of files) {
    const { path, content } = file;
    const parts = path.split('/');
    for (let n = 1; n < parts.length; n++) {
      const prefix = parts.slice(0, n).join('/');
      const parentEntry = entries.get(prefix.toLowerCase());
      if (parentEntry && (parentEntry.type !== 'tree' || parentEntry.path !== prefix)) {
        throw new Error(`مسار المجلد يتعارض مع عنصر في GitHub: ${prefix}`);
      }
    }
    const found = remoteFile(path);
    if (!found || found.sha !== await blobSha(bytesByFile.get(file))) {
      changes.push({ action: found ? 'تعديل' : 'إضافة', entry: { path, mode: found?.mode || '100644', type: 'blob', content },
        ...(isBinaryProjectFile(file) ? { encoding: 'base64' } : {}), size: bytesByFile.get(file).byteLength });
    }
  }
  for (const path of removed) {
    const found = remoteFile(path);
    if (found) changes.push({ action: 'حذف', entry: { path, mode: found.mode, type: 'blob', sha: null } });
  }
  return { repo, base, parent, baseTree, changes, branch, pushMode };
}

export async function pushProject(plan, token, message) {
  const { repo, base, parent, baseTree, branch, changes } = plan;
  if (!changes.length) throw new Error('ما فيه تغييرات لرفعها.');
  const targetCurrent = plan.pushMode === 'current';
  const resultUrl = () => targetCurrent ? `https://github.com/${repo}/commit/${plan.commitSha}`
    : `https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
  async function existingBranch() {
    const ref = await github(repo, token, `/git/ref/heads/${refPath(branch)}`).catch(error => {
      if (error.status !== 404) throw error;
      return null;
    });
    return ref?.object?.sha;
  }
  if (plan.commitSha && await existingBranch() === plan.commitSha) return resultUrl();
  const head = await github(repo, token, `/git/ref/heads/${refPath(base)}`);
  if (head.object?.sha !== parent) throw new Error('تغيّر الفرع الأساسي في GitHub. أعد مراجعة الرفع.');
  if (!plan.commitSha) {
    const entries = [];
    for (const change of changes) {
      if (change.encoding === 'base64' || change.size > 1024 * 1024) {
        // Git tree content accepts UTF-8 only. Binary data must be a separately
        // created blob; large text blobs also keep the tree request compact.
        if (!change.blobSha) {
          const blob = await github(repo, token, '/git/blobs', { content: change.entry.content, encoding: change.encoding || 'utf-8' });
          change.blobSha = requireSha(blob.sha);
        }
        const { content, ...entry } = change.entry;
        entries.push({ ...entry, sha: change.blobSha });
      } else entries.push(change.entry);
    }
    const tree = await github(repo, token, '/git/trees', { base_tree: baseTree, tree: entries });
    const commit = await github(repo, token, '/git/commits', { message, tree: requireSha(tree.sha), parents: [parent] });
    plan.commitSha = requireSha(commit.sha);
  }
  try {
    if (targetCurrent) await github(repo, token, `/git/refs/heads/${refPath(branch)}`, { sha: plan.commitSha, force: false }, 'PATCH');
    else await github(repo, token, '/git/refs', { ref: `refs/heads/${branch}`, sha: plan.commitSha });
  } catch (error) {
    // Check whether GitHub accepted the branch before the response was interrupted.
    if (await existingBranch().catch(() => null) !== plan.commitSha) throw error;
  }
  return resultUrl();
}
