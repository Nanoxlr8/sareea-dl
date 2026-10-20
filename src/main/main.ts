/**
 * Electron main process: window, tray, IPC, local bridge, notifications, clipboard watch.
 * All download logic lives in controller.ts; this file wires it to the OS and enforces the
 * security rules (see README "Security model").
 *
 * Build flavours: __SAREEA_TEST_HOOKS__ is an esbuild define. It is false in the release build, so everything
 * guarded by it (the self-test, the test data folder, the test pipe names) is removed from the bundle before
 * it ships. scripts/check-release.mjs fails the release package if any hook string is left.
 */
import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, protocol, session, shell, Tray,
} from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The esbuild "binary" loader turns the PNG into a Uint8Array at build time.
import iconPng from '../../assets/icon.png';
import { AppController } from './controller.ts';
import type { Platform } from './controller.ts';
import { BridgeServer, pipeNameFor } from './bridge.ts';
import { installIntegration, integrationState, removeIntegration, systemRegRunner } from './browser-integration.ts';
import { Logger } from './logger.ts';
import { runSelfTest } from './selftest.ts';
import { runShowcase } from './showcase.ts';
import { APP_INDEX_URL, APP_SCHEME, resolveAppRequest } from '../app/app-scheme.ts';
import type { AddPrefill, DetailView, IntegrationView, ItemsBatch, Result, ToastMessage, ViewItem } from '../app/api.ts';
import { EXTENSION_ID, HOST_EXE_NAME } from '../app/browser-integration.ts';
import { looksLikeDownloadLink } from '../app/categories.ts';
import { formatRate } from '../app/fmt.ts';
import {
  isTrustedSender, validateAddRequest, validateIds, validateId, validateProbeRequest, validateRemoveRequest, validateWatchId,
} from '../app/ipc.ts';
import type { Checked } from '../app/ipc.ts';
import { validateSettingsPatch } from '../app/settings.ts';
import type { Settings } from '../app/settings.ts';
import { translate } from '../app/strings.ts';
import type { StringKey } from '../app/strings.ts';
import { resolveUserDataDir } from '../app/portable.ts';
import { readTestMode } from '../app/test-hooks.ts';
import type { TestMode } from '../app/test-hooks.ts';

const argv = process.argv.slice(1);
const START_HIDDEN = argv.includes('--hidden');

// Test flavour only (src/app/test-hooks.ts). In the release build this is the constant null and the helper is gone.
const TEST_MODE: TestMode | null = __SAREEA_TEST_HOOKS__ ? readTestMode(argv, process.env, process.pid) : null;
const SELF_TEST = __SAREEA_TEST_HOOKS__ && TEST_MODE !== null && TEST_MODE.selfTest;
const SHOWCASE = __SAREEA_TEST_HOOKS__ && TEST_MODE !== null && TEST_MODE.showcaseDir !== null;
// the README pictures are taken at 1.5x, whatever the screen's own scale is
if (__SAREEA_TEST_HOOKS__ && SHOWCASE) {
  app.commandLine.appendSwitch('force-device-scale-factor', '1.5');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}

// A packaged app must not be started with debugging switches (the exe fuses already switch off the Node ones).
if (app.isPackaged && argv.some((a) => /^--(remote-debugging|inspect|debug)/i.test(a))) process.exit(1);

// The window's page is served from app://sareea/ (handler below). The scheme has to be registered before the app
// is ready. standard + secure gives the page a real origin and nothing more: no fetch API, no CORS, no service
// workers, no CSP bypass.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);

