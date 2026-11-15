import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMarketAnalysis } from './market-analysis.mjs';
import { createMarketFeed } from './market-feed.mjs';
import { validSubscription } from './push-subscription.mjs';

const basePath = '/api/market/';
const maxDevices = 16;
const maxBody = 12_288;

function fault(status, message) {
  return Object.assign(new Error(message), { status });
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function authMatches(value, expected) {
  const match = typeof value === 'string' && /^Bearer (\S+)$/i.exec(value);
  return Boolean(match && timingSafeEqual(digest(match[1]), expected));
}

async function readJSON(req) {
  if (!/^(?:application\/json)(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw fault(415, 'نوع بيانات الطلب غير مدعوم.');
  }
  const tooLarge = () => fault(413, 'حجم الطلب أكبر من المسموح.');
  if (Number(req.headers['content-length']) > maxBody) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) throw tooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fault(400, 'بيانات الطلب غير صالحة.');
  }
}

function cleanSubscription(subscription) {
  if (!validSubscription(subscription)) throw fault(400, 'اشتراك الإشعارات غير صالح.');
  const { endpoint, keys, expirationTime = null } = subscription;
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime <= Date.now())) {
    throw fault(400, 'انتهت صلاحية اشتراك الإشعارات.');
  }
  return { endpoint: new URL(endpoint).href, keys: { p256dh: keys.p256dh, auth: keys.auth }, expirationTime };
}

