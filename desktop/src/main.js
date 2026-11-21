import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Coach } from './coach.js';
import { KEY_NAME, readEnvFile, writeKey } from './settings.js';

const here = dirname(fileURLToPath(import.meta.url));

// Packaged: coach/, engine/ and ui/dist sit unpacked under Resources/tack.
// Dev: run straight from the repository.
const root = app.isPackaged ? join(process.resourcesPath, 'tack') : resolve(here, '..', '..');
const runtimeDir = app.isPackaged ? join(root, 'runtime') : resolve(here, '..', 'runtime');

const userData = app.getPath('userData');
const stateDir = join(userData, 'state');
const envFile = join(userData, '.env');
const logsDir = join(userData, 'logs');
mkdirSync(logsDir, { recursive: true });

function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try {
    appendFileSync(join(logsDir, 'main.log'), `${stamped}\n`);
  } catch {
    // logging must never take the app down
  }
}

const coach = new Coach({
  entry: join(root, 'coach', 'bin', 'serve.ts'),
  watchdog: join(runtimeDir, 'watchdog.mjs'),
  cwd: userData,
  logFile: join(logsDir, 'coach.log'),
  echo: !app.isPackaged,
  log,
  // Read on every start so a key saved from the menu reaches the restarted coach.
  env: () => ({
    ...process.env,
    ...readEnvFile(envFile),
    TACK_STATE_DIR: stateDir,
    TACK_UI_DIR: join(root, 'ui', 'dist'),
  }),
});

let win = null;
let keyWin = null;
let quitting = false;
const crashes = [];

function isInternal(url) {
  try {
    return new URL(url).origin === new URL(coach.url).origin;
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') void shell.openExternal(url);
  } catch {
    // not a URL
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Tack',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0B0B0C',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });

  const { webContents } = win;
  webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (isInternal(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  webContents.on('did-finish-load', () => log(`window loaded ${webContents.getURL()}`));
  webContents.on('did-fail-load', (_e, code, desc, url, mainFrame) => {
    if (mainFrame) log(`window failed to load ${url}: ${code} ${desc}`);
  });
  webContents.on('render-process-gone', (_e, details) => log(`renderer gone: ${details.reason}`));

  void win.loadURL(coach.url);
}

function showWindow() {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

async function restartCoach() {
  await coach.restart();
  if (win) await win.loadURL(coach.url);
}

coach.onExit = async () => {
  if (quitting) return;
  const now = Date.now();
  crashes.push(now);
  while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
  if (crashes.length <= 2) {
    log('coach stopped unexpectedly, restarting');
    try {
      await restartCoach();
      return;
    } catch (err) {
      log(`restart failed: ${err.message}`);
    }
  }
  dialog.showErrorBox('Tack stopped working', `The coach server keeps stopping.\n\nLogs: ${logsDir}`);
  app.quit();
};

// ---------------------------------------------------------------- model key

async function keyStatus() {
  const fileKey = readEnvFile(envFile)[KEY_NAME] || '';
  let model = { configured: false, name: '' };
  try {
    const res = await fetch(`${coach.url}/api/state`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) model = (await res.json()).model ?? model;
  } catch {
    // coach is restarting; report what we know from the file
  }
  return {
    configured: Boolean(model.configured),
    model: model.name || '',
    saved: fileKey ? `ends in ${fileKey.slice(-4)}` : '',
    file: envFile,
  };
}

function openKeyDialog() {
  if (keyWin) {
    keyWin.focus();
    return;
  }
  if (!win) showWindow();
  // A child window, not a sheet: macOS refuses quit (and logout) while a sheet is attached.
  keyWin = new BrowserWindow({
    parent: win ?? undefined,
    width: 480,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Set model key',
    backgroundColor: '#0B0B0C',
    show: false,
    webPreferences: {
      preload: join(here, 'key-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  keyWin.once('ready-to-show', () => keyWin?.show());
  keyWin.on('closed', () => { keyWin = null; });
  keyWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  keyWin.webContents.on('will-navigate', (event) => event.preventDefault());
  void keyWin.loadFile(join(here, 'key.html'));
}

function fromKeyWindow(event) {
  return keyWin !== null && event.sender === keyWin.webContents;
}

ipcMain.handle('key:status', (event) => (fromKeyWindow(event) ? keyStatus() : null));

ipcMain.handle('key:save', async (event, value) => {
  if (!fromKeyWindow(event)) return { ok: false, error: 'not allowed' };
  const key = typeof value === 'string' ? value.trim() : '';
  if (/[\s"'#=]/.test(key)) return { ok: false, error: 'That does not look like an API key.' };
  try {
    writeKey(envFile, key);
    log(key ? 'model key saved, restarting coach' : 'model key cleared, restarting coach');
    await restartCoach();
    return { ok: true, status: await keyStatus() };
  } catch (err) {
    log(`saving key failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.on('key:close', (event) => {
  if (fromKeyWindow(event)) keyWin?.close();
});

// ---------------------------------------------------------------- menu

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Set model key…', click: openKeyDialog },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Show Logs', click: () => void shell.openPath(logsDir) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- lifecycle

async function boot() {
  await app.whenReady();
  buildMenu();
  if (!app.isPackaged) {
    const icon = resolve(here, '..', 'build', 'icon.png');
    if (existsSync(icon)) app.dock?.setIcon(icon);
  }
  app.setAboutPanelOptions({ applicationName: 'Tack', applicationVersion: app.getVersion() });
  log(`starting Tack ${app.getVersion()} (electron ${process.versions.electron}, node ${process.versions.node}, packaged ${app.isPackaged})`);
  log(`resources ${root}; state ${stateDir}`);
  try {
    await coach.start();
  } catch (err) {
    log(`coach failed to start: ${err.message}`);
    dialog.showErrorBox('Tack could not start', `${err.message}\n\nLogs: ${logsDir}`);
    app.exit(1);
    return;
  }
  createWindow();
  app.on('activate', showWindow);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  // Keep running with no windows, as macOS apps do; quitting stops the coach.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', (event) => {
    if (!coach.child) return;
    event.preventDefault();
    void coach.stop().finally(() => {
      log('coach stopped, quitting');
      app.quit();
    });
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.quit());
  void boot();
}
