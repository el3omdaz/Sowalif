import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron';
import { join } from 'node:path';
import { allowDesktopPermission, externalWebLink, isDesktopDocument, ORIGIN, startDesktopServer } from './runtime.mjs';

const title = 'سوالف';
const partition = 'persist:sowalif';
let win, tray, worker;
let quitting = false;

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const contentPolicy = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:", "media-src 'self' data: blob: https:", "font-src 'self' data: https:",
  "connect-src 'self' https: wss:", "worker-src 'self' blob:", "frame-src 'self' blob:", "frame-ancestors 'none'",
  "form-action 'self'", "object-src 'none'", "base-uri 'none'"].join('; ');

function configureSession() {
  const browserSession = session.fromPartition(partition);
  browserSession.setPermissionCheckHandler((contents, permission, origin, details = {}) =>
    (!contents || contents === win?.webContents) && allowDesktopPermission(permission, {
      url: details.requestingUrl || origin, isMainFrame: details.isMainFrame, mediaTypes: details.mediaType ? [details.mediaType] : [],
    }));
  browserSession.setPermissionRequestHandler((contents, permission, respond, details = {}) =>
    respond(contents === win?.webContents && allowDesktopPermission(permission, {
      url: details.requestingUrl, isMainFrame: details.isMainFrame, mediaTypes: details.mediaTypes,
    })));
  browserSession.webRequest.onHeadersReceived({ urls: [`${ORIGIN}/*`] }, (details, respond) => {
    const headers = details.responseHeaders;
    respond({ responseHeaders: isDesktopDocument(details.url) && details.resourceType === 'mainFrame'
      ? { ...headers, 'Content-Security-Policy': [contentPolicy] } : headers });
  });
}

function showInBrowser(value) {
  const url = externalWebLink(value);
  if (url) void shell.openExternal(url).catch(() => {});
}

function createWindow(root, icon) {
  win = new BrowserWindow({ title, icon, width: 1180, height: 830, minWidth: 360, minHeight: 600, show: false,
    webPreferences: { partition, preload: join(root, 'desktop', 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webviewTag: false, webSecurity: true },
  });
  win.once('ready-to-show', showWindow);
  win.on('close', event => {
    if (quitting || !tray) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('will-navigate', (event, url) => {
    const destination = typeof url === 'string' ? url : event.url;
    if (isDesktopDocument(destination)) return;
    event.preventDefault();
    showInBrowser(destination);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isDesktopDocument(typeof url === 'string' ? url : event.url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { showInBrowser(url); return { action: 'deny' }; });
  return win.loadURL(`${ORIGIN}/`);
}

function setupDirectoryPicker() {
  ipcMain.handle('sowalif:pick-directory', async event => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        !isDesktopDocument(event.senderFrame?.url)) return '';
    const result = await dialog.showOpenDialog(win, { title: 'اختيار مجلد في سوالف', properties: ['openDirectory'] });
    return result.canceled ? '' : result.filePaths[0] || '';
  });
}

app.setName('Sowalif');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => { quitting = true; tray?.destroy(); tray = null; });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', event => {
    if (!worker) return;
    event.preventDefault();
    const running = worker;
    worker = null;
    running.close(() => app.quit());
    running.closeAllConnections();
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.sowalif.desktop');
    const root = app.getAppPath();
    worker = await startDesktopServer({ root, dataDir: join(app.getPath('userData'), 'local-service') });
    const icon = nativeImage.createFromPath(join(root, 'icon-192.png'));
    Menu.setApplicationMenu(null);
    configureSession();
    setupDirectoryPicker();
    tray = new Tray(icon.resize({ width: 32, height: 32 }));
    tray.setToolTip(title);
    tray.on('click', showWindow);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'فتح سوالف', click: showWindow }, { label: 'خروج', click: () => app.quit() }]));
    await createWindow(root, icon);
  }).catch(error => {
    const message = error.code === 'EADDRINUSE' ? 'عنوان سوالف المحلي مستخدم. أغلق التطبيق الذي يستخدم المنفذ 4782 ثم افتح سوالف.'
      : 'تعذّر فتح سوالف. أعد فتح التطبيق أو فك الضغط عن مجلد النسخة كاملًا.';
    dialog.showErrorBox(title, message);
    app.quit();
  });
}
