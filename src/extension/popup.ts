/**
 * Popup page. Shows the app status, the capture switch, the 5-minute pause, the per-site cookie
 * permissions (grant and revoke) and the capture rules. Everything that is text from the browser or a
 * site goes into the page with textContent. Permission requests are made straight from the click that
 * asks for them, because the browser only allows that with a user gesture.
 */
import { defaultCaptureSettings, isHttpUrl, PAUSE_MINUTES, parseExtensionList, pauseMinutesLeft, sanitizeSettings } from './capture.ts';
import type { CaptureSettings } from './capture.ts';
import { originFromPattern, originOf, originPattern } from './cookies.ts';
import { classifyReply, NATIVE_HOST_NAME, outcomeText } from './native.ts';
import type { NativeOutcome } from './native.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

const SETTINGS_KEY = 'settings';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error('missing element ' + id);
  return e as T;
};

let settings: CaptureSettings = defaultCaptureSettings();

async function loadSettings(): Promise<void> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  settings = sanitizeSettings(r?.[SETTINGS_KEY]);
}

async function saveSettings(patch: Partial<CaptureSettings>): Promise<void> {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

function sendNative(message: Record<string, unknown>): Promise<NativeOutcome> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (reply: unknown) => {
        const err = chrome.runtime.lastError;
        resolve(classifyReply(reply, err ? String(err.message ?? 'error') : null));
      });
    } catch {
      resolve({ kind: 'failed' });
    }
  });
}

// ------------------------------------------------------------------ status

async function refreshStatus(): Promise<void> {
  const o = await sendNative({ type: 'ping' });
  const text = o.kind === 'ok' ? 'Sareea DL is running' : o.kind === 'app-not-running' ? 'Sareea DL is not running' : outcomeText(o);
  $('statusText').textContent = text;
  $('dot').className = 'dot ' + (o.kind === 'ok' ? 'ok' : 'bad');
  $('openApp').hidden = o.kind === 'host-missing';
  if (o.kind === 'ok') {
    void chrome.action.setBadgeText({ text: '' });
    void chrome.action.setTitle({ title: 'Sareea DL' });
  }
  if (o.kind === 'host-missing') $('statusText').textContent = 'Browser integration is not installed. In Sareea DL open Settings and press "Install browser integration".';
}

$('openApp').addEventListener('click', () => {
  void sendNative({ type: 'open' }).then(() => setTimeout(() => void refreshStatus(), 1500));
});

// ------------------------------------------------------------ switch, pause

function renderSwitches(): void {
  $<HTMLInputElement>('enabled').checked = settings.enabled;
  const left = pauseMinutesLeft(settings, Date.now());
  const pause = $<HTMLButtonElement>('pause');
  pause.textContent = left > 0 ? 'Resume capture now' : `Pause capture for ${PAUSE_MINUTES} minutes`;
  const note = $('pauseNote');
  note.hidden = left === 0;
  note.textContent = left > 0 ? `Paused: downloads go through the browser for about ${left} more minute(s).` : '';
  pause.disabled = !settings.enabled;
}

$('enabled').addEventListener('change', (e) => {
  void saveSettings({ enabled: (e.target as HTMLInputElement).checked }).then(renderSwitches);
});
$('pause').addEventListener('click', () => {
  const left = pauseMinutesLeft(settings, Date.now());
  void saveSettings({ pausedUntil: left > 0 ? 0 : Date.now() + PAUSE_MINUTES * 60_000 }).then(renderSwitches);
});

// ------------------------------------------------------- cookie permissions

function addListItem(list: HTMLElement, origin: string, label: string, onClick: () => void, primary = false): void {
  const li = document.createElement('li');
  const site = document.createElement('span');
  site.className = 'site';
  site.textContent = origin;
  site.title = origin;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn' + (primary ? ' primary' : '');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  li.append(site, btn);
  list.appendChild(li);
}

async function grantedOrigins(): Promise<string[]> {
  const all = await chrome.permissions.getAll();
  const out: string[] = [];
  for (const p of (all?.origins ?? []) as string[]) {
    const o = originFromPattern(p);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

function showSiteError(text: string | null): void {
  const e = $('siteError');
  e.hidden = text === null;
  e.textContent = text ?? '';
}

// Called straight from a click: permissions.request needs the user gesture.
function allow(origin: string): void {
  showSiteError(null);
  const pattern = originPattern(origin);
  if (!pattern) return showSiteError('That is not an http or https address.');
  chrome.permissions.request({ origins: [pattern] }).then(
    (granted: boolean) => {
      if (!granted) showSiteError('The browser did not grant it.');
      else if (settings.declinedOrigins.includes(origin)) void saveSettings({ declinedOrigins: settings.declinedOrigins.filter((o) => o !== origin) });
      void renderSites();
    },
    () => showSiteError('The browser did not grant it.'),
  );
}

function revoke(origin: string): void {
  const pattern = originPattern(origin);
  if (!pattern) return;
  void chrome.permissions.remove({ origins: [pattern] }).then(() => renderSites());
}

async function renderSites(): Promise<void> {
  const granted = await grantedOrigins();
  const recentRaw = (await chrome.storage.session.get('recentSites').catch(() => ({})))?.recentSites;
  const recent = (Array.isArray(recentRaw) ? (recentRaw as unknown[]) : []).filter((o): o is string => typeof o === 'string' && originOf(o) === o && !granted.includes(o));

  const recentList = $('recent');
  recentList.replaceChildren();
  for (const o of recent) addListItem(recentList, o, 'Allow sign-in cookies', () => allow(o), true);

  const grantedList = $('granted');
  grantedList.replaceChildren();
  for (const o of granted) addListItem(grantedList, o, 'Revoke', () => revoke(o));
  $('noGranted').hidden = granted.length > 0;
}

$('addSite').addEventListener('submit', (e) => {
  e.preventDefault();
  let text = $<HTMLInputElement>('siteInput').value.trim();
  if (text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
  const origin = isHttpUrl(text) ? originOf(text) : null;
  if (!origin) return showSiteError('Enter a site address such as https://example.com');
  $<HTMLInputElement>('siteInput').value = '';
  allow(origin);
});

// ------------------------------------------------------------------- rules

function renderRules(): void {
  $<HTMLTextAreaElement>('types').value = settings.extensions.join(', ');
  $<HTMLInputElement>('minSize').value = String(settings.minSizeMB);
  $<HTMLInputElement>('askMenu').checked = settings.askCookiesOnMenu;
}

$('types').addEventListener('change', (e) => {
  void saveSettings({ extensions: parseExtensionList((e.target as HTMLTextAreaElement).value) }).then(renderRules);
});
$('minSize').addEventListener('change', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  void saveSettings({ minSizeMB: Number.isFinite(v) && v >= 0 ? Math.min(v, 1_000_000) : defaultCaptureSettings().minSizeMB }).then(renderRules);
});
$('askMenu').addEventListener('change', (e) => {
  void saveSettings({ askCookiesOnMenu: (e.target as HTMLInputElement).checked });
});
$('resetRules').addEventListener('click', () => {
  const d = defaultCaptureSettings();
  void saveSettings({ extensions: d.extensions, minSizeMB: d.minSizeMB, askCookiesOnMenu: d.askCookiesOnMenu }).then(renderRules);
});

// -------------------------------------------------------------------- start

void (async () => {
  await loadSettings();
  renderSwitches();
  renderRules();
  await renderSites();
  document.body.dataset.ready = '1'; // lets automated tests know the buttons are wired
  void refreshStatus();
})();
