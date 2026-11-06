import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const route = '/api/media-push/';
const hour = 60 * 60 * 1000;
const pushHosts = /^(?:[\w-]+\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com)$/;
const chatIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;

async function readJSON(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validSubscription(subscription) {
  const { endpoint, keys } = subscription || {};
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  const url = URL.parse(endpoint);
  return url?.protocol === 'https:' && !url.port && !url.username && !url.password &&
    pushHosts.test(url.hostname) && /^[\w-]{87}$/.test(keys?.p256dh) && /^[\w-]{22}$/.test(keys?.auth);
}

export function createMediaPushService({ origin, key, database, sendPush }) {
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, secret TEXT NOT NULL,
    subscription TEXT NOT NULL, endpoint TEXT NOT NULL, chat TEXT NOT NULL,
    tag TEXT NOT NULL, expires INTEGER NOT NULL, outcome TEXT, next INTEGER NOT NULL DEFAULT 0
  )`);
  const cleanup = db.prepare('DELETE FROM tickets WHERE expires <= ?');
  const remove = db.prepare('DELETE FROM tickets WHERE id = ?');
  const lookup = db.prepare('SELECT * FROM tickets WHERE id = ? AND expires > ?');
  const limit = db.prepare('SELECT count(*) AS count FROM tickets WHERE endpoint = ?');
  const total = db.prepare('SELECT count(*) AS count FROM tickets');
  const insert = db.prepare('INSERT INTO tickets (id, provider, secret, subscription, endpoint, chat, tag, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const complete = db.prepare('UPDATE tickets SET outcome = ? WHERE id = ? AND outcome IS NULL');
  const ready = db.prepare('SELECT * FROM tickets WHERE outcome IS NOT NULL AND expires > ? AND next <= ? LIMIT 20');
  const defer = db.prepare('UPDATE tickets SET next = ? WHERE id = ?');
  let delivery;

  async function deliver() {
    cleanup.run(Date.now());
    for (const ticket of ready.all(Date.now(), Date.now())) {
      try {
        await sendPush(JSON.parse(ticket.subscription), JSON.stringify({
          chatId: ticket.chat, tag: ticket.tag, outcome: ticket.outcome,
        }));
        remove.run(ticket.id);
      } catch (error) {
        if ([400, 401, 403, 404, 410].includes(error.statusCode)) remove.run(ticket.id);
        else defer.run(Date.now() + 60_000, ticket.id);
      }
    }
  }

  function flush() {
    delivery ??= deliver().finally(() => { delivery = null; });
    return delivery;
  }

  async function handle(req, res) {
    const path = new URL(req.url, origin).pathname;
    const reply = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(data == null ? undefined : JSON.stringify(data));
    };
    if (req.method === 'GET' && path === route + 'key') return reply(200, { key });
    if (req.method !== 'POST') return reply(404);
    if (path === route + 'ticket') {
      if (req.headers.origin !== origin) return reply(403);
      const { provider, subscription, chatId, at } = await readJSON(req, 4096);
      if (!['kie', 'piapi'].includes(provider) || !validSubscription(subscription) ||
          typeof chatId !== 'string' || !chatIdPattern.test(chatId) || !Number.isSafeInteger(at)) return reply(400);
      cleanup.run(Date.now());
      if (limit.get(subscription.endpoint).count >= 40 || total.get().count >= 10000) return reply(429);
      const id = randomBytes(24).toString('hex');
      const secret = randomBytes(24).toString('hex');
      insert.run(id, provider, secret, JSON.stringify(subscription), subscription.endpoint, chatId, `${chatId}-${at}`, Date.now() + 24 * hour);
      return reply(201, { endpoint: origin + route + 'callback/' + id, secret });
    }
    const id = path.startsWith(route + 'callback/') && path.slice((route + 'callback/').length);
    if (!id || !/^[0-9a-f]{48}$/.test(id)) return reply(404);
    const ticket = lookup.get(id, Date.now());
    // A unique, unguessable callback URL is the Kie capability.
    if (!ticket) return reply(204);
    if (ticket.provider === 'piapi' && req.headers['x-webhook-secret'] !== ticket.secret) return reply(403);
    const { data } = await readJSON(req, 24 * 1024 * 1024);
    const status = ticket.provider === 'kie' ? data?.state : data?.status;
    if (['completed', 'success', 'succeeded'].includes(status)) complete.run('ready', id);
    if (['fail', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) complete.run('failed', id);
    reply(204);
    void flush().catch(() => {});
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(400).end();
    });
  });
  const timer = setInterval(() => { void flush().catch(() => {}); }, 15_000);
  server.on('close', () => {
    clearInterval(timer);
    if (delivery) void delivery.then(() => db.close(), () => db.close());
    else db.close();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: webPush } = await import('web-push');
  const { PUSH_ORIGIN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_DATABASE, PORT = 8787 } = process.env;
  if (!PUSH_ORIGIN || new URL(PUSH_ORIGIN).protocol !== 'https:' || new URL(PUSH_ORIGIN).origin !== PUSH_ORIGIN || !PUSH_DATABASE) {
    throw new Error('Set PUSH_ORIGIN to the public HTTPS origin and PUSH_DATABASE to a persistent SQLite path.');
  }
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  createMediaPushService({
    origin: PUSH_ORIGIN, key: VAPID_PUBLIC_KEY, database: PUSH_DATABASE,
    sendPush: (subscription, payload) => webPush.sendNotification(subscription, payload, { TTL: 3600, timeout: 4000 }),
  }).listen(Number(PORT), '127.0.0.1');
}
