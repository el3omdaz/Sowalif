// إعداد مستقل لترتيب شريط الأقسام. نقل العنصر نفسه يحافظ على مستمعات النقر في app.js.
const POSITION_KEY = 'sowalif.workspaceNavPosition.v1';
const COLLAPSED_KEY = 'sowalif.workspaceNavCollapsed.v1';

function readSetting(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writeSetting(key, value) {
  try { localStorage.setItem(key, value); } catch { /* تبقى الوظيفة شغالة حتى عند منع التخزين */ }
}

export function initWorkspaceNavigation() {
  const app = document.querySelector('#app');
  const main = app?.querySelector('.main');
  const top = main?.querySelector('.top');
  const tabs = document.querySelector('#workspaceTabs');
  const select = document.querySelector('#workspaceNavPosition');
  const collapse = document.querySelector('#workspaceNavCollapse');
  if (!app || !main || !top || !tabs || !select || !collapse) return;

  const desktop = window.matchMedia('(min-width: 821px)');
  let preference = readSetting(POSITION_KEY, 'top') === 'side' ? 'side' : 'top';
  let collapsed = readSetting(COLLAPSED_KEY, 'false') === 'true';
  select.value = preference;

  for (const button of tabs.querySelectorAll('button')) {
    if (!button.getAttribute('aria-label')) {
      button.setAttribute('aria-label', button.querySelector('span')?.textContent?.trim() || button.textContent.trim());
    }
  }

  function applyLayout() {
    // على الجوال نحافظ على الشريط في الأعلى حتى لو اختار المستخدم الجانب للكمبيوتر.
    const side = preference === 'side' && desktop.matches;
    if (side) {
      if (tabs.parentElement !== app) app.insertBefore(tabs, main);
    } else if (tabs.parentElement !== main) {
      top.insertAdjacentElement('afterend', tabs);
    }
    app.classList.toggle('workspace-nav-side', side);
    app.classList.toggle('workspace-nav-collapsed', side && collapsed);
    collapse.setAttribute('aria-label', collapsed ? 'توسيع شريط الأقسام' : 'طي شريط الأقسام');
    collapse.title = collapsed ? 'توسيع الشريط' : 'طي الشريط';
  }

  select.addEventListener('change', () => {
    preference = select.value === 'side' ? 'side' : 'top';
    writeSetting(POSITION_KEY, preference);
    applyLayout();
  });
  collapse.addEventListener('click', () => {
    collapsed = !collapsed;
    writeSetting(COLLAPSED_KEY, String(collapsed));
    applyLayout();
  });
  if (typeof desktop.addEventListener === 'function') desktop.addEventListener('change', applyLayout);
  else desktop.addListener(applyLayout);
  applyLayout();
}

if (typeof document !== 'undefined') initWorkspaceNavigation();


// v44: مساحة الهيستوري مستقلة عن موضع شريط الأقسام. تبقى تفضيلات العرض على هذا الجهاز.
const HISTORY_KEY = 'sowalif.historyPanelMode.v1';
const HISTORY_MODES = new Set(['expanded', 'compact', 'hidden']);

export function initHistoryLayout() {
  const app = document.querySelector('#app');
  const sidebar = document.querySelector('#side');
  const menu = document.querySelector('#menuBtn');
  const collapse = document.querySelector('#historyCollapse');
  const select = document.querySelector('#historyPanelMode');
  if (!app || !sidebar || !menu || !collapse || !select) return;

  const desktop = window.matchMedia('(min-width: 821px)');
  const initial = readSetting(HISTORY_KEY, 'compact');
  let mode = HISTORY_MODES.has(initial) ? initial : 'compact';
  let previous = mode === 'hidden' ? 'compact' : mode;

  function render() {
    const isDesktop = desktop.matches;
    app.classList.toggle('history-compact', isDesktop && mode === 'compact');
    app.classList.toggle('history-hidden', isDesktop && mode === 'hidden');
    app.classList.toggle('history-expanded', isDesktop && mode === 'expanded');
    select.value = mode;
    const visible = !isDesktop || mode !== 'hidden';
    menu.setAttribute('aria-expanded', String(isDesktop ? visible : app.classList.contains('side-open')));
    menu.setAttribute('aria-label', visible && isDesktop ? 'إخفاء سجل المحادثات' : 'إظهار سجل المحادثات');
    menu.title = menu.getAttribute('aria-label');
    collapse.setAttribute('aria-expanded', String(!isDesktop || mode === 'expanded'));
    collapse.setAttribute('aria-label', mode === 'compact' && isDesktop ? 'توسيع سجل المحادثات' : 'طي سجل المحادثات');
    collapse.title = collapse.getAttribute('aria-label');
    const list = document.querySelector('#chatList');
    const search = document.querySelector('#search');
    // منع الوصول بالكيبورد إلى عناصر محجوبة عن النظر.
    if (list) list.inert = isDesktop && mode !== 'expanded';
    if (search) search.inert = isDesktop && mode !== 'expanded';
    sidebar.setAttribute('aria-label', isDesktop && mode === 'compact' ? 'شريط المحادثات المطوي' : 'المحادثات والإعدادات');
  }

  function setMode(next) {
    if (!HISTORY_MODES.has(next)) return;
    mode = next;
    if (mode !== 'hidden') previous = mode;
    writeSetting(HISTORY_KEY, mode);
    render();
  }
  function toggle() {
    if (!desktop.matches) {
      app.classList.toggle('side-open');
      render();
      return;
    }
    setMode(mode === 'hidden' ? previous : 'hidden');
  }
  collapse.addEventListener('click', () => {
    if (!desktop.matches) { app.classList.remove('side-open'); render(); return; }
    setMode(mode === 'expanded' ? 'compact' : 'expanded');
  });
  select.addEventListener('change', () => setMode(select.value));
  if (typeof desktop.addEventListener === 'function') desktop.addEventListener('change', () => {
    app.classList.remove('side-open');
    render();
  });
  else desktop.addListener(() => { app.classList.remove('side-open'); render(); });
  document.querySelector('#scrim')?.addEventListener('click', render);
  window.sowalifHistoryLayout = { toggle, setMode, sync: render, getMode: () => mode };
  render();
}

if (typeof document !== 'undefined') initHistoryLayout();
