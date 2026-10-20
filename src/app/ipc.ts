/** Validators for everything the renderer sends to the main process. Pure: no Electron. */
import path from 'node:path';
import { isAbsoluteWindowsPath, LIMITS } from './settings.ts';
import type { AddRequest, ProbeRequest, RemoveRequest } from './api.ts';

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export const MAX_URL_LENGTH = 8192;
export const MAX_FILE_NAME_LENGTH = 255;
export const MAX_IDS = 5000;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Accept only a single http(s) URL: no whitespace or control characters, bounded length. */
export function validateHttpUrl(v: unknown): Checked<string> {
  if (typeof v !== 'string') return { ok: false, error: 'url must be a string' };
  const s = v.trim();
  if (s.length === 0) return { ok: false, error: 'url is empty' };
  if (s.length > MAX_URL_LENGTH) return { ok: false, error: 'url is too long' };
  if (/\s/.test(s) || CONTROL_RE.test(s)) return { ok: false, error: 'url contains whitespace or control characters' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'url is not valid' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'only http and https links are supported' };
  if (!u.hostname) return { ok: false, error: 'url has no host' };
  return { ok: true, value: u.href };
}

export function validateId(v: unknown): Checked<string> {
  return typeof v === 'string' && ID_RE.test(v) ? { ok: true, value: v } : { ok: false, error: 'invalid id' };
}

export function validateIds(v: unknown): Checked<string[]> {
  if (!Array.isArray(v)) return { ok: false, error: 'ids must be an array' };
  if (v.length === 0 || v.length > MAX_IDS) return { ok: false, error: 'ids must hold 1 to 5000 entries' };
  const out: string[] = [];
  for (const x of v) {
    const c = validateId(x);
    if (!c.ok) return c;
    out.push(c.value);
  }
  return { ok: true, value: [...new Set(out)] };
}

export function validateWatchId(v: unknown): Checked<string | null> {
  return v === null ? { ok: true, value: null } : validateId(v);
}

function validateToken(v: unknown): Checked<string | null> {
  if (v === null) return { ok: true, value: null };
  return typeof v === 'string' && TOKEN_RE.test(v) ? { ok: true, value: v } : { ok: false, error: 'invalid token' };
}

function validateOptionalFileName(v: unknown): Checked<string | null> {
  if (v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: 'fileName must be a string' };
  if (v.length > MAX_FILE_NAME_LENGTH || CONTROL_RE.test(v)) return { ok: false, error: 'fileName is not valid' };
  return { ok: true, value: v };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function exactKeys(rec: Record<string, unknown>, keys: string[]): boolean {
  const k = Object.keys(rec);
  return k.length === keys.length && keys.every((x) => x in rec);
}

export function validateProbeRequest(v: unknown): Checked<ProbeRequest> {
  const r = asRecord(v);
  if (!r || !exactKeys(r, ['url', 'bridgeToken'])) return { ok: false, error: 'bad probe request' };
  const url = validateHttpUrl(r.url);
  if (!url.ok) return url;
  const token = validateToken(r.bridgeToken);
  if (!token.ok) return token;
  return { ok: true, value: { url: url.value, bridgeToken: token.value } };
}

export function validateAddRequest(v: unknown): Checked<AddRequest> {
  const r = asRecord(v);
  if (!r || !exactKeys(r, ['url', 'fileName', 'dir', 'connections', 'start', 'bridgeToken'])) return { ok: false, error: 'bad add request' };
  const url = validateHttpUrl(r.url);
  if (!url.ok) return url;
  const name = validateOptionalFileName(r.fileName);
  if (!name.ok) return name;
  let dir: string | null = null;
  if (r.dir !== null) {
    if (!isAbsoluteWindowsPath(r.dir)) return { ok: false, error: 'dir must be an absolute folder path' };
    dir = r.dir;
  }
  const c = r.connections;
  if (typeof c !== 'number' || !Number.isInteger(c) || c < LIMITS.connections.min || c > LIMITS.connections.max) {
    return { ok: false, error: `connections must be an integer ${LIMITS.connections.min}-${LIMITS.connections.max}` };
  }
  if (typeof r.start !== 'boolean') return { ok: false, error: 'start must be true or false' };
  const token = validateToken(r.bridgeToken);
  if (!token.ok) return token;
  return { ok: true, value: { url: url.value, fileName: name.value, dir, connections: c, start: r.start, bridgeToken: token.value } };
}

export function validateRemoveRequest(v: unknown): Checked<RemoveRequest> {
  const r = asRecord(v);
  if (!r || !exactKeys(r, ['ids', 'deleteFile'])) return { ok: false, error: 'bad remove request' };
  const ids = validateIds(r.ids);
  if (!ids.ok) return ids;
  if (typeof r.deleteFile !== 'boolean') return { ok: false, error: 'deleteFile must be true or false' };
  return { ok: true, value: { ids: ids.value, deleteFile: r.deleteFile } };
}

/**
 * A request is trusted only if it comes from our own window's page: the sending frame's URL must be
 * exactly the local index.html we loaded (the hash and query are ignored, the path is not).
 */
export function isTrustedSender(frameUrl: string | undefined | null, expectedFileUrl: string): boolean {
  if (!frameUrl) return false;
  try {
    const a = new URL(frameUrl);
    const b = new URL(expectedFileUrl);
    if (a.protocol !== 'file:' || b.protocol !== 'file:') return false;
    return a.pathname.toLowerCase() === b.pathname.toLowerCase() && a.host === b.host;
  } catch {
    return false;
  }
}

function norm(p: string): string {
  return path.win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
}

/** True if child is the same folder as parent or lies inside it (case-insensitive, Windows paths). */
export function isInsideDir(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + '\\');
}

/** A folder from the renderer is accepted only if it is the default folder tree or one the user picked in the folder dialog. */
export function isDirAllowed(dir: string, defaultDir: string, pickedDirs: Iterable<string>): boolean {
  if (!isAbsoluteWindowsPath(dir)) return false;
  if (isInsideDir(dir, defaultDir)) return true;
  for (const p of pickedDirs) if (isInsideDir(dir, p)) return true;
  return false;
}
