import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createMarketFeed } from '../server/market-feed.mjs';

const MINUTE = 60_000;
const emptyFeed = '<rss version="2.0"><channel></channel></rss>';

async function store(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sowalif-market-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function newsItem({ id, time, link = '' }) {
  return `<item><title>Inflation &amp; policy ${id}</title><description><![CDATA[<p>Official release.</p>]]></description>
    <pubDate>${new Date(time).toUTCString()}</pubDate><guid>${id}</guid><link>${link}</link></item>`;
}

test('market history survives restart, seeds quietly and reuses news for matching assets added later', async t => {
  const dataDir = await store(t);
  const notices = [];
  const clock = { time: Date.parse('2026-11-10T12:00:00Z') };
  let items = newsItem({ id: 'old', time: clock.time - MINUTE });
  const request = async url => new Response(String(url).endsWith('press_monetary.xml')
    ? `<rss version="2.0"><channel>${items}</channel></rss>`
    : emptyFeed);
  const options = { dataDir, request, now: () => clock.time, env: {}, onEvents: events => notices.push(...events) };
  let market = createMarketFeed(options);
  await market.configure({ enabled: true });
  await market.refresh();
  assert.equal(notices.length, 0);
  assert.equal((await market.events('XAU/USD')).events[0].title, 'Inflation & policy old');
  assert.equal((await market.events()).events[0].summary, 'Official release.');

  clock.time += 5 * MINUTE;
  items += newsItem({ id: 'new', time: clock.time });
  await Promise.all([market.refresh(), market.refresh()]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, 'Inflation & policy new');
  const analysis = {
    direction: 'positive', confidence: 'medium', summary: 'Evidence', scenario: 'Possible repricing',
    alternative: 'Could be priced in', model: 'provider/model', analyzedAt: new Date(clock.time).toISOString(),
  };
  await market.saveAnalysis(notices[0].id, 'XAU/USD', { ...analysis, unrelatedKey: 'local secret' });
  await market.saveAnalysis(notices[0].id, 'EUR/USD', { ...analysis, direction: 'negative' });
  market = createMarketFeed(options);
  await market.configure({ assets: ['xau/usd', ' EUR/USD ', 'USD/JPY'] });
  await market.refresh();
  assert.deepEqual((await market.events('USD/JPY')).events.map(event => event.id),
    (await market.events('XAU/USD')).events.map(event => event.id));
  assert.equal(notices.length, 1);
  assert.equal((await market.events('GBP/CHF')).events.length, 0);
  const newest = (await market.events()).events[0];
  assert.equal(newest.direction, 'neutral');
  assert.equal(newest.analyses['XAU/USD'].direction, 'positive');
  assert.equal(newest.analyses['EUR/USD'].direction, 'negative');
  assert.deepEqual(newest.analyses['XAU/USD'], analysis);
  assert.equal((await market.events('XAU/USD')).events[0].direction, 'positive');
});

test('market watches timestamped quote crossings and ignores repeated, stale and closed prices', async t => {
  let checked = Date.parse('2026-11-10T12:00:00Z');
  let at = checked;
  let price = 2499;
  let marketOpen = true;
  const secret = 'mock-price-key';
  const notices = [];
  const market = createMarketFeed({
    dataDir: await store(t), now: () => checked, env: { TWELVE_DATA_API_KEY: secret },
    onEvents: events => notices.push(...events),
    request: async url => {
      const address = new URL(url);
      if (address.hostname !== 'api.twelvedata.com') return new Response(emptyFeed);
      assert.equal(address.searchParams.get('apikey'), secret);
      assert.equal(address.searchParams.get('symbol'), 'XAU/USD');
      return Response.json({ close: String(price), last_quote_at: at / 1000, is_market_open: marketOpen });
    },
  });
  await market.configure({ enabled: true, assets: ['XAU/USD'], priceAlerts: [{ asset: 'XAU/USD', above: 2500, below: 2490 }] });
  await market.refresh();
  checked += 5 * MINUTE;
  at = checked;
  price = 2500;
  await market.refresh();
  assert.equal(notices.length, 0);
  price = 2501;
  await market.refresh();
  assert.equal(notices.length, 0);
  checked += 5 * MINUTE;
  at = checked;
  const status = await market.refresh();
  assert.equal(status.quotes[0].price, 2501);
  assert.equal(status.quotes[0].timestamp, new Date(at).toISOString());
  assert.equal(status.quotes[0].timestampKind, 'quote');
  assert.equal(status.sources.find(source => source.id === 'twelve-data').configured, true);
  assert.equal(JSON.stringify(status).includes(secret), false);
  checked += 5 * MINUTE;
  price = 2489;
  await market.refresh();
  checked += 5 * MINUTE;
  at += MINUTE;
  await market.refresh();
  checked += 5 * MINUTE;
  at = checked;
  marketOpen = false;
  await market.refresh();
  const [event] = (await market.events()).events;
  assert.equal(event.direction, 'positive');
  assert.equal(event.quote.price, 2501);
  assert.equal(notices.length, 1);
  await assert.rejects(market.configure({ assets: ['XAU/XAU'] }), { status: 400 });
  await assert.rejects(market.configure({ priceAlerts: [{ asset: 'XAU/USD', above: 1, below: 2 }] }), { status: 400 });
});

test('enabled monitoring polls when its server starts without a refresh request', { timeout: 8000 }, async t => {
  const market = createMarketFeed({ dataDir: await store(t), env: {}, request: async () => new Response(emptyFeed) });
  await market.configure({ enabled: true, assets: ['XAU/USD'] });
  market.start();
  try {
    let checked = await market.status();
    for (let attempt = 0; !checked.lastCheckedAt && attempt < 40; attempt++) {
      await pause(100);
      checked = await market.status();
    }
    assert.ok(checked.lastCheckedAt, 'the market schedule runs without browser requests');
    assert.deepEqual(checked.errors, []);
  } finally {
    market.close();
  }
});

test('market calendar keeps upcoming times and source values and alerts once per eligible stage', async t => {
  const scheduled = Date.parse('2026-11-10T12:30:00Z');
  let checked = scheduled - 30 * MINUTE;
  const release = {
    CalendarId: '123', Date: '2026-11-10T12:30:00', Event: 'US payroll data', Country: 'United States',
    DateSpan: '0', Currency: '$', Actual: '', Forecast: '150K', Previous: '130K', Revised: '125K',
    URL: '/united-states/non-farm-payrolls', SourceURL: 'https://www.bls.gov/news.release/empsit.nr0.htm',
  };
  const notices = [];
  const market = createMarketFeed({
    dataDir: await store(t), now: () => checked, env: { TRADING_ECONOMICS_API_KEY: 'mock-calendar-key' },
    onEvents: events => notices.push(...events),
    request: async url => {
      const address = new URL(url);
      if (address.hostname !== 'api.tradingeconomics.com') return new Response(emptyFeed);
      assert.equal(address.searchParams.get('importance'), '3');
      assert.equal(address.pathname, '/calendar/country/All/2026-11-08/2026-11-17');
      return Response.json([release, { ...release, CalendarId: '124', DateSpan: 1, Event: 'Estimated timing', Actual: '' }]);
    },
  });
  await market.configure({ enabled: true });
  let status = await market.refresh();
  assert.equal(status.upcoming[0].scheduledAt, '2026-11-10T12:30:00.000Z');
  assert.equal(status.upcoming[1].timeConfirmed, false);
  assert.equal(notices.length, 0);

  checked = scheduled - 10 * MINUTE;
  await market.refresh();
  await market.refresh();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].stage, 'scheduled');

  checked = scheduled + MINUTE;
  release.Actual = '175K';
  release.LastUpdate = '2026-11-10T12:30:50';
  status = await market.refresh();
  assert.equal(status.upcoming.length, 0);
  assert.equal(notices.length, 2);
  const [event] = (await market.events('XAU/USD')).events;
  assert.equal(event.actual, '175K');
  assert.equal(event.forecast, '150K');
  assert.equal(event.previous, '130K');
  assert.equal(event.revised, '125K');
  assert.equal(event.stage, 'released');
  assert.equal(event.direction, 'neutral');
});

