import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MINUTE = 60_000;
const EVENT_LIMIT = 300;
const ANALYSIS_LIMIT = 300;
const MAX_BYTES = 2_000_000;
const DEFAULT_CONFIG = {
  enabled: false,
  assets: ['XAU/USD', 'EUR/USD'],
  intervalMinutes: 5,
  leadMinutes: 15,
  priceAlerts: [],
};

const NEWS_SOURCES = [
  ['fed-policy', 'Federal Reserve · Monetary Policy', 'USD', 'https://www.federalreserve.gov/feeds/press_monetary.xml'],
  ['fed-speeches', 'Federal Reserve · Speeches & Testimony', 'USD', 'https://www.federalreserve.gov/feeds/speeches_and_testimony.xml'],
  ['bls-jobs', 'U.S. Bureau of Labor Statistics · Employment', 'USD', 'https://www.bls.gov/feed/empsit.rss'],
  ['bls-cpi', 'U.S. Bureau of Labor Statistics · CPI', 'USD', 'https://www.bls.gov/feed/cpi.rss'],
  ['ecb-press', 'European Central Bank · Press & Speeches', 'EUR', 'https://www.ecb.europa.eu/rss/press.html'],
  ['boc-press', 'Bank of Canada · Press', 'CAD', 'https://www.bankofcanada.ca/content_type/press-releases/feed/'],
  ['boc-speeches', 'Bank of Canada · Speeches', 'CAD', 'https://www.bankofcanada.ca/content_type/speeches/feed/'],
  ['boj-news', 'Bank of Japan · News', 'JPY', 'https://www.boj.or.jp/en/rss/whatsnew.xml'],
  ['rba-press', 'Reserve Bank of Australia · Press', 'AUD', 'https://www.rba.gov.au/rss/rss-cb-media-releases.xml'],
  ['rba-speeches', 'Reserve Bank of Australia · Speeches', 'AUD', 'https://www.rba.gov.au/rss/rss-cb-speeches.xml'],
].map(([id, name, currency, url]) => ({ id, name, currency, url, kind: 'news' }));

const ARTICLE_PATHS = new Map([
  ['www.federalreserve.gov', /^\/(?:newsevents\/(?:pressreleases|speech|testimony)\/|monetarypolicy\/fomcminutes)[a-z0-9/_-]+\.htm$/i],
  ['www.bls.gov', /^\/news\.release\/(?:archives\/)?[a-z0-9._-]+\.htm$/i],
  ['www.ecb.europa.eu', /^\/press\/[a-z0-9/._-]+\.html$/i],
  ['www.bankofcanada.ca', /^\/20\d{2}\/\d{2}\/[a-z0-9/_-]+\/$/i],
  ['www.boj.or.jp', /^\/en\/(?:mopo|about\/press|announcements)\/[a-z0-9/._-]+\.htm$/i],
  ['www.rba.gov.au', /^\/(?:media-releases|speeches)\/[a-z0-9/._-]+\.html$/i],
]);

