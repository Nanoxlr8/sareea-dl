/**
 * Download-capture decision logic and the extension's settings model. Pure: no chrome.* calls, so it is
 * tested with plain Node and bundled unchanged into the service worker and the popup.
 */

export const DEFAULT_EXTENSIONS: readonly string[] = [
  // archives
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab',
  // programs and installers
  'exe', 'msi', 'msix', 'appx', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'jar',
  // disc images
  'iso', 'img',
  // video
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg',
  // audio
  'mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'wma', 'opus',
  // documents
  'pdf',
];

export const DEFAULT_MIN_SIZE_MB = 1;
export const PAUSE_MINUTES = 5;

export interface CaptureSettings {
  enabled: boolean;
  /** Lower-case extensions without the dot. */
  extensions: string[];
  /** Capture any download at least this big when its size is known. 0 turns the size rule off. */
  minSizeMB: number;
  /** Epoch milliseconds until which capture is paused (0 = not paused). */
  pausedUntil: number;
  /** Ask for the sign-in cookie permission when "Download with Sareea DL" is used on a new site. */
  askCookiesOnMenu: boolean;
  /** Sites (origins) where the user said no, so the context menu does not ask again. */
  declinedOrigins: string[];
}

export function defaultCaptureSettings(): CaptureSettings {
  return {
    enabled: true,
    extensions: [...DEFAULT_EXTENSIONS],
    minSizeMB: DEFAULT_MIN_SIZE_MB,
    pausedUntil: 0,
    askCookiesOnMenu: true,
    declinedOrigins: [],
  };
}

const EXT_RE = /^[a-z0-9]{1,12}$/;

/** "zip, .7z; PDF" -> ["zip", "7z", "pdf"]. Invalid entries are dropped, duplicates removed. */
export function parseExtensionList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const e = part.trim().replace(/^\./, '').toLowerCase();
    if (EXT_RE.test(e) && !out.includes(e)) out.push(e);
  }
  return out.slice(0, 200);
}

/** Lenient read of stored settings: every missing or invalid field falls back to its default. */
export function sanitizeSettings(raw: unknown): CaptureSettings {
  const d = defaultCaptureSettings();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return d;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === 'boolean') d.enabled = r.enabled;
  if (Array.isArray(r.extensions)) d.extensions = parseExtensionList(r.extensions.filter((x): x is string => typeof x === 'string').join(' '));
  if (typeof r.minSizeMB === 'number' && Number.isFinite(r.minSizeMB) && r.minSizeMB >= 0 && r.minSizeMB <= 1_000_000) d.minSizeMB = r.minSizeMB;
  if (typeof r.pausedUntil === 'number' && Number.isFinite(r.pausedUntil) && r.pausedUntil >= 0) d.pausedUntil = r.pausedUntil;
  if (typeof r.askCookiesOnMenu === 'boolean') d.askCookiesOnMenu = r.askCookiesOnMenu;
  if (Array.isArray(r.declinedOrigins)) d.declinedOrigins = r.declinedOrigins.filter((x): x is string => typeof x === 'string' && x.length < 300).slice(0, 200);
  return d;
}

export function isHttpUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0 || u.length > 8192) return false;
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Last path or file-name segment's extension, lower case, or '' when there is none. */
export function extensionOf(nameOrPath: string): string {
  const base = nameOrPath.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase();
}

function extensionFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname;
    return extensionOf(decodeURIComponent(p));
  } catch {
    return '';
  }
}

/** The file name only (no folders) from the path Chrome reports, or null. */
export function baseName(p: string | undefined | null): string | null {
  if (!p) return null;
  const b = p.split(/[\\/]/).pop() ?? '';
  return b.length > 0 && b.length <= 255 ? b : null;
}

/** What the decision needs to know about a browser download. */
export interface DownloadInfo {
  url: string;
  finalUrl?: string;
  /** Chrome's chosen file name or full path (may be empty early on). */
  filename?: string;
  /** Known size in bytes, or -1 / 0 / undefined when unknown. */
  fileSize?: number;
  totalBytes?: number;
  incognito?: boolean;
  /** The extension that started this download through chrome.downloads.download, if any. */
  byExtensionId?: string;
}

export type CaptureDecision =
  | { capture: true; reason: 'extension' | 'size' }
  | { capture: false; reason: 'disabled' | 'paused' | 'not-http' | 'incognito' | 'ours' | 'not-matching' };

/** Known size of a download: the larger of the two fields Chrome fills in, or -1. */
export function knownSize(info: Pick<DownloadInfo, 'fileSize' | 'totalBytes'>): number {
  const a = typeof info.totalBytes === 'number' ? info.totalBytes : -1;
  const b = typeof info.fileSize === 'number' ? info.fileSize : -1;
  return Math.max(a, b);
}

/**
 * Should this browser download be handed to Sareea DL?
 * Order: our own re-issued downloads and incognito are never captured; then the switch, the 5-minute
 * pause, the scheme (http and https only), then the file-type list or the minimum size.
 */
export function decideCapture(info: DownloadInfo, settings: CaptureSettings, now: number, ownExtensionId?: string): CaptureDecision {
  if (ownExtensionId && info.byExtensionId === ownExtensionId) return { capture: false, reason: 'ours' };
  if (info.incognito) return { capture: false, reason: 'incognito' };
  if (!settings.enabled) return { capture: false, reason: 'disabled' };
  if (settings.pausedUntil > now) return { capture: false, reason: 'paused' };
  if (!isHttpUrl(info.url)) return { capture: false, reason: 'not-http' };
  const ext = extensionOf(info.filename ?? '') || extensionFromUrl(info.finalUrl && isHttpUrl(info.finalUrl) ? info.finalUrl : info.url) || extensionFromUrl(info.url);
  if (ext && settings.extensions.includes(ext)) return { capture: true, reason: 'extension' };
  const size = knownSize(info);
  if (settings.minSizeMB > 0 && size > 0 && size >= settings.minSizeMB * 1024 * 1024) return { capture: true, reason: 'size' };
  return { capture: false, reason: 'not-matching' };
}

/** Minutes left of a pause (rounded up), or 0. */
export function pauseMinutesLeft(settings: Pick<CaptureSettings, 'pausedUntil'>, now: number): number {
  return settings.pausedUntil > now ? Math.ceil((settings.pausedUntil - now) / 60_000) : 0;
}

/**
 * Referer to send to the server for a download started from `pageUrl`. It follows the browser's default
 * policy: the full page address to the same site, only the origin to another site, nothing for a
 * non-http page. This keeps the full address of the page you were on away from the download server.
 */
export function referrerFor(pageUrl: string | undefined | null, targetUrl: string): string | null {
  if (!isHttpUrl(pageUrl) || !isHttpUrl(targetUrl)) return null;
  const page = new URL(pageUrl);
  const target = new URL(targetUrl);
  const noFragment = new URL(page.href);
  noFragment.hash = '';
  noFragment.username = '';
  noFragment.password = '';
  if (page.origin === target.origin) return noFragment.href;
  // https page -> http target: the default policy sends nothing
  if (page.protocol === 'https:' && target.protocol === 'http:') return null;
  return page.origin + '/';
}