app.setName('Sareea DL');
app.setAppUserModelId('com.sareea.dl');
// The userData folder: the real one, or (test flavour only) a test folder / the self-test's throw-away profile, so a
// test never touches the real settings, queue or downloads.
app.setPath(
  'userData',
  TEST_MODE?.userData ?? resolveUserDataDir({ exeDir: path.dirname(process.execPath), appDataDir: app.getPath('appData'), fileExists: (p) => fs.existsSync(p) }),
);
if (!SELF_TEST && !SHOWCASE && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: AppController;
let log: Logger;
let bridge: BridgeServer | null = null;
let quitting = false;
let rendererReady = false;
let pendingPrefills: AddPrefill[] = [];
let pendingToasts: ToastMessage[] = [];
let pickDialogOpen = false;
const consoleErrors: string[] = [];
const liveNotifications = new Set<Notification>();

/** The only folder that app:// requests are mapped to (inside app.asar when packaged). */
const RENDERER_DIR = path.join(__dirname, 'renderer');
const ICON = nativeImage.createFromBuffer(Buffer.from(iconPng));

const tt = (key: StringKey, vars?: Record<string, string | number>): string => translate(controller.settings.language, key, vars);

function isHttpUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ OS integration

const platform: Platform = {
  openPath: (p) => shell.openPath(p),
  showItemInFolder: (p) => shell.showItemInFolder(p),
  writeClipboard: (text) => {
    lastClip = text; // do not offer our own "copy link" back to the user
    clipboard.writeText(text).catch((e) => log.error('clipboard write failed', e));
  },
  confirmRisky: async (fileName) => {
    const opts = {
      type: 'warning' as const,
      buttons: [tt('dialog.riskyOpen'), tt('dialog.riskyCancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: tt('app.name'),
      message: tt('dialog.riskyTitle'),
      detail: tt('dialog.riskyText', { name: fileName }),
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 0;
  },
};

function showWindow(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Main to renderer events. Every event has its own literal channel name; the preload script listens on the same one.
function liveContents(): WebContents | null {
  return win && !win.isDestroyed() && rendererReady ? win.webContents : null;
}
const emitItems = (batch: ItemsBatch): void => void liveContents()?.send('sareea:ev:items', batch);
const emitSettings = (s: Settings): void => void liveContents()?.send('sareea:ev:settings', s);
const emitDetail = (d: DetailView): void => void liveContents()?.send('sareea:ev:detail', d);
const emitShowAdd = (p: AddPrefill): void => void liveContents()?.send('sareea:ev:showAdd', p);
const emitToast = (m: ToastMessage): void => void liveContents()?.send('sareea:ev:toast', m);

function toast(kind: ToastMessage['kind'], key: string | null, text: string): void {
  const m: ToastMessage = { kind, key, text };
  if (rendererReady) emitToast(m);
  else pendingToasts.push(m);
}

// -------------------------------------------------------------------- window

function createWindow(): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors;
  const w = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'Sareea DL',
    icon: ICON,
    backgroundColor: dark ? '#12151a' : '#f3f5f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  w.removeMenu();
  if (__SAREEA_TEST_HOOKS__ && SELF_TEST) {
    w.webContents.on('console-message', (event) => {
      const d = event as unknown as { level?: string | number; message?: string };
      if (d.level === 'error' || d.level === 3) consoleErrors.push(String(d.message ?? '').slice(0, 200));
    });
    w.webContents.on('preload-error', (_e, p, err) => consoleErrors.push(`preload error ${p}: ${err.message}`));
  }
  // Visible in the log of every flavour, so a packaged build can be checked without a debugger.
  w.webContents.on('did-finish-load', () => log.info(`page loaded from ${w.webContents.getURL()}`));
  w.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) log.error(`page failed to load (${code} ${description}): ${url}`);
  });
  w.webContents.on('render-process-gone', (_e, details) => log.error(`renderer process gone: ${details.reason}`));
  w.on('close', (e) => {
    if (!quitting && controller.settings.closeToTray && tray) {
      e.preventDefault();
      w.hide();
    }
  });
  w.on('closed', () => {
    win = null;
  });
  void w.loadURL(APP_INDEX_URL).catch(() => undefined); // a failure is logged by did-fail-load
  return w;
}

function createTray(): void {
  tray = new Tray(ICON.resize({ width: 16, height: 16 }));
  tray.setToolTip(tt('tray.tooltip'));
  tray.on('click', showWindow);
  log.info('tray icon ready');
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: tt('tray.show'), click: showWindow },
      { type: 'separator' },
      { label: tt('tray.pauseAll'), click: () => void controller.stopQueue() },
      { label: tt('tray.resumeAll'), click: () => controller.startQueue() },
      { type: 'separator' },
      { label: tt('tray.quit'), click: () => app.quit() },
    ]),
  );
}

