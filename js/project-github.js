import { validProjectPath } from './project.js?v=15';

const shaPattern = /^[a-f0-9]{40}$/i;
const refPath = branch => branch.split('/').map(encodeURIComponent).join('/');

function repoName(value) {
  const match = /^(?:https:\/\/github\.com\/)?([\w-]+)\/([\w.-]+?)\/?$/i.exec(value.trim());
  const repo = match?.[2].replace(/\.git$/i, '');
  if (!repo || ['.', '..'].includes(repo)) throw new Error('اكتب المستودع بصيغة owner/repo أو الصق رابط GitHub.');
  return `${match[1]}/${repo}`;
}

async function github(repo, token, path = '', body) {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method: body ? 'POST' : 'GET',
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
      409: 'المستودع فارغ. أضف README عند إنشائه في GitHub ثم أعد المحاولة.',
      422: 'GitHub رفض إنشاء الفرع أو التعديل. راجع قواعد المستودع.',
    };
    throw Object.assign(new Error(messages[response.status] || `تعذّر الاتصال بـ GitHub (${response.status}).`), { status: response.status });
  }
  return response.json();
}

function requireSha(value) {
  if (!shaPattern.test(value)) throw new Error('لم يرجع GitHub معرّفًا صالحًا للتعديل.');
  return value;
}

async function blobSha(content) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const payload = new Uint8Array(header.length + bytes.length);
  payload.set(header);
  payload.set(bytes, header.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', payload))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareProjectPush({ repository, token, files, removed = [] }) {
  if (!token) throw new Error('أدخل رمز الوصول إلى GitHub أولاً.');
  if (!files.length && !removed.length) throw new Error('أضف ملفات للمشروع أولاً.');
  const repo = repoName(repository);
  const paths = [...files.map(file => file.path), ...removed];
  if (paths.some(path => !validProjectPath(path))) throw new Error('المشروع يحتوي على مسار غير مدعوم.');
  const { default_branch: base } = await github(repo, token);
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
  for (const { path, content } of files) {
    const parts = path.split('/');
    for (let n = 1; n < parts.length; n++) {
      const prefix = parts.slice(0, n).join('/');
      const parentEntry = entries.get(prefix.toLowerCase());
      if (parentEntry && (parentEntry.type !== 'tree' || parentEntry.path !== prefix)) {
        throw new Error(`مسار المجلد يتعارض مع عنصر في GitHub: ${prefix}`);
      }
    }
    const found = remoteFile(path);
    if (!found || found.sha !== await blobSha(content)) {
      changes.push({ action: found ? 'تعديل' : 'إضافة', entry: { path, mode: found?.mode || '100644', type: 'blob', content } });
    }
  }
  for (const path of removed) {
    const found = remoteFile(path);
    if (found) changes.push({ action: 'حذف', entry: { path, mode: found.mode, type: 'blob', sha: null } });
  }
  return { repo, base, parent, baseTree, changes, branch: `sowalif/project-${crypto.randomUUID().slice(0, 12)}` };
}

export async function pushProject(plan, token, message) {
  const { repo, base, parent, baseTree, branch, changes } = plan;
  if (!changes.length) throw new Error('ما فيه تغييرات لرفعها.');
  const url = `https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
  async function existingBranch() {
    const ref = await github(repo, token, `/git/ref/heads/${refPath(branch)}`).catch(error => {
      if (error.status !== 404) throw error;
      return null;
    });
    return ref?.object?.sha;
  }
  if (plan.commitSha && await existingBranch() === plan.commitSha) return url;
  const head = await github(repo, token, `/git/ref/heads/${refPath(base)}`);
  if (head.object?.sha !== parent) throw new Error('تغيّر الفرع الأساسي في GitHub. أعد مراجعة الرفع.');
  if (!plan.commitSha) {
    const tree = await github(repo, token, '/git/trees', { base_tree: baseTree, tree: changes.map(change => change.entry) });
    const commit = await github(repo, token, '/git/commits', { message, tree: requireSha(tree.sha), parents: [parent] });
    plan.commitSha = requireSha(commit.sha);
  }
  try {
    await github(repo, token, '/git/refs', { ref: `refs/heads/${branch}`, sha: plan.commitSha });
  } catch (error) {
    // Check whether GitHub accepted the branch before the response was interrupted.
    if (await existingBranch().catch(() => null) !== plan.commitSha) throw error;
  }
  return url;
}
