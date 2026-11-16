import { createLocalServer } from '../server/local-agent/server.mjs';

export const HOST = '127.0.0.1';
export const PORT = 4782;
export const ORIGIN = `http://${HOST}:${PORT}`;

export function isDesktopDocument(value) {
  const url = URL.parse(value || '');
  return url?.origin === ORIGIN && !url.username && !url.password && (url.pathname === '/' || url.pathname === '/index.html');
}

export function externalWebLink(value) {
  const url = URL.parse(value || '');
  return url && ['https:', 'http:'].includes(url.protocol) && url.origin !== ORIGIN && !url.username && !url.password ? url.href : '';
}

export function allowDesktopPermission(permission, { url, isMainFrame, mediaTypes = [] }) {
  if (isMainFrame === false || !isDesktopDocument(url)) return false;
  if (permission === 'media') return mediaTypes.length > 0 && mediaTypes.every(type => type === 'audio');
  return permission === 'notifications' || permission === 'clipboard-sanitized-write';
}

export async function startDesktopServer({ root, dataDir, port = PORT }) {
  const server = createLocalServer({ root, dataDir });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