// ------------------------------------------------------------------ security

/** Answers app://sareea/... from the renderer folder, and from nowhere else. */
function registerAppScheme(): void {
  const plain = (status: number): Response => new Response(null, { status, headers: { 'cache-control': 'no-store' } });
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET') return plain(405);
    const r = resolveAppRequest(request.url, RENDERER_DIR);
    if (!r) {
      log.warn('refused an app:// request outside the renderer folder');
      return plain(404);
    }
    try {
      const data = await fs.promises.readFile(r.file);
      return new Response(data, { headers: { 'content-type': r.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
    } catch {
      return plain(404);
    }
  });
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // The UI itself never needs the network or the local disk: it is served from app://, and any request to http(s),
  // ws(s), ftp or file is cancelled and logged.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*', 'file://*/*'] }, (details, cb) => {
    let where = 'unknown';
    try {
      const u = new URL(details.url);
      where = u.protocol === 'file:' ? 'a local file' : u.origin;
    } catch {
      /* keep "unknown" */
    }
    log.warn(`blocked renderer request to ${where}`);
    cb({ cancel: true });
  });
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

function trusted(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!win || win.isDestroyed()) return false;
  if (event.sender !== win.webContents) return false;
  if (!frame || frame !== event.sender.mainFrame) return false;
  return isTrustedSender(frame.url, APP_INDEX_URL);
}

/** The sender check. The first statement of every IPC handler: returns the refusal to send back, or null when the call comes from our own page. */
function rejectUntrusted(event: IpcMainInvokeEvent, channel: string): Result | null {
  if (trusted(event)) return null;
  log.warn(`rejected IPC ${channel} from an untrusted sender`);
  return { ok: false, error: 'untrusted sender' };
}

function rejectInvalid(channel: string, error: string): Result {
  log.warn(`rejected IPC ${channel}: ${error}`);
  return { ok: false, error };
}

/** Runs the action of a handler whose sender and arguments were already checked; a thrown error becomes a plain refusal. */
async function perform(channel: string, action: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    return await action();
  } catch (e) {
    log.error(`IPC ${channel} failed`, e);
    return { ok: false, error: 'internal error' };
  }
}

const noArgs = (raw: unknown): Checked<undefined> => (raw === undefined ? { ok: true, value: undefined } : { ok: false, error: 'unexpected argument' });

/**
 * Every handler has a literal channel name, calls rejectUntrusted first and then its own validator.
 * test/ipc-channels.test.ts checks this shape and that each channel is used by exactly one preload method.
 */
