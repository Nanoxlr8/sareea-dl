/**
 * Local bridge protocol (browser extension -> native-messaging host -> this app).
 * Newline-delimited JSON over a Windows named pipe. See docs/protocol.md.
 * Everything here is pure so it can be tested without a pipe.
 */
import { validateHttpUrl } from './ipc.ts';

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Longest accepted line, in bytes. A longer line closes the connection. */
  maxLineBytes: 64 * 1024,
  url: 8192,
  fileName: 255,
  referrer: 8192,
  pageUrl: 8192,
  cookie: 16384,
  userAgent: 512,
  id: 64,
} as const;

export type BridgeRequest =
  | { type: 'ping'; id: string | number }
  | {
      type: 'add';
      id: string | number;
      url: string;
      fileName: string | null;
      referrer: string | null;
      pageUrl: string | null;
      /** Kept in memory for this one download only. Never persisted, never logged. */
      cookie: string | null;
      userAgent: string | null;
    };

export type ParsedRequest = { ok: true; request: BridgeRequest } | { ok: false; id: string | number | null; error: string };

export interface BridgeReply {
  v: typeof PROTOCOL_VERSION;
  id: string | number | null;
  ok: boolean;
  error?: string;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HEADER_BAD_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/; // tab is allowed in header values, nothing else

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseId(v: unknown): string | number | null {
  if (typeof v === 'string' && v.length >= 1 && v.length <= LIMITS.id && !CONTROL_RE.test(v)) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  return null;
}

function optionalUrl(v: unknown, field: string, max: number): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: `${field} must be a string` };
  if (v.length > max) return { ok: false, error: `${field} is too long` };
  const c = validateHttpUrl(v);
  return c.ok ? { ok: true, value: c.value } : { ok: false, error: `${field}: ${c.error}` };
}

function optionalHeader(v: unknown, field: string, max: number): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: `${field} must be a string` };
  if (v.length > max) return { ok: false, error: `${field} is too long` };
  if (HEADER_BAD_RE.test(v)) return { ok: false, error: `${field} contains control characters` };
  return { ok: true, value: v };
}

/** Parse and strictly validate one request line (without the newline). */
export function parseBridgeLine(line: string): ParsedRequest {
  if (Buffer.byteLength(line, 'utf8') > LIMITS.maxLineBytes) return { ok: false, id: null, error: 'line too long' };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, id: null, error: 'invalid JSON' };
  }
  if (!isRecord(raw)) return { ok: false, id: null, error: 'request must be a JSON object' };
  const id = parseId(raw.id);
  if (id === null) return { ok: false, id: null, error: 'id must be a string (1-64 characters) or a non-negative integer' };
  const fail = (error: string): ParsedRequest => ({ ok: false, id, error });
  if (raw.v !== PROTOCOL_VERSION) return fail(`unsupported protocol version (expected ${PROTOCOL_VERSION})`);

  if (raw.type === 'ping') {
    const extra = Object.keys(raw).filter((k) => !['v', 'id', 'type'].includes(k));
    if (extra.length > 0) return fail(`unknown field ${extra[0].slice(0, 32)}`);
    return { ok: true, request: { type: 'ping', id } };
  }
  if (raw.type !== 'add') return fail('type must be "add" or "ping"');

  const allowed = ['v', 'id', 'type', 'url', 'fileName', 'referrer', 'headers', 'pageUrl'];
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return fail(`unknown field ${extra[0].slice(0, 32)}`);

  if (typeof raw.url !== 'string') return fail('url is required');
  if (raw.url.length > LIMITS.url) return fail('url is too long');
  const url = validateHttpUrl(raw.url);
  if (!url.ok) return fail(url.error);

  let fileName: string | null = null;
  if (raw.fileName !== undefined && raw.fileName !== null && raw.fileName !== '') {
    if (typeof raw.fileName !== 'string') return fail('fileName must be a string');
    if (raw.fileName.length > LIMITS.fileName) return fail('fileName is too long');
    if (CONTROL_RE.test(raw.fileName)) return fail('fileName contains control characters');
    fileName = raw.fileName;
  }

  const referrer = optionalUrl(raw.referrer, 'referrer', LIMITS.referrer);
  if (!referrer.ok) return fail(referrer.error);
  const pageUrl = optionalUrl(raw.pageUrl, 'pageUrl', LIMITS.pageUrl);
  if (!pageUrl.ok) return fail(pageUrl.error);

  let cookie: string | null = null;
  let userAgent: string | null = null;
  if (raw.headers !== undefined && raw.headers !== null) {
    if (!isRecord(raw.headers)) return fail('headers must be an object');
    const extraH = Object.keys(raw.headers).filter((k) => k !== 'cookie' && k !== 'userAgent');
    if (extraH.length > 0) return fail(`unknown header field ${extraH[0].slice(0, 32)}`);
    const c = optionalHeader(raw.headers.cookie, 'headers.cookie', LIMITS.cookie);
    if (!c.ok) return fail(c.error);
    const u = optionalHeader(raw.headers.userAgent, 'headers.userAgent', LIMITS.userAgent);
    if (!u.ok) return fail(u.error);
    cookie = c.value;
    userAgent = u.value;
  }

  return { ok: true, request: { type: 'add', id, url: url.value, fileName, referrer: referrer.value, pageUrl: pageUrl.value, cookie, userAgent } };
}

export function formatReply(id: string | number | null, ok: boolean, error?: string): string {
  const r: BridgeReply = { v: PROTOCOL_VERSION, id, ok };
  if (!ok && error) r.error = error;
  return JSON.stringify(r) + '\n';
}

/**
 * Splits a byte stream into lines and enforces the line limit while data arrives, so a client that
 * never sends a newline cannot make us buffer without bound. push() returns the complete lines,
 * or null once the limit is exceeded (the caller must close the connection).
 */
export class LineSplitter {
  private buf = '';
  private bytes = 0;
  private dead = false;
  private readonly max: number;

  constructor(maxLineBytes: number = LIMITS.maxLineBytes) {
    this.max = maxLineBytes;
  }

  push(chunk: string): string[] | null {
    if (this.dead) return null;
    const out: string[] = [];
    let rest = chunk;
    for (;;) {
      const i = rest.indexOf('\n');
      if (i < 0) {
        this.buf += rest;
        this.bytes += Buffer.byteLength(rest, 'utf8');
        if (this.bytes > this.max) {
          this.dead = true;
          return null;
        }
        return out;
      }
      const piece = rest.slice(0, i);
      const line = (this.buf + piece).replace(/\r$/, '');
      this.buf = '';
      this.bytes = 0;
      if (Buffer.byteLength(line, 'utf8') > this.max) {
        this.dead = true;
        return null;
      }
      if (line.trim().length > 0) out.push(line);
      rest = rest.slice(i + 1);
    }
  }
}
