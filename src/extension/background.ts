/**
 * Service worker. Wires the browser's APIs to the tested logic in flow.ts. There is no content script,
 * no network request of its own, and no remote code: the only things it talks to are the browser's
 * download list, the cookie store (only for sites the user granted) and the native host.
 */
import { sanitizeSettings } from './capture.ts';
import type { CaptureSettings } from './capture.ts';
import { handleBrowserDownload, handleMenuClick } from './flow.ts';
import type { BrowserDownload, FlowDeps } from './flow.ts';
import { classifyReply, NATIVE_HOST_NAME, outcomeText } from './native.ts';
import type { NativeOutcome } from './native.ts';

// The chrome.* namespace is provided by the browser; it is deliberately not typed in detail here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

const SETTINGS_KEY = 'settings';
const MENU_ID = 'sareea-dl-download';
const REISSUE_TTL_MS = 2 * 60 * 1000;
const MAX_RECENT_SITES = 6;

// ---------------------------------------------------------------- settings

// Read fresh every time, never cached in a variable. Besides being simple, this matters for the context
// menu: the browser only lets us ask for a site permission inside the user's click, and it carries that
// "gesture" through the extension API calls we start while handling it. A settings read started at
// worker start-up would not carry it.
async function getSettings(): Promise<CaptureSettings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(r?.[SETTINGS_KEY]);
}

async function saveSettings(s: CaptureSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

// -------------------------------------------------------------- native host

function sendNative(message: Record<string, unknown>): Promise<NativeOutcome> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (reply: unknown) => {
        const err = chrome.runtime.lastError; // always read it, or Chrome logs "unchecked runtime.lastError"
        resolve(classifyReply(reply, err ? String(err.message ?? 'error') : null));
      });
    } catch {
      resolve({ kind: 'failed' });
    }
  });
}

function onOutcome(o: NativeOutcome): void {
  if (o.kind === 'ok') {
    void chrome.action.setBadgeText({ text: '' });
    void chrome.action.setTitle({ title: 'Sareea DL' });
    return;
  }
  void chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  void chrome.action.setBadgeText({ text: '!' });
  void chrome.action.setTitle({ title: outcomeText(o) });
}

// ------------------------------------------------------ session bookkeeping

async function sessionGet<T>(key: string, fallback: T): Promise<T> {
  try {
    const r = await chrome.storage.session.get(key);
    return (r?.[key] as T) ?? fallback;
  } catch {
    return fallback;
  }
}

const deps: FlowDeps = {
  getSettings,
  now: () => Date.now(),
  ownId: chrome.runtime.id,
  userAgent: navigator.userAgent,
  cookies: {
    contains: (q) => chrome.permissions.contains(q),
    getAll: (d) => chrome.cookies.getAll(d),
  },
  send: sendNative,
  async cancelDownload(id) {
    try {
      await chrome.downloads.cancel(id);
    } finally {
      await chrome.downloads.erase({ id });
    }
  },
  async reissue(url) {
    const marks = await sessionGet<Record<string, number>>('reissued', {});
    const now = Date.now();
    for (const k of Object.keys(marks)) if (marks[k] < now) delete marks[k];
    marks[url] = now + REISSUE_TTL_MS;
    await chrome.storage.session.set({ reissued: marks });
    await chrome.downloads.download({ url });
  },
  async takeReissuedMark(url) {
    const marks = await sessionGet<Record<string, number>>('reissued', {});
    const exp = marks[url];
    if (exp === undefined) return false;
    delete marks[url];
    await chrome.storage.session.set({ reissued: marks });
    return exp >= Date.now();
  },
  onOutcome,
  async rememberSite(origin) {
    const list = await sessionGet<string[]>('recentSites', []);
    const next = [origin, ...list.filter((o) => o !== origin)].slice(0, MAX_RECENT_SITES);
    await chrome.storage.session.set({ recentSites: next });
  },
  requestPermission: (pattern) => chrome.permissions.request({ origins: [pattern] }),
  async rememberDeclined(origin) {
    const s = await getSettings();
    if (!s.declinedOrigins.includes(origin)) await saveSettings({ ...s, declinedOrigins: [...s.declinedOrigins, origin].slice(-200) });
  },
};

// ---------------------------------------------------------------- listeners

// Chrome waits for suggest() when the listener returns true. A download we do not capture (or could not
// hand over) gets suggest() at once, so it carries on exactly as if we were not here. A captured download
// has been cancelled and erased, and suggest() on it would only log "Invalid downloadId".
chrome.downloads.onDeterminingFilename.addListener((item: BrowserDownload, suggest: () => void) => {
  void handleBrowserDownload(item, deps)
    .catch(() => 'left-to-browser' as const)
    .then((result) => {
      if (result === 'captured') return;
      try {
        suggest();
      } catch {
        /* the worker restarted: the browser carries on by itself */
      }
    });
  return true;
});

chrome.contextMenus.onClicked.addListener((info: { menuItemId: string; linkUrl?: string; srcUrl?: string; pageUrl?: string }) => {
  if (info.menuItemId !== MENU_ID) return;
  void handleMenuClick(info, deps).catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Download with Sareea DL',
      contexts: ['link', 'image', 'video', 'audio'],
    });
  });
});