function createSubscriptionStore(dataDir) {
  const path = join(dataDir, 'market-subscriptions.json');
  let records;
  let queue = Promise.resolve();

  async function read() {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('Invalid push subscription store');
      return raw;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function write(next) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  return function update(change = (active) => active) {
    const operation = queue.then(async () => {
      records ??= await read();
      const active = records.filter((item) => validSubscription(item) &&
        (item.expirationTime == null || (Number.isSafeInteger(item.expirationTime) && item.expirationTime > Date.now())));
      const next = change(active);
      if (next.length !== records.length || next.some((item, index) => item !== records[index])) {
        await write(next);
        records = next;
      }
      return next;
    });
    queue = operation.catch(() => {});
    return operation;
  };
}

function safeDirection(direction) {
  return ['positive', 'negative'].includes(direction) ? direction : 'neutral';
}

function pushPayload(event, assets, direction, multiple) {
  return JSON.stringify({
    type: 'market', id: event.id, title: event.title.slice(0, 350), asset: assets.join(' · '), direction,
    tag: multiple ? `market-${event.id}-${direction}` : `market-${event.id}`,
  });
}

export function createMarketService({
  origin, token, dataDir, key, sendPush, marketFactory = createMarketFeed, analysisFactory = createMarketAnalysis,
} = {}) {
  const address = URL.parse(origin || '');
  if (address?.protocol !== 'https:' || address.origin !== origin) throw new Error('Set MARKET_ORIGIN to the app’s exact HTTPS origin.');
  if (typeof token !== 'string' || !/^[!-~]{32,512}$/.test(token)) throw new Error('Set MARKET_ACCESS_TOKEN to a strong secret with at least 32 characters.');
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('Set MARKET_DATA_DIR to a persistent directory.');
  const expected = digest(token);
  const pushKey = typeof sendPush === 'function' && typeof key === 'string' && key ? key : null;
  const analyze = analysisFactory();
  const withCapabilities = status => ({ ...status, pushKey, analysisEnabled: Boolean(analyze) });
  const subscriptions = createSubscriptionStore(dataDir);
  let delivery = Promise.resolve();

  async function eventGroups(event, assets) {
    if (!analyze || event.kind === 'price' || event.stage === 'scheduled') {
      return [[safeDirection(event.direction), assets]];
    }
    const [article, status] = await Promise.all([
      event.kind === 'news' ? market.article(event.id).catch(() => null) : null,
      market.status().catch(() => null),
    ]);
    const groups = new Map();
    const results = await Promise.allSettled(assets.map(async (asset) => (
      analyze(event, asset, article, status?.quotes?.find(quote => quote.asset === asset))
    )));
    for (const [index, asset] of assets.entries()) {
      const analysis = results[index].value;
      if (analysis) await market.saveAnalysis(event.id, asset, analysis).catch(() => {});
      const direction = safeDirection(analysis?.direction);
      const group = groups.get(direction) || [];
      group.push(asset);
      groups.set(direction, group);
    }
    return [...groups];
  }

  function onEvents(events) {
    if (!pushKey && !analyze) return;
    const task = delivery.then(async () => {
      for (const event of events) {
        if (!/^[a-f0-9]{32}$/.test(event?.id || '') || typeof event.title !== 'string' || !Array.isArray(event.assets)) continue;
        const assets = [...new Set(event.assets.filter((asset) => /^[A-Z]{3}\/[A-Z]{3}$/.test(asset)))];
        if (!assets.length) continue;
        const groups = await eventGroups(event, assets);
        if (!pushKey) continue;
        for (const [direction, group] of groups) {
          const payload = pushPayload(event, group, direction, groups.length > 1);
          const active = await subscriptions();
          const results = await Promise.allSettled(active.map(async item => sendPush(item, payload)));
          const stale = new Set(active.filter((_item, index) => [404, 410].includes(results[index].reason?.statusCode)));
          if (stale.size) await subscriptions(records => records.filter((item) => !stale.has(item)));
        }
      }
    });
    delivery = task.catch(() => {});
    return task;
  }

  const market = marketFactory({ dataDir, onEvents });
  async function handle(req, res) {
    const url = URL.parse(req.url, origin);
    const route = url?.origin === origin && url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : '';
    const reply = (status, data) => {
      req.resume();
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    try {
      if (!['status', 'events', 'article', 'config', 'refresh', 'subscription'].includes(route)) throw fault(404, 'مسار مراقبة السوق غير موجود.');
      const method = ['status', 'events', 'article'].includes(route) ? 'GET' : 'POST';
      res.setHeader('Vary', 'Origin');
      if (req.headers.origin === origin) res.setHeader('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS') {
        if (req.headers.origin !== origin || req.headers['access-control-request-method'] !== method) throw fault(403, 'مصدر الطلب غير مصرح به.');
        res.writeHead(204, { 'Access-Control-Allow-Methods': method, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
        res.end();
        return;
      }
      if (!authMatches(req.headers.authorization, expected)) throw fault(401, 'رمز الوصول لمراقبة السوق غير صالح.');
      if (req.method !== method) throw fault(405, 'طريقة الطلب غير مدعومة.');
      if ((method === 'POST' || req.headers.origin) && req.headers.origin !== origin) throw fault(403, 'مصدر الطلب غير مصرح به.');

      if (route === 'status') return reply(200, withCapabilities(await market.status()));
      if (route === 'events') return reply(200, await market.events(url.searchParams.get('asset')));
      if (route === 'article') return reply(200, await market.article(url.searchParams.get('id')));
      if (route === 'refresh') return reply(200, withCapabilities(await market.refresh()));
      const input = await readJSON(req);
      if (route === 'config') return reply(200, withCapabilities(await market.configure(input)));
      if (!pushKey) throw fault(503, 'إشعارات السوق من الخادم غير مفعّلة.');
      if (typeof input?.enabled !== 'boolean') throw fault(400, 'حالة اشتراك الإشعارات غير صالحة.');
      const item = cleanSubscription(input.subscription);
      await subscriptions((active) => {
        const others = active.filter(({ endpoint }) => endpoint !== item.endpoint);
        if (!input.enabled) return others;
        if (others.length >= maxDevices) throw fault(409, 'بلغت الحد الأقصى لأجهزة التنبيهات المتصلة.');
        return [...others, item];
      });
      return reply(200, { registered: input.enabled });
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      return reply(status, { error: status === 500 ? 'تعذر إكمال طلب مراقبة السوق.' : error.message });
    }
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });
  server.on('listening', () => market.start());
  server.on('close', () => market.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    MARKET_ORIGIN, MARKET_ACCESS_TOKEN, MARKET_DATA_DIR, MARKET_PORT = 8788,
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
  } = process.env;
  const port = Number(MARKET_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set MARKET_PORT to a valid TCP port.');
  let sendPush;
  if (VAPID_PUBLIC_KEY || VAPID_PRIVATE_KEY || VAPID_SUBJECT) {
    const { default: webPush } = await import('web-push');
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    sendPush = (subscription, payload) => webPush.sendNotification(subscription, payload, { TTL: 1800, timeout: 5000 });
  }
  createMarketService({
    origin: MARKET_ORIGIN, token: MARKET_ACCESS_TOKEN, dataDir: MARKET_DATA_DIR,
    key: VAPID_PUBLIC_KEY, sendPush,
  }).listen(port, '127.0.0.1');
}