const QUOTE_SOURCE = { id: 'twelve-data', name: 'Twelve Data', kind: 'price', url: 'https://twelvedata.com/' };
const CALENDAR_SOURCE = { id: 'trading-economics', name: 'Trading Economics', kind: 'calendar', url: 'https://tradingeconomics.com/calendar' };
const CALENDAR_CURRENCIES = new Map([
  ['united states', 'USD'], ['euro area', 'EUR'], ['european union', 'EUR'], ['germany', 'EUR'],
  ['france', 'EUR'], ['italy', 'EUR'], ['spain', 'EUR'], ['united kingdom', 'GBP'], ['japan', 'JPY'],
  ['canada', 'CAD'], ['switzerland', 'CHF'], ['australia', 'AUD'], ['new zealand', 'NZD'],
  ['china', 'CNY'], ['hong kong', 'HKD'], ['india', 'INR'], ['singapore', 'SGD'],
  ['mexico', 'MXN'], ['south africa', 'ZAR'], ['norway', 'NOK'], ['sweden', 'SEK'],
]);
const ASSET_PATTERN = /^[A-Z]{3}\/[A-Z]{3}$/;
const ANALYSIS_DIRECTIONS = new Set(['positive', 'negative', 'neutral']);
const ANALYSIS_CONFIDENCE = new Set(['low', 'medium', 'high']);

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function timestamp(value, utc = false) {
  if (!value) return null;
  const input = String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/i.test(input) && utc
    ? `${input}Z`
    : input;
  const millis = Date.parse(date);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function httpsUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function key(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

function fault(message, status = 400) {
  return Object.assign(new Error(message), { status, statusCode: status });
}

function assetName(value) {
  const normalized = clean(value, 30).toUpperCase().replace(/\s+/g, '');
  if (!ASSET_PATTERN.test(normalized) || normalized.slice(0, 3) === normalized.slice(4)) {
    throw fault('اكتب رمز الأصل بالشكل XAU/USD أو EUR/USD.');
  }
  return normalized;
}

function boundedInt(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw fault(`${label} بين ${min} و${max} دقيقة.`);
  return value;
}

function optionalPrice(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw fault('أدخل سعرًا رقميًا أكبر من صفر.');
  return value;
}

function normalizeConfig(input, previous = DEFAULT_CONFIG) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('إعدادات المراقبة غير صالحة.');
  const config = { ...previous };
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw fault('حالة مراقبة السوق غير صالحة.');
    config.enabled = input.enabled;
  }
  if ('assets' in input) {
    if (!Array.isArray(input.assets) || !input.assets.length || input.assets.length > 12) {
      throw fault('اختر من أصل واحد إلى 12 أصلًا للمتابعة.');
    }
    config.assets = [...new Set(input.assets.map(assetName))];
  }
  if ('intervalMinutes' in input) config.intervalMinutes = boundedInt(input.intervalMinutes, 'مدة التحديث', 1, 60);
  if ('leadMinutes' in input) config.leadMinutes = boundedInt(input.leadMinutes, 'مدة التنبيه قبل الحدث', 0, 120);
  if ('priceAlerts' in input) {
    if (!Array.isArray(input.priceAlerts) || input.priceAlerts.length > 24) throw fault('أضف حتى 24 تنبيهًا سعريًا.');
    config.priceAlerts = input.priceAlerts.map(alert => {
      if (!alert || typeof alert !== 'object') throw fault('التنبيه السعري غير صالح.');
      const asset = assetName(alert.asset);
      const above = optionalPrice(alert.above);
      const below = optionalPrice(alert.below);
      if (!config.assets.includes(asset)) throw fault('اختر أصلًا من قائمة المتابعة للتنبيه السعري.');
      if ((above == null && below == null) || (above != null && below != null && above <= below)) {
        throw fault('حدد حدًا سعريًا واحدًا على الأقل. الحد الأعلى يجب أن يتجاوز الحد الأدنى.');
      }
      return { asset, above, below };
    });
  } else {
    config.priceAlerts = config.priceAlerts.filter(alert => config.assets.includes(alert.asset));
  }
  return config;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };

function decodeXml(value) {
  return typeof value === 'string' ? value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, name) => {
      if (!name.startsWith('#')) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : entity;
      const point = name.toLowerCase().startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    },
  ) : '';
}

