import { httpRequest, HttpStatusError, parseHttpUrl, parseRetryAfter } from './http.ts';
import type { HttpResponse } from './http.ts';
import { fileNameFromUrl, parseContentDisposition, sanitizeFileName } from './filename.ts';

export interface ProbeResult {
  finalUrl: string;
  /** Total size in bytes, or null when the server does not say. */
  size: number | null;
  acceptRanges: boolean;
  etag: string | null;
  lastModified: string | null;
  /** Already sanitized for Windows. */
  fileName: string;
  mime: string | null;
}

export interface ContentRange {
  start: number;
  end: number;
  total: number | null;
}

/** Parse "bytes 0-99/1234" (total may be "*"). */
export function parseContentRange(v: string | undefined): ContentRange | null {
  if (!v) return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(v.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === '*' ? null : Number(m[3]);
  if (![start, end].every(Number.isSafeInteger) || end < start) return null;
  if (total !== null && !Number.isSafeInteger(total)) return null;
  return { start, end, total };
}

function parseLength(v: string | undefined): number | null {
  if (v === undefined || !/^\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** GET with Range: bytes=0-0, headers only (body is dropped). */
async function rangeProbe(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<HttpResponse> {
  const res = await httpRequest(url, { method: 'GET', headers: { ...headers, range: 'bytes=0-0' }, signal });
  res.body.destroy();
  return res;
}

/**
 * Ask the server about a URL without downloading it.
 * HEAD first; if HEAD fails (405, 403, network error, ...) fall back to a GET with
 * "Range: bytes=0-0". If HEAD works but the server never says it accepts ranges we
 * also try the 1-byte ranged GET, because many servers support ranges without advertising it.
 * Header values are sent but never logged or stored.
 */
export async function probe(url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<ProbeResult> {
  parseHttpUrl(url);
  let main: HttpResponse | null = null;
  let ranged: HttpResponse | null = null;

  try {
    const head = await httpRequest(url, { method: 'HEAD', headers, signal });
    head.body.resume();
    if (head.status >= 200 && head.status < 300) main = head;
  } catch (e) {
    if (signal?.aborted) throw e;
  }

  if (main) {
    const adv = one(main.headers['accept-ranges'])?.toLowerCase() ?? '';
    const size = parseLength(one(main.headers['content-length']));
    if (!adv.includes('bytes') && !adv.includes('none') && size !== null && size > 0) {
      try {
        ranged = await rangeProbe(url, headers, signal);
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
  } else {
    ranged = await rangeProbe(url, headers, signal);
    if (ranged.status < 200 || ranged.status >= 300) {
      throw new HttpStatusError(ranged.status, url, parseRetryAfter(one(ranged.headers['retry-after'])));
    }
    main = ranged;
  }

  const h = main.headers;
  let size = parseLength(one(h['content-length']));
  let acceptRanges = (one(h['accept-ranges']) ?? '').toLowerCase().includes('bytes');
  if (ranged) {
    if (ranged.status === 206) {
      const cr = parseContentRange(one(ranged.headers['content-range']));
      if (cr) {
        acceptRanges = true;
        // For the 1-byte fallback GET, content-length is 1, so only Content-Range knows the real size.
        if (ranged === main) size = cr.total;
        else if (cr.total !== null) size = cr.total;
      } else if (ranged === main) {
        size = null;
      }
    } else if (ranged.status === 200) {
      // server ignored the Range header
      acceptRanges = false;
      if (size === null) size = parseLength(one(ranged.headers['content-length']));
    }
  }

  const rawName =
    parseContentDisposition(one(h['content-disposition'])) ??
    (ranged ? parseContentDisposition(one(ranged.headers['content-disposition'])) : null) ??
    fileNameFromUrl(main.finalUrl) ??
    fileNameFromUrl(url) ??
    'download';
  const mime = one(h['content-type'])?.split(';')[0].trim().toLowerCase() || null;

  return {
    finalUrl: main.finalUrl,
    size,
    acceptRanges,
    etag: one(h['etag']) ?? (ranged ? one(ranged.headers['etag']) ?? null : null),
    lastModified: one(h['last-modified']) ?? (ranged ? one(ranged.headers['last-modified']) ?? null : null),
    fileName: sanitizeFileName(rawName),
    mime,
  };
}