function registerIpc(): void {
  ipcMain.handle('sareea:getState', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:getState');
    if (denied) return denied;
    const v = noArgs(raw);
    if (!v.ok) return rejectInvalid('sareea:getState', v.error);
    return perform('sareea:getState', () => controller.getInitialState(app.getVersion(), app.isPackaged));
  });
  ipcMain.handle('sareea:ready', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:ready');
    if (denied) return denied;
    const v = noArgs(raw);
    if (!v.ok) return rejectInvalid('sareea:ready', v.error);
    return perform('sareea:ready', () => {
      rendererReady = true;
      log.info('UI ready');
      for (const p of pendingPrefills) emitShowAdd(p);
      for (const m of pendingToasts) emitToast(m);
      pendingPrefills = [];
      pendingToasts = [];
      return { ok: true };
    });
  });
  ipcMain.handle('sareea:probe', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:probe');
    if (denied) return denied;
    const v = validateProbeRequest(raw);
    if (!v.ok) return rejectInvalid('sareea:probe', v.error);
    return perform('sareea:probe', () => controller.probeUrl(v.value));
  });
  ipcMain.handle('sareea:add', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:add');
    if (denied) return denied;
    const v = validateAddRequest(raw);
    if (!v.ok) return rejectInvalid('sareea:add', v.error);
    return perform('sareea:add', () => controller.addDownload(v.value));
  });
  ipcMain.handle('sareea:pause', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:pause');
    if (denied) return denied;
    const v = validateIds(raw);
    if (!v.ok) return rejectInvalid('sareea:pause', v.error);
    return perform('sareea:pause', () => controller.pause(v.value));
  });
  ipcMain.handle('sareea:resume', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:resume');
    if (denied) return denied;
    const v = validateIds(raw);
    if (!v.ok) return rejectInvalid('sareea:resume', v.error);
    return perform('sareea:resume', () => controller.resume(v.value));
  });
  ipcMain.handle('sareea:remove', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:remove');
    if (denied) return denied;
    const v = validateRemoveRequest(raw);
    if (!v.ok) return rejectInvalid('sareea:remove', v.error);
    return perform('sareea:remove', () => controller.remove(v.value));
  });
  ipcMain.handle('sareea:redownload', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:redownload');
    if (denied) return denied;
    const v = validateIds(raw);
    if (!v.ok) return rejectInvalid('sareea:redownload', v.error);
    return perform('sareea:redownload', () => controller.redownload(v.value));
  });
  ipcMain.handle('sareea:openFile', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:openFile');
    if (denied) return denied;
    const v = validateId(raw);
    if (!v.ok) return rejectInvalid('sareea:openFile', v.error);
    return perform('sareea:openFile', () => controller.openFile(v.value));
  });
  ipcMain.handle('sareea:openFolder', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:openFolder');
    if (denied) return denied;
    const v = validateId(raw);
    if (!v.ok) return rejectInvalid('sareea:openFolder', v.error);
    return perform('sareea:openFolder', () => controller.openFolder(v.value));
  });
  ipcMain.handle('sareea:copyLink', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:copyLink');
    if (denied) return denied;
    const v = validateId(raw);
    if (!v.ok) return rejectInvalid('sareea:copyLink', v.error);
    return perform('sareea:copyLink', () => controller.copyLink(v.value));
  });
  ipcMain.handle('sareea:startQueue', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:startQueue');
    if (denied) return denied;
    const v = noArgs(raw);
    if (!v.ok) return rejectInvalid('sareea:startQueue', v.error);
    return perform('sareea:startQueue', () => controller.startQueue());
  });
  ipcMain.handle('sareea:stopQueue', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:stopQueue');
    if (denied) return denied;
    const v = noArgs(raw);
    if (!v.ok) return rejectInvalid('sareea:stopQueue', v.error);
    return perform('sareea:stopQueue', () => controller.stopQueue());
  });
  ipcMain.handle('sareea:setSettings', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:setSettings');
    if (denied) return denied;
    const v = validateSettingsPatch(raw);
    if (!v.ok) return rejectInvalid('sareea:setSettings', v.error);
    return perform('sareea:setSettings', () => controller.setSettings(v.value));
  });
  ipcMain.handle('sareea:pickFolder', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:pickFolder');
    if (denied) return denied;
    const v = noArgs(raw);
    if (!v.ok) return rejectInvalid('sareea:pickFolder', v.error);
    return perform('sareea:pickFolder', async (): Promise<Result<{ dir: string | null }>> => {
      if (pickDialogOpen || !win) return { ok: true, dir: null };
      pickDialogOpen = true;
      try {
        const r = await dialog.showOpenDialog(win, {
          title: tt('dialog.pickFolder'),
          defaultPath: controller.settings.defaultDir,
          properties: ['openDirectory', 'createDirectory'],
        });
        const dir = r.canceled ? null : (r.filePaths[0] ?? null);
        if (dir) controller.registerPickedDir(dir);
        return { ok: true, dir };
      } finally {
        pickDialogOpen = false;
      }
    });
  });
  ipcMain.handle('sareea:readClipboardUrl', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:readClipboardUrl');
    if (denied) return denied;
    const v = noArgs(raw);
    if (!v.ok) return rejectInvalid('sareea:readClipboardUrl', v.error);
    return perform('sareea:readClipboardUrl', async (): Promise<Result<{ url: string | null }>> => {
      const text = (await clipboard.readText().catch(() => '')).trim().slice(0, 8192);
      return { ok: true, url: text && !/\s/.test(text) && isHttpUrl(text) ? text : null };
    });
  });
  ipcMain.handle('sareea:watch', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:watch');
    if (denied) return denied;
    const v = validateWatchId(raw);
    if (!v.ok) return rejectInvalid('sareea:watch', v.error);
    return perform('sareea:watch', () => controller.watch(v.value));
  });
  ipcMain.handle('sareea:getIntegration', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:getIntegration');
    if (denied) return denied;
    const v = noArgs(raw);
    if (!v.ok) return rejectInvalid('sareea:getIntegration', v.error);
    return perform('sareea:getIntegration', async () => ({ ok: true, integration: await integrationView() }));
  });
  ipcMain.handle('sareea:installIntegration', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:installIntegration');
    if (denied) return denied;
    const v = noArgs(raw);
    if (!v.ok) return rejectInvalid('sareea:installIntegration', v.error);
    return perform('sareea:installIntegration', async (): Promise<Result<{ integration: IntegrationView }>> => {
      if (!app.isPackaged) return { ok: false, error: 'only the packaged app can install the browser integration' };
      const hostExe = path.join(path.dirname(process.execPath), HOST_EXE_NAME);
      if (!fs.existsSync(hostExe)) return { ok: false, error: 'the browser host program is missing next to the app' };
      const r = await installIntegration({ exePath: hostExe, dataDir: app.getPath('userData'), run: systemRegRunner() });
      if (!r.ok) return r;
      log.info('browser integration installed');
      return { ok: true, integration: await integrationView() };
    });
  });
  ipcMain.handle('sareea:removeIntegration', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:removeIntegration');
    if (denied) return denied;
    const v = noArgs(raw);
    if (!v.ok) return rejectInvalid('sareea:removeIntegration', v.error);
    return perform('sareea:removeIntegration', async (): Promise<Result<{ integration: IntegrationView }>> => {
      const r = await removeIntegration({ dataDir: app.getPath('userData'), run: systemRegRunner() });
      if (!r.ok) return r;
      log.info('browser integration removed');
      return { ok: true, integration: await integrationView() };
    });
  });
  ipcMain.handle('sareea:openExtensionFolder', async (event, raw: unknown) => {
    const denied = rejectUntrusted(event, 'sareea:openExtensionFolder');
    if (denied) return denied;
    const v = noArgs(raw);
    if (!v.ok) return rejectInvalid('sareea:openExtensionFolder', v.error);
    return perform('sareea:openExtensionFolder', async (): Promise<Result> => {
      const dir = extensionDir();
      if (!dir) return { ok: false, error: 'the extension folder is only bundled with the packaged app' };
      const err = await shell.openPath(dir);
      return err ? { ok: false, error: 'could not open the folder' } : { ok: true };
    });
  });
}