function tag(xml, name) {
  return new RegExp(`<${name}(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i').exec(xml)?.[1];
}

function plainText(value, max) {
  return clean(decodeXml(value).replace(/<[^>]*>/g, ' '), max);
}

function matchedAssets(assets, currency) {
  return assets.filter(asset => asset.split('/').includes(currency));
}

function parseNews(xml, source, assets, observedAt) {
  if (!/<(?:rss|feed|rdf:RDF)(?=[\s>])/i.test(xml)) throw fault('استجابة مصدر الأخبار غير صالحة.', 502);
  return [...xml.matchAll(/<(item|entry)(?=[\s>])[^>]*>([\s\S]*?)<\/\1\s*>/gi)].slice(0, 80).flatMap(([, , item]) => {
    const title = plainText(tag(item, 'title'), 350);
    const summary = plainText(tag(item, 'description') || tag(item, 'summary') || tag(item, 'content'), 1800);
    const href = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(item)?.[1];
    const url = httpsUrl(decodeXml(tag(item, 'link') || href).trim(), source.url);
    const publishedAt = timestamp(plainText(tag(item, 'pubDate') || tag(item, 'published') || tag(item, 'updated') || tag(item, 'dc:date'), 100));
    const remoteId = plainText(tag(item, 'guid') || tag(item, 'id'), 300);
    if (!title || (!url && !remoteId && !publishedAt)) return [];
    return [{
      id: key(source.id, remoteId || url, remoteId || url ? null : publishedAt, remoteId || url ? null : title),
      kind: 'news', source: source.name, title, summary, url, publishedAt, observedAt, assets, currency: source.currency,
      direction: 'neutral', reason: '',
    }];
  });
}

async function sourceBody(request, url, format) {
  const response = await request(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
    headers: { accept: {
      json: 'application/json', html: 'text/html', xml: 'application/rss+xml, application/atom+xml, text/xml, application/xml',
    }[format] },
  });
  if (!response.ok) throw fault(`المصدر أعاد HTTP ${response.status}.`, 502);
  if (format === 'html' && !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('content-type') || '')) {
    throw fault('نص خبر السوق غير متاح من المصدر.', 502);
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw fault('استجابة المصدر أكبر من الحجم المسموح.', 502);
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw fault('استجابة المصدر أكبر من الحجم المسموح.', 502);
      body += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  body += decoder.decode();
  return format === 'json' ? JSON.parse(body) : body;
}

function extractArticle(html) {
  const sanitized = html.replace(/<!--[\s\S]*?-->/g, '').replace(
    /<(script|style|noscript|template|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '',
  );
  return plainText(tag(sanitized, 'article') || tag(sanitized, 'main') || tag(sanitized, 'body'), 14_000);
}

function epochTimestamp(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 946684800 && seconds < 4102444800
    ? new Date(seconds * 1_000).toISOString()
    : null;
}

async function fetchQuote(request, apiKey, asset, observedAt) {
  const url = new URL('https://api.twelvedata.com/quote');
  url.search = new URLSearchParams({ symbol: asset, interval: '1min', timezone: 'UTC', apikey: apiKey });
  const data = await sourceBody(request, url, 'json');
  const price = Number(data?.close);
  const quoteAt = epochTimestamp(data?.last_quote_at);
  const time = quoteAt || epochTimestamp(data?.timestamp) || timestamp(String(data?.datetime || '').replace(' ', 'T'), true);
  if (!Number.isFinite(price) || price <= 0 || !time || data?.status === 'error') {
    const code = Number(data?.code);
    throw fault(Number.isInteger(code) && code >= 400 && code <= 599 ? `المصدر أعاد ${code} للرمز.` : 'السعر أو توقيته غير متاح من المصدر.', 502);
  }
  return {
    asset, price, timestamp: time, observedAt, source: QUOTE_SOURCE.name,
    marketOpen: typeof data.is_market_open === 'boolean' ? data.is_market_open : null,
    timestampKind: quoteAt ? 'quote' : 'open',
  };
}

function priceEvents(previous, quote, alerts, interval) {
  const time = Date.parse(quote.timestamp);
  const checked = Date.parse(quote.observedAt);
  if (!previous || quote.marketOpen === false || previous.marketOpen === false || time <= Date.parse(previous.timestamp)) return [];
  if (checked - time > 8 * MINUTE || time - checked > MINUTE || time - Date.parse(previous.timestamp) > (interval + 3) * MINUTE) return [];
  const crossings = new Map();
  for (const { asset, above, below } of alerts) {
    if (asset !== quote.asset) continue;
    if (above != null && previous.price <= above && quote.price > above) crossings.set(`positive:${above}`, { direction: 'positive', threshold: above });
    if (below != null && previous.price >= below && quote.price < below) crossings.set(`negative:${below}`, { direction: 'negative', threshold: below });
  }
  return [...crossings.values()].map(({ direction, threshold }) => ({
    id: key('price', quote.asset, quote.timestamp, direction, threshold),
    kind: 'price', source: quote.source, assets: [quote.asset], direction,
    title: direction === 'positive' ? 'السعر تجاوز الحد العلوي' : 'السعر نزل دون الحد السفلي',
    summary: `${quote.asset} · ${quote.price}`,
    reason: `السعر السابق ${previous.price}، حد التنبيه ${threshold}، آخر سعر متاح ${quote.price}.`,
    url: QUOTE_SOURCE.url, publishedAt: quote.timestamp, observedAt: quote.observedAt, quote,
  }));
}

async function fetchCalendar(request, apiKey, assets, observedAt) {
  const asOf = Date.parse(observedAt);
  const dateAfter = days => new Date(asOf + days * 24 * 60 * MINUTE).toISOString().slice(0, 10);
  const url = new URL(`https://api.tradingeconomics.com/calendar/country/All/${dateAfter(-2)}/${dateAfter(7)}`);
  url.search = new URLSearchParams({ c: apiKey, importance: '3', f: 'json' });
  const rows = await sourceBody(request, url, 'json');
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object')) throw fault('بيانات التقويم غير متاحة من المصدر.', 502);
  return rows.flatMap(row => {
    const title = clean(row.Event || row.Category, 320);
    const country = clean(row.Country, 100);
    const code = clean(row.Currency, 12).toUpperCase();
    const currency = /^[A-Z]{3}$/.test(code) ? code : CALENDAR_CURRENCIES.get(country.toLowerCase());
    const matches = matchedAssets(assets, currency);
    const scheduledAt = timestamp(row.Date, true);
    const calendarId = row.CalendarId ?? row.CalendarID;
    if (calendarId == null || !title || !scheduledAt || !matches.length) return [];
    const url = httpsUrl(row.SourceURL) || httpsUrl(row.URL, 'https://tradingeconomics.com') || CALENDAR_SOURCE.url;
    const actual = clean(row.Actual, 60) || null;
    const forecast = clean(row.Forecast, 60) || null;
    const previous = clean(row.Previous, 60) || null;
    const revised = clean(row.Revised, 60) || null;
    return [{
      id: key('calendar', String(calendarId), actual == null ? null : [actual, forecast, previous, revised]),
      kind: 'calendar', source: CALENDAR_SOURCE.name, title, summary: country, url, scheduledAt, observedAt,
      publishedAt: actual == null ? null : timestamp(row.LastUpdate, true) || scheduledAt,
      stage: actual == null ? 'scheduled' : 'released', timeConfirmed: row.DateSpan != null && Number(row.DateSpan) === 0,
      actual, forecast, previous, revised, assets: matches, currency, direction: 'neutral', reason: '',
    }];
  });
}

const STATE_DEFAULTS = {
  version: 1, config: DEFAULT_CONFIG, events: [], seen: [], checkedSources: [], lastCheckedAt: null,
  errors: [], quotes: [], upcoming: [],
};

function assertState(state) {
  if (state?.version !== STATE_DEFAULTS.version || !Array.isArray(state.events) || !Array.isArray(state.seen)) {
    throw fault('تعذرت قراءة سجل مراقبة السوق.', 500);
  }
  return { ...STATE_DEFAULTS, ...state, config: normalizeConfig(state.config) };
}

function savedAnalysis(analysis) {
  const { direction, confidence, summary, scenario, alternative, model, analyzedAt } = analysis || {};
  if (!ANALYSIS_DIRECTIONS.has(direction) || !ANALYSIS_CONFIDENCE.has(confidence)
    || ![summary, scenario, alternative].every(text => typeof text === 'string' && text.trim()) || !timestamp(analyzedAt)) {
    throw fault('تحليل السوق غير صالح.');
  }
  return {
    direction, confidence, summary: summary.slice(0, 1800), scenario: scenario.slice(0, 1800), alternative: alternative.slice(0, 1800),
    model: typeof model === 'string' ? model.slice(0, 150) : null, analyzedAt: timestamp(analyzedAt),
  };
}

function retainRecentAnalyses(events, keepIndex, keepAsset) {
  const entries = events.flatMap((event, index) => Object.entries(event.analyses || {}).map(([asset, result]) => ({
    index, asset, time: result.analyzedAt,
  })));
  if (entries.length <= ANALYSIS_LIMIT) return;
  const excess = entries.length - ANALYSIS_LIMIT;
  const oldest = entries.filter(({ index, asset }) => index !== keepIndex || asset !== keepAsset)
    .sort((a, b) => a.time.localeCompare(b.time)).slice(0, excess);
  for (const { index, asset } of oldest) {
    const analyses = { ...events[index].analyses };
    delete analyses[asset];
    events[index] = { ...events[index], analyses };
  }
}

export function createMarketFeed({ dataDir, onEvents, request = fetch, now = Date.now, env = process.env } = {}) {
  const statePath = join(dataDir, 'market-feed.json');
  const quoteKey = env.TWELVE_DATA_API_KEY?.trim();
  const calendarKey = env.TRADING_ECONOMICS_API_KEY?.trim();
  const sources = [...NEWS_SOURCES.map(info => ({ ...info, configured: true })),
    { ...QUOTE_SOURCE, configured: Boolean(quoteKey) }, { ...CALENDAR_SOURCE, configured: Boolean(calendarKey) }];
  let statePromise;
  let queue = Promise.resolve();
  let inFlight;
  let timer;
  let running = false;

  function load() {
    statePromise ??= readFile(statePath, 'utf8')
      .then(raw => assertState(JSON.parse(raw)))
      .catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return structuredClone(STATE_DEFAULTS);
      });
    return statePromise;
  }

  async function save(state) {
    await mkdir(dataDir, { recursive: true });
    const tempPath = `${statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(state), { mode: 0o600 });
      await rename(tempPath, statePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
    statePromise = Promise.resolve(state);
  }

  function serialized(work) {
    const promise = queue.then(work);
    queue = promise.catch(() => {});
    return promise;
  }

  function publicStatus(state) {
    const { config, lastCheckedAt, errors, quotes, upcoming } = state;
    return structuredClone({ config, lastCheckedAt, errors, sources, quotes, upcoming });
  }

  function visibleAssets(event, config) {
    return event.currency ? matchedAssets(config.assets, event.currency) : event.assets.filter(asset => config.assets.includes(asset));
  }

  function visibleEvent(event, config, filter) {
    const assets = visibleAssets(event, config);
    if (!assets.length || (filter && !assets.includes(filter))) return [];
    const analyses = Object.fromEntries(Object.entries(event.analyses || {}).filter(([asset]) => assets.includes(asset)));
    const directions = (filter ? [filter] : assets).map(asset => analyses[asset]?.direction || event.direction);
    const direction = new Set(directions).size === 1 ? directions[0] : 'neutral';
    return [{ ...event, assets, analyses, direction }];
  }

  function schedule(state, immediate = false) {
    clearTimeout(timer);
    if (!running || !state.config.enabled) return;
    const interval = state.config.intervalMinutes * MINUTE;
    const elapsed = !immediate && state.lastCheckedAt ? now() - Date.parse(state.lastCheckedAt) : interval;
    timer = setTimeout(() => {
      void refresh().catch(() => schedule({ ...state, lastCheckedAt: new Date(now()).toISOString() }));
    }, Math.max(1_000, interval - elapsed)).unref();
  }

  async function poll() {
    const state = await load();
    const checked = Number(now());
    const observedAt = new Date(checked).toISOString();
    const { assets, enabled, intervalMinutes, leadMinutes, priceAlerts } = state.config;
    const errors = [];
    const seen = new Set(state.seen);
    const checkedSources = new Set(state.checkedSources);
    const quotes = new Map(state.quotes.map(quote => [quote.asset, quote]));
    const pending = [];
    const notices = [];
    let upcoming = state.upcoming.filter(event => Date.parse(event.scheduledAt) >= checked);

    function add(event, alert = false) {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      pending.push(event);
      if (alert && enabled) notices.push(event);
    }

    const tasks = [];
    for (const source of NEWS_SOURCES) {
      const matches = matchedAssets(assets, source.currency);
      const sourceKey = `${source.id}:${matches.join(',')}`;
      if (!matches.length) continue;
      tasks.push({ source, run: async () => {
        const xml = await sourceBody(request, source.url, 'xml');
        for (const event of parseNews(xml, source, matches, observedAt).reverse()) {
          const time = Date.parse(event.publishedAt);
          add(event, checkedSources.has(sourceKey) && time > checked - 24 * 60 * MINUTE && time <= checked + MINUTE);
        }
        checkedSources.add(sourceKey);
      } });
    }
    if (quoteKey) {
      for (const asset of assets) {
        tasks.push({ source: QUOTE_SOURCE, asset, run: async () => {
          const quote = await fetchQuote(request, quoteKey, asset, observedAt);
          const previous = quotes.get(asset);
          for (const event of priceEvents(previous, quote, priceAlerts, intervalMinutes)) add(event, true);
          if (!previous || quote.timestamp > previous.timestamp) quotes.set(asset, quote);
          else if (quote.timestamp === previous.timestamp && quote.marketOpen !== previous.marketOpen) {
            quotes.set(asset, { ...previous, marketOpen: quote.marketOpen });
          }
        } });
      }
    }
    if (calendarKey) {
      tasks.push({ source: CALENDAR_SOURCE, run: async () => {
        const calendar = await fetchCalendar(request, calendarKey, assets, observedAt);
        upcoming = calendar.filter(event => event.stage === 'scheduled' && Date.parse(event.scheduledAt) >= checked)
          .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).slice(0, 80);
        const sourceKey = `${CALENDAR_SOURCE.id}:${assets.join(',')}`;
        for (const event of calendar) {
          if (event.stage === 'scheduled') {
            const time = Date.parse(event.scheduledAt);
            if (event.timeConfirmed && time >= checked && time <= checked + leadMinutes * MINUTE) add(event, true);
          } else {
            const time = Date.parse(event.publishedAt);
            add(event, checkedSources.has(sourceKey) && time > checked - 24 * 60 * MINUTE && time <= checked + MINUTE);
          }
        }
        checkedSources.add(sourceKey);
      } });
    }

    const results = await Promise.allSettled(tasks.map(({ run }) => run()));
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      const { source, asset } = tasks[index];
      errors.push({
        source: source.name, asset: asset || null,
        message: result.reason?.status === 502 ? result.reason.message : 'تعذر الحصول على بيانات من المصدر.',
      });
    }

    const events = [...state.events, ...pending].sort((a, b) => {
      const time = event => event.publishedAt || event.observedAt;
      return time(b).localeCompare(time(a));
    }).slice(0, EVENT_LIMIT);
    const latest = {
      ...state, events, seen: [...seen].slice(-2_000), checkedSources: [...checkedSources].slice(-80),
      quotes: [...quotes.values()].filter(quote => assets.includes(quote.asset)), upcoming,
      errors, lastCheckedAt: observedAt,
    };
    await save(latest);
    schedule(latest);
    if (notices.length && typeof onEvents === 'function') {
      Promise.resolve().then(() => onEvents(structuredClone(notices))).catch(() => {});
    }
    return publicStatus(latest);
  }

  function refresh() {
    inFlight ??= serialized(poll).finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    async status() { return publicStatus(await load()); },
    async events(asset) {
      const filter = asset ? assetName(asset) : null;
      const state = await load();
      return { events: structuredClone(state.events.flatMap(event => visibleEvent(event, state.config, filter))) };
    },
    async article(eventId) {
      const state = await load();
      const event = state.events.find(item => item.id === eventId && item.kind === 'news');
      const url = event?.url && new URL(event.url);
      if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || !ARTICLE_PATHS.get(url.hostname)?.test(url.pathname)) {
        throw fault('نص خبر السوق غير متاح لهذا المصدر.', 404);
      }
      url.search = '';
      let text;
      try {
        text = extractArticle(await sourceBody(request, url, 'html'));
      } catch {
        throw fault('تعذر تحميل نص الخبر من المصدر.', 502);
      }
      if (!text || text.length < 100) throw fault('نص خبر السوق غير متاح من المصدر.', 502);
      return { id: event.id, url: url.href, source: event.source, text, retrievedAt: new Date(now()).toISOString() };
    },
    saveAnalysis(eventId, asset, analysis) {
      return serialized(async () => {
        const state = await load();
        const index = state.events.findIndex(event => event.id === eventId);
        if (index === -1) throw fault('خبر السوق غير موجود في السجل.', 404);
        const event = state.events[index];
        const symbol = assetName(asset);
        if (!visibleAssets(event, state.config).includes(symbol)) throw fault('اختر أصلًا مرتبطًا بهذا الحدث.');
        const result = savedAnalysis(analysis);
        const events = state.events.slice();
        events[index] = { ...event, analyses: { ...event.analyses, [symbol]: result } };
        retainRecentAnalyses(events, index, symbol);
        await save({ ...state, events });
        return structuredClone(result);
      });
    },
    async configure(input) {
      const state = await serialized(async () => {
        const state = await load();
        const config = normalizeConfig(input, state.config);
        const updated = {
          ...state, config, quotes: state.quotes.filter(quote => config.assets.includes(quote.asset)),
          upcoming: state.upcoming.map(event => ({ ...event, assets: visibleAssets(event, config) }))
            .filter(event => event.assets.length),
        };
        await save(updated);
        const needsNewData = !state.config.enabled || !config.assets.every(asset => state.config.assets.includes(asset));
        schedule(updated, needsNewData);
        return updated;
      });
      return publicStatus(state);
    },
    refresh,
    start() {
      running = true;
      void load().then(schedule).catch(() => {});
    },
    close() {
      running = false;
      clearTimeout(timer);
    },
  };
}
