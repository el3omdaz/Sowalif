import { connectedAccounts, CONNECTED_SCOPES } from './connected-accounts.js?v=28';
import { connectGoogle, connectMicrosoft, microsoftRedirectUri, prepareGoogleOAuth } from './account-oauth.js?v=28';
import { organizerIntent } from './organizer-intent.js?v=1';

const shortcutTasks = {
  files: [['تصفح الملفات', 'اعرض الملفات'], ['أكبر الملفات', 'أكبر الملفات'], ['المكررات', 'الملفات المتكررة']],
  mail: [['المرفقات', 'الإيميلات اللي فيها مرفقات'], ['غير المقروءة', 'الإيميلات غير المقروءة'], ['للمراجعة', 'الإيميلات اللي ما أحتاجها']],
  drive: [['عرض الملفات', 'اعرض الملفات']],
};

function formatSize(size) {
  if (size == null) return '';
  size = Number(size);
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const unit = Math.min(4, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}

export function initOrganizer({ localAgentOrigin, settings }) {
  const $ = id => document.getElementById(id);
  const sheet = $('organizerSheet');
  const source = $('organizerSource');
  const roots = $('organizerRoot');
  const results = $('organizerResults');
  const task = $('organizerTask');
  const client = $('organizerClient');
  const status = $('organizerStatus');
  const fileStatus = $('organizerFileStatus');
  const linkForm = $('organizerLinkForm');
  const createForm = $('organizerCreateForm');
  const more = $('organizerMore');
  const tokens = {};
  let csrf = '';
  let busy = false;
  let nextPage = null;
  let lastSearch = null;
  let localDirectory = '';
  let rootsAvailable = false;

  const mode = () => source.value === 'files' ? 'files' : ['gmail', 'outlook'].includes(source.value) ? 'mail' : 'drive';
  const provider = () => ['gmail', 'gdrive'].includes(source.value) ? 'google' : 'microsoft';
  const tokenKey = () => provider() === 'google' ? 'googleToken' : 'microsoftToken';
  const api = () => connectedAccounts(tokens);
  const visible = (item, show) => item.classList.toggle('hidden', !show);

  async function local(path, data) {
    if (!localAgentOrigin()) throw new Error('افتح نسخة سوالف للكمبيوتر على http://127.0.0.1:4781/ لإدارة ملفات الجهاز.');
    async function request(route, options) {
      let response;
      try {
        response = await fetch(`/api/files/${route}`, { ...options, cache: 'no-store', signal: AbortSignal.timeout(route === 'scan' ? 60_000 : 15_000) });
      } catch {
        throw new Error('تعذّر الاتصال بخدمة ملفات الكمبيوتر. شغّل سوالف من Start-Sowalif.cmd وحاول مرة ثانية.');
      }
      let result;
      try { result = await response.json(); } catch { /* An older service can return a page. */ }
      if (!response.ok || !result) {
        if (response.status === 403) csrf = '';
        throw new Error(response.status === 404 || !result ? 'خدمة الملفات تحتاج تحديث. أعد تشغيل نسخة سوالف للكمبيوتر.' :
          result.error || 'تعذّر تنفيذ مهمة الملفات.');
      }
      return result;
    }
    if (data === undefined) return request(path);
    if (!csrf) {
      ({ csrf } = await request('session'));
      if (!csrf) throw new Error('تعذّر بدء جلسة ملفات الكمبيوتر.');
    }
    return request(path, { method: 'POST', headers: { 'X-Sowalif-CSRF': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  }

  function updateLocalControls() {
    const selected = rootsAvailable && Boolean(roots.value);
    roots.disabled = busy || !selected;
    $('organizerLink').disabled = busy || !localAgentOrigin();
    $('organizerUnlink').disabled = $('organizerCreate').disabled = busy || !selected || roots.value === '*';
  }

  async function action(fn, feedback = status) {
    if (busy) return;
    busy = true;
    source.disabled = true;
    updateLocalControls();
    feedback.textContent = 'جاري التنفيذ…';
    try {
      await fn();
      if (feedback.textContent === 'جاري التنفيذ…') feedback.textContent = '';
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      source.disabled = false;
      busy = false;
      updateLocalControls();
    }
  }

  function button(title, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'btn ghost';
    element.textContent = title;
    element.onclick = () => { if (!busy) onClick(); };
    return element;
  }

  function item(title, text) {
    const element = document.createElement('article');
    const heading = document.createElement('strong');
    heading.dir = 'auto';
    heading.textContent = title;
    const meta = document.createElement('p');
    meta.dir = 'auto';
    meta.className = 'muted';
    meta.textContent = text;
    const controls = document.createElement('div');
    controls.className = 'row';
    element.append(heading, meta, controls);
    return { element, controls };
  }

  function clearResults() {
    results.replaceChildren();
    visible($('organizerBulkMail'), false);
    nextPage = null;
    lastSearch = null;
    visible(more, false);
  }

  async function loadRoots(selection = roots.value) {
    const { roots: entries } = await local('roots');
    rootsAvailable = entries.length > 0;
    roots.replaceChildren(...(rootsAvailable ? entries.map(entry => new Option(entry.path, entry.path)) :
      [new Option('ما أضفت مجلد أو قرص للحين', '')]));
    if (entries.length > 1) roots.append(new Option('كل المجلدات والأقراص المرتبطة', '*'));
    if (entries.some(entry => entry.path === selection) || selection === '*' && entries.length > 1) roots.value = selection;
    fileStatus.textContent = rootsAvailable ? '' : 'أضف مجلد أو قرص عشان تبدأ البحث فيه.';
  }

  function showConnection() {
    const connected = Boolean(tokens[tokenKey()]);
    visible($('organizerConnect'), !connected);
    visible($('organizerDisconnect'), connected);
    visible($('organizerCompose'), connected && mode() === 'mail');
  }

  function showSource() {
    clearResults();
    localDirectory = '';
    task.value = '';
    task.placeholder = mode() === 'files' ? 'مثال: ابحث عن ملف الميزانية' : 'اكتب كلمة للبحث أو اختر مهمة';
    visible($('organizerLocal'), mode() === 'files');
    visible($('organizerCloud'), mode() !== 'files');
    $('organizerMessage').reset();
    visible($('organizerMessage'), false);
    $('organizerShortcuts').replaceChildren(...shortcutTasks[mode()].map(([label, value]) => button(label, () => {
      task.value = value;
      void runSearch();
    })));
    if (mode() === 'files') {
      status.textContent = '';
      const localPage = localAgentOrigin();
      const notice = $('organizerLocalNotice');
      notice.textContent = 'إدارة ملفات ويندوز تعمل من نسخة الكمبيوتر. شغّل Start-Sowalif.cmd، ثم افتح نسخة الكمبيوتر.';
      visible(notice, !localPage);
      visible($('organizerOpenLocal'), !localPage);
      updateLocalControls();
      if (localPage) void action(loadRoots, fileStatus);
    } else {
      const service = provider();
      client.value = settings.get(`organizerClient.${service}`, '');
      $('organizerConnectConfig').open = !client.value;
      $('organizerConnectHelp').textContent = service === 'google'
        ? `فعّل Gmail API وDrive API وأضف ${location.origin} ضمن عناوين JavaScript المسموحة في Google Cloud.`
        : location.hostname === '127.0.0.1'
          ? 'لربط Microsoft محليًا، افتح سوالف على http://localhost:4781/ واستخدم http://localhost:4781/oauth-microsoft.html في إعداد تطبيق SPA.'
          : `سجّل تطبيق SPA في Microsoft Entra وأضف عنوان الرجوع ${microsoftRedirectUri()}.`;
      if (service === 'google') void prepareGoogleOAuth().catch(() => {});
      showConnection();
      status.textContent = tokens[tokenKey()] ? 'الحساب متصل في هذه الجلسة.' : 'اربط حسابك للبحث.';
    }
  }

  function renderLocalFile(file, target) {
    const directory = file.kind === 'directory';
    const { element, controls } = item(file.name, [directory ? 'مجلد' : formatSize(file.size), file.path].filter(Boolean).join(' · '));
    if (directory) {
      controls.append(button('فتح المجلد', () => {
        localDirectory = file.path;
        task.value = 'اعرض الملفات';
        void runSearch();
      }));
      target.append(element);
      return;
    }
    controls.append(button('قراءة النص', () => void action(async () => {
      const output = await local('read', { root: roots.value, path: file.path });
      let preview = element.querySelector('pre');
      if (!preview) {
        preview = document.createElement('pre');
        preview.dir = 'auto';
        preview.className = 'organizer-mail-body';
        element.append(preview);
      }
      preview.textContent = output.text || 'ملف نصي فارغ.';
      status.textContent = output.partial ? 'تم عرض أول جزء من الملف.' : 'تم عرض نص الملف.';
    })));
    function transfer(actionName, label) {
      controls.append(button(label, () => {
        const destination = prompt('الصق المسار الكامل للملف في مكانه الجديد', file.path)?.trim();
        if (!destination || destination === file.path) return;
        void action(async () => {
          const changed = await local('change', { action: actionName, path: file.path, destination });
          if (actionName === 'move') element.remove();
          status.textContent = `تم ${label} إلى ${changed.destination}.`;
        });
      }));
    }
    transfer('move', 'نقل');
    transfer('copy', 'نسخ');
    controls.append(button('إلى المهملات', () => {
      if (!confirm(`تنقل «${file.path}» إلى مهملات سوالف؟`)) return;
      void action(async () => {
        const change = await local('change', { action: 'trash', path: file.path });
        controls.replaceChildren(button('استرجاع', () => void action(async () => {
          await local('change', { action: 'restore', path: change.destination, destination: file.path });
          element.remove();
          renderLocalFile(file, target);
          status.textContent = 'تم استرجاع الملف.';
        })));
        status.textContent = `تم نقل الملف إلى ${change.destination}.`;
      });
    }));
    target.append(element);
  }

  function renderLocal(result) {
    for (const file of result.files || []) renderLocalFile(file, results);
    for (const group of result.groups || []) {
      const section = document.createElement('section');
      const heading = document.createElement('h4');
      heading.textContent = `${group.count || group.files.length} نسخ متطابقة · ${formatSize(group.size)} لكل نسخة`;
      section.append(heading);
      for (const file of group.files) renderLocalFile(file, section);
      results.append(section);
    }
    status.textContent = [
      results.childElementCount ? `تم فحص ${result.scanned} ملف.` : 'ما لقيت نتائج في النطاق الذي تم فحصه.',
      result.skipped ? `تعذّر قراءة ${result.skipped} عنصر.` : '',
      result.contentSkipped ? `تم تجاوز محتوى ${result.contentSkipped} ملف.` : '',
      result.partial ? 'النتائج جزئية. حدّد مجلدًا أصغر للحصول على نتيجة أدق.' : '',
      result.more ? 'تم عرض أول النتائج ضمن حد العرض.' : '',
    ].filter(Boolean).join(' ');
  }

  function renderMail(message) {
    const { element, controls } = item(message.subject || 'بدون موضوع', [message.from, message.date && new Date(message.date).toLocaleString('ar'), !message.unread ? '' : 'غير مقروءة', message.attachmentCount ? 'فيها مرفقات' : ''].filter(Boolean).join(' · '));
    const selection = document.createElement('input');
    selection.type = 'checkbox';
    selection.dataset.mailId = message.id;
    selection.setAttribute('aria-label', `تحديد رسالة ${message.subject || 'بدون موضوع'}`);
    element.prepend(selection);
    const body = document.createElement('p');
    body.dir = 'auto';
    body.className = 'organizer-mail-body';
    body.textContent = message.snippet || '';
    element.insertBefore(body, controls);
    controls.append(button('قراءة', () => void action(async () => {
      const full = await api().readMail(provider(), message.id);
      body.textContent = full.body || full.snippet || 'الرسالة بدون نص مقروء.';
      const files = document.createElement('div');
      files.className = 'row';
      for (const file of full.attachments || []) files.append(button(`تنزيل ${file.name}`, () => void action(async () => {
        download(file.name, await api().mailAttachment(provider(), message.id, file));
      })));
      element.querySelector('.organizer-attachments')?.remove();
      files.classList.add('organizer-attachments');
      element.append(files);
    })));
    const mark = button(message.unread ? 'تحديد كمقروءة' : 'تحديد كغير مقروءة', () => void action(async () => {
      await api().updateMail(provider(), message.id, message.unread ? 'read' : 'unread');
      message.unread = !message.unread;
      mark.textContent = message.unread ? 'تحديد كمقروءة' : 'تحديد كغير مقروءة';
      status.textContent = 'تم تحديث حالة الرسالة.';
    }));
    controls.append(mark, button('أرشفة', () => void action(async () => {
      await api().updateMail(provider(), message.id, 'archive');
      element.remove();
      status.textContent = 'تمت أرشفة الرسالة.';
    })), button('إلى المهملات', () => {
      if (!confirm(`تنقل رسالة «${message.subject || 'بدون موضوع'}» إلى المهملات؟`)) return;
      void action(async () => {
        await api().trashMail(provider(), message.id);
        element.remove();
        status.textContent = 'تم نقل الرسالة إلى المهملات.';
      });
    }));
    results.append(element);
    visible($('organizerBulkMail'), true);
  }

  function renderDrive(file) {
    const { element, controls } = item(file.name, [file.folder ? 'مجلد' : formatSize(file.size), file.modified && new Date(file.modified).toLocaleString('ar')].filter(Boolean).join(' · '));
    if (file.url && /^https:\/\//i.test(file.url)) {
      const link = document.createElement('a');
      link.href = file.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'فتح في المزوّد';
      controls.append(link);
    }
    if (file.folder) controls.append(button('تصفح المجلد', () => {
      clearResults();
      lastSearch = { action: 'search', parentId: file.id };
      void runSearch(true);
    }));
    else controls.append(button('تنزيل', () => void action(async () => {
      const { name, blob } = await api().driveDownload(provider(), file.id);
      download(name, blob);
    })));
    controls.append(button('نقل', () => {
      const name = prompt('اكتب اسم المجلد الذي تريد النقل إليه')?.trim();
      if (!name) return;
      void action(async () => {
        const found = await api().searchDrive(provider(), name, { limit: 30, foldersOnly: true });
        const folders = found.items.filter(candidate => candidate.folder && candidate.id !== file.id);
        if (!folders.length) throw new Error('ما لقيت مجلدًا مطابقًا للاسم.');
        const choice = Number(prompt(`اختر رقم المجلد:\n${folders.map((folder, i) => `${i + 1}. ${folder.name}`).join('\n')}`));
        if (!folders[choice - 1]) return;
        await api().moveDrive(provider(), file.id, folders[choice - 1].id);
        element.remove();
        status.textContent = 'تم نقل العنصر.';
      });
    }), button('إلى المهملات', () => {
      if (!confirm(`تنقل «${file.name}» إلى المهملات؟`)) return;
      void action(async () => {
        await api().trashDrive(provider(), file.id);
        element.remove();
        status.textContent = 'تم نقل العنصر إلى المهملات.';
      });
    }));
    results.append(element);
  }

  async function runSearch(append = false) {
    if (busy) return;
    if (!append) clearResults();
    await action(async () => {
      const kind = mode();
      const input = task.value.trim();
      const intent = append ? lastSearch : organizerIntent(input, kind) ||
        (input && (kind === 'files' ? { action: 'find', query: input } : { action: 'search', query: input }));
      if (!intent) throw new Error('اكتب اسمًا للبحث أو اختر إحدى المهام الظاهرة.');
      if (kind === 'files') {
        if (!roots.value) throw new Error('أضف مجلدًا أو قرصًا أولًا.');
        if (roots.value === '*' && intent.action === 'browse') throw new Error('اختر مجلدًا أو قرصًا واحدًا للتصفح.');
        const result = await local('scan', { ...intent, root: roots.value, directory: intent.action === 'browse' && localDirectory || undefined });
        if (intent.action === 'browse' && localDirectory) {
          results.append(button('العودة إلى جذر المجلد', () => {
            localDirectory = '';
            void runSearch();
          }));
        }
        renderLocal(result);
        return;
      }
      if (!tokens[tokenKey()]) throw new Error('اربط الحساب أولًا.');
      const options = { limit: 25, cursor: append ? nextPage : undefined, attachmentsOnly: intent.attachmentsOnly,
        unreadOnly: intent.unreadOnly, from: intent.from, review: intent.review, parentId: intent.parentId };
      const method = kind === 'mail' ? 'searchMail' : 'searchDrive';
      const result = await api()[method](provider(), intent.query || '', options);
      for (const entry of result.items) (kind === 'mail' ? renderMail : renderDrive)(entry);
      lastSearch = intent;
      nextPage = result.cursor;
      visible(more, Boolean(nextPage));
      const count = results.childElementCount;
      if (intent.review) {
        status.textContent = `عدد الرسائل المرشحة للمراجعة: ${count}. المعايير: رسائل مقروءة عمرها أكثر من 90 يومًا، بدون مرفقات أو نجمة أو علامة متابعة.`;
      } else status.textContent = count ? `عدد النتائج المعروضة: ${count}.` : 'ما لقيت نتائج.';
    });
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name || 'attachment';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  $('openOrganizer').onclick = () => {
    visible(sheet, true);
    if (!busy) showSource();
    source.focus();
  };
  source.onchange = showSource;
  roots.onchange = () => {
    localDirectory = '';
    clearResults();
    updateLocalControls();
    toggleForm(createForm, $('organizerCreate'), false);
    fileStatus.textContent = '';
    status.textContent = '';
  };
  $('organizerSearch').onsubmit = event => { event.preventDefault(); void runSearch(); };
  more.onclick = () => { if (nextPage) void runSearch(true); };
  for (const [id, operation] of [['organizerArchiveSelected', 'archive'], ['organizerTrashSelected', 'trash']]) {
    $(id).onclick = () => {
      if (busy || mode() !== 'mail') return;
      const selected = [...results.querySelectorAll('input[data-mail-id]:checked')];
      if (!selected.length) {
        status.textContent = 'حدّد الرسائل من نتائج البحث أولًا.';
        return;
      }
      const description = operation === 'archive' ? 'أرشفة' : 'نقل للمهملات';
      if (!confirm(`تنفّذ «${description}» لعدد ${selected.length} من الرسائل المحددة؟`)) return;
      void action(async () => {
        let completed = 0;
        try {
          for (const field of selected) {
            await api().updateMail(provider(), field.dataset.mailId, operation);
            field.closest('article').remove();
            completed++;
          }
          status.textContent = `تم تنفيذ العملية على ${completed} رسالة.`;
        } catch (error) {
          status.textContent = `تم تنفيذ العملية على ${completed} من ${selected.length} رسالة. ${error.message}`;
        } finally {
          visible($('organizerBulkMail'), Boolean(results.childElementCount));
        }
      });
    };
  }
  function toggleForm(form, control, expanded) {
    visible(form, expanded);
    control.setAttribute('aria-expanded', String(expanded));
  }
  $('organizerLink').onclick = () => {
    if (busy || !localAgentOrigin()) return;
    const expanded = linkForm.classList.contains('hidden');
    toggleForm(linkForm, $('organizerLink'), expanded);
    toggleForm(createForm, $('organizerCreate'), false);
    if (expanded) $('organizerRootPath').focus();
  };
  linkForm.onsubmit = event => {
    event.preventDefault();
    if (busy) return;
    const path = $('organizerRootPath').value.trim().replace(/^"(.*)"$/, '$1');
    if (!path) { fileStatus.textContent = 'أدخل مسار المجلد أو القرص.'; return; }
    void action(async () => {
      const { roots: entries } = await local('roots', { path });
      const selection = entries.find(entry => entry.path.toLowerCase() === path.toLowerCase())?.path || entries.at(-1)?.path;
      await loadRoots(selection);
      clearResults();
      linkForm.reset();
      toggleForm(linkForm, $('organizerLink'), false);
      fileStatus.textContent = `تمت إضافة «${roots.value}».`;
    }, fileStatus);
  };
  $('organizerUnlink').onclick = () => {
    const path = roots.value;
    if (busy || !path || path === '*' || !confirm(`تلغي وصول سوالف إلى «${path}»؟`)) return;
    void action(async () => {
      await local('roots', { path, remove: true });
      clearResults();
      toggleForm(createForm, $('organizerCreate'), false);
      await loadRoots();
      fileStatus.textContent = `تمت إزالة الوصول إلى «${path}».`;
    }, fileStatus);
  };
  $('organizerCreate').onclick = () => {
    if (busy || !roots.value || roots.value === '*') return;
    const expanded = createForm.classList.contains('hidden');
    toggleForm(createForm, $('organizerCreate'), expanded);
    toggleForm(linkForm, $('organizerLink'), false);
    if (expanded) $('organizerNewName').focus();
  };
  $('organizerNewType').onchange = () => visible($('organizerNewText'), $('organizerNewType').value === 'create');
  createForm.onsubmit = event => {
    event.preventDefault();
    if (busy || !roots.value || roots.value === '*') return;
    const root = roots.value;
    const name = $('organizerNewName').value.trim();
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
      fileStatus.textContent = 'اكتب اسم ملف أو مجلد صالح داخل المسار المحدد.';
      return;
    }
    const directory = localDirectory || root;
    const separator = directory.includes('\\') ? '\\' : '/';
    const path = directory.endsWith(separator) ? directory + name : directory + separator + name;
    const kind = $('organizerNewType').value;
    void action(async () => {
      const changed = await local('change', { root, path, action: kind, content: $('organizerNewContent').value });
      fileStatus.textContent = `تم إنشاء ${changed.path}.`;
      createForm.reset();
      visible($('organizerNewText'), false);
      toggleForm(createForm, $('organizerCreate'), false);
    }, fileStatus);
  };
  $('organizerConnect').onclick = () => {
    if (busy) return;
    const id = client.value.trim();
    if (!id) {
      $('organizerConnectConfig').open = true;
      client.focus();
      status.textContent = 'أدخل معرّف تطبيق OAuth من إعداد الاتصال.';
      return;
    }
    const which = provider();
    void action(async () => {
      const connect = which === 'google' ? connectGoogle : connectMicrosoft;
      tokens[tokenKey()] = await connect(id, CONNECTED_SCOPES[which]);
      settings.set(`organizerClient.${which}`, id);
      $('organizerConnectConfig').open = false;
      showConnection();
      status.textContent = 'تم ربط الحساب لهذه الجلسة.';
    });
  };
  $('organizerDisconnect').onclick = () => {
    if (busy) return;
    delete tokens[tokenKey()];
    showSource();
  };
  $('organizerCompose').onclick = () => {
    if (busy) return;
    visible($('organizerMessage'), $('organizerMessage').classList.contains('hidden'));
    $('organizerTo').focus();
  };
  $('organizerMessage').onsubmit = event => {
    event.preventDefault();
    if (busy || !tokens[tokenKey()]) return;
    const to = $('organizerTo').value.trim();
    const subject = $('organizerSubject').value.trim();
    const body = $('organizerBody').value.trim();
    if (!to || !subject || !body || !confirm(`ترسل «${subject}» إلى ${to}؟`)) return;
    const form = event.target;
    void action(async () => {
      await api().sendMail(provider(), { to, subject, body });
      form.reset();
      visible(form, false);
      status.textContent = 'تم إرسال الرسالة.';
    });
  };
}