function extensionDir(): string | null {
  return app.isPackaged ? path.join(process.resourcesPath, 'extension') : null;
}

async function integrationView(): Promise<IntegrationView> {
  const st = await integrationState({ dataDir: app.getPath('userData'), run: systemRegRunner() });
  return { supported: app.isPackaged, chrome: st.chrome, edge: st.edge, extensionId: EXTENSION_ID, extensionDir: extensionDir() };
}

// ------------------------------------------------------- settings side effects

let appliedSettings: Settings | null = null;

function applySettingsEffects(s: Settings): void {
  nativeTheme.themeSource = s.theme;
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#12151a' : '#f3f5f8');
  if (!appliedSettings || appliedSettings.startWithWindows !== s.startWithWindows) {
    if (app.isPackaged && !SELF_TEST) {
      app.setLoginItemSettings({ openAtLogin: s.startWithWindows, args: ['--hidden'] });
    } else if (s.startWithWindows) {
      log.info('start with Windows is only applied by the packaged app');
    }
  }
  if (!appliedSettings || appliedSettings.clipboardWatch !== s.clipboardWatch) setClipboardWatch(s.clipboardWatch);
  if (!appliedSettings || appliedSettings.language !== s.language) {
    rebuildTrayMenu();
    tray?.setToolTip(tt('tray.tooltip'));
  }
  appliedSettings = { ...s };
}

