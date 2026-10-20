import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

/** Marks an error as worth retrying (stall, truncated body, ...). */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

export class HttpStatusError extends Error {
  status: number;
  retryAfterMs: number | null;
  constructor(status: number, url: string, retryAfterMs: number | null = null) {
    super(`HTTP ${status} from ${redactUrl(url)}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** origin + path only: query strings and credentials often carry secrets. */
export function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

/** Parse a URL and refuse anything that is not http: or https:. */
export function parseHttpUrl(u: string): URL {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol ${url.protocol} (only http: and https: are allowed)`);
  }
  return url;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  finalUrl: string;
  body: IncomingMessage;
}

export interface RequestOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirects?: number;
  /** Time to wait for response headers (ms). 0 disables. Default 30000. */
  timeoutMs?: number;
}

const SENSITIVE_ON_REDIRECT = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** Merge header maps case-insensitively (later maps win). Keys are lower-cased. */
export function mergeHeaders(...maps: Array<Record<string, string> | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of maps) {
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) out[k.toLowerCase()] = v;
  }
  return out;
}

export function parseRetryAfter(v: string | undefined): number | null {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 60) * 1000;
  const when = Date.parse(v);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), 60000);
  return null;
}

/**
 * One HTTP(S) request with manual redirect handling. No automatic decompression
 * (we always ask for identity) so byte ranges mean what they say.
 * The caller owns `body` and must consume or destroy it.
 */
export function httpRequest(rawUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? 30000;
  const baseHeaders = mergeHeaders(
    { 'user-agent': 'SareeaDL/0.1', accept: '*/*', 'accept-encoding': 'identity' },
    opts.headers,
  );
  return new Promise<HttpResponse>((resolve, reject) => {
    const go = (urlStr: string, left: number, headers: Record<string, string>): void => {
      let url: URL;
      try {
        url = parseHttpUrl(urlStr);
      } catch (e) {
        reject(e);
        return;
      }
      if (opts.signal?.aborted) {
        reject(opts.signal.reason ?? new Error('aborted'));
        return;
      }
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, { method, headers, signal: opts.signal });
      // Must stay attached for the whole life of the request: late errors (abort
      // after the response started) would otherwise be uncaught exceptions.
      req.on('error', reject);
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => req.destroy(new TransientError('Timed out waiting for the server')));
      }
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          if (left <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            reject(new Error('Invalid redirect location'));
            return;
          }
          let h = headers;
          if (next.origin !== url.origin) {
            h = {};
            for (const [k, v] of Object.entries(headers)) if (!SENSITIVE_ON_REDIRECT.has(k)) h[k] = v;
          }
          go(next.toString(), left - 1, h);
          return;
        }
        req.setTimeout(0); // body stalls are handled by the caller; a throttled reader is not a stall
        resolve({ status, headers: res.headers, finalUrl: url.toString(), body: res });
      });
      req.end();
    };
    go(rawUrl, opts.maxRedirects ?? 10, baseHeaders);
  });
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET',
]);

export function isTransientError(e: unknown): boolean {
  if (e instanceof TransientError) return true;
  if (e instanceof HttpStatusError) return e.status >= 500 || e.status === 429 || e.status === 408;
  const err = e as { code?: string; message?: string } | null;
  if (err?.code && TRANSIENT_CODES.has(err.code)) return true;
  return /socket hang up|aborted|premature close|terminated/i.test(err?.message ?? '');
}
