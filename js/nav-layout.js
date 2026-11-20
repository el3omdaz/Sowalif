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
