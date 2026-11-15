const tones = { positive: 'إيجابي', negative: 'سلبي', neutral: 'محايد أو غير محسوم' };
const times = new Intl.DateTimeFormat('ar-KW', { dateStyle: 'medium', timeStyle: 'short' });
const displayTime = value => Number.isFinite(Date.parse(value)) ? times.format(new Date(value)) : '';
const safeLink = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
};
function marketOrigin(value) {
  if (!safeLink(value)) return '';
  const url = new URL(value);
  return url.pathname === '/' && !url.search && !url.hash ? url.origin : '';
}
const element = (tag, value, className) => {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
};

export function initMarket({ local, analyze }) {
  const $ = id => document.getElementById(id);
  const sheet = $('marketSheet');
  const notice = $('marketStatus');
  const selectedEvent = new URL(location.href).searchParams.get('market');
  const filter = $('marketFilter');
  const apiKey = $('marketToken');
  const endpointField = $('marketEndpoint');
  let csrf = '';
  let token = local ? '' : localStorage.getItem('sowalifMarketToken') || '';
  let endpoint = local ? '' : marketOrigin(localStorage.getItem('sowalifMarketEndpoint'));
  endpointField.value = endpoint;
  let data, openId = selectedEvent;
  let working = false;
  const cachedAnalysis = new Map();
  $('marketAccess').classList.toggle('hidden', local);
  $('marketNotifyBar').classList.toggle('hidden', local);

  async function api(route, body) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (body !== undefined && csrf) headers['X-Sowalif-CSRF'] = csrf;
    const response = await fetch(`${endpoint}/api/market/${route}`, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', credentials: 'omit', redirect: 'error',
      referrerPolicy: 'same-origin', signal: AbortSignal.timeout(30000) });
    if (!response.headers.get('content-type')?.includes('application/json') || response.status === 404 && route === 'status') {
      throw new Error(local ? 'أعد تشغيل نسخة سوالف للكمبيوتر لتفعيل السوق.' : 'خدمة السوق تحتاج تشغيلًا على خادم سوالف. افتح نسخة الكمبيوتر لمتابعة السوق محليًا.');
    }
    const result = await response.json();
    if (response.status === 401) throw new Error('أدخل رمز الوصول لخدمة السوق.');
    if (!response.ok) throw new Error(result.error || 'تعذّر الاتصال بخدمة السوق.');
    return result;
  }

  async function task(action) {
    if (working) return;
    working = true;
    notice.textContent = 'جاري جلب بيانات السوق…';
    try { await action(); }
    catch (error) { notice.textContent = error.message; }
    finally { working = false; }
  }

  function status(value, fillForm = false) {
    data = value;
    csrf = value.csrf || csrf;
    const { config, sources = [], quotes = [], errors = [], lastCheckedAt } = data;
    $('marketTools').classList.remove('hidden');
    $('marketNotifyBar').classList.toggle('hidden', local || !data.pushKey);
    const active = filter.value;
    filter.replaceChildren(new Option('كل المتابعة', ''), ...config.assets.map(asset => new Option(asset, asset)));
    filter.value = config.assets.includes(active) ? active : '';
    const types = new Set(sources.filter(source => source.configured).map(source => source.kind));
    notice.textContent = [config.enabled ? `المتابعة تعمل كل ${config.intervalMinutes} دقيقة.` : 'المتابعة التلقائية متوقفة.',
      lastCheckedAt && `آخر فحص ${displayTime(lastCheckedAt)}.`, !types.has('price') && 'ربط الأسعار غير مفعّل.',
      !types.has('calendar') && 'ربط التقويم الاقتصادي غير مفعّل.', errors.length > 0 && `تعذّر تحديث ${errors.length} من المصادر.`].filter(Boolean).join(' ');
    if (errors.length) notice.title = errors.map(({ source, message }) => `${source} — ${message}`).join('\n');
    else notice.removeAttribute('title');
    $('marketQuotes').replaceChildren(...quotes.map(quote => {
      const card = element('div', '', 'market-quote');
      const when = displayTime(quote.timestamp || quote.observedAt);
      card.append(element('strong', `${quote.asset} · ${quote.price}`), element('small', [quote.source,
        quote.timestampKind === 'open' ? `افتتاح شمعة الدقيقة ${when}` : when, quote.marketOpen === false && 'السوق مغلق'].filter(Boolean).join(' · ')));
      return card;
    }));
    if (!fillForm) return;
    $('marketEnabled').checked = config.enabled;
    $('marketAssets').value = config.assets.join(', ');
    $('marketInterval').value = config.intervalMinutes;
    $('marketLead').value = config.leadMinutes;
    $('marketThresholds').value = config.priceAlerts.flatMap(alert => [alert.above && `${alert.asset} > ${alert.above}`, alert.below && `${alert.asset} < ${alert.below}`].filter(Boolean)).join('\n');
  }

  function eventCard(event) {
    const card = element('details', '', 'market-event');
    const summary = element('summary');
    const asset = filter.value || event.assets[0];
    const direction = ['positive', 'negative'].includes(event.direction) ? event.direction : 'neutral';
    const heading = element('strong', '', 'market-assets');
    for (const symbol of event.assets) {
      const assessment = event.analyses?.[symbol];
      const tone = assessment && Object.hasOwn(tones, assessment.direction) ? assessment.direction : direction;
      const label = element('bdi', symbol, `market-symbol ${tone}`);
      label.title = tones[tone];
      label.setAttribute('aria-label', `${symbol} ${tones[tone]}`);
      heading.append(label);
    }
    summary.append(heading, element('span', tones[direction], `market-direction ${direction}`), element('span', event.title),
      element('small', [event.source, displayTime(event.scheduledAt || event.publishedAt || event.observedAt)].filter(Boolean).join(' · ')));
    const body = element('div', '', 'market-event-body');
    if (event.summary) body.append(element('p', event.summary));
    if (event.reason) body.append(element('p', event.reason));
    if (event.stage === 'scheduled') body.append(element('p', event.timeConfirmed === false ? 'الموعد تقديري لحين تأكيد وقت الإصدار.' : 'حدث مجدول. يتضح الأثر بعد صدور النتيجة الفعلية.'));
    const values = [['الفعلي', event.actual], ['المتوقع', event.forecast], ['السابق', event.previous], ['السابق قبل المراجعة', event.revised]]
      .filter(([, value]) => value !== null && value !== undefined && value !== '').map(([label, value]) => `${label} ${value}`);
    if (values.length) body.append(element('p', values.join(' · ')));
    const trust = { high: 'عالية', medium: 'متوسطة', low: 'منخفضة' };
    for (const [symbol, assessment] of Object.entries(event.analyses || {})) {
      const tone = Object.hasOwn(tones, assessment.direction) ? assessment.direction : 'neutral';
      const panel = element('section', '', 'market-assessment');
      panel.append(element('strong', `${symbol} · ${tones[tone]}`, `market-direction ${tone}`), element('p', assessment.summary),
        element('p', assessment.scenario), element('p', assessment.alternative),
        element('small', [trust[assessment.confidence] && `الثقة ${trust[assessment.confidence]}`, assessment.model, displayTime(assessment.analyzedAt)].filter(Boolean).join(' · ')));
      body.append(panel);
    }
    const href = safeLink(event.url);
    if (href) {
      const link = element('a', 'المصدر');
      Object.assign(link, { href, target: '_blank', rel: 'noopener noreferrer' });
      body.append(link);
    }
    const analysis = element('p', '', 'market-analysis');
    analysis.setAttribute('role', 'status');
    const key = `${event.id}:${asset}`;
    const updateAnalysis = value => { analysis.textContent = `${value.model}\n${value.text}`; };
    if (cachedAnalysis.has(key)) updateAnalysis(cachedAnalysis.get(key));
    if (analyze && event.stage !== 'scheduled' && asset) {
      const button = element('button', `حلّل أثره على ${asset}`, 'btn ghost');
      button.type = 'button';
      button.onclick = async () => {
        button.disabled = true;
        analysis.textContent = 'يقرأ المصدر ويحلل السيناريوهات…';
        try {
          const article = event.kind === 'news' ? await api(`article?id=${encodeURIComponent(event.id)}`).catch(() => null) : null;
          const quote = event.quote || data.quotes.find(entry => entry.asset === asset);
          const result = await analyze({ event, asset, article, quote });
          cachedAnalysis.set(key, result);
          updateAnalysis(result);
        } catch (error) { analysis.textContent = error.message; }
        finally { button.disabled = false; }
      };
      body.append(button, analysis);
    }
    card.append(summary, body);
    card.open = event.id === openId;
    if (card.open) requestAnimationFrame(() => card.scrollIntoView({ block: 'nearest' }));
    card.ontoggle = () => { if (card.open) openId = event.id; else if (openId === event.id) openId = null; };
    return card;
  }

  async function events() {
    const result = await api(`events${filter.value ? `?asset=${encodeURIComponent(filter.value)}` : ''}`);
    const upcoming = (data.upcoming || []).filter(event => !filter.value || event.assets.includes(filter.value));
    const list = [...upcoming.filter(event => !result.events.some(item => item.id === event.id)), ...result.events];
    $('marketEvents').replaceChildren(...(list.length ? list.map(eventCard) : [element('p', 'ما في أحداث متاحة للأصول المحددة.', 'muted')]));
  }

  const open = () => {
    sheet.classList.remove('hidden');
    return task(async () => { status(await api('status'), true); await events(); });
  };
  $('openMarket').onclick = open;
  if (selectedEvent) void open();
  $('marketConnect').onclick = () => {
    if (working) return;
    const raw = endpointField.value.trim();
    const next = marketOrigin(raw);
    if (raw && !next) {
      notice.textContent = 'أدخل عنوان خادم يبدأ بـ https:// ويحتوي على النطاق فقط.';
      return;
    }
    const secret = apiKey.value.trim() || (next === endpoint ? token : '');
    if (!secret) { notice.textContent = 'أدخل رمز الوصول لخدمة السوق.'; return; }
    csrf = '';
    endpoint = next;
    token = secret;
    apiKey.value = '';
    localStorage.setItem('sowalifMarketEndpoint', endpoint);
    localStorage.setItem('sowalifMarketToken', token);
    void open();
  };
  $('marketForget').onclick = () => {
    if (working) return;
    token = '';
    data = null;
    localStorage.removeItem('sowalifMarketToken');
    $('marketTools').classList.add('hidden');
    $('marketEvents').replaceChildren();
    notice.textContent = 'تم مسح رمز الوصول من هذا الجهاز.';
  };
  filter.onchange = () => task(async () => { await events(); status(data); });
  $('marketRefresh').onclick = () => task(async () => { status(await api('refresh', {})); await events(); });
  $('marketForm').onsubmit = event => {
    event.preventDefault();
    void task(async () => {
      const priceAlerts = $('marketThresholds').value.trim().split('\n').filter(line => line.trim()).map(line => {
        const [, asset, sign, price] = /^\s*([a-z]{3}\/[a-z]{3})\s*([<>])\s*(\d+(?:\.\d+)?)\s*$/i.exec(line) || [];
        if (!asset) throw new Error('اكتب كل حد سعري بسطر مثل XAU/USD > 2500.');
        return { asset, [sign === '>' ? 'above' : 'below']: Number(price) };
      });
      status(await api('config', { enabled: $('marketEnabled').checked,
        assets: $('marketAssets').value.trim().split(/[\s,،]+/), intervalMinutes: Number($('marketInterval').value),
        leadMinutes: Number($('marketLead').value), priceAlerts }), true);
      await events();
    });
  };
  async function subscribe(enabled) {
    if (enabled && await globalThis.Notification?.requestPermission() !== 'granted') throw new Error('فعّل إذن الإشعارات من إعدادات الجهاز.');
    const registration = await navigator.serviceWorker?.getRegistration();
    const manager = registration?.pushManager;
    if (!manager || !data?.pushKey) throw new Error('الإشعارات تحتاج متصفحًا يدعمها. على الآيفون افتح سوالف من الشاشة الرئيسية.');
    let subscription = await manager.getSubscription();
    const registeredKey = subscription?.options?.applicationServerKey;
    if (enabled && registeredKey) {
      const current = btoa(String.fromCharCode(...new Uint8Array(registeredKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (current !== data.pushKey.replace(/=+$/, '')) throw new Error('خادم السوق وإشعارات سوالف يحتاجان مفتاح الإشعارات نفسه على هذا الجهاز.');
    }
    if (!subscription && enabled) subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: data.pushKey });
    if (subscription) await api('subscription', { enabled, subscription: subscription.toJSON() });
    if (enabled) localStorage.setItem('sowalifMarketPush', 'true');
    else localStorage.removeItem('sowalifMarketPush');
    notice.textContent = enabled ? 'تم تفعيل إشعارات السوق على هذا الجهاز.' : 'تم إيقاف إشعارات السوق على هذا الجهاز.';
  }
  $('marketEnableNotify').onclick = () => task(() => subscribe(true));
  $('marketDisableNotify').onclick = () => task(() => subscribe(false));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !sheet.classList.contains('hidden') && data) void task(async () => { status(await api('status')); await events(); });
  });
  setInterval(() => {
    if (!document.hidden && !sheet.classList.contains('hidden') && data) void task(async () => { status(await api('status')); await events(); });
  }, 60000);
}
