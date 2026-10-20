/**
 * Electron main process: window, tray, IPC, local bridge, notifications, clipboard watch.
 * All download logic lives in controller.ts; this file wires it to the OS and enforces the
 * security rules (see README "Security model").
 */
import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, session, shell, Tray,
} from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// The esbuild "binary" loader turns the PNG into a Uint8Array at build time.
import iconPng from '../../assets/icon.png';
import { AppController } from './controller.ts';
import type { Platform } from './controller.ts';
import { BridgeServer, pipeNameFor } from './bridge.ts';
import { installIntegration, integrationState, removeIntegration, systemRegRunner } from './browser-integration.ts';
import { Logger } from './logger.ts';
import { runSelfTest } from './selftest.ts';
import { CH } from '../app/api.ts';
import type { AddPrefill, IntegrationView, ItemsBatch, Result, ToastMessage, ViewItem } from '../app/api.ts';
import { EXTENSION_ID, HOST_EXE_NAME, pipeSuffixForTestDir, testDirFromEnv } from '../app/browser-integration.ts';
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

const argv = process.argv.slice(1);
const SELF_TEST = argv.includes('--self-test');
const START_HIDDEN = argv.includes('--hidden');
const argValue = (name: string): string | null => {
  const a = argv.find((x) => x.startsWith(name + '='));
  return a ? a.slice(name.length + 1) : null;
};

// A packaged app must not be started with debugging switches (the exe fuses already switch off the Node ones).
if (app.isPackaged && argv.some((a) => /^--(remote-debugging|inspect|debug)/i.test(a))) process.exit(1);

app.setName('Sareea DL');
app.setAppUserModelId('com.sareea.dl');
// SAREEA_DL_TEST_DIR is a test hook (see docs/extension.md): the end-to-end test keeps the app's data and
// its pipe name apart from a real installation.
const TEST_DIR = testDirFromEnv(process.env);
if (!argv.includes('--self-test')) app.setPath('userData', TEST_DIR ?? path.join(app.getPath('appData'), 'Sareea DL'));

if (SELF_TEST) {
  // A throw-away profile: the self-test never touches the real settings, queue or downloads.
  app.setPath('userData', path.join(os.tmpdir(), `sareea-selftest-${process.pid}`));
} else if (!app.requestSingleInstanceLock()) {
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

const INDEX_HTML = path.join(__dirname, 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;
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

function sendToWindow(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed() && rendererReady) win.webContents.send(channel, payload);
}

function toast(kind: ToastMessage['kind'], key: string | null, text: string): void {
  const m: ToastMessage = { kind, key, text };
  if (rendererReady) sendToWindow(CH.evToast, m);
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
  if (SELF_TEST) {
    w.webContents.on('console-message', (event) => {
      const d = event as unknown as { level?: string | number; message?: string };
      if (d.level === 'error' || d.level === 3) consoleErrors.push(String(d.message ?? '').slice(0, 200));
    });
    w.webContents.on('preload-error', (_e, p, err) => consoleErrors.push(`preload error ${p}: ${err.message}`));
  }
  w.on('close', (e) => {
    if (!quitting && controller.settings.closeToTray && tray) {
      e.preventDefault();
      w.hide();
    }
  });
  w.on('closed', () => {
    win = null;
  });
  void w.loadFile(INDEX_HTML);
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

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // The UI itself never needs the network: any request that is not a local file or devtools is cancelled.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (details, cb) => {
    log.warn(`blocked renderer request to ${new URL(details.url).origin}`);
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
  return isTrustedSender(frame.url, INDEX_URL);
}

function handle<A>(channel: string, validate: (raw: unknown) => Checked<A>, fn: (arg: A) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    if (!trusted(event)) {
      log.warn(`rejected IPC ${channel} from an untrusted sender`);
      return { ok: false, error: 'untrusted sender' };
    }
    const v = validate(raw);
    if (!v.ok) {
      log.warn(`rejected IPC ${channel}: ${v.error}`);
      return { ok: false, error: v.error };
    }
    try {
      return await fn(v.value);
    } catch (e) {
      log.error(`IPC ${channel} failed`, e);
      return { ok: false, error: 'internal error' };
    }
  });
}

const noArgs = (raw: unknown): Checked<undefined> => (raw === undefined ? { ok: true, value: undefined } : { ok: false, error: 'unexpected argument' });