// ----------------------------------------------------------- clipboard watch

let lastClip = '';
let clipTimer: NodeJS.Timeout | null = null;

function setClipboardWatch(on: boolean): void {
  if (clipTimer) {
    clearInterval(clipTimer);
    clipTimer = null;
  }
  if (!on) return;
  void clipboard.readText().then((t) => {
    lastClip = t.trim().slice(0, 8192); // what is already there is not offered
  }, () => undefined);
  let reading = false;
  clipTimer = setInterval(() => {
    if (reading) return;
    reading = true;
    void clipboard
      .readText()
      .then((raw) => {
        const text = raw.trim().slice(0, 8192);
        if (!text || text === lastClip) return;
        lastClip = text;
        if (!looksLikeDownloadLink(text)) return;
        if (controller.queue.list().some((i) => i.url === text)) return;
        offerClipboardLink(text);
      })
      .catch(() => undefined)
      .finally(() => {
        reading = false;
      });
  }, 1000);
}

function offerClipboardLink(url: string): void {
  if (!Notification.isSupported()) return;
  let name = 'file';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'file');
  } catch {
    /* keep the generic name */
  }
  const n = new Notification({ title: tt('notify.clipTitle'), body: tt('notify.clipBody', { name }) });
  liveNotifications.add(n);
  n.on('click', () => {
    showWindow();
    deliverPrefill({ url, fileName: null, bridgeToken: null, hasCookie: false, source: 'clipboard' });
  });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

function deliverPrefill(p: AddPrefill): void {
  if (rendererReady) emitShowAdd(p);
  else pendingPrefills.push(p);
}

// ------------------------------------------------------- batches -> window/tray

let lastTrayUpdate = 0;

function onBatch(batch: ItemsBatch): void {
  emitItems(batch);
  const now = Date.now();
  if (now - lastTrayUpdate < 1000) return;
  lastTrayUpdate = now;
  const live = controller.queue.list().filter((i) => i.status === 'downloading');
  const speed = live.reduce((s, i) => s + i.speed, 0);
  tray?.setToolTip(live.length > 0 ? `${tt('tray.tooltip')} - ${live.length} / ${formatRate(speed, controller.settings.language)}` : tt('tray.tooltip'));
  // taskbar progress over all running downloads that know their size
  let done = 0;
  let total = 0;
  for (const i of live) {
    if (i.size) {
      done += i.downloaded;
      total += i.size;
    }
  }
  if (win && !win.isDestroyed()) win.setProgressBar(total > 0 ? Math.min(1, done / total) : -1);
}

