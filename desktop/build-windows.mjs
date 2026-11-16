import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const desktop = dirname(fileURLToPath(import.meta.url));
const source = dirname(desktop);
const runtimeVersion = '45.3.3';
// https://github.com/electron/electron/releases/download/v45.3.3/SHASUMS256.txt
const checksums = {
  x64: '49dd2d3875944f08de03d34595cd30093c588b9edcabb41a0ac481028a3a5a8a',
  arm64: '86a22b905a56566a221dfc225750317e50be326b33d8bf29292bc883b78661e3',
};
const staticExtensions = new Set(['.css', '.html', '.ico', '.jpg', '.js', '.json', '.mjs', '.png', '.svg', '.wasm', '.webp', '.woff', '.woff2']);

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function electronArchive(arch) {
  const cache = join(desktop, '.cache');
  await mkdir(cache, { recursive: true });
  const asset = `electron-v${runtimeVersion}-win32-${arch}.zip`;
  const path = join(cache, asset);
  if (await digest(path).catch(() => '') === checksums[arch]) return path;

  console.log(`Downloading Electron ${runtimeVersion} for Windows ${arch}…`);
  const response = await fetch(`https://github.com/electron/electron/releases/download/v${runtimeVersion}/${asset}`, {
    signal: AbortSignal.timeout(8 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`Electron download failed (${response.status}).`);
  const temp = `${path}.${process.pid}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags: 'wx' }));
    if (await digest(temp) !== checksums[arch]) throw new Error('Electron download failed SHA-256 verification.');
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
  return path;
}

async function copyTree(from, to, selectFile) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const input = join(from, entry.name);
    const output = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(input, output, selectFile);
    if (entry.isFile() && selectFile(entry.name)) await copyFile(input, output);
  }
}

function archive(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar.exe', args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Windows tar exited with code ${code}.`)));
  });
}

async function stageApplication(destination) {
  await mkdir(destination, { recursive: true });
  for (const name of ['index.html', 'oauth-microsoft.html', 'style.css', 'sw.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png']) {
    await copyFile(join(source, name), join(destination, name));
  }
  for (const name of ['js', 'vendor']) {
    await copyTree(join(source, name), join(destination, name), (file) => staticExtensions.has(extname(file)));
  }
  const server = join(destination, 'server');
  await copyTree(join(source, 'server', 'local-agent'), join(server, 'local-agent'), (file) =>
    /\.(?:mjs|py)$/.test(file) || ['Dockerfile', 'documents-requirements.txt', 'package.json', 'package-lock.json'].includes(file));
  await copyFile(join(source, 'server', 'market-feed.mjs'), join(server, 'market-feed.mjs'));
  const desktopRuntime = join(destination, 'desktop');
  await mkdir(desktopRuntime);
  for (const entry of await readdir(desktop, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith('.') && /\.(?:mjs|cjs)$/.test(entry.name) &&
        entry.name !== 'build-windows.mjs' && !entry.name.includes('.test.')) {
      await copyFile(join(desktop, entry.name), join(desktopRuntime, entry.name));
    }
  }
  await writeFile(join(destination, 'package.json'), JSON.stringify({
    name: 'sowalif-desktop', productName: 'Sowalif', version: '1.0.0', type: 'module', main: 'desktop/main.mjs',
  }, null, 2) + '\n');
}

async function writeShortcutIcon(path) {
  const png = await readFile(join(source, 'icon-192.png'));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || width > 256 || !height || height > 256) throw new Error('Expected a Windows-compatible shortcut icon size.');
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // Icon resource
  header.writeUInt16LE(1, 4); // One PNG image
  header[6] = width % 256;
  header[7] = height % 256;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  await writeFile(path, Buffer.concat([header, png]));
}

const shortcutScript = [
  "$ErrorActionPreference = 'Stop';",
  '$folder = $env:SOWALIF_DESKTOP_FOLDER;',
  "$target = Join-Path $folder 'Sowalif.exe';",
  "if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Sowalif.exe is missing.' };",
  '$shell = New-Object -ComObject WScript.Shell;',
  "foreach ($place in @('Programs', 'DesktopDirectory')) {",
  '  $location = [Environment]::GetFolderPath($place);',
  '  if ($location) {',
  "    $link = $shell.CreateShortcut((Join-Path $location 'Sowalif.lnk'));",
  '    $link.TargetPath = $target;',
  '    $link.WorkingDirectory = $folder;',
  "    $link.IconLocation = (Join-Path $folder 'Sowalif.ico') + ',0';",
  '    $link.Save();',
  '  }',
  '}',
].join(' ');

const shortcuts = [
  '@echo off',
  'setlocal',
  'set "SOWALIF_DESKTOP_FOLDER=%~dp0"',
  `powershell.exe -NoProfile -Command "${shortcutScript}"`,
  'if errorlevel 1 (',
  '  echo Could not add the Sowalif shortcuts.',
  '  pause',
  '  exit /b 1',
  ')',
  'echo Sowalif was added to the desktop and Start menu.',
  'pause',
  '',
].join('\r\n');

async function build() {
  if (process.platform !== 'win32') throw new Error('Run the Windows package build on Windows.');
  const args = process.argv.slice(2);
  const arch = args.find((arg) => arg.startsWith('--arch='))?.slice(7) || process.arch;
  if (!Object.hasOwn(checksums, arch) || args.some((arg) => arg !== '--zip' && arg !== `--arch=${arch}`)) {
    throw new Error('Use node desktop/build-windows.mjs [--arch=x64|--arch=arm64] [--zip].');
  }
  await readFile(join(desktop, 'main.mjs'));
  const binary = await electronArchive(arch);
  const distribution = join(desktop, 'dist');
  await mkdir(distribution, { recursive: true });
  const distributionRoot = await realpath(distribution);
  const staging = await mkdtemp(join(distributionRoot, '.building-'));
  if (dirname(await realpath(staging)) !== distributionRoot) throw new Error('Build path must stay inside desktop/dist.');
  await archive(['-xf', binary, '-C', staging]);
  await stageApplication(join(staging, 'resources', 'app'));
  await rename(join(staging, 'electron.exe'), join(staging, 'Sowalif.exe'));
  await writeShortcutIcon(join(staging, 'Sowalif.ico'));
  await writeFile(join(staging, 'Add-Sowalif-Shortcuts.cmd'), shortcuts);
  const output = join(distributionRoot, `Sowalif-Windows-${arch}-${basename(staging).slice('.building-'.length)}`);
  await rename(staging, output);
  console.log(`Windows app: ${relative(source, join(output, 'Sowalif.exe'))}`);
  const portable = join(distributionRoot, `${basename(output)}.zip`);
  if (args.includes('--zip')) {
    const temporaryZip = join(distributionRoot, `${basename(staging)}.zip`);
    try {
      await archive(['-a', '-cf', temporaryZip, '-C', distributionRoot, basename(output)]);
      await rename(temporaryZip, portable);
    } finally {
      await unlink(temporaryZip).catch(() => {});
    }
    console.log(`Portable ZIP: ${relative(source, portable)}`);
  }
}

build().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