function registerIpc(): void {
  handle(CH.getState, noArgs, () => controller.getInitialState(app.getVersion(), app.isPackaged));
  handle(CH.ready, noArgs, () => {
    rendererReady = true;
    for (const p of pendingPrefills) sendToWindow(CH.evShowAdd, p);
    for (const m of pendingToasts) sendToWindow(CH.evToast, m);
    pendingPrefills = [];
    pendingToasts = [];
    return { ok: true };
  });
  handle(CH.probe, validateProbeRequest, (r) => controller.probeUrl(r));
  handle(CH.add, validateAddRequest, (r) => controller.addDownload(r));
  handle(CH.pause, validateIds, (ids) => controller.pause(ids));
  handle(CH.resume, validateIds, (ids) => controller.resume(ids));
  handle(CH.remove, validateRemoveRequest, (r) => controller.remove(r));
  handle(CH.redownload, validateIds, (ids) => controller.redownload(ids));
  handle(CH.openFile, validateId, (id) => controller.openFile(id));
  handle(CH.openFolder, validateId, (id) => controller.openFolder(id));
  handle(CH.copyLink, validateId, (id) => controller.copyLink(id));
  handle(CH.startQueue, noArgs, () => controller.startQueue());
  handle(CH.stopQueue, noArgs, () => controller.stopQueue());
  handle(
    CH.setSettings,
    (raw) => {
      const r = validateSettingsPatch(raw);
      return r.ok ? { ok: true, value: r.value } : r;
    },
    (patch) => controller.setSettings(patch),
  );
  handle(CH.pickFolder, noArgs, async (): Promise<Result<{ dir: string | null }>> => {
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
  handle(CH.readClipboardUrl, noArgs, async (): Promise<Result<{ url: string | null }>> => {
    const text = (await clipboard.readText().catch(() => '')).trim().slice(0, 8192);
    return { ok: true, url: text && !/\s/.test(text) && isHttpUrl(text) ? text : null };
  });
  handle(CH.watch, validateWatchId, (id) => controller.watch(id));
  handle(CH.getIntegration, noArgs, async () => ({ ok: true, integration: await integrationView() }));
  handle(CH.installIntegration, noArgs, async (): Promise<Result<{ integration: IntegrationView }>> => {
    if (!app.isPackaged) return { ok: false, error: 'only the packaged app can install the browser integration' };
    const hostExe = path.join(path.dirname(process.execPath), HOST_EXE_NAME);
    if (!fs.existsSync(hostExe)) return { ok: false, error: 'the browser host program is missing next to the app' };
    const r = await installIntegration({ exePath: hostExe, dataDir: app.getPath('userData'), run: systemRegRunner() });
    if (!r.ok) return r;
    log.info('browser integration installed');
    return { ok: true, integration: await integrationView() };
  });
  handle(CH.removeIntegration, noArgs, async (): Promise<Result<{ integration: IntegrationView }>> => {
    const r = await removeIntegration({ dataDir: app.getPath('userData'), run: systemRegRunner() });
    if (!r.ok) return r;
    log.info('browser integration removed');
    return { ok: true, integration: await integrationView() };
  });
  handle(CH.openExtensionFolder, noArgs, async (): Promise<Result> => {
    const dir = extensionDir();
    if (!dir) return { ok: false, error: 'the extension folder is only bundled with the packaged app' };
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: 'could not open the folder' } : { ok: true };
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
  if (rendererReady) sendToWindow(CH.evShowAdd, p);
  else pendingPrefills.push(p);
}

// ------------------------------------------------------- batches -> window/tray

let lastTrayUpdate = 0;

function onBatch(batch: ItemsBatch): void {
  sendToWindow(CH.evItems, batch);
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
  if (!controller.settings.notifyOnComplete || !Notification.isSupported() || SELF_TEST) return;
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
  controller = new AppController({
    dataDir,
    userProfile: process.env.USERPROFILE ?? os.homedir(),
    platform,
    log,
    settingsOverride: selfDir ? { defaultDir: selfDir, categorySubfolders: true, language: 'en', theme: 'light' } : undefined,
  });
  controller.on('batch', onBatch);
  controller.on('detail', (d) => sendToWindow(CH.evDetail, d));
  controller.on('settings', (s: Settings) => {
    applySettingsEffects(s);
    sendToWindow(CH.evSettings, s);
  });
  controller.on('completed', onCompleted);
  controller.on('prefill', (p: AddPrefill) => {
    showWindow();
    deliverPrefill(p);
  });

  hardenSession();
  registerIpc();
  applySettingsEffects(controller.settings);

  const showSelfTest = SELF_TEST && argValue('--screenshot-dir') !== null;
  win = createWindow();
  win.once('ready-to-show', () => {
    if (SELF_TEST) {
      if (showSelfTest) win?.showInactive();
    } else if (!START_HIDDEN) win?.show();
  });
  if (!SELF_TEST) createTray();

  bridge = new BridgeServer({
    pipe: pipeNameFor(undefined, SELF_TEST ? `-selftest-${process.pid}` : pipeSuffixForTestDir(TEST_DIR)),
    log,
    onAdd: (req) => controller.handleBridgeAdd(req),
  });
  const bridgeOk = await bridge.start();
  if (!bridgeOk) toast('error', 'toast.error', 'The browser bridge could not start.');

  if (SELF_TEST) {
    const code = await runSelfTest({
      controller,
      win,
      pipe: bridge.pipePath,
      log,
      outFile: argValue('--self-test-out'),
      screenshotDir: argValue('--screenshot-dir'),
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
});
