import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const url = 'http://127.0.0.1:4781/';
let running = false;
try { const r = await fetch(url + 'api/agent/status', { signal: AbortSignal.timeout(1500) }); running = (await r.json()).local === true; } catch {}
if (!running) {
  await mkdir(join(root, '.local-agent'), { recursive: true });
  const out = await open(join(root, '.local-agent/server.log'), 'a');
  const child = spawn(process.execPath, [join(root, 'server/local-agent/server.mjs')], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out.fd, out.fd] });
  child.unref();
  await out.close();
}
console.log('Sowalif: ' + url);
// The launcher is explicitly opened by the user to open their local app.
if (process.platform === 'win32') spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' }).unref();
