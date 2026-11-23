import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { FILE_SEARCH_VERSION } from './search-capabilities.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const url = 'http://127.0.0.1:4781/';

export async function startLocalApp({ request = fetch, launch = spawn, base = root, platform = process.platform,
  log = console.log, error = console.error } = {}) {
  let state;
  try { const response = await request(url + 'api/agent/status', { signal: AbortSignal.timeout(1500) }); state = await response.json(); } catch {}
  const running = state?.local === true;
  if (running && (!Number.isInteger(state.fileSearchVersion) || state.fileSearchVersion < FILE_SEARCH_VERSION)) {
    error('خدمة سوالف المفتوحة بالخلفية تحتاج إعادة تشغيل لتفعيل تحديث بحث الملفات. أعد تشغيل خدمة سوالف ثم افتح Start-Sowalif.cmd. إذا تعذّر إيقاف الخدمة، أعد تشغيل الكمبيوتر.');
    return false;
  }
  if (!running) {
    await mkdir(join(base, '.local-agent'), { recursive: true });
    const out = await open(join(base, '.local-agent/server.log'), 'a');
    try {
      const child = launch(process.execPath, [join(base, 'server/local-agent/server.mjs')], { cwd: base, detached: true, windowsHide: true, stdio: ['ignore', out.fd, out.fd] });
      child.unref();
    } finally { await out.close(); }
  }
  log('Sowalif: ' + url);
  // The launcher is explicitly opened by the user to open their local app.
  if (platform === 'win32') launch('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' }).unref();
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await startLocalApp()) process.exitCode = 1;
}
