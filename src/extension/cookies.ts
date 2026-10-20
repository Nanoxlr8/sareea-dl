/**
 * Cookie access, gated by a per-site permission. Pure apart from the injected `deps`, so the gating
 * rule is unit tested: with no grant for the exact origin of the download URL, cookies.getAll is never
 * called. The cookie header is built here and handed on to the host for that one download; it is never
 * stored, logged, or put in an error message.
 */
import { isHttpUrl } from './capture.ts';

export interface CookieLike {
  name: string;
  value: string;
}

export interface CookieDeps {
  /** chrome.permissions.contains */
  contains(query: { origins: string[] }): Promise<boolean>;
  /** chrome.cookies.getAll */
  getAll(details: { url: string }): Promise<CookieLike[]>;
}

/** Longest Cookie header the app accepts (src/app/protocol.ts). Longer means we send none rather than a cut-off one. */
export const MAX_COOKIE_HEADER = 16384;

/** Match pattern for exactly one origin, e.g. "https://example.com/*" or "http://127.0.0.1:8080/*". Null for non-http(s). */
export function originPattern(url: string): string | null {
  if (!isHttpUrl(url)) return null;
  return new URL(url).origin + '/*';
}

/** Origin ("https://example.com") of an http(s) URL, or null. */
export function originOf(url: string): string | null {
  return isHttpUrl(url) ? new URL(url).origin : null;
}

/** "https://example.com/*" -> "https://example.com", or null if the pattern is not a single http(s) origin. */
export function originFromPattern(pattern: string): string | null {
  const m = /^(https?:\/\/[^/*]+)\/\*$/.exec(pattern);
  if (!m || m[1].includes('*')) return null;
  return m[1];
}

const BAD_COOKIE_CHARS = /[\u0000-\u001f\u007f;]/;

export function buildCookieHeader(cookies: readonly CookieLike[]): string | null {
  const parts: string[] = [];
  for (const c of cookies) {
    if (typeof c.name !== 'string' || typeof c.value !== 'string' || c.name.length === 0) continue;
    if (BAD_COOKIE_CHARS.test(c.name) || BAD_COOKIE_CHARS.test(c.value)) continue;
    parts.push(`${c.name}=${c.value}`);
  }
  const header = parts.join('; ');
  return header.length > 0 && header.length <= MAX_COOKIE_HEADER ? header : null;
}

/**
 * The Cookie header for `url`, or null. Cookies are read only when the user granted this exact origin,
 * and only for this exact URL (cookies.getAll with `url`), never for a whole domain or a whole store.
 */
export async function cookieHeaderFor(url: string, deps: CookieDeps): Promise<string | null> {
  const pattern = originPattern(url);
  if (!pattern) return null;
  let granted = false;
  try {
    granted = await deps.contains({ origins: [pattern] });
  } catch {
    return null;
  }
  if (!granted) return null; // no grant: the cookies API is not touched at all
  try {
    return buildCookieHeader(await deps.getAll({ url }));
  } catch {
    return null;
  }
}