function onCompleted(v: ViewItem): void {
  if (!controller.settings.notifyOnComplete || !Notification.isSupported() || SELF_TEST || SHOWCASE) return;
  const n = new Notification({ title: tt('notify.done'), body: v.name });
  liveNotifications.add(n);
  n.on('click', () => void controller.openFolder(v.id));
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

// -------------------------------------------------------------------- startup

process.on('uncaughtException', (e) => {
  try {
    log?.error('uncaught exception', e);
  } catch {
    /* nothing more we can do */
  }
});
process.on('unhandledRejection', (e) => {
  try {
    log?.error('unhandled rejection', e);
  } catch {
    /* nothing more we can do */
  }
});

app.on('second-instance', () => showWindow());
app.on('window-all-closed', () => {
  if (quitting || !controller?.settings.closeToTray) app.quit();
});

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  const timeout = new Promise<void>((r) => setTimeout(r, 8000));
  void Promise.race([controller.shutdown(), timeout])
    .then(() => bridge?.stop())
    .then(() => log.flush())
    .finally(() => app.exit(0));
});

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const dataDir = app.getPath('userData');
  log = new Logger(path.join(dataDir, 'logs'), SELF_TEST || !app.isPackaged);
  log.info(`Sareea DL ${app.getVersion()} starting (${app.isPackaged ? 'packaged' : 'development'}, Electron ${process.versions.electron})`);

  const selfDir = SELF_TEST ? path.join(dataDir, 'downloads') : null;
  const showDir = SHOWCASE ? path.join(dataDir, 'Downloads') : null;
  controller = new AppController({
    dataDir,
    userProfile: process.env.USERPROFILE ?? os.homedir(),
    platform,
    log,
    settingsOverride: selfDir ? { defaultDir: selfDir, categorySubfolders: true, language: 'en', theme: 'light' } : showDir ? { defaultDir: showDir, categorySubfolders: true, language: 'en', theme: 'light' } : undefined,
  });
  controller.on('batch', onBatch);
  controller.on('detail', (d: DetailView) => emitDetail(d));
  controller.on('settings', (s: Settings) => {
    applySettingsEffects(s);
    emitSettings(s);
  });
  controller.on('completed', onCompleted);
  controller.on('prefill', (p: AddPrefill) => {
    showWindow();
    deliverPrefill(p);
  });

  registerAppScheme();
  hardenSession();
  registerIpc();
  applySettingsEffects(controller.settings);

  const showSelfTest = __SAREEA_TEST_HOOKS__ && TEST_MODE !== null && TEST_MODE.selfTest && TEST_MODE.screenshotDir !== null;
  win = createWindow();
  win.once('ready-to-show', () => {
    if (SELF_TEST) {
      if (showSelfTest) win?.showInactive();
    } else if (SHOWCASE) win?.show();
    else if (!START_HIDDEN) win?.show();
  });
  if (!SELF_TEST && !SHOWCASE) createTray();

  bridge = new BridgeServer({
    pipe: pipeNameFor(undefined, TEST_MODE?.pipeSuffix ?? ''),
    log,
    onAdd: (req) => controller.handleBridgeAdd(req),
  });
  const bridgeOk = await bridge.start();
  if (!bridgeOk) toast('error', 'toast.error', 'The browser bridge could not start.');

  if (__SAREEA_TEST_HOOKS__ && TEST_MODE !== null && TEST_MODE.selfTest) {
    const code = await runSelfTest({
      controller,
      win,
      pipe: bridge.pipePath,
      log,
      outFile: TEST_MODE.selfTestOut,
      screenshotDir: TEST_MODE.screenshotDir,
      downloadDir: selfDir as string,
      consoleErrors,
      packaged: app.isPackaged,
    });
    quitting = true;
    await controller.shutdown().catch(() => undefined);
    await bridge.stop();
    await log.flush();
    app.exit(code);
  }

  if (__SAREEA_TEST_HOOKS__ && SHOWCASE && TEST_MODE !== null && TEST_MODE.showcaseDir !== null) {
    const code = await runShowcase({ controller, win, log, outDir: TEST_MODE.showcaseDir });
    quitting = true;
    await controller.shutdown().catch(() => undefined);
    await bridge.stop();
    await log.flush();
    app.exit(code);
  }
});
