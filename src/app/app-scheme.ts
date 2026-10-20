/**
 * The custom scheme the window's page is served from: app://sareea/<file>. Pure helpers, no Electron.
 *
 * Why not file://: a file:// page can be confused with every other local file, needs the
 * GrantFileProtocolExtraPrivileges fuse to load from inside app.asar, and gives the sender check a weak
 * identity (a path). With a scheme registered as standard + secure, the page has a real origin
 * (app://sareea), `'self'` in the CSP means exactly that origin, and the only thing that can answer a request
 * for it is the handler in main.ts, which maps it to the files of one folder (dist/renderer) and nothing else.
 */
import path from 'node:path';
import { isInsideDir } from './ipc.ts';

export const APP_SCHEME = 'app';
export const APP_HOST = 'sareea';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;

/** What the handler will serve, by extension. Anything else is refused even if the file exists. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export interface ResolvedAppFile {
  /** Absolute path inside rootDir. */
  file: string;
  mime: string;
}

/**
 * Map an app:// URL to a file inside `rootDir` (the renderer folder), or null when the request must be refused:
 * wrong scheme or host, credentials or a port in the URL, `..` or `.` segments (also percent-encoded), encoded
 * separators, backslashes, drive letters or other `:`, NUL and control characters, empty segments, an extension
 * that is not on the list, or a path that does not stay inside rootDir after resolving.
 */
export function resolveAppRequest(requestUrl: string, rootDir: string): ResolvedAppFile | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  // (Node parses a custom scheme with an opaque host, so the case is folded here; Chromium already lower-cases it.)
  if (u.protocol !== `${APP_SCHEME}:` || u.hostname.toLowerCase() !== APP_HOST) return null;
  if (u.username || u.password || u.port) return null;

  const rawPath = u.pathname === '/' || u.pathname === '' ? '/index.html' : u.pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(decoded) || /%/.test(decoded)) return null;
  const segments = decoded.slice(1).split('/');
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..' || /^\.+$/.test(s) || /[ .]$/.test(s))) return null;

  const mime = MIME[path.extname(segments[segments.length - 1]).toLowerCase()];
  if (!mime) return null;
  const file = path.resolve(rootDir, ...segments);
  if (!isInsideDir(file, rootDir) || file.toLowerCase() === path.resolve(rootDir).toLowerCase()) return null;
  return { file, mime };
}
