/**
 * The extension's behaviour, with every chrome.* call and the clock injected, so it is unit tested with
 * plain Node: what happens to a browser download, and what happens on a "Download with Sareea DL" click.
 * background.ts only wires these to the real browser APIs.
 */
import { baseName, decideCapture, isHttpUrl, referrerFor } from './capture.ts';
import type { CaptureSettings } from './capture.ts';
import { cookieHeaderFor, originOf, originPattern } from './cookies.ts';
import type { CookieDeps } from './cookies.ts';
import { buildAddMessage } from './native.ts';
import type { NativeOutcome } from './native.ts';

/** The fields of chrome.downloads.DownloadItem that the flow uses. */
export interface BrowserDownload {
  id: number;
  url: string;
  finalUrl?: string;
  filename?: string;
  referrer?: string;
  fileSize?: number;
  totalBytes?: number;
  incognito?: boolean;
  byExtensionId?: string;
}

export interface FlowDeps {
  getSettings(): Promise<CaptureSettings>;
  now(): number;
  /** This extension's own ID (downloads we start ourselves are never captured). */
  ownId: string;
  userAgent: string;
  cookies: CookieDeps;
  /** Send one message to the native host. */
  send(message: Record<string, unknown>): Promise<NativeOutcome>;
  /** Cancel the browser's own download and erase it from the download list. */
  cancelDownload(id: number): Promise<void>;
  /** Start the download in the browser (chrome.downloads.download) after marking the URL as ours. */
  reissue(url: string): Promise<void>;
  /** True once if this URL was marked by reissue() (and the mark is used up). */
  takeReissuedMark(url: string): Promise<boolean>;
  /** Called with every host outcome (badge on failure, cleared on success). */
  onOutcome(outcome: NativeOutcome): void;
  /** Remember an origin the popup can offer to allow. Origins only, no paths. */
  rememberSite(origin: string): Promise<void>;
  /** chrome.permissions.request for one origin pattern. Must be called inside the user's click. */
  requestPermission(pattern: string): Promise<boolean>;
  rememberDeclined(origin: string): Promise<void>;
}

export type DownloadResult = 'captured' | 'left-to-browser' | 'skipped';

/**
 * A browser download is about to get its file name. Decide, and if it should be captured, hand it to the
 * app. The browser's own download is cancelled only after the app has said yes, so when the app is not
 * running (or refuses) the very same download simply carries on in the browser: no restart, no loop.
 */
export async function handleBrowserDownload(item: BrowserDownload, deps: FlowDeps): Promise<DownloadResult> {
  const settings = await deps.getSettings();
  const decision = decideCapture(item, settings, deps.now(), deps.ownId);
  if (!decision.capture) return 'skipped';
  if (await deps.takeReissuedMark(item.url)) return 'skipped'; // a download we put back in the browser ourselves

  const origin = originOf(item.url);
  if (origin) await deps.rememberSite(origin);
  const cookie = await cookieHeaderFor(item.url, deps.cookies); // null unless this exact origin was granted
  const msg = buildAddMessage({
    url: item.url,
    fileName: baseName(item.filename),
    referrer: isHttpUrl(item.referrer) ? item.referrer : null,
    cookie,
    userAgent: deps.userAgent,
  });
  const outcome = await deps.send(msg);
  deps.onOutcome(outcome);
  if (outcome.kind !== 'ok') return 'left-to-browser';
  await deps.cancelDownload(item.id);
  return 'captured';
}

export interface MenuClick {
  linkUrl?: string;
  srcUrl?: string;
  pageUrl?: string;
}

export type MenuResult = 'sent' | 'fallback' | 'ignored';

/**
 * "Download with Sareea DL" on a link or media element. A click is a user gesture, so this is the one
 * place besides the popup where the per-site cookie permission may be requested, and only for the
 * origin of the clicked link. A site the user turned down is not asked again. If the app cannot take
 * the download, it is started in the browser instead (marked, so it is not captured again).
 */
export async function handleMenuClick(info: MenuClick, deps: FlowDeps): Promise<MenuResult> {
  const url = [info.linkUrl, info.srcUrl].find((u): u is string => isHttpUrl(u));
  if (!url) return 'ignored';
  const settings = await deps.getSettings();
  const origin = originOf(url);
  const pattern = originPattern(url);
  if (!origin || !pattern) return 'ignored';

  let granted = false;
  try {
    granted = await deps.cookies.contains({ origins: [pattern] });
  } catch {
    granted = false;
  }
  if (!granted && settings.askCookiesOnMenu && !settings.declinedOrigins.includes(origin)) {
    let answered = false;
    try {
      granted = await deps.requestPermission(pattern);
      answered = true;
    } catch {
      granted = false; // the browser refused to ask (no user gesture): not the same as the user saying no
    }
    if (answered && !granted) await deps.rememberDeclined(origin);
  }
  await deps.rememberSite(origin);

  const cookie = granted ? await cookieHeaderFor(url, deps.cookies) : null;
  const referrer = referrerFor(info.pageUrl, url);
  const msg = buildAddMessage({
    url,
    referrer,
    pageUrl: referrer && isHttpUrl(info.pageUrl) ? info.pageUrl : null,
    cookie,
    userAgent: deps.userAgent,
  });
  const outcome = await deps.send(msg);
  deps.onOutcome(outcome);
  if (outcome.kind === 'ok') return 'sent';
  await deps.reissue(url);
  return 'fallback';
}