test('market only fetches articles from allowed source pages and returns stripped text', async t => {
  const checked = Date.parse('2026-11-10T12:00:00Z');
  const articlePath = 'https://www.federalreserve.gov/newsevents/speech/powell20261110a.htm';
  const items = newsItem({ id: 'trusted', time: checked, link: `${articlePath}?utm_source=feed` })
    + newsItem({ id: 'untrusted', time: checked, link: 'https://untrusted.example/private' })
    + newsItem({ id: 'other-path', time: checked, link: 'https://www.federalreserve.gov/unrelated/somewhere.htm' });
  let articleFetches = 0;
  const market = createMarketFeed({
    dataDir: await store(t), now: () => checked, env: {},
    request: async (url, options) => {
      if (String(url) === articlePath) {
        articleFetches++;
        assert.equal(options.redirect, 'error');
        return new Response(`<html><body><main><nav>A nav</nav><article><script>danger()</script><p>${'Text from the official source. '.repeat(20)}</p></article></main></body></html>`,
          { headers: { 'content-type': 'text/html;charset=utf-8' } });
      }
      return new Response(String(url).endsWith('press_monetary.xml')
        ? `<rss version="2.0"><channel>${items}</channel></rss>`
        : emptyFeed);
    },
  });
  await market.refresh();
  const { events } = await market.events();
  for (const event of events.filter(item => !item.title.endsWith(' trusted'))) {
    await assert.rejects(market.article(event.id), { status: 404 });
  }
  const article = await market.article(events.find(item => item.title.endsWith(' trusted')).id);
  assert.match(article.text, /^Text from the official source/);
  assert.doesNotMatch(article.text, /danger|A nav/);
  assert.equal(article.url, articlePath);
  assert.equal(articleFetches, 1);
});
